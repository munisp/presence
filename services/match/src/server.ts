/**
 * Match service HTTP surface (stateless per PRS-SRS-001 §5).
 *
 *   POST /v1/scan   — full scan orchestration: ring expansion, presence
 *                     lookup, scoring, adaptive threshold (FR-21), MMR
 *                     (FR-22), at most three results with reasons (FR-20)
 *   POST /v1/score  — score one explicit pair (tooling, tests, eval harness)
 *   GET  /healthz
 *
 * The edge enforces auth, rate limits (FR-24), suppression (FR-23) and the
 * empty state (FR-26); this service is the pure scoring core behind it.
 */

import Fastify from "fastify";
import { gridDisk, gridDistance } from "h3-js";
import { Matcher, nonSensitiveCount, Profile } from "./engine.js";
import { matchesServed, renderMetrics, scanRequests } from "./metrics.js";
import { resolveRequestId } from "./requestid.js";
import { MIN_CELL_POPULATION, rankScan, ScanCandidate } from "./scan.js";
import { Store } from "./store.js";

interface ScanBody {
  userId: string;
  cell: string;
  venue?: { baseThreshold?: number; maxResults?: number };
  ringK?: number;      // TR-12: k=1 default
  exclude?: string[];  // FR-23: suppressed pairs, computed by the edge
  tieBreakSeed?: number; // FR-91/SEC-22: rotating tie-break, per-scan
}

export function buildServer(store: Store) {
  const app = Fastify({
    logger: true,
    // NFR-31: honor the edge's X-Request-Id so one trace id spans gateway →
    // edge → match; malformed ids are replaced, never trusted.
    genReqId: (req) => resolveRequestId(req.headers["x-request-id"]),
  });

  // NFR-31: the trace id rides back to the caller on every response.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.get("/healthz", async () => ({ ok: true }));

  // NFR-33: Prometheus scrape endpoint — the MatchRateCollapse alert reads
  // these two counters. Operational surface, aggregates only.
  app.get("/metrics", async (_req, reply) =>
    reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(renderMetrics()),
  );

  app.post("/v1/score", async (req) => {
    const { a, b } = req.body as { a: Profile; b: Profile };
    const matcher = new Matcher(store.getGraph());
    return matcher.score(a, b, store.getCorpus());
  });

  app.post("/v1/scan", async (req, reply) => {
    scanRequests.inc();
    const body = req.body as ScanBody;
    const k = body.ringK ?? 1;
    const cells = gridDisk(body.cell, k);
    const requesterCell = body.cell;

    const seen = new Set<string>(body.exclude ?? []);
    const candidates: ScanCandidate[] = [];
    for (const cell of cells) {
      const members = await store.cellMembers(cell);
      for (const uid of members) {
        if (uid === body.userId || seen.has(uid)) continue;
        seen.add(uid);
        // TR-02: cache-only — the scan path never calls Postgres. A cold
        // profile warms in the background and joins discovery next scan (or
        // at the 60 s corpus refresh, whichever comes first).
        const profile = store.cachedProfile(uid);
        // FR-11: fewer than two non-sensitive interests → not discoverable.
        if (!profile || nonSensitiveCount(profile, store.getGraph()) < 2) continue;
        candidates.push({
          userId: uid,
          profile,
          cellDistance: gridDistance(requesterCell, cell),
        });
      }
    }

    // FR-26: below the minimum cell population the scan returns the empty
    // state — never a thinning, low-confidence list.
    if (candidates.length + 1 < MIN_CELL_POPULATION) {
      return reply.send({ state: "quiet", results: [] });
    }

    const requesterProfile = store.cachedProfile(body.userId);
    if (!requesterProfile) {
      // TR-02: same discipline for the requester — warm async, answer the
      // explanatory empty state this scan rather than hit Postgres.
      return reply.send({ state: "quiet", results: [] });
    }

    const matcher = new Matcher(store.getGraph());
    const results = rankScan(
      requesterProfile,
      candidates,
      matcher,
      store.getCorpus(),
      body.venue ?? {},
      body.tieBreakSeed,
    );
    matchesServed.inc(results.length);
    return reply.send({ state: "ok", results });
  });

  return app;
}

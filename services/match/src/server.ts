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
import { Matcher, Profile } from "./engine.js";
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
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/score", async (req) => {
    const { a, b } = req.body as { a: Profile; b: Profile };
    const matcher = new Matcher(store.getGraph());
    return matcher.score(a, b, store.getCorpus());
  });

  app.post("/v1/scan", async (req, reply) => {
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
        const profile = await store.profile(uid);
        if (!profile || Object.keys(profile).length < 2) continue; // FR-11
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

    const requesterProfile = await store.profile(body.userId);
    if (!requesterProfile) {
      return reply.code(422).send({ error: "requester has no profile" });
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
    return reply.send({ state: "ok", results });
  });

  return app;
}

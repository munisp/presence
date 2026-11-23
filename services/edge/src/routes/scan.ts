/**
 * Scan route (PRS-SRS-001 §5.3).
 *
 *   POST /v1/scan — rate-limited to six per minute per user (FR-24), with a
 *   200-per-hour ceiling on top (SEC-20). The edge resolves the requester's
 *   live presence, collects their FR-23 suppression list, and delegates ring
 *   expansion, scoring, adaptive thresholding and MMR to the match service.
 *   Surfaced pairs are suppressed for ten minutes (FR-23). Below the minimum
 *   cell population the match service returns the empty state and the edge
 *   passes it through untouched (FR-26).
 *
 * The response carries bands and reasons, never coordinates or metres
 * (FR-25), and never identity before OPEN (FR-30): each result is keyed by
 * the pair id and the candidate's FR-16 presence session id — account ids
 * never leave the edge pre-OPEN.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { matchBudget } from "../budget.js";
import { EdgeContext, SUPPRESSION_TTL_S, suppressionKey } from "../context.js";
import { FloorDeclaration, floorsCompatible } from "../floors.js";
import { recordTelemetry } from "../telemetry.js";
import {
  bumpRecurrence,
  dayOrdinal,
  parseRecurrence,
  RECURRENCE_TTL_S,
  recurrenceKey,
} from "../intents.js";
import { SCAN_HOURLY_MAX } from "../velocity.js";
import { DISCOVERY_BLOCKED_ERROR, isDiscoveryAllowed } from "./account.js";

const SCAN_RATE_MAX = 6;        // FR-24
const SCAN_RATE_WINDOW = "1 minute";

interface MatchScanResponse {
  state: "ok" | "quiet";
  results: Array<{
    userId: string;
    score: number;
    band: string;
    reasons: unknown[];
    icebreaker: string;
  }>;
}

export function registerScanRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/scan",
    { config: { rateLimit: { max: SCAN_RATE_MAX, timeWindow: SCAN_RATE_WINDOW, keyGenerator: (req) => req.userId } } },
    async (req, reply) => {
      const userId = req.userId;

      // FR-02/FR-04: age-blocked and deleted accounts cannot scan.
      if (!(await isDiscoveryAllowed(ctx, userId))) {
        return reply.code(403).send({ error: DISCOVERY_BLOCKED_ERROR });
      }

      // SEC-20: hourly scan ceiling, on top of the per-minute burst limit.
      const hourly = await ctx.valkey.incr(`rl:scan:h:${userId}`);
      if (hourly === 1) await ctx.valkey.expire(`rl:scan:h:${userId}`, 3600);
      if (hourly > SCAN_HOURLY_MAX) {
        return reply.code(429).send({ error: "hourly scan limit reached (SEC-20)" });
      }

      const presence = await ctx.valkey.get(`presence:user:${userId}`);
      if (!presence) {
        return reply.code(409).send({ error: "no live presence; enter a venue first" });
      }
      const { cell, venueId, floorId } = JSON.parse(presence) as {
        cell: string;
        venueId?: string | null;
        floorId?: string | null;
      };

      // FR-28: density-scaled match budget — the denser the cell, the fewer
      // scans per window (3/hr sparse down to 1/day crowd). Separate from
      // the SEC-20 anti-abuse ceiling above, which still applies.
      const cellPopulation = await ctx.valkey.scard(`presence:cell:${cell}`);
      const budget = matchBudget(cellPopulation);
      const budgetUsed = await ctx.valkey.incr(`budget:scan:${userId}`);
      if (budgetUsed === 1) await ctx.valkey.expire(`budget:scan:${userId}`, budget.windowSeconds);
      if (budgetUsed > budget.limit) {
        return reply.code(429).send({
          error: "match budget reached for this window (FR-28)",
          band: budget.band,
        });
      }

      // BR-12: venue scan counter behind the dashboard's scansLastHour.
      if (venueId) {
        const n = await ctx.valkey.incr(`stats:venue:${venueId}:scans:h`);
        if (n === 1) await ctx.valkey.expire(`stats:venue:${venueId}:scans:h`, 3600);
      }

      // FR-23: who is suppressed for this requester right now?
      const suppressed: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", `suppress:${userId}:*`, "COUNT", 100);
        cursor = next;
        for (const k of keys) suppressed.push(k.split(":").pop()!);
      } while (cursor !== "0");
      // suppression keys are canonically ordered; also scan the flipped side
      cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", `suppress:*:${userId}`, "COUNT", 100);
        cursor = next;
        for (const key of keys) {
          const other = key.split(":")[1];
          if (other !== userId) suppressed.push(other);
        }
      } while (cursor !== "0");

      // FR-34: permanent blocks, both key directions (no TTL, unlike FR-23)…
      cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", `block:${userId}:*`, "COUNT", 100);
        cursor = next;
        for (const k of keys) suppressed.push(k.split(":").pop()!);
      } while (cursor !== "0");
      cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", `block:*:${userId}`, "COUNT", 100);
        cursor = next;
        for (const key of keys) {
          const other = key.split(":")[1];
          if (other !== userId) suppressed.push(other);
        }
      } while (cursor !== "0");
      // …and the durable record behind them (covers a Valkey flush). The
      // SECURITY DEFINER function erases direction, preserving FR-34 silence.
      const blockRows = await ctx.pg.query("SELECT blocked_users_for($1::uuid) AS other", [userId]);
      for (const r of blockRows.rows) suppressed.push(r.other);

      // FR-91: pairs whose offer was acted on rotate out for seven days.
      cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", `rotate:${userId}:*`, "COUNT", 100);
        cursor = next;
        for (const k of keys) suppressed.push(k.split(":").pop()!);
      } while (cursor !== "0");
      cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", `rotate:*:${userId}`, "COUNT", 100);
        cursor = next;
        for (const key of keys) {
          const other = key.split(":")[1];
          if (other !== userId) suppressed.push(other);
        }
      } while (cursor !== "0");
      const exclude = [...new Set(suppressed)];

      // FR-91/SEC-22: a per-user counter feeds the match service's rotating
      // tie-break, so equal-score ordering is not stable across scans.
      const tieBreakSeed = await ctx.valkey.incr(`tbreak:${userId}`);
      if (tieBreakSeed === 1) await ctx.valkey.expire(`tbreak:${userId}`, 86400);

      // TR-11: venue threshold configuration
      let venue: { baseThreshold?: number; maxResults?: number } = {};
      // FR-99/TR-42: the venue's floor declarations, for same-venue floor
      // scoping of the surfaced list below.
      let floors: FloorDeclaration[] = [];
      if (venueId) {
        const rows = await ctx.pg.query(
          "SELECT base_threshold, max_scan_results FROM venues WHERE venue_id = $1 AND active",
          [venueId],
        );
        if (rows.rows.length) {
          venue = {
            baseThreshold: rows.rows[0].base_threshold,
            maxResults: rows.rows[0].max_scan_results,
          };
        }
        const floorRows = await ctx.pg.query(
          "SELECT floor_id, connected_to FROM venue_floors WHERE venue_id = $1",
          [venueId],
        );
        floors = floorRows.rows.map((r) => ({
          floorId: r.floor_id as string,
          connectedTo: r.connected_to as string[],
        }));
      }

      const res = await fetch(`${ctx.matchServiceUrl}/v1/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, cell, venue, exclude, tieBreakSeed }),
      });
      if (!res.ok) {
        return reply.code(502).send({ error: "match service unavailable" });
      }
      const body = (await res.json()) as MatchScanResponse;

      // FR-29: the first surfacing of a pair records DETECTED in the
      // append-only ledger (idempotent — later scans find the pair exists).
      // FR-33: first surfacing also starts the 30-minute offer window.
      const detected: Array<{ pairId: string; candidateId: string; score: number; band: string; reasons: unknown[]; icebreaker: string }> = [];
      if (body.results.length > 0) {
        await withRls(ctx.pg, userId, async (c) => {
          for (const r of body.results) {
            const [lo, hi] = userId < r.userId ? [userId, r.userId] : [r.userId, userId];
            const inserted = await c.query(
              `INSERT INTO matches (user_lo, user_hi, expires_at)
               VALUES ($1, $2, now() + interval '30 minutes')
               ON CONFLICT (user_lo, user_hi) DO NOTHING RETURNING pair_id`,
              [lo, hi],
            );
            let pairId: string;
            if (inserted.rows.length) {
              pairId = inserted.rows[0].pair_id;
              await c.query(
                `INSERT INTO consent_ledger (pair_id, actor, from_state, to_state)
                 VALUES ($1, NULL, NULL, 'DETECTED')`,
                [pairId],
              );
              // NFR-32/TR-34: the funnel's first event, aggregate dims only.
              recordTelemetry(ctx, "consent.transitioned", { to: "DETECTED" });
            } else {
              const existing = await c.query(
                "SELECT pair_id FROM matches WHERE user_lo = $1 AND user_hi = $2",
                [lo, hi],
              );
              if (!existing.rows.length) continue;
              pairId = existing.rows[0].pair_id;
            }
            detected.push({
              pairId,
              candidateId: r.userId,
              score: r.score,
              band: r.band,
              reasons: r.reasons,
              icebreaker: r.icebreaker,
            });
          }
        });
      }

      // NFR-32/TR-34: one scan event with the aggregate outcome — band and
      // surfaced count only, never user or pair identifiers.
      recordTelemetry(ctx, "scan.completed", { band: budget.band, surfaced: detected.length });

      // FR-16/FR-30: the wire result carries the pair id and the candidate's
      // live presence session id — never an account id. Candidates whose
      // presence lapsed between the match call and this response are dropped.
      // FR-99: at the same venue, a candidate on a different floor is dropped
      // unless the venue declared the two floors connected.
      // FR-64: each surfaced candidate's structured prompts ride along as
      // reason material (screened at write time; never searchable).
      const promptRows = detected.length > 0
        ? await ctx.pg.query(
            "SELECT user_id, slot, body FROM profile_prompts WHERE user_id = ANY($1::uuid[]) ORDER BY slot",
            [detected.map((d) => d.candidateId)],
          )
        : { rows: [] as Array<{ user_id: string; slot: number; body: string }> };
      const promptsByUser = new Map<string, Array<{ slot: number; body: string }>>();
      for (const row of promptRows.rows) {
        const list = promptsByUser.get(row.user_id) ?? [];
        list.push({ slot: row.slot, body: row.body });
        promptsByUser.set(row.user_id, list);
      }
      const requesterFloor = typeof floorId === "string" ? floorId : null;

      // FR-17/FR-71: pull the requester's intent once, then per candidate
      // their intent and the pair's recurrence counter in one pipeline.
      const myIntentRaw = await ctx.valkey.get(`intent:${userId}`);
      const myIntent = myIntentRaw ? (JSON.parse(myIntentRaw) as { intent: string }).intent : null;
      const today = dayOrdinal(new Date());
      const signalPipe = ctx.valkey.pipeline();
      for (const r of detected) {
        signalPipe.get(`intent:${r.candidateId}`);
        const [lo, hi] = userId < r.candidateId ? [userId, r.candidateId] : [r.candidateId, userId];
        signalPipe.get(recurrenceKey(lo, hi));
      }
      const signals = detected.length > 0 ? await signalPipe.exec() : [];

      const results: Array<Record<string, unknown>> = [];
      const recurWrites = ctx.valkey.pipeline();
      let recurDirty = false;
      for (const [i, r] of detected.entries()) {
        const p = await ctx.valkey.get(`presence:user:${r.candidateId}`);
        if (!p) continue;
        const cand = JSON.parse(p) as { sessionId?: string; venueId?: string | null; floorId?: string | null };
        if (!cand.sessionId) continue;
        if (venueId && cand.venueId === venueId && floors.length > 0) {
          const candFloor = typeof cand.floorId === "string" ? cand.floorId : null;
          if (!floorsCompatible(requesterFloor, candFloor, floors)) continue;
        }
        // FR-17: a shared active intent is a match signal — annotation only,
        // the score contract does not move.
        const candIntentRaw = signals?.[2 * i]?.[1] as string | null;
        const candIntent = candIntentRaw ? (JSON.parse(candIntentRaw) as { intent: string }).intent : null;
        const sharedIntent = myIntent !== null && candIntent === myIntent ? candIntent : null;
        // FR-71: bump the pair's day counter at most once per day; the wire
        // carries the day count, never a timestamp.
        const [lo, hi] = userId < r.candidateId ? [userId, r.candidateId] : [r.candidateId, userId];
        const stored = parseRecurrence((signals?.[2 * i + 1]?.[1] as string | null) ?? null);
        const { next, bumped } = bumpRecurrence(stored, today);
        if (bumped) {
          recurWrites.set(recurrenceKey(lo, hi), JSON.stringify(next), "EX", RECURRENCE_TTL_S);
          recurDirty = true;
        }
        results.push({
          pairId: r.pairId,
          sessionId: cand.sessionId,
          score: r.score,
          band: r.band,
          reasons: r.reasons,
          icebreaker: r.icebreaker,
          prompts: promptsByUser.get(r.candidateId) ?? [],
          sharedIntent,
          recurrenceDays: next.days,
        });
      }
      if (recurDirty) await recurWrites.exec();

      // FR-23: suppress every surfaced pair for ten minutes.
      if (detected.length > 0) {
        const pipe = ctx.valkey.pipeline();
        for (const r of detected) {
          pipe.set(suppressionKey(userId, r.candidateId), "1", "EX", SUPPRESSION_TTL_S);
        }
        await pipe.exec();
      }

      // FR-44: in the crowd band discovery transitions to interest rooms —
      // the response says so and points at the room surface.
      const crowdMode = budget.band === "crowd" && typeof venueId === "string" && venueId.length > 0;
      return reply.send({
        state: body.state,
        results,
        ...(crowdMode
          ? { mode: "rooms" as const, roomsUrl: `/v1/venues/${venueId}/rooms` }
          : {}),
      });
    },
  );
}

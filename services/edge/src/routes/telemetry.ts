/**
 * Telemetry console routes (PRS-SRS-001 §2.5) — NFR-32, TR-34.
 *
 *   GET /v1/telemetry/metrics    — the four §2.5 product metrics as JSON,
 *                                  with the freshness of the underlying
 *                                  events (the ≤5-minute budget, evidenced)
 *   GET /v1/telemetry/export.csv — the same metrics in the versioned CSV
 *                                  contract (TR-34)
 *
 * Workforce analysts only (requireAnalyst + app.analyst GUC). Read-only.
 */

import { FastifyInstance } from "fastify";
import { requireAnalyst, withAnalyst } from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  METRICS_QUERY,
  computeProductMetrics,
  parseWindowMinutes,
  toCsv,
} from "../telemetry.js";

interface MetricsResult {
  metrics: ReturnType<typeof computeProductMetrics>;
  windowStart: Date;
  windowEnd: Date;
  newestEventAgeSeconds: number | null;
}

async function computeWindow(ctx: EdgeContext, windowMinutes: number): Promise<MetricsResult> {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowMinutes * 60_000);
  return withAnalyst(ctx.pg, async (client) => {
    const res = await client.query(METRICS_QUERY, [windowStart, windowEnd]);
    const r = res.rows[0] as Record<string, unknown>;
    const num = (k: string) => Number(r[k] ?? 0);
    const metrics = computeProductMetrics({
      scans: num("scans"),
      scansSurfaced: num("scans_surfaced"),
      detected: num("detected"),
      expressed: num("expressed"),
      mutual: num("mutual"),
      opened: num("opened"),
      firstMessages: num("first_messages"),
    });
    // NFR-32: age of the newest event in the window. Writes are synchronous
    // in the causing request, so metrics are computable well inside the
    // five-minute budget; the console shows the evidence rather than
    // asserting it.
    const newestRaw = r.newest;
    const newest =
      newestRaw == null ? null : newestRaw instanceof Date ? newestRaw : new Date(newestRaw as string);
    const newestEventAgeSeconds =
      newest === null ? null : Math.max(0, Math.round((windowEnd.getTime() - newest.getTime()) / 1000));
    return { metrics, windowStart, windowEnd, newestEventAgeSeconds };
  });
}

export function registerTelemetryRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get("/v1/telemetry/metrics", { preHandler: requireAnalyst }, async (req, reply) => {
    const windowMinutes = parseWindowMinutes((req.query as Record<string, unknown>).windowMinutes);
    if (windowMinutes === null) return reply.code(422).send({ error: "windowMinutes must be 1-1440" });
    const out = await computeWindow(ctx, windowMinutes);
    return reply.send({
      windowStart: out.windowStart.toISOString(),
      windowEnd: out.windowEnd.toISOString(),
      newestEventAgeSeconds: out.newestEventAgeSeconds,
      metrics: out.metrics.map((m) => ({
        metricKey: m.metricKey,
        value: m.value,
        numerator: m.numerator,
        denominator: m.denominator,
      })),
    });
  });

  app.get("/v1/telemetry/export.csv", { preHandler: requireAnalyst }, async (req, reply) => {
    const windowMinutes = parseWindowMinutes((req.query as Record<string, unknown>).windowMinutes);
    if (windowMinutes === null) return reply.code(422).send({ error: "windowMinutes must be 1-1440" });
    const out = await computeWindow(ctx, windowMinutes);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .send(toCsv(out.metrics, out.windowStart, out.windowEnd));
  });
}

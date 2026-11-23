/**
 * NFR-32/TR-34: product telemetry — stable event keys, the four §2.5
 * product metrics, and the versioned CSV export contract.
 *
 * Events are written synchronously by the request that caused them
 * (recordTelemetry is fire-and-forget but never queued or batched), so the
 * metrics are computable within seconds — the NFR-32 five-minute budget is
 * met by construction, and every response reports its own freshness.
 *
 * Privacy shape: aggregate dimensions only. No user ids, no pair ids, no
 * cells — telemetry must never become a tracking surface.
 */

import { EdgeContext } from "./context.js";

/** TR-34: the governed event keys; the DB CHECK enforces the same list. */
export const TELEMETRY_EVENT_KEYS = [
  "scan.completed",
  "consent.transitioned",
  "pair.first_message",
] as const;
export type TelemetryEventKey = (typeof TELEMETRY_EVENT_KEYS)[number];

/** TR-34: the versioned CSV contract identifier — first line of every export. */
export const TELEMETRY_CSV_VERSION = "presence-telemetry/v1";

/** TR-34: stable column order for the CSV export. */
export const TELEMETRY_CSV_COLUMNS = [
  "metric_key",
  "window_start",
  "window_end",
  "value",
  "numerator",
  "denominator",
] as const;

/** NFR-32: the metrics window bounds (minutes); default one hour, max one day. */
export const METRICS_WINDOW_DEFAULT_MIN = 60;
export const METRICS_WINDOW_MAX_MIN = 1440;

/** Fire-and-forget event write. Never fails a user request; never queued. */
export function recordTelemetry(
  ctx: EdgeContext,
  eventKey: TelemetryEventKey,
  dims: Record<string, unknown> = {},
): void {
  ctx.pg
    .query("INSERT INTO telemetry_events (event_key, dims) VALUES ($1, $2)", [
      eventKey,
      JSON.stringify(dims),
    ])
    .catch((err) => console.error("telemetry write failed", err));
}

export interface ProductMetric {
  metricKey: string;
  value: number | null; // null when the denominator is zero
  numerator: number;
  denominator: number;
}

/** NFR-32: the four §2.5 product metrics over the consent funnel. */
export const PRODUCT_METRIC_KEYS = [
  "scan.surfaced_rate",
  "surfacing.express_rate",
  "mutual.open_rate",
  "open.first_message_rate",
] as const;

interface EventCounts {
  scans: number;
  scansSurfaced: number;
  detected: number;
  expressed: number;
  mutual: number;
  opened: number;
  firstMessages: number;
}

/** NFR-32: one pass over the events table produces every funnel count. */
export const METRICS_QUERY = `
SELECT
  count(*) FILTER (WHERE event_key = 'scan.completed') AS scans,
  count(*) FILTER (WHERE event_key = 'scan.completed' AND (dims->>'surfaced')::int > 0) AS scans_surfaced,
  count(*) FILTER (WHERE event_key = 'consent.transitioned' AND dims->>'to' = 'DETECTED') AS detected,
  count(*) FILTER (WHERE event_key = 'consent.transitioned' AND dims->>'to' = 'EXPRESSED') AS expressed,
  count(*) FILTER (WHERE event_key = 'consent.transitioned' AND dims->>'to' = 'MUTUAL') AS mutual,
  count(*) FILTER (WHERE event_key = 'consent.transitioned' AND dims->>'to' = 'OPEN') AS opened,
  count(*) FILTER (WHERE event_key = 'pair.first_message') AS first_messages,
  max(occurred_at) AS newest
FROM telemetry_events
WHERE occurred_at >= $1 AND occurred_at < $2`;

/** The funnel arithmetic, pure for testing. Rates are numerator/denominator;
 * a zero denominator yields null, never a fake zero. */
export function computeProductMetrics(c: EventCounts): ProductMetric[] {
  const rate = (metricKey: string, numerator: number, denominator: number): ProductMetric => ({
    metricKey,
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
  });
  return [
    rate("scan.surfaced_rate", c.scansSurfaced, c.scans),
    rate("surfacing.express_rate", c.expressed, c.detected),
    rate("mutual.open_rate", c.opened, c.mutual),
    rate("open.first_message_rate", c.firstMessages, c.opened),
  ];
}

/** TR-34: the versioned CSV document. Version line, header, one row per
 * metric — the column order is contractually stable. */
export function toCsv(
  metrics: ProductMetric[],
  windowStart: Date,
  windowEnd: Date,
): string {
  const lines = [`# ${TELEMETRY_CSV_VERSION}`, TELEMETRY_CSV_COLUMNS.join(",")];
  for (const m of metrics) {
    lines.push(
      [
        m.metricKey,
        windowStart.toISOString(),
        windowEnd.toISOString(),
        m.value === null ? "" : m.value.toFixed(6),
        String(m.numerator),
        String(m.denominator),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function parseWindowMinutes(raw: unknown): number | null {
  if (raw === undefined) return METRICS_WINDOW_DEFAULT_MIN;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > METRICS_WINDOW_MAX_MIN) return null;
  return n;
}

/** NFR-32/TR-34 telemetry unit tests. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  METRICS_WINDOW_DEFAULT_MIN,
  METRICS_WINDOW_MAX_MIN,
  PRODUCT_METRIC_KEYS,
  TELEMETRY_CSV_COLUMNS,
  TELEMETRY_CSV_VERSION,
  TELEMETRY_EVENT_KEYS,
  computeProductMetrics,
  parseWindowMinutes,
  toCsv,
} from "../src/telemetry.js";

test("the event keys and metric keys are the governed stable sets (TR-34)", () => {
  assert.deepEqual([...TELEMETRY_EVENT_KEYS], ["scan.completed", "consent.transitioned", "pair.first_message"]);
  assert.deepEqual([...PRODUCT_METRIC_KEYS], [
    "scan.surfaced_rate",
    "surfacing.express_rate",
    "mutual.open_rate",
    "open.first_message_rate",
  ]);
});

test("funnel arithmetic: rates, and null on a zero denominator (NFR-32)", () => {
  const metrics = computeProductMetrics({
    scans: 10,
    scansSurfaced: 4,
    detected: 8,
    expressed: 2,
    mutual: 4,
    opened: 3,
    firstMessages: 2,
  });
  assert.equal(metrics[0].metricKey, "scan.surfaced_rate");
  assert.equal(metrics[0].value, 0.4);
  assert.equal(metrics[1].value, 0.25);
  assert.equal(metrics[2].value, 0.75);
  assert.equal(metrics[3].value, 2 / 3);

  const empty = computeProductMetrics({
    scans: 0,
    scansSurfaced: 0,
    detected: 0,
    expressed: 0,
    mutual: 0,
    opened: 0,
    firstMessages: 0,
  });
  for (const m of empty) {
    assert.equal(m.value, null, `${m.metricKey} must be null, never a fake zero`);
    assert.equal(m.denominator, 0);
  }
});

test("the CSV contract: version line, stable columns, one row per metric (TR-34)", () => {
  const metrics = computeProductMetrics({
    scans: 2,
    scansSurfaced: 1,
    detected: 1,
    expressed: 1,
    mutual: 1,
    opened: 1,
    firstMessages: 1,
  });
  const start = new Date("2026-11-23T18:00:00.000Z");
  const end = new Date("2026-11-23T19:00:00.000Z");
  const csv = toCsv(metrics, start, end);
  const lines = csv.split("\n");
  assert.equal(lines[0], `# ${TELEMETRY_CSV_VERSION}`);
  assert.equal(lines[1], TELEMETRY_CSV_COLUMNS.join(","));
  assert.equal(lines[1], "metric_key,window_start,window_end,value,numerator,denominator");
  assert.equal(lines.length, 2 + metrics.length + 1); // trailing newline
  assert.equal(
    lines[2],
    "scan.surfaced_rate,2026-11-23T18:00:00.000Z,2026-11-23T19:00:00.000Z,0.500000,1,2",
  );
  assert.ok(csv.endsWith("\n"));
});

test("null values export as empty fields, never the string null", () => {
  const metrics = computeProductMetrics({
    scans: 0,
    scansSurfaced: 0,
    detected: 0,
    expressed: 0,
    mutual: 0,
    opened: 0,
    firstMessages: 0,
  });
  const csv = toCsv(metrics, new Date(0), new Date(60_000));
  assert.ok(!csv.includes("null"));
  assert.ok(csv.includes("scan.surfaced_rate,1970-01-01T00:00:00.000Z,1970-01-01T00:01:00.000Z,,0,0"));
});

test("window parsing is bounded and defaults to one hour", () => {
  assert.equal(parseWindowMinutes(undefined), METRICS_WINDOW_DEFAULT_MIN);
  assert.equal(parseWindowMinutes("60"), 60);
  assert.equal(parseWindowMinutes("1"), 1);
  assert.equal(parseWindowMinutes(String(METRICS_WINDOW_MAX_MIN)), METRICS_WINDOW_MAX_MIN);
  assert.equal(parseWindowMinutes("0"), null);
  assert.equal(parseWindowMinutes("1441"), null);
  assert.equal(parseWindowMinutes("1.5"), null);
  assert.equal(parseWindowMinutes("abc"), null);
});

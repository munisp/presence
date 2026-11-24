/**
 * NFR-33: the scan-demand and served counters the MatchRateCollapse alert
 * reads — exposition format and increment semantics.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Counter, matchesServed, renderMetrics, scanRequests } from "../src/metrics.js";

test("counter exposition follows the text format", () => {
  const c = new Counter("test_total", "a test counter");
  c.inc();
  c.inc(4);
  assert.equal(
    c.render(),
    "# HELP test_total a test counter\n# TYPE test_total counter\ntest_total 5",
  );
});

test("both alert-input series render with their contract names", () => {
  const out = renderMetrics();
  assert.match(out, /^# TYPE match_scan_requests_total counter$/m);
  assert.match(out, /^# TYPE match_served_total counter$/m);
});

test("the module counters are the exported singletons", () => {
  scanRequests.inc();
  matchesServed.inc(3);
  const out = renderMetrics();
  const scan = Number(/^match_scan_requests_total (\d+)$/m.exec(out)?.[1]);
  const served = Number(/^match_served_total (\d+)$/m.exec(out)?.[1]);
  assert.ok(scan >= 1);
  assert.ok(served >= 3);
});

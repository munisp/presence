/**
 * Batch 24 — reporting & compliance records: the pure contracts.
 *
 * The SQL-side invariants (CHECK vocabularies, RLS policies, retention
 * interval, append-only triggers) are pinned by
 * tests/test_reporting_compliance.py against the migration source; these
 * tests pin the edge-side constants and the audit writer's fire-and-forget
 * contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_CATEGORIES } from "../src/reports.js";
import { SECURITY_EVENT_KINDS, recordSecurityEvent } from "../src/security.js";
import { TAXONOMY_PROVENANCE } from "../src/taxonomy.js";

test("FR-49: exactly the six spec categories, in spec order", () => {
  assert.deepEqual([...REPORT_CATEGORIES], [
    "harassment",
    "impersonation",
    "under_age",
    "commercial_solicitation",
    "hate",
    "other",
  ]);
});

test("SEC-30: the kind vocabulary covers every wired event", () => {
  assert.deepEqual([...SECURITY_EVENT_KINDS], [
    "impossible_travel",
    "missing_attestation",
    "attestation_key_duplicate",
    "mock_location_refusal",
    "console_authorization_denied",
    "retention.purge",
  ]);
});

test("BR-21: provenance is CC0 over a Wikidata-derived structure, no proprietary venue data", () => {
  assert.equal(TAXONOMY_PROVENANCE.license, "CC0");
  assert.equal(TAXONOMY_PROVENANCE.structureSource, "Wikidata");
  assert.match(TAXONOMY_PROVENANCE.attribution, /wikidata\.org/);
  assert.equal(TAXONOMY_PROVENANCE.proprietaryVenueData, "none");
});

test("SEC-30: the writer calls the governed definer function with kind, actor, detail", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      return Promise.resolve({ rows: [] });
    },
  };
  recordSecurityEvent(pool as never, "mock_location_refusal", "00000000-0000-0000-0000-000000000001", {
    platform: "android",
  });
  // fire-and-forget: let the promise land
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /SELECT record_security_event\(\$1, \$2::uuid, \$3::jsonb\)/);
  assert.deepEqual(calls[0].values, [
    "mock_location_refusal",
    "00000000-0000-0000-0000-000000000001",
    JSON.stringify({ platform: "android" }),
  ]);
});

test("SEC-30: an audit failure never throws into the request path", async () => {
  const pool = {
    query: () => Promise.reject(new Error("db down")),
  };
  const origError = console.error;
  let logged = "";
  console.error = (...args: unknown[]) => {
    logged = String(args[0]);
  };
  try {
    recordSecurityEvent(pool as never, "impossible_travel", null, { resolution: 9 });
    await new Promise((r) => setImmediate(r));
  } finally {
    console.error = origError;
  }
  assert.match(logged, /security audit write failed/);
});

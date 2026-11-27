/** TECH-16: dependency maintenance/licence/size budget; the 45 MB bundle cap. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALLOWED_LICENSES,
  BUNDLE_CAP_BYTES,
  BUNDLE_SIZE_LEDGER,
  MAINTENANCE_RULES,
  PROHIBITED_LICENSE_MARKERS,
  RUNTIME_DEPENDENCY_COUNT,
  bundleSizeFits,
  dependencyAdmission,
  dependencyBudgetHonoursTech16,
  licenceAllowed,
} from "../src/presence/dependencyBudget.js";

test("the bundle cap is 45 MB", () => {
  assert.equal(BUNDLE_CAP_BYTES, 45 * 1024 * 1024);
});

test("the licence allowlist mirrors the SEC-25 CI set", () => {
  assert.deepEqual(
    [...ALLOWED_LICENSES],
    ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0"],
  );
});

test("permissive licences pass, copyleft and unknowns refuse", () => {
  for (const spdx of ALLOWED_LICENSES) {
    assert.ok(licenceAllowed(spdx), `${spdx} must be allowed`);
  }
  assert.equal(licenceAllowed("AGPL-3.0-only"), false);
  assert.equal(licenceAllowed("GPL-3.0-or-later"), false);
  assert.equal(licenceAllowed("LGPL-2.1-only"), false);
  assert.equal(licenceAllowed("SSPL-1.0"), false);
  assert.equal(licenceAllowed("WTFPL"), false);
  assert.equal(licenceAllowed(""), false);
});

test("the prohibited-marker screen runs before the allowlist", () => {
  for (const marker of PROHIBITED_LICENSE_MARKERS) {
    assert.equal(licenceAllowed(`MIT-or-${marker}`), false, `${marker} must refuse`);
  }
  assert.equal(licenceAllowed("mit"), false, "the allowlist match is exact");
});

test("the ledger has one allocation per runtime dependency and fits the cap", () => {
  assert.equal(BUNDLE_SIZE_LEDGER.length, RUNTIME_DEPENDENCY_COUNT);
  // Batch 66 (AMD-CRT-04): centrifuge admitted — count 7 -> 8, total 31 -> 39 MB.
  assert.equal(RUNTIME_DEPENDENCY_COUNT, 8);
  assert.ok(bundleSizeFits(BUNDLE_SIZE_LEDGER));
  assert.ok(dependencyBudgetHonoursTech16());
  const total = BUNDLE_SIZE_LEDGER.reduce((sum, d) => sum + d.bytes, 0);
  assert.equal(total, 39 * 1024 * 1024, "39 MB allocated against the 45 MB cap");
});

test("a ledger that cannot fit fails loudly; duplicates and garbage fail closed", () => {
  assert.equal(bundleSizeFits([{ name: "huge", bytes: BUNDLE_CAP_BYTES + 1 }]), false);
  assert.equal(bundleSizeFits([{ name: "x", bytes: 0 }]), false);
  assert.equal(bundleSizeFits([{ name: "x", bytes: Number.NaN }]), false);
  assert.equal(
    bundleSizeFits([
      { name: "x", bytes: 1 },
      { name: "x", bytes: 2 },
    ]),
    false,
  );
});

test("the maintenance rules are pinned", () => {
  assert.deepEqual(
    [...MAINTENANCE_RULES],
    [
      "no-deprecated-packages",
      "sec-18-allowlist-membership",
      "licence-allowlist-exact-match",
      "size-within-allocation",
    ],
  );
});

test("admission: a compliant candidate passes", () => {
  const verdict = dependencyAdmission({
    name: "small-lib",
    licence: "MIT",
    sizeBytes: 1024 * 1024,
    deprecated: false,
    onSec18Allowlist: true,
  });
  assert.deepEqual(verdict, { admit: true });
});

test("admission refusals are pinned and ordered", () => {
  const base = {
    name: "candidate",
    licence: "MIT",
    sizeBytes: 1024,
    deprecated: false,
    onSec18Allowlist: true,
  };
  assert.deepEqual(dependencyAdmission({ ...base, sizeBytes: 0 }), {
    admit: false,
    reason: "size-not-positive",
  });
  assert.deepEqual(dependencyAdmission({ ...base, onSec18Allowlist: false }), {
    admit: false,
    reason: "not-on-sec-18-allowlist",
  });
  assert.deepEqual(dependencyAdmission({ ...base, deprecated: true }), {
    admit: false,
    reason: "deprecated",
  });
  assert.deepEqual(dependencyAdmission({ ...base, licence: "AGPL-3.0-only" }), {
    admit: false,
    reason: "licence-refused",
  });
  assert.deepEqual(dependencyAdmission({ ...base, sizeBytes: BUNDLE_CAP_BYTES }), {
    admit: false,
    reason: "bundle-over-cap",
  });
});

test("libsignal's AGPL-3.0 refuses at the gate — the TECH-08 discipline", () => {
  const verdict = dependencyAdmission({
    name: "libsignal-client",
    licence: "AGPL-3.0",
    sizeBytes: 4 * 1024 * 1024,
    deprecated: false,
    onSec18Allowlist: false,
  });
  assert.equal(verdict.admit, false);
  assert.equal(licenceAllowed("AGPL-3.0"), false);
});

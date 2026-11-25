/**
 * TECH-08: the messaging-crypto contract — provider registry with the
 * libsignal prohibition, device-held keys, the epoch state machine, the
 * ciphertext-only wire, and the screen-before-encrypt compose path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_CRYPTO_PROVIDERS,
  COMPOSE_PIPELINE,
  FORBIDDEN_PLAINTEXT_FIELDS,
  GROUP_STATES,
  KEY_PACKAGE_REFILL_FLOOR,
  KEY_PACKAGE_UPLOAD_FIELDS,
  LIBSIGNAL_PROHIBITION_REASON,
  OUTBOUND_PAYLOAD_FIELDS,
  PRIVATE_KEY_STORAGE,
  PROHIBITED_CRYPTO_PROVIDERS,
  applyEpochEvent,
  buildKeyPackageUpload,
  buildOutboundPayload,
  cryptoProviderAllowed,
  e2eCryptoHonoursTech08,
  initialGroupEpoch,
  keyPackageRefillDue,
  payloadViolations,
  planCompose,
} from "../src/presence/e2eCrypto.js";

test("TECH-08: the provider registry is exactly OpenMLS and vodozemac", () => {
  assert.deepEqual(
    ALLOWED_CRYPTO_PROVIDERS.map((provider) => provider.name),
    ["OpenMLS", "vodozemac"],
  );
  for (const provider of ALLOWED_CRYPTO_PROVIDERS) {
    assert.ok(cryptoProviderAllowed(provider), provider.name);
    for (const spdx of provider.licenses) {
      assert.ok(["MIT", "Apache-2.0"].includes(spdx), spdx);
    }
  }
});

test("TECH-08: libsignal is prohibited with the SRS reason pinned", () => {
  assert.deepEqual([...PROHIBITED_CRYPTO_PROVIDERS], ["libsignal"]);
  assert.equal(LIBSIGNAL_PROHIBITION_REASON, "AGPL-3.0 conflicts with a closed client");
  assert.ok(!cryptoProviderAllowed({ name: "libsignal", ecosystem: "C", licenses: ["AGPL-3.0"] }));
});

test("TECH-08: libsignal lookalikes refuse even with a clean licence", () => {
  assert.ok(
    !cryptoProviderAllowed({ name: "libsignal-client", ecosystem: "C", licenses: ["MIT"] }),
  );
  assert.ok(
    !cryptoProviderAllowed({ name: "LibSignal fork", ecosystem: "C", licenses: ["MIT"] }),
  );
});

test("TECH-08: an unknown provider refuses even with a clean licence", () => {
  assert.ok(!cryptoProviderAllowed({ name: "curve25519-kit", ecosystem: "Rust", licenses: ["MIT"] }));
});

test("TECH-08: an AGPL licence refuses a registered provider name", () => {
  assert.ok(
    !cryptoProviderAllowed({ name: "OpenMLS", ecosystem: "Rust", licenses: ["AGPL-3.0"] }),
  );
  assert.ok(
    !cryptoProviderAllowed({ name: "vodozemac", ecosystem: "Rust", licenses: ["MIT-or-AGPL-3.0"] }),
  );
});

test("TECH-08: private keys are pinned to the device keystore", () => {
  assert.equal(PRIVATE_KEY_STORAGE, "secure-store");
});

test("TECH-08: the key-package upload is single-field and refuses blanks", () => {
  assert.deepEqual([...KEY_PACKAGE_UPLOAD_FIELDS], ["keyPackage"]);
  const upload = buildKeyPackageUpload("kp.abc123");
  assert.deepEqual(upload, { keyPackage: "kp.abc123" });
  assert.equal(buildKeyPackageUpload(""), null);
  assert.equal(buildKeyPackageUpload("   "), null);
  assert.equal(buildKeyPackageUpload(undefined as never), null);
});

test("TECH-08: the refill floor is pinned and garbage refills", () => {
  assert.equal(KEY_PACKAGE_REFILL_FLOOR, 10);
  assert.ok(keyPackageRefillDue(9));
  assert.ok(keyPackageRefillDue(0));
  assert.ok(!keyPackageRefillDue(10));
  assert.ok(!keyPackageRefillDue(50));
  assert.ok(keyPackageRefillDue(Number.NaN));
  assert.ok(keyPackageRefillDue(-1));
  assert.ok(keyPackageRefillDue(Number.POSITIVE_INFINITY));
});

test("TECH-08: the group forms at pair open and refuses messages before it", () => {
  assert.deepEqual([...GROUP_STATES], ["pending", "active", "closed"]);
  const pending = initialGroupEpoch();
  assert.deepEqual(pending, { state: "pending", epoch: 0 });
  assert.equal(applyEpochEvent(pending, "message"), null);
  assert.equal(applyEpochEvent(pending, "member-add"), null);
  assert.equal(applyEpochEvent(pending, "pair-close"), null);
  const active = applyEpochEvent(pending, "pair-open");
  assert.deepEqual(active, { state: "active", epoch: 1 });
});

test("TECH-08: epochs advance while active and the group seals at close", () => {
  let group = applyEpochEvent(initialGroupEpoch(), "pair-open");
  assert.ok(group !== null);
  group = applyEpochEvent(group, "message");
  assert.equal(group?.epoch, 2);
  group = applyEpochEvent(group!, "member-remove");
  assert.equal(group?.epoch, 3);
  assert.equal(group?.state, "active");
  assert.equal(applyEpochEvent(group!, "pair-open"), null);
  const closed = applyEpochEvent(group!, "pair-close");
  assert.deepEqual(closed, { state: "closed", epoch: 4 });
  assert.equal(applyEpochEvent(closed!, "message"), null);
  assert.equal(applyEpochEvent(closed!, "pair-open"), null);
  assert.equal(applyEpochEvent(closed!, "garbage" as never), null);
});

test("TECH-08: the wire payload is exactly the opaque envelope", () => {
  assert.deepEqual([...OUTBOUND_PAYLOAD_FIELDS], ["envelope"]);
  const payload = buildOutboundPayload("Y2lwaGVydGV4dA==");
  assert.deepEqual(payload, { envelope: "Y2lwaGVydGV4dA==" });
  assert.equal(buildOutboundPayload(""), null);
  assert.equal(buildOutboundPayload("   "), null);
});

test("TECH-08: plaintext-carrying fields are violations", () => {
  assert.deepEqual(
    [...FORBIDDEN_PLAINTEXT_FIELDS],
    ["body", "text", "plaintext", "preview", "snippet", "attachment"],
  );
  assert.deepEqual(payloadViolations({ envelope: "YQ==" }), []);
  assert.deepEqual(payloadViolations({ envelope: "YQ==", preview: "hi" }), [
    "plaintext:preview",
  ]);
  assert.deepEqual(payloadViolations({ envelope: "YQ==", extra: 1 }), ["field:extra"]);
  assert.deepEqual(payloadViolations({}), ["envelope"]);
  assert.deepEqual(payloadViolations({ envelope: " " }), ["envelope"]);
});

test("TECH-08: compose screens before it encrypts, required on the first message", () => {
  assert.deepEqual([...COMPOSE_PIPELINE], ["screen", "encrypt", "send"]);
  assert.equal(planCompose(0).screening, "required");
  assert.equal(planCompose(0).stages, COMPOSE_PIPELINE);
  assert.equal(planCompose(1).screening, "not-required");
  assert.equal(planCompose(5).screening, "not-required");
});

test("TECH-08: the master guard holds", () => {
  assert.ok(e2eCryptoHonoursTech08());
});

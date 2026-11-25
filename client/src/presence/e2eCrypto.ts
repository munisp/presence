/**
 * TECH-08: messaging crypto — OpenMLS or vodozemac; libsignal
 * prohibited.
 *
 * The SRS: the messaging channel is end-to-end encrypted over MLS, with
 * keys generated and held on device; the server MUST NOT be able to
 * decrypt message content or attachments, and MUST store only
 * ciphertext (FR-36 — its server half is already law: the messages
 * table is one opaque `envelope bytea`). TECH-08 pins the provider:
 * OpenMLS or vodozemac (both MIT/Apache-2.0); libsignal MUST NOT be
 * used because AGPL-3.0 conflicts with a closed client.
 *
 * The enforceable client half lands here as five contracts:
 *
 *   1. Provider registry — {@link ALLOWED_CRYPTO_PROVIDERS} is exactly
 *      the two SRS-named providers with their licences pinned, and
 *      {@link cryptoProviderAllowed} refuses libsignal twice over: by
 *      name and by its AGPL marker (via the TECH-16 licence screen), so
 *      neither a rename nor a licence-laundering admits it.
 *   2. Key custody — private keys are generated and held on device in
 *      the platform keystore ({@link PRIVATE_KEY_STORAGE}, the TR-30
 *      secure-store adapter); the only key material that ever leaves
 *      the device is the public key package, and
 *      {@link buildKeyPackageUpload} carries exactly that one field.
 *      {@link keyPackageRefillDue} fails closed toward refilling on
 *      garbage counts.
 *   3. Epoch state machine — one MLS group per pair
 *      ({@link applyEpochEvent}): the group forms at pair OPEN, every
 *      membership change and message advances the epoch, nothing sends
 *      before OPEN or after close — both refuse null, fail closed.
 *   4. Ciphertext-only wire — {@link buildOutboundPayload} emits
 *      exactly `{ envelope }` (base64), mirroring the server's
 *      `envelope bytea`; {@link payloadViolations} flags any
 *      plaintext-carrying field, so a "preview" or "snippet" can never
 *      ride along and give the server something to read.
 *   5. Compose path — FR-38's first-message screening MUST run in the
 *      client because the server can no longer see plaintext:
 *      {@link COMPOSE_PIPELINE} pins screen → encrypt → send, and the
 *      screening stage is mandatory exactly when the FR-38 rule says so
 *      (cross-pinned to conversationThread).
 *
 * Framework-free by design: pure TypeScript, so the unit tests run
 * under plain node --test.
 */

import { licenceAllowed } from "./dependencyBudget.js";
import { composeRequiresScreening } from "./conversationThread.js";

/** A candidate MLS provider with its pinned licence set. */
export interface CryptoProvider {
  readonly name: string;
  readonly ecosystem: string;
  readonly licenses: readonly string[];
}

/** TECH-08: exactly the two providers the SRS permits. */
export const ALLOWED_CRYPTO_PROVIDERS: readonly CryptoProvider[] = [
  { name: "OpenMLS", ecosystem: "Rust", licenses: ["MIT", "Apache-2.0"] },
  { name: "vodozemac", ecosystem: "Rust", licenses: ["MIT"] },
];

/** TECH-08: the prohibited provider and the SRS's reason, pinned. */
export const PROHIBITED_CRYPTO_PROVIDERS = ["libsignal"] as const;
export const LIBSIGNAL_PROHIBITION_REASON =
  "AGPL-3.0 conflicts with a closed client";

/**
 * Provider admission, fail closed. A provider passes only when its name
 * is exactly one of the two registered, no prohibited name appears
 * anywhere in it (case-insensitive, so "libsignal-client" or
 * "LibSignal fork" refuse too), and every pinned licence clears the
 * TECH-16 screen — which itself refuses any AGPL marker. Unknown
 * providers refuse: the SRS names the set, it is not open.
 */
export function cryptoProviderAllowed(provider: CryptoProvider): boolean {
  const name = provider.name.toLowerCase();
  if (
    (PROHIBITED_CRYPTO_PROVIDERS as readonly string[]).some((banned) =>
      name.includes(banned.toLowerCase()),
    )
  ) {
    return false;
  }
  if (!ALLOWED_CRYPTO_PROVIDERS.some((allowed) => allowed.name === provider.name)) {
    return false;
  }
  return provider.licenses.every((spdx) => licenceAllowed(spdx));
}

/** FR-36: private keys live in the device keystore, nowhere else. */
export const PRIVATE_KEY_STORAGE = "secure-store";

/** The key-package relay floor: refill before the pool runs dry. */
export const KEY_PACKAGE_REFILL_FLOOR = 10;

/** The upload carries the public key package — one field, never more. */
export const KEY_PACKAGE_UPLOAD_FIELDS = ["keyPackage"] as const;

/**
 * Build the key-package upload. Exactly one field by construction: the
 * type has no room for private material, and blank or garbage packages
 * refuse null rather than uploading noise.
 */
export function buildKeyPackageUpload(
  keyPackage: string,
): { keyPackage: string } | null {
  if (typeof keyPackage !== "string" || keyPackage.trim() === "") return null;
  return { keyPackage };
}

/**
 * True when the key-package pool should be refilled. Garbage counts —
 * NaN, negative, non-finite — fail closed toward refilling: a client
 * that cannot count its packages must assume it has none.
 */
export function keyPackageRefillDue(remaining: number): boolean {
  if (!Number.isFinite(remaining) || remaining < 0) return true;
  return remaining < KEY_PACKAGE_REFILL_FLOOR;
}

/** The MLS group lifecycle, one group per pair. */
export const GROUP_STATES = ["pending", "active", "closed"] as const;
export type GroupState = (typeof GROUP_STATES)[number];

export const EPOCH_EVENTS = [
  "pair-open",
  "member-add",
  "member-remove",
  "message",
  "pair-close",
] as const;
export type EpochEvent = (typeof EPOCH_EVENTS)[number];

export interface GroupEpoch {
  readonly state: GroupState;
  readonly epoch: number;
}

/** A pair starts with no group: pending at epoch zero. */
export function initialGroupEpoch(): GroupEpoch {
  return { state: "pending", epoch: 0 };
}

/**
 * Advance the group. The group forms when the pair opens; membership
 * changes and messages advance the epoch while active; closing the pair
 * seals the group. Anything out of order — a message before the group
 * exists, any event after close, an unknown event — refuses null: an
 * unsendable message is never sent, and a sealed group never reopens.
 */
export function applyEpochEvent(
  group: GroupEpoch,
  event: EpochEvent,
): GroupEpoch | null {
  if (!(EPOCH_EVENTS as readonly string[]).includes(event)) return null;
  if (group.state === "pending") {
    if (event === "pair-open") return { state: "active", epoch: group.epoch + 1 };
    return null;
  }
  if (group.state === "active") {
    if (event === "pair-close") return { state: "closed", epoch: group.epoch + 1 };
    if (event === "pair-open") return null;
    return { state: "active", epoch: group.epoch + 1 };
  }
  return null;
}

/** FR-36: the wire carries exactly the opaque envelope. */
export const OUTBOUND_PAYLOAD_FIELDS = ["envelope"] as const;

/**
 * Fields that would carry plaintext to the server — the FR-36 "server
 * MUST NOT be able to decrypt" boundary made enumerable. Any of these
 * on a payload is a violation, whether populated or not.
 */
export const FORBIDDEN_PLAINTEXT_FIELDS = [
  "body",
  "text",
  "plaintext",
  "preview",
  "snippet",
  "attachment",
] as const;

export interface OutboundPayload {
  readonly envelope: string;
}

/**
 * Build the outbound wire payload: exactly `{ envelope }` (base64
 * ciphertext), mirroring the server's `envelope bytea` column. Blank
 * ciphertext refuses null.
 */
export function buildOutboundPayload(envelopeBase64: string): OutboundPayload | null {
  if (typeof envelopeBase64 !== "string" || envelopeBase64.trim() === "") {
    return null;
  }
  return { envelope: envelopeBase64 };
}

/**
 * Audit a wire payload against the ciphertext-only contract: unknown
 * fields, plaintext-carrying fields, and a missing or blank envelope
 * are all violations. An empty list means the server sees only
 * ciphertext.
 */
export function payloadViolations(payload: Record<string, unknown>): string[] {
  const violations: string[] = [];
  for (const field of Object.keys(payload)) {
    if ((FORBIDDEN_PLAINTEXT_FIELDS as readonly string[]).includes(field)) {
      violations.push(`plaintext:${field}`);
    } else if (!(OUTBOUND_PAYLOAD_FIELDS as readonly string[]).includes(field)) {
      violations.push(`field:${field}`);
    }
  }
  const envelope = payload.envelope;
  if (typeof envelope !== "string" || envelope.trim() === "") {
    violations.push("envelope");
  }
  return violations;
}

/**
 * FR-38 in the MLS world: the server cannot screen ciphertext, so the
 * first-message classifier runs in the client compose path — BEFORE
 * encryption. The stage order is pinned and must never invert: once a
 * message is encrypted the client has nothing left to screen.
 */
export const COMPOSE_PIPELINE = ["screen", "encrypt", "send"] as const;

/**
 * The compose plan for one outgoing message: the pinned pipeline with
 * the screening stage mandatory exactly when FR-38 requires it (the
 * sender's first message to the pair — cross-pinned to
 * conversationThread).
 */
export interface ComposePlan {
  readonly stages: readonly string[];
  readonly screening: "required" | "not-required";
}

export function planCompose(sentCount: number): ComposePlan {
  return {
    stages: COMPOSE_PIPELINE,
    screening: composeRequiresScreening(sentCount) ? "required" : "not-required",
  };
}

/**
 * The TECH-08 contract as an executable check:
 *
 *  - the registry is exactly the two SRS providers, both admissible;
 *  - libsignal refuses by name (including lookalike forks) AND by its
 *    AGPL licence marker;
 *  - private keys are pinned to the device keystore;
 *  - the upload and wire payloads are single-field by construction and
 *    the audits flag plaintext fields;
 *  - the epoch machine forms at open, advances while active, refuses
 *    before open and after close;
 *  - the compose pipeline screens before it encrypts, and screening is
 *    required exactly when FR-38 says so.
 */
export function e2eCryptoHonoursTech08(): boolean {
  if (ALLOWED_CRYPTO_PROVIDERS.length !== 2) return false;
  if (!ALLOWED_CRYPTO_PROVIDERS.every(cryptoProviderAllowed)) return false;
  if (
    cryptoProviderAllowed({ name: "libsignal", ecosystem: "C", licenses: ["AGPL-3.0"] })
  ) {
    return false;
  }
  if (
    cryptoProviderAllowed({
      name: "libsignal-client",
      ecosystem: "C",
      licenses: ["MIT"],
    })
  ) {
    return false;
  }
  if (
    cryptoProviderAllowed({ name: "OpenMLS", ecosystem: "Rust", licenses: ["AGPL-3.0"] })
  ) {
    return false;
  }
  if (LIBSIGNAL_PROHIBITION_REASON !== "AGPL-3.0 conflicts with a closed client") {
    return false;
  }
  if (PRIVATE_KEY_STORAGE !== "secure-store") return false;

  // Key packages: single-field upload, pinned floor, garbage refills.
  if (KEY_PACKAGE_UPLOAD_FIELDS.length !== 1) return false;
  const upload = buildKeyPackageUpload("kp.abc123");
  if (upload === null || Object.keys(upload).join(",") !== "keyPackage") return false;
  if (buildKeyPackageUpload("") !== null) return false;
  if (KEY_PACKAGE_REFILL_FLOOR !== 10) return false;
  if (!keyPackageRefillDue(KEY_PACKAGE_REFILL_FLOOR - 1)) return false;
  if (keyPackageRefillDue(KEY_PACKAGE_REFILL_FLOOR)) return false;
  if (!keyPackageRefillDue(Number.NaN)) return false;

  // Epoch machine: form at open, advance while active, refuse otherwise.
  let group = initialGroupEpoch();
  if (applyEpochEvent(group, "message") !== null) return false;
  group = applyEpochEvent(group, "pair-open") as GroupEpoch;
  if (group.state !== "active" || group.epoch !== 1) return false;
  group = applyEpochEvent(group, "message") as GroupEpoch;
  if (group.epoch !== 2) return false;
  group = applyEpochEvent(group, "member-add") as GroupEpoch;
  if (group.epoch !== 3) return false;
  group = applyEpochEvent(group, "pair-close") as GroupEpoch;
  if (group.state !== "closed") return false;
  if (applyEpochEvent(group, "message") !== null) return false;
  if (applyEpochEvent(group, "pair-open") !== null) return false;

  // Wire payload: exactly the envelope; plaintext fields flagged.
  if (OUTBOUND_PAYLOAD_FIELDS.length !== 1) return false;
  const payload = buildOutboundPayload("Y2lwaGVydGV4dA==");
  if (payload === null) return false;
  if (payloadViolations({ ...payload }).length !== 0) return false;
  if (buildOutboundPayload("  ") !== null) return false;
  if (
    payloadViolations({ envelope: "YQ==", preview: "hi" }).join(",") !==
    "plaintext:preview"
  ) {
    return false;
  }
  if (payloadViolations({}).join(",") !== "envelope") return false;

  // Compose path: screen before encrypt, required exactly per FR-38.
  if (COMPOSE_PIPELINE.join(",") !== "screen,encrypt,send") return false;
  if (COMPOSE_PIPELINE.indexOf("screen") >= COMPOSE_PIPELINE.indexOf("encrypt")) {
    return false;
  }
  if (planCompose(0).screening !== "required") return false;
  if (planCompose(1).screening !== "not-required") return false;
  return true;
}

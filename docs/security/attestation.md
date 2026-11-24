# Device attestation (FR-51 / SEC-19)

Every account must pass platform device attestation before it can appear in
discovery, and every new account must pass it before it can appear in another
user's results. This document is the protocol reference and the SEC-19
fallback procedure.

## Protocol

1. **Challenge** — `POST /v1/devices/attestation-challenge` mints a 256-bit
   single-use challenge (Valkey, 120-second TTL, one outstanding per
   account).
2. **Assertion** — the client signs `sha256(challenge:userId)` with its
   platform attestation key (App Attest on iOS, Play Integrity on Android;
   ECDSA P-256) and enrols via `POST /v1/devices` with
   `{ attestation: { platform, publicKey, counter, signature } }`.
3. **Verification** — the edge consumes the challenge (single-use) and
   verifies the signature against the presented SPKI. The monotonic
   `counter` is enforced inside `register_verified_attestation()`: a
   regressed or repeated counter is a replay and never honours the write.
4. **Registry** — verified keys land in `attestation_keys` with
   `verified_at` set. The FR-07 dedupe semantics are unchanged: a key
   already bound to another account is recorded for moderation and the
   client still sees the neutral 201.

Enrolment without the `attestation` object remains accepted for legacy
clients (assertion header only), but the key is unverified and the account
stays **discovery-ineligible** until it completes a verified enrolment.

## Discovery gate

The match service reads profiles through the `attested_accounts` view —
verified keys plus approved fallback waivers, account ids only. An account
outside the view has no profile as far as the corpus is concerned: it
cannot appear in scan results. The gate is evaluated at profile fetch time,
so a revoked key or revoked waiver removes the account from results on the
next 60-second corpus refresh.

## Fallback (SEC-19)

Devices that genuinely cannot attest (damaged secure enclave, unsupported
hardware) are approved manually:

1. the user contacts support; a moderator reviews the account;
2. `POST /v1/moderation/attestation-fallbacks/:userId` approves the waiver —
   one open waiver per account, written into `attestation_fallbacks` with
   the moderator subject, audited via `admin_audit`;
3. `DELETE /v1/moderation/attestation-fallbacks/:userId` revokes it — the
   account drops out of `attested_accounts` immediately and out of results
   within one corpus refresh.

The fallback is deliberately a moderation action, never a client-facing
self-service: the waiver exists so honest users are not locked out, not so
the check can be opted out of.

## Session revocation (SEC-02)

Consumer-realm access tokens live 5 minutes. Because passive expiry cannot
meet the 60-second revocation budget, revocation is active: deleting a
device (or a moderator action on its attestation key) writes the Valkey
denylist key `revoked:dev:{deviceId}` before the route replies, and the
edge's authenticate hook denies any request presenting that device id. The
end-to-end propagation contract is exercised by
`scripts/revocation_drill.py` (budget: 60 seconds).

## Push payloads (FR-56)

Push notifications carry only `{ type, ref }` — a notification type and one
opaque identifier — delivered as an APNs background push or an FCM data
message. No profile content, reason text, handle or location ever leaves
the server in a push payload; the client renders localised strings from
`type`. Dead tokens reported by the provider are dropped via
`drop_push_token()`.

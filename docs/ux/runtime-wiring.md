# Client runtime wiring (AMD-CRT-01..04)

Batch 66 wires the batch-65 connectivity contracts into a runtime: four
modules, each framework-free with injected effects, each pinned by
`client/test/runtimeWiring.test.ts`.

## AMD-CRT-01 — the API client (`client/src/presence/apiClient.ts`)

The single HTTP chokepoint. Every request flows through it:

- **Headers** — bearer + FR-05 device id (`session.ts`), the TR-27
  `x-client-version`, and on mutations an `Idempotency-Key` minted
  BEFORE the first byte flies.
- **Observation** — every outcome feeds the AMD-NET-03 classifier
  (round-trip on success, failure otherwise). The classifier eats real
  traffic, never synthetic pings.
- **Reads** — network first; a network failure is reported as exactly
  that so the caller falls back to the AMD-NET-02 read cache with the
  staleness marker, never silently.
- **Mutations** — offline enqueues straight into the AMD-NET-01 outbox;
  a wire failure after a send enqueues THE SAME request with THE SAME
  idempotency key (`OutboxDraft.idempotencyKey`) — the server sees one
  logical action whether or not the first attempt landed.
- **401** — the exactly-one-refresh-retry discipline, re-exported
  through the chokepoint so callers never reach past it.

## AMD-CRT-02 — the session runtime (`client/src/presence/sessionRuntime.ts`)

Proactive refresh, so a member mid-session never hits a 401 on a tap:

- scheduled at `refreshDueAtMs` (REFRESH_MARGIN_S before expiry);
- bounded — at most REFRESH_ATTEMPTS attempts on the AMD-NET-03
  full-jitter schedule, proven to fit inside the margin;
- rotation-safe — `refreshedSession` keeps the previous refresh token
  unless the realm rotated a replacement (SEC-02);
- single-flight — the coordinator joins concurrent refreshers (the
  proactive timer AND any reactive 401) on ONE in-flight realm call;
- honest exhaustion — a spent schedule says "reauthenticate".

## AMD-CRT-03 — the outbox pump (`client/src/presence/outboxPump.ts`)

When drains run and who may run them:

- **Triggers** — enqueue-due, foreground, connectivity promotion out of
  offline, session-resumed after the 401 pause, wake timer.
- **Single-flight** — concurrent kicks join the in-flight cycle; a kick
  mid-flight marks the cycle dirty and exactly one follow-up pass runs.
  A venue-full of foreground events produces one drain.
- **Persistence** — the queue is written after every pass whose
  serialization changed (ack, backoff, poison, pause all mutate); a
  crash between cycles loses nothing. An untouched queue is not
  rewritten.
- **Offline** — kicks are skipped, never buffered: enqueueing is the
  offline story (`pumpAllowed`).
- **Next wake** — `nextWakeAtMs` hands the caller the backoff wake
  moment (poisoned entries never schedule one); the pump owns no timers.

## AMD-CRT-04 — the realtime adapter (`client/src/presence/realtime.ts`)

Centrifugo, gated by the link:

- **Configured or off** — `realtime.wsUrl` arrives in the bootstrap
  config (GET /v1/client/config); empty means no realtime tier and the
  adapter never connects.
- **Token-bound** — POST /v1/realtime/token (edge `realtimeToken.ts`)
  issues an HS256 JWT, 600 s, `channels` claim scoped to the member's
  own user channel plus open pair channels. The edge answers 503 when
  CENTRIFUGO_TOKEN_HMAC_SECRET_KEY is unconfigured (the AMD-PAY-16
  discipline). The adapter refreshes the token 60 s before expiry and
  subscribes ONLY to granted channels — the privacy boundary is
  enforced on both sides.
- **Link-gated** — offline disconnects immediately; degraded keeps the
  socket but the subscription plan may only add (never churn); online
  is full reconciliation.
- **Bounded reconnect** — full-jitter backoff, base 1 s, cap 60 s.
- **Dependency** — the `centrifuge` npm package (MIT) was admitted
  through the TECH-16 gate with an 8 MB ledger allocation covering its
  protobufjs/events subtree (~7.6 MB measured): runtime dependencies
  7 → 8, ledger 31 → 39 MB against the 45 MB cap, SEC-18 allowlist
  entry recorded.

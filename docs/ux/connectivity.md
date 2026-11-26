# Connectivity UX — designing for the last mile (AMD-NET-01..05)

The member this platform is for is on a contested 2G/3G link. This note
is the design contract for how every surface behaves when the network is
slow, lossy, or absent — degrade deliberately, never fail open, never
lie about freshness.

## The five mechanisms

| Mechanism | Module | What the member sees |
|---|---|---|
| AMD-NET-01 action outbox | `client/src/presence/outbox.ts` | Taps always "take". A badge counts pending sends; poisoned actions are surfaced for review, never silently dropped. |
| AMD-NET-02 bounded read cache | `client/src/presence/readCache.ts` | Reopening the app in a dead zone shows the last known scan, conversations, and nearby venues — marked "Last updated …", never presented as live. |
| AMD-NET-03 connectivity classifier | `client/src/presence/connectivity.ts` | A banner appears on degraded links and offline states — and disappears only after the link has proven itself with two healthy probes. |
| AMD-NET-04 wire efficiency | `services/edge` (compression + conditional config) | Smaller transfers; a config revalidation costs one round trip. |
| AMD-NET-05 transfer budgets | `client/src/presence/transferBudget.ts` | (Invisible when it works.) Payloads are sized in CI against the `edge2g` profile so surfaces stay usable on 2G. |

## Rules for surface designers

1. **State-changing taps go through the outbox.** Never fire-and-forget
   a POST from a button handler. The outbox mints the idempotency key at
   enqueue time, so a retry can never double-apply.
2. **Cached data is always marked.** Anything rendered from the read
   cache carries its `cachedAtMs` as "Last updated {time}"
   (`ui.connectivity.staleCopy`). Stale truth presented as live truth is
   a dark pattern.
3. **Respect the feature gate.** `featureGateForLink` returns
   `full | reduced | none`. `reduced` means no imagery prefetch and no
   background sync; `none` means the outbox and the cache ARE the
   surface. Do not pretend a dead link is live.
4. **Banners follow hysteresis.** The classifier demotes fast and
   promotes slowly on purpose — do not add your own flapping indicators
   on top of individual request failures.
5. **Budgets are enforced in CI, not in reviews.** If your feature
   grows a payload past its AMD-NET-05 budget (`scan` 8 s, `publish`
   4 s, `configBootstrap` 6 s, `configRevalidate` 1 RTT, `message` 6 s —
   all on the `edge2g` 50 kbps / 1200 ms RTT profile), the build fails.
   Shrink the payload; do not raise the budget without an SRS amendment.

## Copy keys

`ui.connectivity.offline`, `ui.connectivity.degraded`,
`ui.connectivity.outboxPending`, `ui.connectivity.staleCopy`,
`ui.connectivity.poisonPrompt` — see `client/src/presence/copyRegistry.ts`.

## Privacy boundary

The outbox and the read cache are the ONLY connectivity-related
persistence, and they sit on the TR-30 allowlist
(`presence.outbox.queue`, `presence.cache.read`) — the logout and duress
wipes clear them by construction. There is still no location history, no
contact cache, and no analytics blob on the device.

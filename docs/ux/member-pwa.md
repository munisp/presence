# Member PWA — the lite web client (AMD-PWA-01..06)

The installable lite client for members on low-end devices, shared
handsets, or no-install contexts. Zero runtime dependencies: contract
modules compile straight to browser ESM and the render half is a thin
DOM layer. Served same-origin through nginx/APISIX (`app.presence.example`
host route, `/v1/*` proxied to the edge) — no CORS surface anywhere.

## Sign-in (AMD-PWA-02)

Authorization code + PKCE (S256) against the **consumer** realm as the
dedicated public client `presence-web`. The consumer browser flow is
passkey-only, so members authenticate phishing-resistant by default.
Tokens live in **memory only** — a reload signs you out by construction;
only the PKCE transaction crosses the redirect in sessionStorage. A 401
anywhere ends the session with an honest notice.

## Home (AMD-PWA-03)

One fan-out across the member's own read models — identity, KYC status,
consent pairs, wallets. Partial failure is per-section: 404 is a normal
state (identity not set up yet), network failure falls back to the read
cache marked stale. The attention model orders what needs the member
first (a wave awaiting an answer, a mutual pair ready to open, KYC,
held funds) and drives the app badge where the Badging API exists.

## Offline-honest (AMD-PWA-04)

The native connectivity pack, mirrored for the web:

- **Classifier** — request observations (EMA RTT > 1,500 ms or > 25%
  failures over eight degrades; two consecutive failures goes offline)
  plus `navigator.onLine`; two healthy probes to promote (hysteresis).
- **Read cache** — exactly five allowlisted documents, wholesale
  replace, TTL staleness marking, 128 KiB cap, corrupted reads absent.
- **Outbox** — FIFO, single-flight, idempotency key minted at enqueue,
  ack on 2xx only, 401 pauses, 4xx poisons, 5xx retries with full-jitter
  backoff; a full queue refuses loudly.

The service worker NEVER caches `/v1/*` — member data caching is the
explicit app-layer read cache, not an SW side effect.

## Installability and updates (AMD-PWA-05)

Manifest with 192/512/maskable icons, standalone display. The service
worker is network-first for navigations AND for the unhashed code/config
bundle (cache-first would mask every republish), cache-first only for
icons, and activates updates immediately with a once-guarded reload.

## Privacy self-service (AMD-PWA-06)

DSAR export as a JSON download, device list with per-device revoke, and
account deletion armed only by typing `DELETE`. Sign-out and deletion
wipe every persisted key (PKCE transaction, read cache, outbox) from
every storage the shell touches — a shared handset keeps nothing.

## Local development

```bash
npm ci --prefix pwa
npm test --prefix pwa          # tsc build + node --test
docker compose -f deploy/docker-compose.yml up pwa   # http://localhost:8081
```

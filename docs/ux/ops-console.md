# Operations console (AMD-CON-01..06, batch 67)

The workforce console is the platform's sixth deployable: an installable PWA
for the people who operate Presence — moderators, venue-ops, analysts. It is
deliberately **zero-runtime-dependency**: the contract modules under
`console/src/` compile with `tsc` straight to native browser ESM (no bundler,
no framework), and the render half (`console/web/app.ts`) is a thin DOM layer
that only binds those modules to the document. The TECH-16 dependency gate
has nothing to admit.

## Layout

| Path | Role |
| --- | --- |
| `console/src/oidc.ts` | AMD-CON-02: PKCE authorization-code flow against the workforce realm; tokens in memory only |
| `console/src/consoleApi.ts` | AMD-CON-03: the one transport chokepoint — bearer, Idempotency-Key minted before send, 10 s timeout, typed 401/403 |
| `console/src/surfaces.ts` | AMD-CON-01: the section tree and role visibility map (UX filter only — the edge re-checks) |
| `console/src/dashboard.ts` | AMD-CON-03: the 403-tolerant overview fan-out with 60 s freshness |
| `console/src/queues.ts` | AMD-CON-04: the unified worklist and the governed-vocabulary action guards |
| `console/src/geofenceEditor.ts` | AMD-CON-05: the GeoLibre polygon-editing geometry contract |
| `console/src/pwa.ts` | AMD-CON-06: manifest validation and the service-worker update model |
| `console/web/app.ts` | The thin DOM render half (hash routing, SVG editor canvas) |
| `console/public/` | The static shell: `index.html`, `styles.css`, `sw.js`, `manifest.webmanifest`, `config.json`, icons |
| `console/test/opsConsole.test.ts` | The 25-test contract suite (`npm test --prefix console`) |

## Sign-in (AMD-CON-02)

Authorization code + PKCE (S256) against the Keycloak workforce realm as the
public client `workforce-console` (already in `deploy/keycloak/realm-workforce.json`
with the `ops.presence.example` and `localhost:8082` redirect URIs). Tokens
live in **memory only** — a reload signs the operator out, deliberately: an
XSS payload cannot exfiltrate what is not persisted. Only the PKCE
transaction (state + verifier — not a credential) crosses the redirect via
sessionStorage. A 15 s loop refreshes inside the 30 s margin; any 401 ends
the session visibly.

Environment wiring is `public/config.json` (issuer, clientId, redirectUri,
apiBase) — the k8s `console-config` ConfigMap pins the production values.
One deployment note: the edge verifies workforce tokens against the issuer
it is configured with — the realm's public issuer URL (frontendUrl) and the
edge's `KEYCLOAK_ISSUER` for the workforce realm must agree, exactly as the
consumer realm already does with `KEYCLOAK_PUBLIC_ISSUER_URL`.

## Same-origin, no CORS (AMD-CON-01)

The console and the API share an origin in every topology:

- **compose dev**: `console` nginx proxies `/v1/` to `edge:4000` — the
  console is on `http://localhost:8082`;
- **k8s**: APISIX host-matches `ops.presence.example` to the console service
  while the longer-prefix `/v1/*` route still lands on the edge;
- the console's own nginx also proxies `/v1/` in-cluster as a direct path.

The edge has no CORS surface, and none is added. The network policy admits
the console from APISIX only; its egress allowlist is exactly the edge.

## Surfaces

- **Overview** — queue depths with a live/stale marker (stale past 60 s).
- **Reports / Appeals** — resolve with the governed outcome + reason-code
  vocabulary; an overturned appeal lifts the suspension server-side in the
  same transaction.
- **KYC review** — read-only queue surface; verdicts arrive over the signed
  OpenKYC webhook (AMD-KYC-09). The console does not decide identity.
- **Onboarding** — approve / reject with a mandatory rejection reason.
- **Elevation** — approve / reject / revoke JIT grants.
- **Geofences** — the estate QA report plus the GeoLibre polygon editor
  (geometry-only until the AMD-MAP tile surface lands; density and overlap
  are re-verified server-side at draft and publish).
- **Security events** — the SEC-30/36 audit surface, kind-filtered.

## PWA discipline (AMD-CON-06)

Installable (192/512/maskable icons, standalone). The service worker
precaches the shell, serves navigations network-first, serves the unhashed
code bundle and config network-first with a cache fallback (a zero-build
bundle carries no content hash, so cache-first would mask every republish),
caches only the content-stable icons cache-first, never caches `/v1/*`, and
activates updates immediately
(`skipWaiting` + `clientsClaim`, once-guarded reload). The shell version is
one constant cross-pinned between `public/sw.js` and `src/pwa.ts`
(`CONSOLE_SW_VERSION`) — bump it to ship an update.

# Client authentication (FR-01)

Passkey-only sign-in for the consumer app. The SRS acceptance is
release-blocking: a platform passkey is created during onboarding and **no
password is ever set**; a second device enrols only through an existing
authenticated device or a recovery code.

## Architecture

The passkey ceremony runs where platform authenticators already live — in
the **system browser** (ASWebAuthenticationSession on iOS, a Custom Tab on
Android) — against the passkey-only `consumer` Keycloak realm (TECH-07).
The realm's `consumer passkey browser` flow requires a passwordless
WebAuthn authenticator (platform authenticator, user verification
required, resident keys) and enrols one via the
`webauthn-register-passwordless` required action. Passwords are not
merely discouraged: they are absent from the flow, so the client can never
accidentally present a password surface.

The app therefore needs **no raw WebAuthn native dependency**. It speaks
OpenID Connect Authorization Code + PKCE (S256) and receives the redirect:

```
app                        system browser                    Keycloak (consumer)
 |  1. GET /v1/client/config  |                                   |
 |<----- auth:{issuer,clientId} ------ (unauthenticated bootstrap)|
 |  2. beginAuthorization: verifier, state, S256 challenge        |
 |-------------------------- authorize?...&code_challenge ------->|
 |                             |  passkey ceremony (create/get)   |
 |<---------- presence://auth/callback?code=…&state=… ------------|
 |  3. parseCallback: state must match (fail closed)              |
 |-------------------------- token (code + code_verifier) ------->|
 |<--------------------- access(300s) + refresh + id -------------|
 |  4. POST /v1/devices (attestation-gated enrolment, FR-05)      |
 |  5. persist refresh token (secure store, TR-30 allowlist)      |
```

## The two-URL rule

The edge verifies tokens against the **in-cluster** issuer
(`KEYCLOAK_ISSUER`). A phone cannot resolve an in-cluster name, so the
bootstrap config carries the **device-reachable** issuer separately:

| Env | Consumer | Example (prod) | Example (compose) |
|---|---|---|---|
| `KEYCLOAK_ISSUER` | edge (JWKS verification) | `https://auth.presence.example/realms/consumer` | `http://keycloak:8080/realms/consumer` |
| `KEYCLOAK_PUBLIC_ISSUER_URL` | app (sign-in) | `https://auth.presence.example/realms/consumer` | `http://localhost:8080/realms/consumer` |
| `KEYCLOAK_CLIENT_ID` | app (sign-in) | `presence-app` (realm-exported default) | same |

Both URLs name the same realm; the split exists so the edge and the device
each use the address they can reach. On Android emulators the host machine
is `10.0.2.2`, so the dev issuer becomes
`http://10.0.2.2:8080/realms/consumer`. The bootstrap values are public —
client ids and issuer URLs are not credentials.

## Client modules (client/src/presence/)

- **`authFlow.ts`** — the ceremony's pure logic. Builds the authorize /
  token / refresh / logout requests, derives the S256 challenge with the
  in-repo pure-TypeScript SHA-256 (Hermes ships no crypto primitives; a
  native crypto package would add a SEC-18 allowlist entry for one
  digest), and parses the callback **fail-closed**: a state mismatch is a
  rejection, never a best-effort sign-in. Randomness is injected
  (`RandomSource`) because Hermes has no `crypto.getRandomValues` — the
  platform adapter supplies the CSPRNG, tests a deterministic source.
  `resolveAuthConfig` fails closed on an empty issuer or client id:
  sign-in is *unavailable*, never pointed at a guessed endpoint.
- **`session.ts`** — the token lifecycle. Refresh falls due 30 s before
  the 300 s SEC-02 access-token expiry so one retry window fits inside
  the remaining life; a 401 earns **exactly one** refresh-and-retry, and a
  second 401 is re-authentication, never a retry loop. Refresh responses
  may rotate the refresh token — the old one is kept only when the
  response omits a replacement. The refresh token is the only persisted
  credential, under the TR-30 allowlisted key
  `presence.session.refreshToken` in the platform secure store. Every
  authed call carries `Authorization` plus the FR-05 `x-device-id`, so
  server-side revocation (SEC-02) denies a revoked device inside its
  60-second budget.

## Logout order (FR-19)

Pinned in `LOGOUT_PIPELINE` and executed by `executeLogout`:

1. **Withdraw presence first** — `DELETE /v1/presence` needs a still-valid
   access token, and the FR-19 withdrawal contract does not wait for the
   IdP round-trip.
2. **RP-initiated logout** — `id_token_hint` +
   `post_logout_redirect_uri=presence://auth/logout` ends the IdP session;
   without it the next authorize would silently re-log-in.
3. **TR-30 wipe last** — `clearLocalState` clears every allowlisted key by
   construction.

## The second device (FR-01)

A second device completes this same sign-in (its own passkey ceremony in
its own system browser), then enrols through the attestation-gated
`POST /v1/devices` (docs/security/attestation.md). The `device_cap()`
trigger rejects a fourth active device, and enrolment is always anchored
on an authenticated session — there is no unauthenticated enrolment path.
The recovery path is the SEC-09 recovery phone (`PUT
/v1/account/recovery-phone`, HMAC-SHA256 at rest), never a password
reset — there is no password to reset.

## Realm contract (deploy/keycloak/realm-consumer.json)

The `presence-app` client is a **public** client: standard flow enabled,
direct access grants **disabled**, PKCE pinned to S256, redirect URIs
`presence://auth/callback` (+ the localhost dev URI), post-logout redirect
`presence://auth/logout`. Access tokens live 300 s (SEC-02). Changing a
redirect URI on either side without the other breaks sign-in — the client
pins both URIs as constants and the unit tests assert them against the
realm export.

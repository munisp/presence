# Keycloak realms (ARC-002 §8.2, TECH-07)

Three realms, imported automatically by the compose stack (`start-dev
--import-realm` reads this directory):

| Realm | Population | Policy |
|---|---|---|
| `consumer` | app users | Passkeys primary (platform authenticator, user verification required), passwords disabled, 5-min access tokens (SEC-02); SMS recovery is configured per market at launch (SEC-09: server-side storage is a keyed hash only — `PUT /v1/account/recovery-phone` → HMAC-SHA256 in `recovery_phones`, migration 0015; no phone number ever lands in a Keycloak attribute or a plaintext column) |
| `workforce` | moderators, taxonomists, venue ops | Hardware (cross-platform) second factor with user verification required; realm roles `moderator`, `taxonomist`, `venue-ops`, `elevation-eligible`; 4-hour session ceiling is the JIT elevation bound (SEC-03) |
| `partners` | venue dashboards, event organisers | `venue-manager` / `event-organiser` roles; SAML/OIDC federation is configured per partner at onboarding (`identityProviders` is intentionally empty in the export); partner provisioning exports use SCIM-shaped payloads from the partner service — Keycloak itself does not serve SCIM |

The edge verifies consumer-realm RS256 tokens against the realm JWKS when
`KEYCLOAK_ISSUER` is set (e.g. `http://keycloak:8080/realms/consumer` in
compose). With the variable unset it falls back to the shared HS256 dev
secret so unit tests and offline runs stay self-contained (ADR-0003).

Known follow-ups, recorded honestly:

- The passkey-only browser flow (WebAuthn passwordless authenticator
  replacing the username/password form) is a flow binding on top of this
  import; the policy knobs above are imported, the custom flow is wired when
  onboarding screens land (FR-01/FR-02).
- Admin console in dev: http://localhost:8080 (admin / p0-dev-admin —
  dev-only credentials, SEC-28).

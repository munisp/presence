# Keycloak realms (ARC-002 §8.2, TECH-07)

Three realms, imported automatically by the compose stack (`start-dev
--import-realm` reads this directory):

| Realm | Population | Policy |
|---|---|---|
| `consumer` | app users | Passkeys only (platform authenticator, user verification required, resident keys) — the imported `consumer passkey browser` flow replaces the username/password form entirely (`browserFlow` binding: `auth-cookie` ALTERNATIVE + `webauthn-authenticator-passwordless` REQUIRED); new accounts enrol a passkey via the `webauthn-register-passwordless` default required action; passwords are disabled, 5-min access tokens (SEC-02); SMS recovery is configured per market at launch (SEC-09: server-side storage is a keyed hash only — `PUT /v1/account/recovery-phone` → HMAC-SHA256 in `recovery_phones`, migration 0015; no phone number ever lands in a Keycloak attribute or a plaintext column) |
| `workforce` | moderators, taxonomists, venue ops | Hardware (cross-platform) second factor with user verification required; realm roles `moderator`, `taxonomist`, `venue-ops`, `elevation-eligible`; administrative access is just-in-time (SEC-03): an `elevation-eligible` member requests a time-boxed grant, a DIFFERENT moderator approves it (four-eyes), and the grant expires automatically inside the 4-hour session ceiling — migration 0022 is the source of truth, the edge replays the grant window into this realm via the Admin API (see below), docs/security/elevation.md |
| `partners` | venue dashboards, event organisers | `venue-manager` / `event-organiser` roles; SAML/OIDC federation is configured per partner at onboarding (`identityProviders` is intentionally empty in the export); partner provisioning exports use SCIM-shaped payloads from the partner service — Keycloak itself does not serve SCIM |

The edge verifies consumer-realm RS256 tokens against the realm JWKS when
`KEYCLOAK_ISSUER` is set (e.g. `http://keycloak:8080/realms/consumer` in
compose). With the variable unset it falls back to the shared HS256 dev
secret so unit tests and offline runs stay self-contained (ADR-0003).

## SEC-03 role binding (automated)

The edge replays approved elevation grants into the workforce realm through
the Admin API (`services/edge/src/keycloakAdmin.ts`, env-gated): approve →
add the `moderator` realm role; revoke/expiry → remove it. Configure a
service-account client (one-time per environment) and hand its credentials
to the edge via `KEYCLOAK_ADMIN_CLIENT_ID` / `KEYCLOAK_ADMIN_CLIENT_SECRET`:

```
kcadm.sh create clients -r workforce -f - <<'JSON'
{ "clientId": "presence-edge-admin", "enabled": true,
  "publicClient": false, "serviceAccountsEnabled": true,
  "standardFlowEnabled": false, "directAccessGrantsEnabled": false }
JSON
kcadm.sh add-roles -r workforce --uusername service-account-presence-edge-admin \
  --cclientid realm-management --rolename manage-users --rolename view-users
```

Without those variables the binding is a documented no-op (compose/dev):
the Postgres grant record stays authoritative and operators bind manually
in the admin console. The Admin API mapping calls are idempotent, so a
missed bind is repaired by the next transition.

## SMS recovery contract (TECH-07)

Recovery is deliberately NOT a second factor that weakens the passkey-only
flow. The account-recovery path is: verified recovery phone (SEC-09 keyed
hash) → per-market SMS one-time code → passkey re-enrolment required action.
Keycloak ships no SMS authenticator, so the code check is a deployment
binding: an authenticator SPI implementing the market's SMS gateway is
dropped into `/opt/keycloak/providers` and referenced by a `consumer
recovery` flow override. The SPI contract: verify the code against the
gateway, then complete with the `webauthn-register-passwordless` required
action — the old passkey is invalidated by device revocation (SEC-02)
before recovery begins.

Known follow-ups, recorded honestly:

- Admin console in dev: http://localhost:8080 (admin / p0-dev-admin —
  dev-only credentials, SEC-28).

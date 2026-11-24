# Consumer authentication — NIST SP 800-63B AAL2 conformance (SEC-01)

The consumer realm authenticates users at NIST SP 800-63B **AAL2**. This
document is the conformance evidence: every AAL2 requirement is mapped to
the control that satisfies it, and the controls are pinned to the realm
export by automated assertions (tests/test_batch31.py) so a configuration
drift fails CI rather than silently downgrading the assurance level.

## Authenticator model

AAL2 requires proof of possession and control of two distinct
authentication factors. The platform satisfies this with a **passkey on a
platform authenticator**: the private key never leaves the device's secure
element (something you have), and every ceremony requires user
verification — biometric or device PIN (something you are / know). NIST
SP 800-63B §4.2.1 explicitly counts a user-verifying platform
authenticator as meeting AAL2 (a single physical authenticator that
unlocks a cryptographic key via biometric/PIN constitutes two factors).

Realm controls (`deploy/keycloak/realm-consumer.json`):

| AAL2 requirement | Control |
|---|---|
| Phishing-resistant authentication | WebAuthn ceremonies are origin-bound; the RP id is pinned (`webAuthnPolicyPasswordlessRpId`) |
| User verification REQUIRED | `webAuthnPolicyPasswordlessUserVerificationRequirement: "required"` |
| Hardware-bound key | `webAuthnPolicyPasswordlessAuthenticatorAttachment: "platform"` |
| Discoverable credential | `webAuthnPolicyPasswordlessRequireResidentKey: "Yes"` |
| Approved cryptography | `webAuthnPolicyPasswordlessSignatureAlgorithms: ["ES256", "RS256"]` |
| No knowledge-factor fallback | the imported `consumer passkey browser` flow contains **no** `auth-username-password-form` execution — there is no password path to downgrade to |
| Enrolment discipline | `webauthn-register-passwordless` is a default required action: every new account binds a passkey at first login |

## Verifier controls

| AAL2 requirement | Control |
|---|---|
| Verifier impersonation resistance | RS256 bearer tokens verified against the realm JWKS with the issuer pinned (`KEYCLOAK_ISSUER`); unsigned/HS tokens from outside the dev fallback are never accepted in deployment |
| Replay resistance | PKCE S256 is mandatory on the `presence-app` client; direct access grants are disabled; WebAuthn challenges are single-use by protocol |
| Session / reauthentication | 5-minute access tokens (`accessTokenLifespan: 300`); device revocation propagates within 60 seconds (SEC-02: Valkey denylist checked per request) |
| Online guessing | realm brute-force protection enabled (`bruteForceProtected`) |
| Recovery does not weaken AAL2 | recovery re-enrols a passkey (TECH-07 SMS contract); it never falls back to a knowledge factor, and the previous credential is invalidated by device revocation first |

## Scope note

AAL2 is a property of the authentication infrastructure and the verifier.
The client ceremony binding (passkey enrolment and assertion UX in the
React Native app) is tracked in the client workstream; it changes nothing
about the controls above, which the realm enforces regardless of client.

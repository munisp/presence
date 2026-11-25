# ASVS 4.0.3 L2 / MASVS 2.0 L1 control map (SEC-23)

SEC-23 requires an independent OWASP ASVS 4.0.3 L2 (server) and MASVS 2.0 L1
(client) assessment before launch. This document is the assessor's map: every
control area points at the in-repo mechanism and its evidence, so the
assessment verifies rather than discovers. The third-party assessment itself
remains outstanding — SEC-23 stays external-evidence until the report exists.

## ASVS 4.0.3 L2 (server)

| Chapter | Presence control | Evidence |
|---|---|---|
| V1 Architecture | ARC-002 phases, ADR record, threat-shaped NetworkPolicies, default-deny | `deploy/k8s/`, `docs/adr/` |
| V2 Authentication | Passkey-only consumer flow (WebAuthn UV, resident keys), AAL2 mapping, no knowledge-factor fallback | `deploy/keycloak/realm-consumer.json`, `docs/security/aal2.md` |
| V3 Session | 300 s access tokens, 60 s revocation denylist written before DELETE, one refresh retry | `services/edge` (SEC-02), `client/src/presence/session.ts` |
| V4 Access control | Postgres RLS enforces FR-30 on every table; workforce elevation is JIT, four-eyes, 4 h | `db/migrations/`, SEC-03 |
| V5 Validation | Schema-validated routes, contract tests, coordinate-shaped fields rejected 422 | `docs/api/openapi.yaml`, TR-15/TR-23 |
| V6 Stored crypto | Append-only consent/audit ledgers, keyed-hash recovery phone (HMAC-SHA256), age-encrypted backups with dual-authorised restore | SEC-09, SEC-11 (`deploy/postgres/backup/`) |
| V7 Error/logging | Error envelope contract, scrubbed logs (SEC-29), request ids (NFR-31) | `services/edge/src/errors.ts` |
| V8 Data protection | Minimisation by construction: cells not coordinates, k-suppression, KYC state without documents, DSAR export incl. tombstone-safe transfers | TR-15, BR-13, AMD-KYC, AMD-PAY-09 |
| V9 Communications | TLS 1.3 only, HSTS+CSP, OCSP stapling, cert pinning policy served to clients | TR-26, INF-11, TR-33 |
| V10 Malicious code | Reproducible builds, SBOM + provenance, cosign keyless sign/verify on promote AND rollback | INF-15, SEC-24 |
| V11 Business logic | Consent state machine DB-enforced, transfer transitions DB-enforced with settlement GUC-gated | migrations 0002/0024/0025 |
| V12 Files/resources | No user file upload surface exists except out-of-band photo (post-OPEN); taxonomy content is governed CMS | FR-59 |
| V13 API | Version contract with 426 floor, idempotency keys on mutations, rate limits per user and per IP | TR-27, TR-24, INF-13 |
| V14 Configuration | Secrets via ESO only, gitleaks + CodeQL in CI, sdk allowlist gate, environment separation gate | SEC-28, SEC-25/26, INF-02/03 |

## MASVS 2.0 L1 (client)

| Control | Presence mechanism | Evidence |
|---|---|---|
| MASVS-STORAGE | Allowlisted typed KV only; private keys in secure-store; wipe via the allowlist | `client/src/presence/localState.ts`, TR-30 |
| MASVS-NETWORK | TLS 1.3 + pin policy from the bootstrap config, fail-open anti-bricking rotation | `client/src/presence/certPinning.ts`, TR-33 |
| MASVS-PLATFORM | Permissions degrade-never-dead with a manual-checkin floor; no dead ends | `client/src/presence/permissions.ts`, TR-32 |
| MASVS-AUTH | Auth Code + PKCE S256 in the system browser, randomness injected, fail-closed callback parsing | `client/src/presence/authFlow.ts`, FR-01 |
| MASVS-CODE | Dependency budget with licence allowlist, SDK allowlist gate in CI, reproducible install | `client/src/presence/dependencyBudget.ts`, SEC-18/25 |
| MASVS-RESILIENCE | Device attestation with single-use challenges; rooted/tampered clients excluded from discovery | FR-51/SEC-19, `docs/security/attestation.md` |
| MASVS-PRIVACY | On-device cell computation; precise coordinates never leave the device; ambient surfaces contentless | `client/src/presence/cell.ts`, FR-15 |

## Assessment logistics

- Scope: edge + match services, APISIX config, k8s base, Keycloak realms,
  client contracts; out of scope: P1+ components not yet deployed (TR-40).
- Method: verify-each-row against the evidence column, then penetration test
  per BR-17 (independent pen test is budgeted there).
- Output: the assessor's report is filed as the SEC-23 closing evidence; the
  classification flips only when the report exists.

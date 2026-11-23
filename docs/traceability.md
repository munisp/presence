# Traceability matrix — PRS-SRS-001 v1.0 / PRS-ARC-002

GENERATED ARTEFACT — do not hand-edit. Regenerate with `python3 scripts/build_traceability.py` (SRS §10: the matrix is generated, not hand-maintained).

Total requirements: **306** (283 MUST · 22 SHOULD · 1 MAY per Appendix A).

## Status summary

| Status | Count | Meaning |
|---|---|---|
| implemented | 71 | working in the repo with tests or structural evidence |
| partial | 52 | meaningful part implemented; named gap remains |
| gap-p0 | 74 | ARC-P0 product scope, code not yet built |
| phase-gated | 8 | ARC P1+ component; correctly deferred per TR-40 / ARC-002 §9 |
| client | 36 | requires the React Native client workstream |
| organisational | 34 | legal / process / staffing — not expressible as code |
| external-evidence | 29 | needs production infrastructure or third-party evidence |
| superseded | 2 | superseded by a recorded ADR |

## Per-family breakdown

| Family | implemented | partial | gap-p0 | phase-gated | client | organisational | external-evidence | superseded | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BR | 3 | 4 | 4 | 0 | 0 | 22 | 0 | 0 | 33 |
| FR | 26 | 14 | 43 | 1 | 15 | 1 | 0 | 0 | 100 |
| NFR | 4 | 5 | 3 | 1 | 11 | 0 | 13 | 0 | 37 |
| TR | 20 | 5 | 9 | 4 | 6 | 0 | 0 | 0 | 44 |
| SEC | 5 | 12 | 11 | 1 | 1 | 5 | 3 | 0 | 38 |
| INF | 5 | 4 | 1 | 0 | 0 | 1 | 8 | 1 | 20 |
| TECH | 8 | 7 | 3 | 1 | 3 | 1 | 0 | 1 | 24 |
| ACC | 0 | 1 | 0 | 0 | 0 | 4 | 5 | 0 | 10 |

## BR — Business requirements (§3)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| BR-01 | organisational | — | Single-metro launch with >=3 venues in 2 km — launch-ops gate (ACC-07), not code. |
| BR-02 | organisational | — | Positioning (friendship, not dating) — store copy / onboarding / marketing review; no dating surface exists in code. |
| BR-03 | gap-p0 | — | Age declaration at onboarding, under-18 block, re-verification on escalation — no onboarding flow or age fields yet. |
| BR-04 | organisational | — | Second-city expansion gate on anchor-venue metrics (§2.5 for 3 consecutive weeks). |
| BR-05 | partial | `deploy/keycloak/realm-partners.json` | events table models venue+window; event-scoped instance mode and presence-to-event attribution not wired. |
| BR-06 | organisational | `docs/adr/0007-payments-gated-on-br06.md` | Five sequenced revenue lines only; payments gated per docs/adr/0007. |
| BR-07 | partial | `docs/api/openapi.yaml` | Reports endpoint exists and is ungated; two-tap reachability is client UX (not built); no monetisation gate exists. |
| BR-08 | implemented | — | Structural: no endpoint exposes precise location, pre-OPEN identity, or unconsented data; no paid tier exists to violate it. |
| BR-09 | organisational | — | Per-market local-currency pricing via store billing — monetisation phase. |
| BR-10 | organisational | — | Pilot unit-economics targets (CAC <= EUR6, payback <=4 mo, conversion >=3%). |
| BR-11 | organisational | — | Venue agreement: data-processing roles, signage, escalation, 30-day termination. |
| BR-12 | gap-p0 | `deploy/keycloak/realm-partners.json` | Aggregate-only venue dashboard not built; Keycloak partners realm (P0) is its identity surface. |
| BR-13 | gap-p0 | — | k=11 suppression for venue aggregate figures — lands with the venue dashboard. |
| BR-14 | partial | `deploy/keycloak/realm-workforce.json` | venues.active is checked on scan (immediate effect); suspension fully propagates within the 15-min TTL; venue self-serve suspend endpoint missing. |
| BR-15 | organisational | — | Resourcing: 4 FTE + fractional design/DPO/T&S, 16 weeks to pilot. |
| BR-16 | organisational | — | T&S staffing >=1 moderator per 10k MAU + named escalation path. |
| BR-17 | organisational | — | Budget: build + 12-month run + EUR2M cyber insurance + independent pen test. |
| BR-18 | organisational | — | Named DPO before EU processing, independent of Product/Engineering. |
| BR-19 | organisational | — | DPIA signed before launch; annual or on-material-change review. |
| BR-20 | organisational | — | ToS / Privacy Notice / Community Guidelines / Cookie notice per launch language. |
| BR-21 | partial | — | Taxonomy seed is synthetic (no CC0 content used); per-release provenance record (TR-20) missing. |
| BR-22 | organisational | — | Nominative, descriptive use only; seed uses names without logos/marks; formal legal review outstanding. |
| BR-23 | organisational | — | Register of processing activities + published sub-processor list. |
| BR-24 | organisational | — | Five launch lines / prices / inclusions per §3.6.1. |
| BR-25 | organisational | — | Venue pricing per venue, unmetered. |
| BR-26 | implemented | — | Structural: the scorer reads profile + corpus only; no tier or payment input exists on the match path. |
| BR-27 | implemented | — | Structural: the matcher never receives partner status; per-venue config is limited to threshold/result-count (TR-11). |
| BR-28 | organisational | — | Aggregate-only reporting principle; no revenue line exists yet. |
| BR-29 | organisational | — | Unit-economics model as single source of truth, monthly review. |
| BR-30 | organisational | — | New revenue line requires DPIA + spec revision. |
| BR-31 | organisational | — | Commercial model reviewed vs telemetry at each month close. |
| BR-32 | organisational | — | >20% multi-site discounts modelled pre-signature. |
| BR-33 | gap-p0 | — | Announcement categories as policy + verified-org work category — enforcement code missing (FR-96/97). |

## FR — Functional requirements (§4)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| FR-01 | partial | `deploy/keycloak/README.md` | Consumer realm ships the passkey policy (platform authenticator, user verification required, passwords disabled); edge verifies RS256 via JWKS; passkey-only onboarding flow + RN client pending. |
| FR-02 | implemented | `db/migrations/0003_account_deletion.sql`<br>`deploy/keycloak/README.md`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/presence.ts` | POST /account/age-declaration upserts a birth-year declaration; under-18 sets age_blocked; presence+scan refuse with a neutral 403 (no reason disclosed); boundary fails toward blocking; tested. |
| FR-03 | partial | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | DELETE /v1/account erases in one authenticated call; the <=3-tap journey is client UX, pending with the RN client. |
| FR-04 | implemented | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/src/routes/scan.ts` | delete_account purges envelopes/pairs/blocks/profile/identity synchronously and tombstones the user; the edge strips Valkey presence+suppress+block keys in the same call; ledger actors anonymised after the 90-day hold by lifecycle_tick. |
| FR-05 | gap-p0 | — | <=3 concurrent devices + enrolment notification — device registry arrives with Keycloak device-bound tokens. |
| FR-06 | partial | — | user_identities carries handle + photo gated to OPEN by RLS; display-name default and 140-char bio missing. |
| FR-07 | gap-p0 | — | Duplicate-account detection on attestation key — needs real App Attest / Play Integrity verification. |
| FR-08 | gap-p0 | — | 3-20 interests, searchable <=3-level picker — profile write API missing; picker is client work. |
| FR-09 | gap-p0 | — | Free-text entity linking with per-node confirmation — pgvector linking service (TECH-09) not built. |
| FR-10 | implemented | `presence/matching.py`<br>`services/match/src/engine.ts`<br>`tests/test_matching.py` | Sensitive nodes excluded from vectors, reasons, idf and bonus at build time; covered by engine tests. |
| FR-11 | partial | `presence/matching.py`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts`<br>`services/match/src/store.ts` | Candidates need >=2 interests to be scored; publish-side >=3 enforcement + client explanation missing. |
| FR-12 | implemented | — | Profile and corpus caches refresh on a 60 s loop (TR-05). |
| FR-13 | gap-p0 | — | k-suppressed local popularity per interest — no endpoint. |
| FR-14 | implemented | `docs/api/openapi.yaml`<br>`docs/presence-model.md`<br>`services/edge/src/routes/presence.ts`<br>`services/match/src/store.ts` | 900 s Valkey TTL; stale cell members filtered at read; tested. |
| FR-15 | partial | — | Server rejects coordinate-shaped fields with 422 (TR-15); on-device cell computation is client work. |
| FR-16 | gap-p0 | — | 128-bit per-presence session ids, unlinkable and reuse-rejected — presence is keyed by account id today. |
| FR-17 | gap-p0 | — | Time-boxed intent vocabulary expiring with presence or 60 min, usable as match signal. |
| FR-18 | gap-p0 | — | Global invisible switch — immediate, persistent, no confirmation dialogue. |
| FR-19 | client | — | Background-withdrawal <=60 s is client lifecycle behaviour. |
| FR-20 | implemented | `db/migrations/0001_init.sql`<br>`docs/api/openapi.yaml`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts`<br>`services/match/test/scan.test.ts` | <=3 candidates with ordered reasons; unit + golden tests. |
| FR-21 | implemented | `db/migrations/0001_init.sql`<br>`presence/matching.py`<br>`services/match/src/engine.ts`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts` | Adaptive threshold: (1-5/n)-quantile floored at venue base; tested. |
| FR-22 | partial | `services/match/src/scan.ts`<br>`services/match/src/server.ts` | MMR (lambda 0.7) over reason-node Jaccard; a hard no-shared-primary-reason guarantee is not enforced. |
| FR-23 | implemented | `docs/presence-model.md`<br>`services/edge/src/context.ts`<br>`services/edge/src/lifecycle.ts`<br>`services/edge/src/routes/lifecycle.ts`<br>`services/edge/src/routes/scan.ts` | Canonical suppression keys, 600 s TTL, both directions; tested. |
| FR-24 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/scan.ts`<br>`services/match/src/server.ts` | 6 scans/min per user at the edge; tested. |
| FR-25 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/test/scan.test.ts` | Bands from H3 grid distance only; no metres/bearing/cell ids in responses. |
| FR-26 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts` | Explanatory empty state below 8 discoverable users in scope; tested. |
| FR-27 | implemented | `docs/api/openapi.yaml`<br>`presence/matching.py`<br>`services/match/src/engine.ts` | Ordered reason path in every scan payload; /v1/score re-scores any explicit pair. |
| FR-28 | gap-p0 | — | Density-scaled match budget (3/hr sparse to 1/day crowd) not implemented. |
| FR-29 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0002_offer_lifecycle.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/consent.ts`<br>`services/edge/src/routes/scan.ts` | DETECTED>NUDGED>EXPRESSED>MUTUAL>OPEN enforced by DB trigger; DETECTED recorded on first surfacing; tested. |
| FR-30 | implemented | `db/migrations/0001_init.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/auth.ts`<br>`services/edge/src/routes/consent.ts`<br>`services/edge/src/routes/messages.ts` | Identity RLS-gated to OPEN; verified by policy + edge tests. |
| FR-31 | implemented | `docs/api/openapi.yaml` | One wave per offer via illegal-transition rejection; the wave carries no content. |
| FR-32 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/lifecycle.ts`<br>`services/edge/src/routes/account.ts` | Silent decline: POST /consent/:id/decline always answers 204, publishes 'expired'; maskCloseReason maps declined>expired; tested. |
| FR-33 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/index.ts`<br>`services/edge/src/lifecycle.ts` | 30-min offer window: expires_at set at first surfacing, renewed per action; lifecycle_tick expires overdue offers; tested. |
| FR-34 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/lifecycle.ts`<br>`services/edge/src/routes/consent.ts` | Blocking: blocks table (no UPDATE/DELETE grants), permanent Valkey blockKey, scan excludes both directions via blocked_users_for; pair closes silently. |
| FR-35 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`services/edge/src/routes/consent.ts` | Append-only ledger, no-update trigger, actor+timestamp per row; the sole exception is a transaction-local purge mode reachable only from SECURITY DEFINER retention functions (NFR-19/21); tested. |
| FR-36 | implemented | `db/migrations/0001_init.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/messages.ts`<br>`services/edge/src/screening.ts` | Server stores opaque MLS envelopes only (bytea), RLS-gated to OPEN members; client MLS integration pending. |
| FR-37 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/lifecycle.ts`<br>`services/edge/src/routes/consent.ts` | 24-h conversation clock: closes_at set on OPEN, /consent/:id/keep from both sides clears it; lifecycle_tick lapses the rest; messages RLS gates on closed_at. |
| FR-38 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/messages.ts`<br>`services/edge/src/screening.ts`<br>`services/edge/test/screening.test.ts` | First message per sender per pair screened at the edge for links/phones/emails/bypass/scam patterns before storage; rejection is inline and category-level, nothing stored; tested. With MLS the same classifier runs in the client compose path (TECH-08). |
| FR-39 | implemented | — | Only text envelopes exist; no media/voice/file paths to disable. |
| FR-40 | partial | `docs/api/openapi.yaml` | Reports endpoint exists; no pair/offer anchor column; in-conversation control is client UX. |
| FR-41 | gap-p0 | — | Local delete + 24-h own-message revocation not implemented. |
| FR-42 | partial | `deploy/keycloak/realm-workforce.json` | venues carries geofence (PostGIS), h3_res, thresholds, active; partner status + operating schedule missing. |
| FR-43 | partial | `deploy/keycloak/realm-partners.json` | events = venue + window in schema; presence-to-event attribution not wired. |
| FR-44 | gap-p0 | `services/edge/src/screening.ts` | Crowd-mode transition to interest rooms — room surface not built. |
| FR-45 | gap-p0 | — | Interest-room content rules (topic, suppressed count, opted-in notes) — with FR-44. |
| FR-46 | gap-p0 | `services/edge/src/screening.ts` | Room posting 1 note/5 min + first-message content filters — with FR-44/SEC-21. |
| FR-47 | implemented | — | Resolution ladder 9>10 (2 000) >11 (10 000) on live venue density; tested. |
| FR-48 | gap-p0 | — | Venue check-in codes — signed-token path (FR-100) not built. |
| FR-49 | partial | — | rep…[~4220 tokens omitted during compaction]…ignal. |
| TR-31 | client | — | BLE rotating derived codes <=15 min, never a stable identifier. |
| TR-32 | client | — | Graceful degradation on denied Bluetooth/location/push permissions. |
| TR-33 | client | — | Certificate pinning removable by configuration (MAY). |
| TR-34 | gap-p0 | — | Stable metric keys + versioned CSV telemetry export contract — not implemented. |
| TR-35 | partial | — | Reason payload is render-complete (TR-08); the versioned diagram spec is a client artifact. |
| TR-36 | gap-p0 | — | idf prior smoothing (<=2% shift at N>=30) — not implemented; current idf has no global-taxonomy prior. |
| TR-37 | gap-p0 | — | Per-market resolution calibration held in configuration — the ladder is code constants today (SHOULD). |
| TR-38 | phase-gated | — | Polygon attribution as a lakehouse spatial join published to the operational store (P1 lakehouse). |
| TR-39 | phase-gated | — | Gold-table owner/grain/SLO/retention + catalogue registration (P1 lakehouse). |
| TR-40 | implemented | — | Phase-gate admission documented; 8 ADRs recorded (Valkey, Keycloak, Kafka, Dapr, OpenSearch, payments, GeoLibre, sequencing). |
| TR-41 | gap-p0 | — | GeoLibre authoring + second-person review + density verification workflow — not built. |
| TR-42 | gap-p0 | — | Floor id + connected floors on geometry records — schema extension pending (FR-99). |
| TR-43 | phase-gated | — | GeoParquet analytical outputs (P1 lakehouse). |
| TR-44 | phase-gated | — | Static-tile serving when map surfaces arrive; no runtime tile server exists (compliant by absence). |

## SEC — Security requirements (§7)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| SEC-01 | partial | — | Consumer realm enforces WebAuthn-with-UV, platform attachment, resident keys; AAL2 conformance evidence + client integration pending. |
| SEC-02 | partial | `deploy/keycloak/README.md`<br>`services/edge/src/auth.ts` | 5-minute realm access tokens configured; device binding (attestation) and the 60-second revocation drill pending. |
| SEC-03 | partial | `deploy/keycloak/README.md`<br>`deploy/keycloak/realm-workforce.json` | Workforce realm ships hardware-2FA policy, elevation-eligible role and a 4-hour session ceiling; the automated JIT grant workflow is pending. |
| SEC-04 | implemented | — | RLS on every personal-data table; app connects as non-bypass roles; tested. |
| SEC-05 | partial | — | Only the edge role reads envelopes, RLS-gated to pair members; no analytics/admin read path exists. |
| SEC-06 | gap-p0 | `deploy/k8s/README.md` | TLS 1.3 everywhere at APISIX (P0); dev compose is plaintext. |
| SEC-07 | external-evidence | `deploy/k8s/README.md` | AES-256-GCM at rest + KMS + annual rotation — production-infra evidence. |
| SEC-08 | implemented | — | No coordinate columns anywhere; server rejects coordinate fields; H3 cells only. |
| SEC-09 | gap-p0 | `deploy/keycloak/README.md` | Phone recovery stored as keyed hash only — lands with Keycloak SMS recovery config. |
| SEC-10 | implemented | `services/edge/src/screening.ts`<br>`services/edge/test/screening.test.ts` | Server persists ciphertext bytea + routing metadata only; client MLS integration pending. |
| SEC-11 | external-evidence | — | Encrypted backups, separate key, dual-authorisation restore — production ops. |
| SEC-12 | organisational | — | Per-category privacy-by-design rationale recorded in the DPIA. |
| SEC-13 | partial | — | Introduction consent ledgered with actor+timestamp; data-processing consent artefacts (purpose/scope/policy version) missing. |
| SEC-14 | implemented | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | DSAR assemble (GET /account/export) and erasure (DELETE /account) respond in seconds — far inside the 30-day/72-h SLAs; masking preserved in exports. |
| SEC-15 | organisational | — | Record of processing activities per Appendix B. |
| SEC-16 | phase-gated | — | Analytics pseudonymisation before leaving production — P1 pipeline. |
| SEC-17 | gap-p0 | `db/migrations/0003_account_deletion.sql` | Privacy-preserving age assurance without ID-document storage — method selection pending (BR-03/FR-02). |
| SEC-18 | gap-p0 | — | Third-party SDK allowlist enforced in CI — CI not built; client pending. |
| SEC-19 | partial | `docs/api/openapi.yaml`<br>`services/edge/src/auth.ts` | Assertion header required on presence write; cryptographic verification + documented fallback pending. |
| SEC-20 | partial | — | 6 scans/min edge limit exists; 200 scans/h, 20 waves/day and impossible-travel rules missing. |
| SEC-21 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/messages.ts`<br>`services/edge/src/screening.ts`<br>`services/edge/test/screening.test.ts` | screenText covers links, contact details and scam/bypass abuse patterns on first messages (enforced pre-storage in the messages route); room notes (FR-46) reuse the same module when rooms land (FR-44); tested. |
| SEC-22 | partial | — | No list endpoints; results capped at 3; tie-break is deterministic userId — randomised/rotating tie-break (FR-91) pending. |
| SEC-23 | external-evidence | — | OWASP ASVS 4.0.3 L2 / MASVS 2.0 L1 assessment before launch. |
| SEC-24 | partial | — | Dependencies pinned (exact versions + lockfile); SBOM + signed provenance per release not yet produced. |
| SEC-25 | gap-p0 | — | Dependency licence policy check in CI. |
| SEC-26 | gap-p0 | — | SAST + dependency + secret scanning on every PR — CI not built. |
| SEC-27 | organisational | — | Independent pen test before launch and annually. |
| SEC-28 | partial | `deploy/k8s/README.md`<br>`deploy/keycloak/README.md` | Only clearly-marked dev secrets in compose; managed secret store arrives with K8s. |
| SEC-29 | gap-p0 | — | Log scrubber (no coords / cell+user pairs / content / tokens) + tests — not implemented. |
| SEC-30 | partial | — | Append-only consent ledger exists; general security-event audit store + 12-month retention missing. |
| SEC-31 | organisational | — | Incident response plan, severity levels, on-call, 72-h regulator path, twice-yearly rehearsal. |
| SEC-32 | organisational | — | Law-enforcement request procedure + annual transparency report. |
| SEC-33 | gap-p0 | — | Group-surface participant caps enforced in the data layer — with rooms/tables (FR-44/66). |
| SEC-34 | gap-p0 | — | External links plain-text + interstitial + allowlist, no server fetch — with FR-65. |
| SEC-35 | client | — | Contentless ambient surfaces — client enforcement. |
| SEC-36 | partial | — | Mock-location refusal is client-side; the server-side refusal record endpoint is missing. |
| SEC-37 | gap-p0 | — | Announcement/response screening pre-publish + pre-delivery — not implemented. |
| SEC-38 | gap-p0 | — | Responder enumeration caps; no identity before acceptance — with FR-94/95. |

## INF — Infrastructure requirements (§8)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| INF-01 | external-evidence | — | Single primary region + same-jurisdiction warm standby — production topology. |
| INF-02 | partial | `deploy/k8s/README.md` | Local compose exists; integration/staging/production environments not provisioned. |
| INF-03 | partial | — | Synthetic distributional data generator exists (eval harness); environment separation pending INF-02. |
| INF-04 | implemented | `deploy/k8s/README.md` | Compose + migrations + ADRs + full K8s manifests (deploy/k8s: workloads, gateway, HPA, NetworkPolicy, canary) are code; scripts/validate_deploy.py asserts the invariants. |
| INF-05 | external-evidence | `deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml` | API/match sizing 3x 2 vCPU/4 GB — production. |
| INF-06 | external-evidence | `deploy/k8s/README.md`<br>`deploy/k8s/valkey.yaml` | Valkey 1 primary + 1 replica, 4 GB — production. |
| INF-07 | external-evidence | `deploy/k8s/README.md`<br>`deploy/k8s/postgres.yaml` | Postgres 4 vCPU/16 GB, 500 GB SSD, PITR — production. |
| INF-08 | external-evidence | — | Centrifugo 2 nodes x 2 vCPU — production. |
| INF-09 | superseded | — | ClickHouse superseded by the OpenSearch-only decision (ADR-0006 / TECH-21). |
| INF-10 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/canary.yaml`<br>`deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml` | autoscaling/v2 HPAs on edge + match: external p95 metric (120 ms target, 3-min window) with CPU fallback; scaleDown capped at 1 pod per 600 s; asserted by scripts/validate_deploy.py. |
| INF-11 | partial | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`scripts/validate_deploy.py` | TLS termination, HSTS and CSP configured at APISIX (validated); OCSP stapling is delegated to the cert-manager issuance chain and needs production evidence. |
| INF-12 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml`<br>`deploy/k8s/namespace.yaml` | K8s: only APISIX reaches edge, only edge reaches match, everything else ClusterIP/headless; default-deny-all NetworkPolicy; asserted by scripts/validate_deploy.py. |
| INF-13 | external-evidence | — | Edge DDoS mitigation + pre-launch test. |
| INF-14 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/namespace.yaml`<br>`deploy/k8s/networkpolicy.yaml`<br>`scripts/validate_deploy.py` | Default-deny egress + per-workload egress allowlists (DNS only otherwise) in deploy/k8s/networkpolicy.yaml; asserted by scripts/validate_deploy.py. |
| INF-15 | gap-p0 | — | Merge -> signed reproducible artefact -> auto-deploy to integration — CI pipeline. |
| INF-16 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/canary.yaml`<br>`scripts/validate_deploy.py` | Flagger Canary resources on the APISIX provider: 5% steps held 10 min, auto-rollback on success-rate/p95-latency breach (deploy/k8s/canary.yaml); asserted by scripts/validate_deploy.py. Requires Flagger + Prometheus in-cluster. |
| INF-17 | partial | — | Forward-only migrations practised; rehearsal against a production-sized snapshot pending. |
| INF-18 | external-evidence | — | PITR 5-min granularity, 35-day retention, quarterly timed restore. |
| INF-19 | external-evidence | — | <=EUR1 500/mo at 100k MAU — Kubecost (P1) + monthly review. |
| INF-20 | organisational | — | On-call staffing, escalation ladder, 30-min Sev-1 acknowledgement. |

## TECH — Technology requirements (§9)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| TECH-01 | client | — | React Native + Expo custom dev client; Expo Go prohibited (BLE). |
| TECH-02 | implemented | — | h3-js 4.x in both TS services; the client uses the same library family so cell ids agree bit-for-bit. |
| TECH-03 | implemented | `deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml` | Dockerfiles on node:22-alpine, engines >=22, @types/node 22.10.2; TypeScript strict, pinned toolchain; tests green. |
| TECH-04 | partial | `deploy/k8s/postgres.yaml` | Postgres 17 + PostGIS deployed; h3-pg extension not yet added. |
| TECH-05 | implemented | `deploy/k8s/valkey.yaml` | Valkey 8 (BSD-3); no Redis anywhere. |
| TECH-06 | partial | `deploy/k8s/centrifugo.yaml` | Centrifugo deployed; Valkey-as-broker not yet configured (in-memory engine in dev compose). |
| TECH-07 | partial | `deploy/docker-compose.yml`<br>`deploy/k8s/README.md`<br>`deploy/k8s/keycloak.yaml`<br>`deploy/keycloak/README.md`<br>`services/edge/src/app.ts` | Three realm imports (consumer passkey policy / workforce hardware 2FA / partners roles) boot in compose; edge verifies RS256 via realm JWKS; passkey-only browser flow + SMS recovery config pending. |
| TECH-08 | client | `services/edge/src/screening.ts` | OpenMLS/vodozemac client crypto; libsignal prohibited (AGPL-3.0 vs closed client). |
| TECH-09 | gap-p0 | — | pgvector for free-text linking only (FR-09), never in the match path — extension + service pending. |
| TECH-10 | superseded | — | ClickHouse superseded by OpenSearch (ADR-0006 / TECH-21); aggregated events only. |
| TECH-11 | partial | — | Fastify structured logs; OpenTelemetry traces + Grafana stack not wired (AGPL internal-only constraint noted). |
| TECH-12 | partial | — | Health endpoints + structured logs done; OpenTelemetry traces missing. |
| TECH-13 | implemented | — | Golden-file suite (120 pairs) fails on any score change; 81-test Python regression suite. |
| TECH-14 | gap-p0 | `docs/api/openapi.yaml` | Client<->server contract tests generated from docs/api/openapi.yaml — schema exists (TR-23), tests not yet written. |
| TECH-15 | partial | — | Python engine is pure/deterministic; TS services read the wall clock directly — clock/id injection not formalised. |
| TECH-16 | client | — | Dependency maintenance/licence/size budget; 45 MB bundle cap. |
| TECH-17 | organisational | — | Team skills: TypeScript, React Native, Postgres, one systems language. |
| TECH-18 | gap-p0 | `deploy/k8s/match.yaml` | ARC language allocation: Rust match core + Go presence/venue/consent services outstanding; TS services are the documented P0 stand-in. |
| TECH-19 | implemented | — | Kafka designated event backbone (ADR-0004); no Fluvio deployed; Kafka rollout itself is ARC P1. |
| TECH-20 | implemented | — | No Temporal calls on the scan path (none exist anywhere); Temporal rollout is ARC P1. |
| TECH-21 | implemented | `deploy/docker-compose.yml`<br>`deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/canary.yaml`<br>`deploy/k8s/networkpolicy.yaml` | No ClickHouse / second warehouse; APISIX is the sole public ingress — the only LoadBalancer Service, enforced by NetworkPolicy (validated); OpenSearch is P1. |
| TECH-22 | phase-gated | — | Delta-on-Parquet bronze/silver/gold — P1 lakehouse; no analytics on the live match path (satisfied). |
| TECH-23 | implemented | — | No Mojaloop/TigerBeetle deployed; ARC-002 §9 gates them at P3. |
| TECH-24 | partial | — | Canonical geometry in PostGIS (venues.geofence); GeoLibre authoring/QA workflow not built (TR-41). |

## ACC — Acceptance and verification (§10)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| ACC-01 | external-evidence | — | This generated matrix + the test suites are the verification instrument; final gate at pilot. |
| ACC-02 | organisational | — | Independent pen test with critical/high remediation + retest. |
| ACC-03 | organisational | — | DPIA signed by DPO + accountable executive. |
| ACC-04 | external-evidence | — | Load + soak profile on production-equivalent infrastructure. |
| ACC-05 | organisational | — | Incident response rehearsed; on-call staffed; runbooks published. |
| ACC-06 | external-evidence | — | Rollback drill: production release reverted <=10 min. |
| ACC-07 | organisational | — | Three anchor venues contracted + dashboards verified. |
| ACC-08 | external-evidence | — | Store review acceptance on both platforms — needs the client. |
| ACC-09 | external-evidence | — | 10-user first-time usability test (>=8 describe the product correctly) — needs the client. |
| ACC-10 | partial | `presence/eval_harness.py`<br>`presence/eval_score.py`<br>`scripts/export_golden.py`<br>`services/match/src/engine.ts`<br>`services/match/test/engine.test.ts` | Eval pipeline complete (653-pair key, rating pack, scoring; self-test alpha 0.832, p@3 0.389); the real >=3-independent-rater study is outstanding. |

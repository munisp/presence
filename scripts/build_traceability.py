#!/usr/bin/env python3
"""Generate the Presence requirement traceability matrix.

PRS-SRS-001 requires the traceability matrix to be a generated artefact, not a
hand-maintained spreadsheet. This script is the generator:

  1. CLASSIFICATION below holds, per requirement id, the audited status and a
     one-line basis note (the audit itself — updated when code changes).
  2. Evidence pointers are extracted mechanically by scanning the repo for
     requirement-id mentions in source, tests, schema, docs and eval assets.
  3. Outputs:
       docs/traceability.json  — machine-readable matrix
       docs/traceability.md    — human-readable matrix with summary counts

Run from the repo root:  python3 scripts/build_traceability.py

Statuses:
  implemented       working in the repo with tests or structural evidence
  partial           meaningful part implemented; named gap remains
  gap-p0            in ARC-P0 product scope, not yet built (code work)
  phase-gated       belongs to an ARC P1+ component (Kafka/Temporal/OpenSearch/
                    lakehouse); correctly deferred per TR-40 / ARC-002 §9
  client            requires the React Native client workstream
  organisational    legal / process / staffing; not expressible as code here
  external-evidence needs production infrastructure or third-party evidence
  superseded        superseded by a recorded architecture decision (ADR)
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import OrderedDict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAMILIES = OrderedDict(
    [
        ("BR", ("Business requirements (§3)", 33)),
        ("FR", ("Functional requirements (§4)", 100)),
        ("NFR", ("Non-functional requirements (§5)", 37)),
        ("TR", ("Technical requirements (§6)", 44)),
        ("SEC", ("Security requirements (§7)", 38)),
        ("INF", ("Infrastructure requirements (§8)", 20)),
        ("TECH", ("Technology requirements (§9)", 24)),
        ("ACC", ("Acceptance and verification (§10)", 10)),
    ]
)

STATUS_ORDER = [
    "implemented",
    "partial",
    "gap-p0",
    "phase-gated",
    "client",
    "organisational",
    "external-evidence",
    "superseded",
]

# id -> (status, basis note)
CLASSIFICATION: dict[str, tuple[str, str]] = {
    # ---------------- BR ----------------
    "BR-01": ("organisational", "Single-metro launch with >=3 venues in 2 km — launch-ops gate (ACC-07), not code."),
    "BR-02": ("organisational", "Positioning (friendship, not dating) — store copy / onboarding / marketing review; no dating surface exists in code."),
    "BR-03": ("gap-p0", "Age declaration at onboarding, under-18 block, re-verification on escalation — no onboarding flow or age fields yet."),
    "BR-04": ("organisational", "Second-city expansion gate on anchor-venue metrics (§2.5 for 3 consecutive weeks)."),
    "BR-05": ("partial", "events table models venue+window; event-scoped instance mode and presence-to-event attribution not wired."),
    "BR-06": ("organisational", "Five sequenced revenue lines only; payments gated per docs/adr/0007."),
    "BR-07": ("partial", "Reports endpoint exists and is ungated; two-tap reachability is client UX (not built); no monetisation gate exists."),
    "BR-08": ("implemented", "Structural: no endpoint exposes precise location, pre-OPEN identity, or unconsented data; no paid tier exists to violate it."),
    "BR-09": ("organisational", "Per-market local-currency pricing via store billing — monetisation phase."),
    "BR-10": ("organisational", "Pilot unit-economics targets (CAC <= EUR6, payback <=4 mo, conversion >=3%)."),
    "BR-11": ("organisational", "Venue agreement: data-processing roles, signage, escalation, 30-day termination."),
    "BR-12": ("gap-p0", "Aggregate-only venue dashboard not built; Keycloak partners realm (P0) is its identity surface."),
    "BR-13": ("gap-p0", "k=11 suppression for venue aggregate figures — lands with the venue dashboard."),
    "BR-14": ("partial", "venues.active is checked on scan (immediate effect); suspension fully propagates within the 15-min TTL; venue self-serve suspend endpoint missing."),
    "BR-15": ("organisational", "Resourcing: 4 FTE + fractional design/DPO/T&S, 16 weeks to pilot."),
    "BR-16": ("organisational", "T&S staffing >=1 moderator per 10k MAU + named escalation path."),
    "BR-17": ("organisational", "Budget: build + 12-month run + EUR2M cyber insurance + independent pen test."),
    "BR-18": ("organisational", "Named DPO before EU processing, independent of Product/Engineering."),
    "BR-19": ("organisational", "DPIA signed before launch; annual or on-material-change review."),
    "BR-20": ("organisational", "ToS / Privacy Notice / Community Guidelines / Cookie notice per launch language."),
    "BR-21": ("partial", "Taxonomy seed is synthetic (no CC0 content used); per-release provenance record (TR-20) missing."),
    "BR-22": ("organisational", "Nominative, descriptive use only; seed uses names without logos/marks; formal legal review outstanding."),
    "BR-23": ("organisational", "Register of processing activities + published sub-processor list."),
    "BR-24": ("organisational", "Five launch lines / prices / inclusions per §3.6.1."),
    "BR-25": ("organisational", "Venue pricing per venue, unmetered."),
    "BR-26": ("implemented", "Structural: the scorer reads profile + corpus only; no tier or payment input exists on the match path."),
    "BR-27": ("implemented", "Structural: the matcher never receives partner status; per-venue config is limited to threshold/result-count (TR-11)."),
    "BR-28": ("organisational", "Aggregate-only reporting principle; no revenue line exists yet."),
    "BR-29": ("organisational", "Unit-economics model as single source of truth, monthly review."),
    "BR-30": ("organisational", "New revenue line requires DPIA + spec revision."),
    "BR-31": ("organisational", "Commercial model reviewed vs telemetry at each month close."),
    "BR-32": ("organisational", ">20% multi-site discounts modelled pre-signature."),
    "BR-33": ("gap-p0", "Announcement categories as policy + verified-org work category — enforcement code missing (FR-96/97)."),
    # ---------------- FR ----------------
    "FR-01": ("partial", "Consumer realm ships the passkey policy (platform authenticator, user verification required, passwords disabled); edge verifies RS256 via JWKS; passkey-only onboarding flow + RN client pending."),
    "FR-02": ("gap-p0", "Age declaration + neutral under-18 block — no onboarding endpoint yet."),
    "FR-03": ("gap-p0", "In-app account deletion <=3 taps — DELETE /v1/account missing; client pending."),
    "FR-04": ("gap-p0", "Deletion purge (presence/offers <=60 s, ledger anonymisation after retention, index removal) — no deletion flow."),
    "FR-05": ("gap-p0", "<=3 concurrent devices + enrolment notification — device registry arrives with Keycloak device-bound tokens."),
    "FR-06": ("partial", "user_identities carries handle + photo gated to OPEN by RLS; display-name default and 140-char bio missing."),
    "FR-07": ("gap-p0", "Duplicate-account detection on attestation key — needs real App Attest / Play Integrity verification."),
    "FR-08": ("gap-p0", "3-20 interests, searchable <=3-level picker — profile write API missing; picker is client work."),
    "FR-09": ("gap-p0", "Free-text entity linking with per-node confirmation — pgvector linking service (TECH-09) not built."),
    "FR-10": ("implemented", "Sensitive nodes excluded from vectors, reasons, idf and bonus at build time; covered by engine tests."),
    "FR-11": ("partial", "Candidates need >=2 interests to be scored; publish-side >=3 enforcement + client explanation missing."),
    "FR-12": ("implemented", "Profile and corpus caches refresh on a 60 s loop (TR-05)."),
    "FR-13": ("gap-p0", "k-suppressed local popularity per interest — no endpoint."),
    "FR-14": ("implemented", "900 s Valkey TTL; stale cell members filtered at read; tested."),
    "FR-15": ("partial", "Server rejects coordinate-shaped fields with 422 (TR-15); on-device cell computation is client work."),
    "FR-16": ("gap-p0", "128-bit per-presence session ids, unlinkable and reuse-rejected — presence is keyed by account id today."),
    "FR-17": ("gap-p0", "Time-boxed intent vocabulary expiring with presence or 60 min, usable as match signal."),
    "FR-18": ("gap-p0", "Global invisible switch — immediate, persistent, no confirmation dialogue."),
    "FR-19": ("client", "Background-withdrawal <=60 s is client lifecycle behaviour."),
    "FR-20": ("implemented", "<=3 candidates with ordered reasons; unit + golden tests."),
    "FR-21": ("implemented", "Adaptive threshold: (1-5/n)-quantile floored at venue base; tested."),
    "FR-22": ("partial", "MMR (lambda 0.7) over reason-node Jaccard; a hard no-shared-primary-reason guarantee is not enforced."),
    "FR-23": ("implemented", "Canonical suppression keys, 600 s TTL, both directions; tested."),
    "FR-24": ("implemented", "6 scans/min per user at the edge; tested."),
    "FR-25": ("implemented", "Bands from H3 grid distance only; no metres/bearing/cell ids in responses."),
    "FR-26": ("implemented", "Explanatory empty state below 8 discoverable users in scope; tested."),
    "FR-27": ("implemented", "Ordered reason path in every scan payload; /v1/score re-scores any explicit pair."),
    "FR-28": ("gap-p0", "Density-scaled match budget (3/hr sparse to 1/day crowd) not implemented."),
    "FR-29": ("implemented", "DETECTED>NUDGED>EXPRESSED>MUTUAL>OPEN enforced by DB trigger; DETECTED recorded on first surfacing; tested."),
    "FR-30": ("implemented", "Identity RLS-gated to OPEN; verified by policy + edge tests."),
    "FR-31": ("implemented", "One wave per offer via illegal-transition rejection; the wave carries no content."),
    "FR-32": ("gap-p0", "Silent decline (counterpart sees only expiry) — no decline endpoint."),
    "FR-33": ("gap-p0", "30-min server-side offer expiry — matches has no expiry column or job."),
    "FR-34": ("gap-p0", "Immediate, silent, permanent mutual discovery removal — no block table/endpoint."),
    "FR-35": ("implemented", "Append-only ledger, no-update trigger, actor+timestamp per row; tested."),
    "FR-36": ("implemented", "Server stores opaque MLS envelopes only (bytea), RLS-gated to OPEN members; client MLS integration pending."),
    "FR-37": ("gap-p0", "24-h conversation auto-close unless both keep — no close transition or job."),
    "FR-38": ("gap-p0", "First-message screening (links/phones/emails, inline explanation) not implemented."),
    "FR-39": ("implemented", "Only text envelopes exist; no media/voice/file paths to disable."),
    "FR-40": ("partial", "Reports endpoint exists; no pair/offer anchor column; in-conversation control is client UX."),
    "FR-41": ("gap-p0", "Local delete + 24-h own-message revocation not implemented."),
    "FR-42": ("partial", "venues carries geofence (PostGIS), h3_res, thresholds, active; partner status + operating schedule missing."),
    "FR-43": ("partial", "events = venue + window in schema; presence-to-event attribution not wired."),
    "FR-44": ("gap-p0", "Crowd-mode transition to interest rooms — room surface not built."),
    "FR-45": ("gap-p0", "Interest-room content rules (topic, suppressed count, opted-in notes) — with FR-44."),
    "FR-46": ("gap-p0", "Room posting 1 note/5 min + first-message content filters — with FR-44/SEC-21."),
    "FR-47": ("implemented", "Resolution ladder 9>10 (2 000) >11 (10 000) on live venue density; tested."),
    "FR-48": ("gap-p0", "Venue check-in codes — signed-token path (FR-100) not built."),
    "FR-49": ("partial", "reports accepts free-text reason; the fixed category enum is missing."),
    "FR-50": ("organisational", "24/7 4-h high-severity triage — staffing/rota (BR-16) plus the moderation console (FR-54)."),
    "FR-51": ("partial", "Attestation assertion header required on presence write; cryptographic verification + discovery gating pending."),
    "FR-52": ("gap-p0", "Per-account trust score (verification, report outcomes, account age) not implemented."),
    "FR-53": ("gap-p0", "Silent investigation removal + appeal path not implemented."),
    "FR-54": ("gap-p0", "Moderation console (reason path, ledger, sessions, history; never message content) not built."),
    "FR-55": ("gap-p0", "Independent suspension of attestation key / handle / payment instrument not implemented."),
    "FR-56": ("partial", "Realtime events carry only a type on an opaque pair channel; APNs/FCM push pipeline not built."),
    "FR-57": ("gap-p0", "Nudge cap 3/day + user quiet window not implemented (no nudge sender)."),
    "FR-58": ("gap-p0", "Per-category notification switches (safety notices exempt) not implemented."),
    "FR-59": ("gap-p0", "Taxonomy CMS draft/review/publish + one-action rollback not built (seed export scripts only)."),
    "FR-60": ("gap-p0", "Immutable admin audit log (actor, reason code, before/after) not implemented."),
    "FR-61": ("phase-gated", "Analytics pipeline is P1 lakehouse (Delta/Parquet) per ARC-002 §9; identifier exclusion + cell aggregation specified there."),
    "FR-62": ("gap-p0", "Data-subject assemble/erase tool (30-day) not built."),
    "FR-63": ("gap-p0", "Per-venue feature flags for §4.4/4.5/4.7 behaviours not implemented."),
    "FR-64": ("gap-p0", "Structured prompts (<=3 x 120 chars, screened, reason material, not searchable) not implemented."),
    "FR-65": ("gap-p0", "Post-OPEN allowlisted social link, counterpart-only, never fetched server-side — not implemented."),
    "FR-66": ("gap-p0", "Group tables <=6, member-only visibility — not implemented."),
    "FR-67": ("gap-p0", "Table conversation cards from shared reasons, labelled generated — not implemented."),
    "FR-68": ("gap-p0", "Bookable 1:1 slots where booking is the consent act — not implemented."),
    "FR-69": ("gap-p0", "Host designation, name+role display, scoped visibility — not implemented."),
    "FR-70": ("client", "Verification status at identity reveal — client rendering (+ data from FR-51/52)."),
    "FR-71": ("gap-p0", "Recurrence signal (hashed pair, day counter, <=1/day, no timestamps) — optional MAY, not implemented."),
    "FR-72": ("gap-p0", "Table boundary acceptance criteria — with FR-66."),
    "FR-73": ("gap-p0", "Booked-slot acceptance criteria — with FR-68."),
    "FR-74": ("gap-p0", "Host accountability + visibility limits — with FR-69."),
    "FR-75": ("gap-p0", "Group enumeration restrictions — with FR-66/68."),
    "FR-76": ("client", "Convergence rendering from the reason payload — payload complete server-side (TR-08)."),
    "FR-77": ("implemented", "Structural: no endpoint exposes maps, bearings, distances, radii, or proximity arrangements."),
    "FR-78": ("client", "Density-as-texture rendering, no positional component."),
    "FR-79": ("client", "Closing-perimeter expiry affordance, no default countdown."),
    "FR-80": ("client", "Shared screen skeleton across pairs/rooms/tables."),
    "FR-81": ("client", "Spatial taxonomy picker + <=4-interaction interest selection."),
    "FR-82": ("client", "400-ms sustained-press wave with progressive feedback."),
    "FR-83": ("client", "Distinct haptics per transition + non-visual channel."),
    "FR-84": ("client", "Co-located close suggestion after 15 min (SHOULD)."),
    "FR-85": ("client", "Reduced-power 10-min cadence mode with visibility trade-off notice."),
    "FR-86": ("client", "Ambient surfaces individually opt-in, off by default, one-action disable."),
    "FR-87": ("client", "Prohibited engagement mechanics — none exist server-side; enforcement is client review."),
    "FR-88": ("client", "Location-accuracy authorization read before publish; refuse on approximate-only."),
    "FR-89": ("gap-p0", "Venue check-in as the primary indoor presence path — signed codes (FR-100)."),
    "FR-90": ("partial", "venues.geofence holds the canonical polygon; attribution, versioning and precedence logic not implemented."),
    "FR-91": ("gap-p0", "7-day no-re-offer rotation + per-user tie-break counter — only 10-min suppression exists."),
    "FR-92": ("client", "5-min modal-cell stabilisation on device (SHOULD)."),
    "FR-93": ("partial", "announcements table + time-windowed read exist; publish path, trust floor, 4-h cap, category assignment missing."),
    "FR-94": ("gap-p0", "Inverted-consent responses (anonymous until acceptance) — not implemented."),
    "FR-95": ("gap-p0", "One active announcement, 1/24 h publish, one response each, <=5 shown — not implemented."),
    "FR-96": ("gap-p0", "Category assignment + body screening (links/phones/emails/solicitation) — not implemented."),
    "FR-97": ("gap-p0", "Work category restricted to verified organisations — needs partner verification (Keycloak partners realm)."),
    "FR-98": ("gap-p0", "Auto-removal after 2 reports in 10 min, publisher notified, evidence retained — not implemented."),
    "FR-99": ("gap-p0", "Per-floor codes/polygons/attribution + connected-floor declaration — not implemented."),
    "FR-100": ("gap-p0", "Signed check-in token, QR baseline, NFC optional, same token format — not implemented."),
}
CLASSIFICATION.update({
    # ---------------- NFR ----------------
    "NFR-01": ("external-evidence", "Scan server latency p95 <=150 ms — load evidence (ACC-04)."),
    "NFR-02": ("external-evidence", "Scan server latency p99 <=400 ms — load evidence (ACC-04)."),
    "NFR-03": ("external-evidence", "Presence publish ack p95 <=120 ms — load evidence."),
    "NFR-04": ("client", "Cold start to interactive <=1.8 s mid-tier."),
    "NFR-05": ("client", "Warm start <=600 ms."),
    "NFR-06": ("external-evidence", "Tap-to-results p95 <=900 ms — end-to-end measurement with the client."),
    "NFR-07": ("partial", "Centrifugo realtime fan-out wired; <=500 ms delivery unmeasured."),
    "NFR-08": ("external-evidence", "25 000 concurrent presences per city cluster — capacity test."),
    "NFR-09": ("external-evidence", "600 scans/s at p95 peak — capacity test."),
    "NFR-10": ("external-evidence", "60 000 single-venue burst per 10 min — capacity test."),
    "NFR-11": ("external-evidence", "Linear 2x scale-out without schema/client change — K8s HPA + test."),
    "NFR-12": ("external-evidence", "250k-node taxonomy at match latency targets — scale test (TR-21)."),
    "NFR-13": ("external-evidence", "99.9% measured scan-path availability — production measurement."),
    "NFR-14": ("partial", "Presence path is independent of the matcher; edge returns 502 today — graceful 'discovery paused' client state pending."),
    "NFR-15": ("external-evidence", "RTO <=60 min single-zone loss."),
    "NFR-16": ("external-evidence", "RPO <=5 min consent ledger (PITR, INF-18)."),
    "NFR-17": ("implemented", "Presence RPO deliberately zero — Valkey-only, disposable by design; documented."),
    "NFR-18": ("partial", "15-min TTL enforced; the 45-min grace semantics for index residue are only partially explicit (lazy stale-member filtering)."),
    "NFR-19": ("gap-p0", "Offer retention 30 min + 24 h — with FR-33."),
    "NFR-20": ("gap-p0", "Conversation ciphertext purge 24 h after close — with FR-37."),
    "NFR-21": ("partial", "Ledger append-only and retained; the 90-day abuse-hold enforcement job is missing."),
    "NFR-22": ("partial", "Reports persisted; 12-month retention policy job missing."),
    "NFR-23": ("phase-gated", "25-month aggregate analytics retention — P1 lakehouse."),
    "NFR-24": ("external-evidence", "35-day backup retention — production ops."),
    "NFR-25": ("client", "WCAG 2.2 AA (contrast, dynamic type, screen reader, focus, reduced motion)."),
    "NFR-26": ("client", "44x44 pt touch targets."),
    "NFR-27": ("client", "English at launch; localisable without code changes; +2 locales in 3 months."),
    "NFR-28": ("client", "iOS 16+ / Android 10+ with graceful BLE-floor degradation."),
    "NFR-29": ("client", "Foreground battery <=2%/h on reference mid-tier."),
    "NFR-30": ("client", "Background battery parity with a no-op app when background presence is off."),
    "NFR-31": ("partial", "Fastify request ids per service; APISIX request-id plugin generates and echoes X-Request-Id at the gateway; edge->match propagation of the id still missing."),
    "NFR-32": ("gap-p0", "Four §2.5 product metrics computable from telemetry <=5 min — telemetry pipeline (TR-34)."),
    "NFR-33": ("gap-p0", "Alert set: SLO burn, error spike, presence-publish failure, match-rate collapse, moderation queue age."),
    "NFR-34": ("gap-p0", "Runbook per alert, each alert naming an owner."),
    "NFR-35": ("client", "60 fps match surface (>=30 fps floor on weakest supported device)."),
    "NFR-36": ("client", "Ambient refresh <=1/min, no idle radio wake."),
    "NFR-37": ("client", "Primary action reachable one-handed in the lower 40% of the display."),
    # ---------------- TR ----------------
    "TR-01": ("implemented", "Edge + match are stateless; all state lives in Valkey/Postgres."),
    "TR-02": ("partial", "Scan reads Valkey + warmed caches; a cold profile cache miss still hits Postgres inline — bulk warming or async load outstanding."),
    "TR-03": ("partial", "K8s NetworkPolicies isolate east-west traffic (only declared flows allowed); mTLS between services awaits the mesh decision."),
    "TR-04": ("implemented", "0.55/hop, depth <=4, max-combine — pinned against the answer key (653/653)."),
    "TR-05": ("implemented", "df over live presence, link-free closures, 60 s refresh loop."),
    "TR-06": ("implemented", "sqrt(ln(1+N/(1+df))) with cap — pinned."),
    "TR-07": ("implemented", "Links contribute one hop at authored weight <=0.5, excluded from df — pinned."),
    "TR-08": ("implemented", "Ordered reasons with node ids, labels, contributions in every response."),
    "TR-09": ("implemented", "Deterministic template rendering; no LLM anywhere in reason generation."),
    "TR-10": ("implemented", "81 Python tests incl. 60 key-pinned pairs; 120-pair TS golden parity at 1e-9."),
    "TR-11": ("implemented", "venues.base_threshold / max_scan_results configurable per venue row without deployment."),
    "TR-12": ("implemented", "H3 res 9 default; k=1 ring; tested."),
    "TR-13": ("implemented", "Responses carry bands only — no neighbour cell or ring distance."),
    "TR-14": ("implemented", "Descent at 2 000 / 10 000 live presences; tested."),
    "TR-15": ("implemented", "Coordinate-shaped payload fields hard-422; tested."),
    "TR-16": ("gap-p0", "h3-pg native column type (TECH-04) — cells are Valkey strings today; no H3 column in Postgres."),
    "TR-17": ("implemented", "Graph enforces an acyclic hierarchy <=5 levels + typed non-hierarchical edges."),
    "TR-18": ("implemented", "taxonomy_closure materialised, rebuilt by the seed/export pipeline."),
    "TR-19": ("partial", "redirect_to column + Python graph support exist; the TS engine does not resolve redirects yet."),
    "TR-20": ("gap-p0", "Monotonic version + provenance + diff summary per taxonomy release — no release tooling."),
    "TR-21": ("gap-p0", "250k-node closure <10 min — scale test not run (current seed is a small synthetic graph)."),
    "TR-22": ("implemented", "Sensitive nodes skipped at vector construction (write time), not query time."),
    "TR-23": ("partial", "/v1 path versioning done; machine-readable schema + strict unknown-field rejection missing."),
    "TR-24": ("gap-p0", "Idempotency keys on every mutating endpoint — not implemented."),
    "TR-25": ("partial", "Errors carry a message only; stable machine codes + retry hints missing; no internal leaks observed."),
    "TR-26": ("implemented", "APISIX listener configured TLSv1.3-only with HTTP/2 (deploy/k8s/apisix.yaml); downgrade impossible at the listener; asserted by scripts/validate_deploy.py. Dev compose stays plaintext by design."),
    "TR-27": ("client", "Unsupported-version detection + update prompt."),
    "TR-28": ("implemented", "All expiry windows use server now(); no client-clock input anywhere."),
    "TR-29": ("client", "On-device cell computation; raw coordinates discarded before any network call."),
    "TR-30": ("client", "Minimum local state; cleared on logout/uninstall signal."),
    "TR-31": ("client", "BLE rotating derived codes <=15 min, never a stable identifier."),
    "TR-32": ("client", "Graceful degradation on denied Bluetooth/location/push permissions."),
    "TR-33": ("client", "Certificate pinning removable by configuration (MAY)."),
    "TR-34": ("gap-p0", "Stable metric keys + versioned CSV telemetry export contract — not implemented."),
    "TR-35": ("partial", "Reason payload is render-complete (TR-08); the versioned diagram spec is a client artifact."),
    "TR-36": ("gap-p0", "idf prior smoothing (<=2% shift at N>=30) — not implemented; current idf has no global-taxonomy prior."),
    "TR-37": ("gap-p0", "Per-market resolution calibration held in configuration — the ladder is code constants today (SHOULD)."),
    "TR-38": ("phase-gated", "Polygon attribution as a lakehouse spatial join published to the operational store (P1 lakehouse)."),
    "TR-39": ("phase-gated", "Gold-table owner/grain/SLO/retention + catalogue registration (P1 lakehouse)."),
    "TR-40": ("implemented", "Phase-gate admission documented; 8 ADRs recorded (Valkey, Keycloak, Kafka, Dapr, OpenSearch, payments, GeoLibre, sequencing)."),
    "TR-41": ("gap-p0", "GeoLibre authoring + second-person review + density verification workflow — not built."),
    "TR-42": ("gap-p0", "Floor id + connected floors on geometry records — schema extension pending (FR-99)."),
    "TR-43": ("phase-gated", "GeoParquet analytical outputs (P1 lakehouse)."),
    "TR-44": ("phase-gated", "Static-tile serving when map surfaces arrive; no runtime tile server exists (compliant by absence)."),
    # ---------------- SEC ----------------
    "SEC-01": ("partial", "Consumer realm enforces WebAuthn-with-UV, platform attachment, resident keys; AAL2 conformance evidence + client integration pending."),
    "SEC-02": ("partial", "5-minute realm access tokens configured; device binding (attestation) and the 60-second revocation drill pending."),
    "SEC-03": ("partial", "Workforce realm ships hardware-2FA policy, elevation-eligible role and a 4-hour session ceiling; the automated JIT grant workflow is pending."),
    "SEC-04": ("implemented", "RLS on every personal-data table; app connects as non-bypass roles; tested."),
    "SEC-05": ("partial", "Only the edge role reads envelopes, RLS-gated to pair members; no analytics/admin read path exists."),
    "SEC-06": ("gap-p0", "TLS 1.3 everywhere at APISIX (P0); dev compose is plaintext."),
    "SEC-07": ("external-evidence", "AES-256-GCM at rest + KMS + annual rotation — production-infra evidence."),
    "SEC-08": ("implemented", "No coordinate columns anywhere; server rejects coordinate fields; H3 cells only."),
    "SEC-09": ("gap-p0", "Phone recovery stored as keyed hash only — lands with Keycloak SMS recovery config."),
    "SEC-10": ("implemented", "Server persists ciphertext bytea + routing metadata only; client MLS integration pending."),
    "SEC-11": ("external-evidence", "Encrypted backups, separate key, dual-authorisation restore — production ops."),
    "SEC-12": ("organisational", "Per-category privacy-by-design rationale recorded in the DPIA."),
    "SEC-13": ("partial", "Introduction consent ledgered with actor+timestamp; data-processing consent artefacts (purpose/scope/policy version) missing."),
    "SEC-14": ("gap-p0", "DSAR 30-day / erasure 72-h tooling (FR-62)."),
    "SEC-15": ("organisational", "Record of processing activities per Appendix B."),
    "SEC-16": ("phase-gated", "Analytics pseudonymisation before leaving production — P1 pipeline."),
    "SEC-17": ("gap-p0", "Privacy-preserving age assurance without ID-document storage — method selection pending (BR-03/FR-02)."),
    "SEC-18": ("gap-p0", "Third-party SDK allowlist enforced in CI — CI not built; client pending."),
    "SEC-19": ("partial", "Assertion header required on presence write; cryptographic verification + documented fallback pending."),
    "SEC-20": ("partial", "6 scans/min edge limit exists; 200 scans/h, 20 waves/day and impossible-travel rules missing."),
    "SEC-21": ("gap-p0", "First-message / room-note screening (links, contact details, abuse patterns) — not implemented."),
    "SEC-22": ("partial", "No list endpoints; results capped at 3; tie-break is deterministic userId — randomised/rotating tie-break (FR-91) pending."),
    "SEC-23": ("external-evidence", "OWASP ASVS 4.0.3 L2 / MASVS 2.0 L1 assessment before launch."),
    "SEC-24": ("partial", "Dependencies pinned (exact versions + lockfile); SBOM + signed provenance per release not yet produced."),
    "SEC-25": ("gap-p0", "Dependency licence policy check in CI."),
    "SEC-26": ("gap-p0", "SAST + dependency + secret scanning on every PR — CI not built."),
    "SEC-27": ("organisational", "Independent pen test before launch and annually."),
    "SEC-28": ("partial", "Only clearly-marked dev secrets in compose; managed secret store arrives with K8s."),
    "SEC-29": ("gap-p0", "Log scrubber (no coords / cell+user pairs / content / tokens) + tests — not implemented."),
    "SEC-30": ("partial", "Append-only consent ledger exists; general security-event audit store + 12-month retention missing."),
    "SEC-31": ("organisational", "Incident response plan, severity levels, on-call, 72-h regulator path, twice-yearly rehearsal."),
    "SEC-32": ("organisational", "Law-enforcement request procedure + annual transparency report."),
    "SEC-33": ("gap-p0", "Group-surface participant caps enforced in the data layer — with rooms/tables (FR-44/66)."),
    "SEC-34": ("gap-p0", "External links plain-text + interstitial + allowlist, no server fetch — with FR-65."),
    "SEC-35": ("client", "Contentless ambient surfaces — client enforcement."),
    "SEC-36": ("partial", "Mock-location refusal is client-side; the server-side refusal record endpoint is missing."),
    "SEC-37": ("gap-p0", "Announcement/response screening pre-publish + pre-delivery — not implemented."),
    "SEC-38": ("gap-p0", "Responder enumeration caps; no identity before acceptance — with FR-94/95."),
})
CLASSIFICATION.update({
    # ---------------- INF ----------------
    "INF-01": ("external-evidence", "Single primary region + same-jurisdiction warm standby — production topology."),
    "INF-02": ("partial", "Local compose exists; integration/staging/production environments not provisioned."),
    "INF-03": ("partial", "Synthetic distributional data generator exists (eval harness); environment separation pending INF-02."),
    "INF-04": ("implemented", "Compose + migrations + ADRs + full K8s manifests (deploy/k8s: workloads, gateway, HPA, NetworkPolicy, canary) are code; scripts/validate_deploy.py asserts the invariants."),
    "INF-05": ("external-evidence", "API/match sizing 3x 2 vCPU/4 GB — production."),
    "INF-06": ("external-evidence", "Valkey 1 primary + 1 replica, 4 GB — production."),
    "INF-07": ("external-evidence", "Postgres 4 vCPU/16 GB, 500 GB SSD, PITR — production."),
    "INF-08": ("external-evidence", "Centrifugo 2 nodes x 2 vCPU — production."),
    "INF-09": ("superseded", "ClickHouse superseded by the OpenSearch-only decision (ADR-0006 / TECH-21)."),
    "INF-10": ("implemented", "autoscaling/v2 HPAs on edge + match: external p95 metric (120 ms target, 3-min window) with CPU fallback; scaleDown capped at 1 pod per 600 s; asserted by scripts/validate_deploy.py."),
    "INF-11": ("partial", "TLS termination, HSTS and CSP configured at APISIX (validated); OCSP stapling is delegated to the cert-manager issuance chain and needs production evidence."),
    "INF-12": ("implemented", "K8s: only APISIX reaches edge, only edge reaches match, everything else ClusterIP/headless; default-deny-all NetworkPolicy; asserted by scripts/validate_deploy.py."),
    "INF-13": ("external-evidence", "Edge DDoS mitigation + pre-launch test."),
    "INF-14": ("implemented", "Default-deny egress + per-workload egress allowlists (DNS only otherwise) in deploy/k8s/networkpolicy.yaml; asserted by scripts/validate_deploy.py."),
    "INF-15": ("gap-p0", "Merge -> signed reproducible artefact -> auto-deploy to integration — CI pipeline."),
    "INF-16": ("implemented", "Flagger Canary resources on the APISIX provider: 5% steps held 10 min, auto-rollback on success-rate/p95-latency breach (deploy/k8s/canary.yaml); asserted by scripts/validate_deploy.py. Requires Flagger + Prometheus in-cluster."),
    "INF-17": ("partial", "Forward-only migrations practised; rehearsal against a production-sized snapshot pending."),
    "INF-18": ("external-evidence", "PITR 5-min granularity, 35-day retention, quarterly timed restore."),
    "INF-19": ("external-evidence", "<=EUR1 500/mo at 100k MAU — Kubecost (P1) + monthly review."),
    "INF-20": ("organisational", "On-call staffing, escalation ladder, 30-min Sev-1 acknowledgement."),
    # ---------------- TECH ----------------
    "TECH-01": ("client", "React Native + Expo custom dev client; Expo Go prohibited (BLE)."),
    "TECH-02": ("implemented", "h3-js 4.x in both TS services; the client uses the same library family so cell ids agree bit-for-bit."),
    "TECH-03": ("implemented", "Dockerfiles on node:22-alpine, engines >=22, @types/node 22.10.2; TypeScript strict, pinned toolchain; tests green."),
    "TECH-04": ("partial", "Postgres 17 + PostGIS deployed; h3-pg extension not yet added."),
    "TECH-05": ("implemented", "Valkey 8 (BSD-3); no Redis anywhere."),
    "TECH-06": ("partial", "Centrifugo deployed; Valkey-as-broker not yet configured (in-memory engine in dev compose)."),
    "TECH-07": ("partial", "Three realm imports (consumer passkey policy / workforce hardware 2FA / partners roles) boot in compose; edge verifies RS256 via realm JWKS; passkey-only browser flow + SMS recovery config pending."),
    "TECH-08": ("client", "OpenMLS/vodozemac client crypto; libsignal prohibited (AGPL-3.0 vs closed client)."),
    "TECH-09": ("gap-p0", "pgvector for free-text linking only (FR-09), never in the match path — extension + service pending."),
    "TECH-10": ("superseded", "ClickHouse superseded by OpenSearch (ADR-0006 / TECH-21); aggregated events only."),
    "TECH-11": ("partial", "Fastify structured logs; OpenTelemetry traces + Grafana stack not wired (AGPL internal-only constraint noted)."),
    "TECH-12": ("partial", "Health endpoints + structured logs done; OpenTelemetry traces missing."),
    "TECH-13": ("implemented", "Golden-file suite (120 pairs) fails on any score change; 81-test Python regression suite."),
    "TECH-14": ("gap-p0", "Client<->server contract tests from a machine-readable schema (with TR-23)."),
    "TECH-15": ("partial", "Python engine is pure/deterministic; TS services read the wall clock directly — clock/id injection not formalised."),
    "TECH-16": ("client", "Dependency maintenance/licence/size budget; 45 MB bundle cap."),
    "TECH-17": ("organisational", "Team skills: TypeScript, React Native, Postgres, one systems language."),
    "TECH-18": ("gap-p0", "ARC language allocation: Rust match core + Go presence/venue/consent services outstanding; TS services are the documented P0 stand-in."),
    "TECH-19": ("implemented", "Kafka designated event backbone (ADR-0004); no Fluvio deployed; Kafka rollout itself is ARC P1."),
    "TECH-20": ("implemented", "No Temporal calls on the scan path (none exist anywhere); Temporal rollout is ARC P1."),
    "TECH-21": ("implemented", "No ClickHouse / second warehouse; APISIX is the sole public ingress — the only LoadBalancer Service, enforced by NetworkPolicy (validated); OpenSearch is P1."),
    "TECH-22": ("phase-gated", "Delta-on-Parquet bronze/silver/gold — P1 lakehouse; no analytics on the live match path (satisfied)."),
    "TECH-23": ("implemented", "No Mojaloop/TigerBeetle deployed; ARC-002 §9 gates them at P3."),
    "TECH-24": ("partial", "Canonical geometry in PostGIS (venues.geofence); GeoLibre authoring/QA workflow not built (TR-41)."),
    # ---------------- ACC ----------------
    "ACC-01": ("external-evidence", "This generated matrix + the test suites are the verification instrument; final gate at pilot."),
    "ACC-02": ("organisational", "Independent pen test with critical/high remediation + retest."),
    "ACC-03": ("organisational", "DPIA signed by DPO + accountable executive."),
    "ACC-04": ("external-evidence", "Load + soak profile on production-equivalent infrastructure."),
    "ACC-05": ("organisational", "Incident response rehearsed; on-call staffed; runbooks published."),
    "ACC-06": ("external-evidence", "Rollback drill: production release reverted <=10 min."),
    "ACC-07": ("organisational", "Three anchor venues contracted + dashboards verified."),
    "ACC-08": ("external-evidence", "Store review acceptance on both platforms — needs the client."),
    "ACC-09": ("external-evidence", "10-user first-time usability test (>=8 describe the product correctly) — needs the client."),
    "ACC-10": ("partial", "Eval pipeline complete (653-pair key, rating pack, scoring; self-test alpha 0.832, p@3 0.389); the real >=3-independent-rater study is outstanding."),
})

# ---------------------------------------------------------------- generation

SCAN_DIRS = ["presence", "services", "tests", "db", "docs", "deploy", "eval", "scripts"]
SCAN_EXTS = {".py", ".ts", ".sql", ".md", ".json", ".yml", ".yaml"}
SKIP_DIRS = {"node_modules", ".git", "__pycache__", "dist"}
MAX_EVIDENCE = 5


def collect_evidence() -> dict[str, list[str]]:
    """Map requirement id -> repo-relative files that mention it."""
    hits: dict[str, list[str]] = {}
    pattern = re.compile(r"\b(?:BR|FR|NFR|TR|SEC|INF|TECH|ACC)-\d{2,3}\b")
    for d in SCAN_DIRS:
        root_dir = os.path.join(REPO, d)
        if not os.path.isdir(root_dir):
            continue
        for root, dirs, files in os.walk(root_dir):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            for f in files:
                if os.path.splitext(f)[1] not in SCAN_EXTS:
                    continue
                path = os.path.join(root, f)
                rel = os.path.relpath(path, REPO)
                if rel.endswith(("traceability.md", "traceability.json", "build_traceability.py")):
                    continue
                try:
                    with open(path, encoding="utf-8", errors="ignore") as fh:
                        text = fh.read()
                except OSError:
                    continue
                for rid in set(pattern.findall(text)):
                    hits.setdefault(rid, [])
                    if rel not in hits[rid]:
                        hits[rid].append(rel)
    return hits


def main() -> int:
    evidence = collect_evidence()
    rows: OrderedDict[str, dict] = OrderedDict()
    missing = []
    for fam, (title, count) in FAMILIES.items():
        for i in range(1, count + 1):
            rid = f"{fam}-{i:02d}"
            if rid not in CLASSIFICATION:
                missing.append(rid)
                continue
            status, note = CLASSIFICATION[rid]
            rows[rid] = {
                "family": fam,
                "status": status,
                "evidence": sorted(evidence.get(rid, []))[:MAX_EVIDENCE],
                "note": note,
            }
    if missing:
        print("MISSING classification for:", ", ".join(missing), file=sys.stderr)
        return 1

    counts: dict[str, int] = {s: 0 for s in STATUS_ORDER}
    per_family: dict[str, dict[str, int]] = {}
    for rid, row in rows.items():
        counts[row["status"]] += 1
        pf = per_family.setdefault(row["family"], {s: 0 for s in STATUS_ORDER})
        pf[row["status"]] += 1

    out_json = {
        "spec": "PRS-SRS-001 v1.0 / PRS-ARC-002",
        "generated_by": "scripts/build_traceability.py",
        "total": len(rows),
        "status_counts": counts,
        "per_family": per_family,
        "requirements": rows,
    }
    with open(os.path.join(REPO, "docs", "traceability.json"), "w") as fh:
        json.dump(out_json, fh, indent=2)
        fh.write("\n")

    lines: list[str] = []
    lines.append("# Traceability matrix — PRS-SRS-001 v1.0 / PRS-ARC-002")
    lines.append("")
    lines.append("GENERATED ARTEFACT — do not hand-edit. Regenerate with "
                 "`python3 scripts/build_traceability.py` (SRS §10: the matrix is "
                 "generated, not hand-maintained).")
    lines.append("")
    lines.append(f"Total requirements: **{len(rows)}** "
                 f"(283 MUST · 22 SHOULD · 1 MAY per Appendix A).")
    lines.append("")
    lines.append("## Status summary")
    lines.append("")
    lines.append("| Status | Count | Meaning |")
    lines.append("|---|---|---|")
    meaning = {
        "implemented": "working in the repo with tests or structural evidence",
        "partial": "meaningful part implemented; named gap remains",
        "gap-p0": "ARC-P0 product scope, code not yet built",
        "phase-gated": "ARC P1+ component; correctly deferred per TR-40 / ARC-002 §9",
        "client": "requires the React Native client workstream",
        "organisational": "legal / process / staffing — not expressible as code",
        "external-evidence": "needs production infrastructure or third-party evidence",
        "superseded": "superseded by a recorded ADR",
    }
    for s in STATUS_ORDER:
        lines.append(f"| {s} | {counts[s]} | {meaning[s]} |")
    lines.append("")
    lines.append("## Per-family breakdown")
    lines.append("")
    header = "| Family | " + " | ".join(STATUS_ORDER) + " | total |"
    lines.append(header)
    lines.append("|---|" + "---:|" * (len(STATUS_ORDER) + 1))
    for fam, (title, _count) in FAMILIES.items():
        pf = per_family.get(fam, {})
        cells = " | ".join(str(pf.get(s, 0)) for s in STATUS_ORDER)
        lines.append(f"| {fam} | {cells} | {sum(pf.values())} |")
    lines.append("")
    for fam, (title, _count) in FAMILIES.items():
        lines.append(f"## {fam} — {title}")
        lines.append("")
        lines.append("| ID | Status | Evidence | Basis |")
        lines.append("|---|---|---|---|")
        for i in range(1, _count + 1):
            rid = f"{fam}-{i:02d}"
            row = rows[rid]
            ev = "<br>".join(f"`{e}`" for e in row["evidence"]) or "—"
            lines.append(f"| {rid} | {row['status']} | {ev} | {row['note']} |")
        lines.append("")
    with open(os.path.join(REPO, "docs", "traceability.md"), "w") as fh:
        fh.write("\n".join(lines))

    print(f"requirements: {len(rows)}")
    for s in STATUS_ORDER:
        print(f"  {s:18s} {counts[s]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# Requirement traceability — PRS-SRS-001 / PRS-ARC-002 → implementation

## Functional requirements

| Req | Requirement | Implementation | Verification |
|---|---|---|---|
| FR-10 | Sensitive interests never enter matching or reasons | `matching.py` `vector`/`_reduced`; `engine.ts` `vector`/`reduced` | `test_sensitive_excluded_at_write_time` |
| FR-11 | ≥2 declared interests to be discoverable | `matching.py` `MIN_PROFILE`; match `store.ts` corpus filter, `server.ts` scan filter | scan tests |
| FR-14 | Presence TTL 15 min | edge `routes/presence.ts` `PRESENCE_TTL_S`; `docs/presence-model.md` | code review; TTL test |
| FR-20 | ≤3 candidates per scan, each with reasons | match `scan.ts` `rankScan`, `MAX_SCAN_RESULTS` | `a scan returns at most three candidates` |
| FR-21 | Adaptive threshold: (1−5/n)-quantile, floored at base | match `scan.ts` `adaptiveThreshold` | `adaptive threshold floors at the venue base` |
| FR-22 | MMR diversification | match `scan.ts` `rankScan` MMR loop | scan tests |
| FR-23 | 10-min suppression of surfaced pairs | edge `routes/scan.ts`, `context.ts` `suppressionKey` | `suppression keys are canonically ordered` |
| FR-24 | 6 scans/min/user | edge `routes/scan.ts` rate-limit config | config review |
| FR-25 | Proximity bands, never metres | match `scan.ts` `bandFor`; responses carry bands only | `proximity is bands, never metres` |
| FR-26 | Empty state below 8 present users | match `server.ts` `MIN_CELL_POPULATION` → `state: "quiet"` | code review |
| FR-27 | Deterministic icebreaker from reason path | `matching.py` `icebreaker`; `engine.ts` `icebreaker` | `test_reason_list_shape` |
| FR-29 | Consent machine DETECTED→NUDGED→EXPRESSED→MUTUAL→OPEN | db `consent_transition_ok` trigger; edge `routes/consent.ts` | trigger rejects illegal jumps |
| FR-30 | No identity before OPEN | db RLS `identity_owner`/`identity_after_open`; edge strips identity pre-OPEN | policy review |
| FR-35 | Append-only consent ledger | db `consent_ledger` trigger + revoked UPDATE/DELETE grants | privilege review |
| FR-36 | MLS E2E messaging post-OPEN | db `messages` (opaque envelopes) + RLS; edge `routes/messages.ts` | policy review |

## Technical requirements

| Req | Requirement | Implementation | Verification |
|---|---|---|---|
| TR-04 | Closure decay 0.55/hop, ≤4 hops | `graph.py` `DECAY`/`closure`; `engine.ts` `closure` | `test_closure_decay`, `test_closure_max_depth_four` |
| TR-05 | df over link-free closures of live population, ≥60 s refresh | `matching.py` `Corpus.from_vectors`; match `store.ts` `rebuildCorpus` | `test_links_excluded_from_document_frequency` |
| TR-06 | idf = sqrt(ln(1+N/(1+df))) | `Corpus.idf` (both languages) | `test_idf_compressed_and_bounded`; 653/653 key |
| TR-07 | Semantic links: one hop, authored weight, excluded from df | `graph.py` links; `vector(with_links)` both languages | key-pinned rivalry/neighbour pairs |
| TR-08 | Ordered reason list | `Matcher._reasons` / `reasons` | golden reason parity test |
| TR-09 | Deterministic reason text, no LLM | `icebreaker` templates (both languages) | golden parity; template tests |
| TR-10 | Deterministic scoring + ≥50-pair regression | `tests/test_matching.py` 60 key-pinned pairs; TS golden fixture | 81 Python tests, 7 TS tests |
| TR-11 | Per-venue threshold config | db `venues.base_threshold`/`max_scan_results`; edge scan route | unit tests |
| TR-12/14 | H3 res-9 k=1; descend to 10 >2 000, 11 >10 000 presences | edge `routes/presence.ts` `resolutionFor` | `resolution ladder follows venue density` |
| TR-15 | Coordinates rejected server-side | edge `auth.ts` `containsCoordinates` | `any coordinate-shaped field is rejected` |
| TR-17 | Taxonomy depth ≤5 | `InterestGraph._validate` / `validate` | `test_graph_is_acyclic_and_shallow` |
| TR-18 | Materialized closure in Postgres | db `taxonomy_closure`; `scripts/export_taxonomy_sql.py` | seed row counts vs graph |
| TR-19 | Stable node ids; deprecation = redirect | db `taxonomy_nodes.redirect_to`; `Node.redirect` | schema review |
| TR-22 | Sensitive nodes excluded at write time | `Node.sensitive`; vector/reduced skip | `test_sensitive_excluded_at_write_time` |

## Evaluation (ACC-10)

| Item | Implementation | Status |
|---|---|---|
| Eval pack generation | `presence/eval_harness.py` → `eval/key.csv`, `rating-pack.xlsx`, `MANIFEST.json` | item composition identical to reference key (0 profile mismatches) |
| Rater scoring | `presence/eval_score.py` — Krippendorff alpha, precision@3 + bootstrap CI, band/venue curves | self-test: alpha 0.832, p@3 0.389 (CI 0.344–0.431) vs 0.33 — PASS |
| Answer-key reproduction | `matching.py` | 653/653 pair scores exact to 4 dp |

# Identity assurance — KYC gate and recognition anchors

SRS Addendum 001 (batch 48) records the owner's amendment: every account
that can appear in discovery is KYC-verified and vetted, and a match can
be recognised in a crowded space by a curated symbol — without a
photograph changing hands before consent. The amendment is safety- and
privacy-first: it ADDS a gate in front of discovery and a non-identity
anchor; it loosens nothing in the FR-30/FR-87 boundary.

## Component map

| Piece | Governing | Module | What it guarantees |
| --- | --- | --- | --- |
| KYC state | AMD-KYC-01..05 | `db/migrations/0024_kyc_avatars.sql` | `users.kyc_state` is a four-state column (`pending`/`verified`/`rejected`/`suspended`) defaulting to `pending`, so existing and new accounts start OUTSIDE discovery. Data minimisation is structural: the schema holds an opaque provider reference, the state, the timestamp and the reviewing actor — never documents, legal names or dates of birth. |
| KYC decisions | AMD-KYC-03/05 | `record_kyc_decision` (migration 0024) | The five legal transitions are enforced by the definer itself (mirroring the FR-29 trigger discipline), not by endpoint logic. Only a moderator (or the provider-callback GUC) may move a state; every decision writes an `admin_audit_log` row with from/to and the actor, composable with FR-55 review. |
| Discovery gate | AMD-KYC-01 | `discovery_eligible` view + `services/match/src/store.ts` | Discovery reads `attested_accounts ∩ kyc_verified_accounts`. The gate fails closed in both directions: no attestation, no entry (FR-51/SEC-19); no verified KYC, no entry. `attested_accounts` itself is unchanged — attestation remains a distinct property. |
| Pair avatar read | AMD-KYC-04/AMD-AVT-02 | `pair_avatar` (migration 0024) | The ONLY pre-OPEN identity read: the counterpart's avatar key when the pair is NUDGED or later, or the caller's own. RLS is row-level, so the column-narrowing lives in the definer; name, photo and everything else stay behind FR-30. |
| Avatar registry | AMD-AVT-01/04 | `services/edge/src/identity.ts` + `client/src/presence/identityAssurance.ts` | Twelve curated abstract symbols — never user-uploaded, never photo-derived, never free text. The edge and client copies are byte-identical and cross-pinned by `tests/test_batch48.py`; any drift fails the build. Every `paletteRole` is a CLIENT_PALETTE role, so the NFR-25 contrast audit covers every symbol by construction. |
| Avatar discipline | AMD-AVT-03 | `routes/identity.ts` + `planAvatarChange` | A symbol changes at most once per 24 h and never while a conversation is OPEN — an anchor that shifts mid-negotiation is a confusion and evasion vector. The client planner refuses with exactly one pinned reason so the UI can explain it. |
| Recognition anchor | AMD-AVT-02 | `buildRecognitionAnchor` + `buildMatchScreen` | Pre-OPEN the anchor is the symbol alone; the name joins only at OPEN (FR-30). The descriptor has no photo field — the FR-87 photo ban holds by construction. On screen the anchor is an optional header text node on the match screen, supplied from the `pair_avatar` contract — never from the reason payload, which still builds the MatchSurface alone. |
| Status read | AMD-KYC-04 | `GET /v1/identity/status` | The only consumer read of the assurance state, answering the owner alone: KYC status, avatar, and nothing else. |

## What is deliberately NOT here

- **KYC vendor integration**: choosing and wiring a verification provider
  (document capture, liveness, sanctions screening) is organisational —
  procurement, a data-processing agreement, and the FR-55 workforce
  process that operates the review queue. The platform stores only the
  opaque outcome.
- **User-uploaded or generated avatars**: uploads, photo-derived symbols
  and free text are refused by construction (AMD-AVT-01). If the curated
  set ever grows it does so as a registry edit both halves ship
  together, pinned by the byte-identical cross-check.
- **Peer-to-peer payments**: the BR-06 revision is initiated
  (AMD-PAY-01/02) but the TECH-23 deployment gate stands until a
  payments compliance programme is approved; the transfer contracts land
  in batch 49.

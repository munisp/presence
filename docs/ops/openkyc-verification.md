# OpenKYC verification (AMD-KYC-06..10)

How a member becomes `kyc_state = 'verified'` through the in-house open
pipeline — and how operators run it.

## The member journey

1. **Open a session** — `POST /v1/identity/kyc/session`. The member must
   be `pending` or `rejected`; one open session at a time (a repeat
   answers 200 with the open session). The response carries the
   randomized liveness challenge (3 of 5 actions, shuffled, per-action
   windows), the single-use signed upload token, the expiry (600 s) and
   the upload URL.
2. **Liveness + capture** — on the member's attested device (FR-51), the
   client walks the challenge (`capturePlan`), captures a short frame
   burst per action, then a credential frame set. The upload goes to the
   OpenKYC service directly — the platform API never carries a capture.
3. **The verdict** — the pipeline verifies the token BEFORE decoding a
   frame, fuses six liveness signals (challenge response, rPPG pulse,
   moiré, depth, rigidity, injection) with the authenticity score
   (Docling structure + VLM semantics, even split), purges the capture
   in place, and posts the signed verdict to the edge webhook.
4. **The outcome** —
   - `verified` (both scores ≥ 0.80, over-18, in-date credential):
     `record_kyc_decision` composes; a previously rejected member walks
     the legal `rejected → pending → verified` path; the AMD-ONB-06
     review stamp clears.
   - `rejected` (either score < 0.50, under-18, or out-of-date
     credential): the state moves; the member may open a new session.
   - `review` (mid-band scores): NO auto-decision — the session parks in
     the manual worklist (`GET /v1/moderation/kyc-sessions`) and the
     AMD-ONB-06 stamp routes it to `kyc_review_queue`; a moderator
     decides through the existing KYC decision route.

The member polls `GET /v1/identity/kyc/session` — state and timestamps
only; scores are never projected to the member (they would aid spoof
probing). `sessionAction` maps each state to the next allowed step.

## What the platform stores

The challenge digest, the state machine, the derived facts (credential
kind, over-18, credential validity, two scores, opaque provider ref) and
the append-only event ledger — never a capture, a legal name, a
credential number or a date of birth. A `verified` row that is not
over-18 or not on a valid credential is unrepresentable in storage.

## Operations

| Signal | Where |
| --- | --- |
| Webhook results | `presence_kyc_webhook_results_total{result}` — watch `unconfigured` (missing `KYC_VERDICT_SECRET`) and `rejected` spikes (grinding or a bad shared secret) |
| Review backlog | `GET /v1/moderation/kyc-sessions` — review-state sessions, oldest first |
| Stale sessions | `expire_kyc_sessions()` — the sweeper; idempotent, no GUC |
| Audit | `kyc.session.issued / .verified / .rejected / .review` rows in the admin audit log |

### Engine modes

`OPENKYC_ENGINES=reference` (default) runs the deterministic engines —
zero third-party dependencies, what CI and the rehearsal exercise.
`OPENKYC_ENGINES=real` requires PaddleOCR, Docling and a VLM
(`OPENKYC_VLM_MODEL` picks the weights); a missing engine refuses the
process start — never a silent downgrade.

### Configuration

`KYC_CHALLENGE_SECRET` (edge + openkyc), `KYC_VERDICT_SECRET`
(edge + openkyc), `EDGE_VERDICT_URL` (openkyc), `OPENKYC_UPLOAD_URL`
(edge → client hint, default `/openkyc/v1/captures`).

### Failure posture

- Unset secrets answer 503 on BOTH sides — the wire exists, the
  credential arrives with the deployment.
- Freshness is checked BEFORE the signature (300 s skew).
- Every authorization gate is NULL-safe (`IS [NOT] DISTINCT FROM 'on'`):
  an unset GUC on a cold pooled connection is FALSE, never NULL — the
  batch-63 rehearsal finding that re-pinned the four console helpers and
  both KYC decision gates.
- A verdict whose digest does not match the issued session is a 401 —
  forgery signal, counted.
- A replayed verdict answers `replayed` and changes nothing.
- Purge precedes verdict: the ledger records `capture_purged` before
  any state moves.

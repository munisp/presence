# OpenKYC — the in-house verification provider (AMD-KYC-06..10)

An open-source KYC pipeline for Presence: **PaddleOCR** (text extraction),
**Docling** (layout/structure parsing) and a **VLM** (semantic authenticity)
behind one conformance interface, plus deterministic reference engines for
CI. It is the in-house realization of the AMD-KYC-02 "verification
provider": the platform stores a verdict and derived facts only — never a
capture, a legal name, a credential number or a date of birth.

## Pipeline

```
client ── upload (signed challenge token) ──▶ POST /v1/captures
        intake: token verified BEFORE a frame is decoded
        liveness (AMD-KYC-07): challenge-response, rPPG pulse, moire,
                               depth, rigidity, injection — six fused
                               signals, pinned weights
        credential analysis (AMD-KYC-06): PaddleOCR text, Docling
                               structure, VLM authenticity
        fusion: verified | rejected | review (pinned thresholds)
        purge (AMD-KYC-10): frame buffers overwritten in place, receipt
                               logged — nothing ever touches disk
        callback (AMD-KYC-09): HMAC-signed verdict (timestamp-first,
                               300 s freshness) → edge webhook →
                               complete_kyc_session → record_kyc_decision
```

## Engine modes

- `OPENKYC_ENGINES=reference` (default): deterministic sha256-derived
  engines; the whole pipeline runs with zero third-party dependencies —
  this is what CI and the full-chain rehearsal exercise.
- `OPENKYC_ENGINES=real`: requires all three adapters importable
  (`paddleocr`+`paddlepaddle`, `docling`, a transformers-style VLM whose
  model id comes from `OPENKYC_VLM_MODEL`). A missing engine refuses the
  process start — never a silent downgrade.

## Configuration

| Variable               | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `OPENKYC_PORT`         | listen port (default 4200)                       |
| `KYC_CHALLENGE_SECRET` | HMAC key verifying the single-use upload tokens  |
| `EDGE_VERDICT_URL`     | the edge webhook URL for signed verdicts         |
| `KYC_VERDICT_SECRET`   | HMAC key signing verdicts to the edge            |
| `OPENKYC_ENGINES`      | `reference` (default) or `real`                  |
| `OPENKYC_VLM_MODEL`    | VLM model id (real mode only)                    |

## Hard rules

- The service never writes OLTP (ADR-0009) — its only egress is the
  signed edge callback.
- No capture is ever persisted: no upload directory, no spool, no temp
  files; frames are in-memory buffers purged before the verdict leaves.
- The verdict wire form is exactly the nine pinned fields
  (`VERDICT_FIELDS`); anything more is a spec amendment.

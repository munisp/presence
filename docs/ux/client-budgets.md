# Client budgets — performance and dependency contracts

The measurable NFRs and TECH-16 get the same treatment as the surface
batches: the enforceable client-side half lands as framework-free
contracts in `client/src/presence/`, audited fail-closed in CI. Where a
requirement is a measurable claim (seconds, %/h, frames per second), the
contract pins the budget ledger the device behaviour must fit and the
profiling pass on reference hardware remains the named gap; where the
requirement is a code property (refresh cadence, no idle radio wake,
dependency admission), the contract closes it outright.

## Component map

| SRS item | Governing | Contract module | What it guarantees |
| --- | --- | --- | --- |
| start-up budget | NFR-04, NFR-05 | `startupBudget.ts` | The pinned phase ledger for cold and warm starts. Cold start pays for native init (350 ms), the JS bundle (550 ms), the TR-30 secure-store read (150 ms), the TR-33 cached-config read (100 ms — network revalidation happens AFTER interactive), first render (500 ms) and the interactive handoff (150 ms): exactly the 1800 ms NFR-04 ceiling. Warm start pays nothing for the resident native runtime or JS bundle and sums to exactly the 600 ms NFR-05 ceiling, with no warm phase dearer than its cold twin. Work that would tax every start-up — BLE start, taxonomy prefetch, analytics flush, ambient-widget sync, push-token refresh — is pinned to the post-interactive queue and audited off the critical path. The ledger fails closed: garbage or over-budget plans cannot pass. Device profiling on the reference mid-tier remains (partial). |
| power budget | NFR-29, NFR-30 | `powerBudget.ts` | The duty-cycle ledger. Fixed consumers (BLE advertise 650, BLE scan 450, UI render 400 mp/h) plus publish and cell work priced per activation and COMPUTED from the FR-85 cadence (`publishIntervalS` cross-imported, never duplicated): 12 activations/h standard, 6/h reduced — both modes inside the 2000 mp/h (2 %/h) NFR-29 ceiling, reduced strictly cheaper, which is the FR-85 trade-off in numbers. NFR-30 is structural: the background work registry is EMPTY when background presence is off — parity with a no-op app by doing nothing — and holds exactly the BLE central wake when opted in, cross-pinned to app.json (UIBackgroundModes `bluetooth-central`; `ACCESS_BACKGROUND_LOCATION` blocked). Device battery profiling remains (partial). |
| frame budget | NFR-35, NFR-36 | `frameBudget.ts` | The match-surface render ledger (layout 4, path geometry 6, label measure 3, paint commit 3 = 16 ms) fits the 60 fps frame budget AND the 30 fps floor, so the planned work fits the weakest legal device; garbage or over-budget render plans fail closed. On-device fps profiling remains (NFR-35 partial). NFR-36 closes outright: the ambient refresh gate enforces at most one refresh per minute (first refresh allowed, garbage clocks and backwards time refuse), the pinned refresh sources are push and app-active only — poll is absent by construction, so an idle device never wakes the radio — and an approved refresh carries the FR-86/SEC-35 contentless payload built locally with zero network fetches. |
| dependency budget | TECH-16 | `dependencyBudget.ts` | The 45 MB bundle cap with one size allocation per runtime dependency (31 MB allocated across the seven package.json runtime deps, cross-pinned; 14 MB of argued headroom). The licence allowlist mirrors the SEC-25 CI set (MIT/ISC/BSD/Apache-2.0/0BSD/CC0) with a prohibited-marker screen in front — any GPL/AGPL/LGPL/SSPL/Commons-Clause marker refuses outright, the same discipline TECH-08 applies to libsignal. The admission gate refuses in pinned order: non-positive size, not on the SEC-18 allowlist, deprecated, licence refused, bundle over cap. Maintenance rules pinned for uniform review. Implemented: the SEC-18 CI gate enforces membership on every push. |

## What is deliberately NOT here

Seven requirements remain client-gated in the traceability matrix:
FR-70 (verification status at identity reveal), NFR-25/26/37
(accessibility: WCAG 2.2 AA, 44 pt targets, one-handed reach), NFR-27
(localisation), NFR-28 (OS floors with BLE-floor degradation) and
TECH-08 (OpenMLS/vodozemac E2E crypto). These are the next batch's
scope. The five measurable budget requirements above (NFR-04/05/29/30/
35) keep their partial status until the device-profiling pass on
reference hardware lands — the ledgers here are what that pass measures
against.

# match-core — the Rust match engine (TECH-18)

The ARC language allocation puts the match core in Rust. This crate is that
core: a faithful port of the TypeScript engine (`services/match/src/engine.ts`),
itself a port of the verified Python reference (`presence/matching.py`), all
three pinned to the same golden corpus.

## Contract

- Score: `sim(A,B) = Σ idf(n)·wA(n)·wB(n) / (‖vA‖·‖vB‖)` with a 5%
  exact-overlap bonus per co-declared node, capped at 1.0.
- TR-04 closure decay 0.55/hop, max 4 hops, max-combine; TR-05 link-free
  document frequency; TR-06 sqrt-compressed log-smoothed idf; TR-07 semantic
  links at authored weight, excluded from df; TR-08/09/10 deterministic,
  ordered, LLM-free reasons — every accumulation iterates in sorted node
  order, so results are bit-stable across processes and hash seeds.
- TR-36 global prior blend, fading to exactly zero at N = 30 live documents.

## Verification

`cargo test` (wired into CI as the `match-core` job):

- `tests/golden.rs` — parity to **1e-9 with the shared golden corpus**
  (`services/match/test/golden.json`, 120 pairs): scores, reason kinds,
  order and contributions, plus bit-determinism across independent engine
  constructions. This is the same file the TS engine and Python reference
  are pinned to; the Python side reproduces the ACC-10 answer key 653/653.
- `tests/unit.rs` — structural contract: graph validation (unknown link
  endpoints, unknown parents, cycles, depth > 5), closure decay, link
  contribution vs df exclusion, sensitive-node exclusion (FR-10), prior
  fade, exact-overlap cap, reason ordering.

`Cargo.lock` is committed (SEC-24 pinning discipline).

## Serving

The TypeScript match service remains the P0 serving stand-in (documented in
the ARC traceability); this crate is the verified core it migrates to. The
binding into serving (native addon or sidecar) is a deployment decision and
changes no scoring behaviour — parity is pinned by the golden suite either
way.

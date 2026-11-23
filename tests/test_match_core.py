#!/usr/bin/env python3
"""TECH-18 acceptance criteria: the ARC-allocated Rust match core.

The behavioural evidence is the crate's own cargo suite — pinned to 1e-9
against the same golden corpus as the TypeScript engine and the Python
reference — wired into CI as the match-core job. These tests pin the
crate's existence and contract surface, the parity-test wiring, the CI
job, and the honesty of the serving note (the TS service remains the
documented P0 stand-in; the core changes no scoring behaviour).

Run: python3 -m pytest tests/test_match_core.py
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CRATE = ROOT / "services/match-core"
LIB = (CRATE / "src/lib.rs").read_text()
GOLDEN_TEST = (CRATE / "tests/golden.rs").read_text()
UNIT_TEST = (CRATE / "tests/unit.rs").read_text()
CARGO_TOML = (CRATE / "Cargo.toml").read_text()
README = (CRATE / "README.md").read_text()
CI = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())


# ------------------------------------------------------------- crate -------

def test_tech18_crate_exists_with_committed_lockfile() -> None:
    assert (CRATE / "Cargo.toml").is_file()
    assert (CRATE / "Cargo.lock").is_file()   # SEC-24 pinning discipline
    assert (CRATE / "src/lib.rs").is_file()
    assert (CRATE / ".gitignore").read_text().strip() == "target/"


def test_tech18_lib_is_dependency_free() -> None:
    # The scoring core itself has no runtime dependencies; serde is dev-only
    # (golden parsing in tests).
    assert "[dependencies]" not in CARGO_TOML
    assert "[dev-dependencies]" in CARGO_TOML


def test_tech18_governed_constants() -> None:
    for decl in (
        "pub const DECAY: f64 = 0.55;",
        "pub const EXPANSION_DEPTH: usize = 4;",
        "pub const MAX_DEPTH: usize = 5;",
        "pub const EXACT_OVERLAP_BONUS: f64 = 0.05;",
        "pub const PRIOR_FADE_N: f64 = 30.0;",
    ):
        assert decl in LIB, decl


def test_tech18_score_contract_surface() -> None:
    # Same engine surface as the TS stand-in: graph, corpus, matcher,
    # reasons, icebreaker.
    for symbol in (
        "pub struct InterestGraph",
        "pub struct Corpus",
        "pub struct Matcher",
        "pub fn closure(",
        "pub fn idf(",
        "pub fn vector(",
        "pub fn score(",
        "pub fn declared(",
        "pub fn icebreaker(",
    ):
        assert symbol in LIB, symbol


def test_tech18_determinism_by_sorted_iteration() -> None:
    # TR-10: accumulations iterate in sorted node order — bit-stable across
    # processes and hash seeds, stronger than insertion-order reliance.
    assert "shared_keys.sort()" in LIB
    assert re.search(r"keys\.sort\(\)", LIB)
    assert "total_cmp" in LIB


# --------------------------------------------------------- golden parity ---

def test_tech18_golden_test_reads_the_shared_corpus() -> None:
    # The same file pins all three implementations — the crate does not
    # carry a copy that could drift.
    assert 'include_str!("../../match/test/golden.json")' in GOLDEN_TEST
    assert not (CRATE / "tests/golden.json").exists()
    assert "1e-9" in GOLDEN_TEST
    assert 'assert_eq!(golden.pairs.len(), 120' in GOLDEN_TEST


def test_tech18_golden_test_covers_scores_and_reasons() -> None:
    assert "golden_pair_scores_agree_with_the_reference_to_1e9" in GOLDEN_TEST
    assert "golden_reason_lists_agree_in_kind_node_order_and_contribution" in GOLDEN_TEST
    assert "scoring_is_bit_deterministic_across_runs" in GOLDEN_TEST


def test_tech18_unit_tests_cover_structural_contract() -> None:
    for test in (
        "graph_rejects_unknown_link_endpoints",
        "graph_rejects_unknown_parents",
        "graph_rejects_cycles",
        "graph_rejects_depth_beyond_five",
        "vector_excludes_sensitive_declarations",
        "links_contribute_at_authored_weight_but_never_to_df",
        "prior_blend_fades_to_exactly_zero_at_thirty",
        "exact_overlap_bonus_is_capped_at_one",
    ):
        assert f"fn {test}(" in UNIT_TEST, test


# ----------------------------------------------------------------- CI ------

def test_tech18_ci_job_runs_cargo_test_locked() -> None:
    job = CI["jobs"]["match-core"]
    runs = "\n".join(str(s.get("run", "")) for s in job["steps"])
    assert "cargo test --locked --manifest-path services/match-core/Cargo.toml" in runs
    uses = " ".join(str(s.get("uses", "")) for s in job["steps"])
    assert "dtolnay/rust-toolchain@stable" in uses


# ------------------------------------------------------------- honesty -----

def test_tech18_readme_records_parity_and_serving_story() -> None:
    assert "1e-9" in README
    assert "services/match/test/golden.json" in README
    assert "P0 serving stand-in" in README

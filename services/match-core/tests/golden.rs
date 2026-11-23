//! Parity suite: the Rust match core must reproduce the shared golden
//! corpus (the same file the TypeScript engine and the Python reference are
//! pinned to — the Python side reproduces the ACC-10 answer key 653/653)
//! to 1e-9 on every pair: scores and the full ordered reason lists
//! (TR-08, TR-10).

use match_core::{Corpus, InterestGraph, Matcher, Profile};
use serde::Deserialize;
use std::collections::HashMap;

const GOLDEN: &str = include_str!("../../match/test/golden.json");
const TOLERANCE: f64 = 1e-9;

#[derive(Deserialize)]
struct Golden {
    taxonomy: GoldenTaxonomy,
    corpus: GoldenCorpus,
    pairs: Vec<GoldenPair>,
}

#[derive(Deserialize)]
struct GoldenTaxonomy {
    nodes: Vec<GoldenNode>,
    #[serde(default)]
    links: Vec<GoldenLink>,
}

#[derive(Deserialize)]
struct GoldenNode {
    nid: String,
    label: String,
    parent: Option<String>,
    kind: String,
    sensitive: bool,
}

#[derive(Deserialize)]
struct GoldenLink {
    a: String,
    b: String,
    kind: String,
    weight: f64,
}

#[derive(Deserialize)]
struct GoldenCorpus {
    size: usize,
    df: HashMap<String, f64>,
}

#[derive(Deserialize)]
struct GoldenPair {
    a: Vec<String>,
    b: Vec<String>,
    score: f64,
    reasons: Vec<GoldenReason>,
}

#[derive(Deserialize)]
struct GoldenReason {
    kind: String,
    node: String,
    contribution: f64,
}

fn profile(nids: &[String]) -> Profile {
    nids.iter().map(|n| (n.clone(), 1.0)).collect()
}

#[test]
fn golden_pair_scores_agree_with_the_reference_to_1e9() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden.json parses");
    let graph = InterestGraph::new(
        golden
            .taxonomy
            .nodes
            .iter()
            .map(|n| match_core::GraphNode {
                nid: n.nid.clone(),
                label: n.label.clone(),
                parent: n.parent.clone(),
                kind: n.kind.clone(),
                sensitive: n.sensitive,
            })
            .collect(),
        golden
            .taxonomy
            .links
            .iter()
            .map(|l| match_core::GraphLink {
                a: l.a.clone(),
                b: l.b.clone(),
                kind: l.kind.clone(),
                weight: l.weight,
            })
            .collect(),
    )
    .expect("golden taxonomy is valid");
    let matcher = Matcher::new(&graph);
    let corpus = Corpus::new(golden.corpus.size, golden.corpus.df);

    assert_eq!(golden.pairs.len(), 120, "the golden corpus is the governed 120 pairs");
    for p in &golden.pairs {
        let m = matcher
            .score(&profile(&p.a), &profile(&p.b), &corpus)
            .expect("golden pair scores");
        assert!(
            (m.score - p.score).abs() < TOLERANCE,
            "score drift on {:?} x {:?}: {} != {}",
            p.a,
            p.b,
            m.score,
            p.score
        );
    }
}

#[test]
fn golden_reason_lists_agree_in_kind_node_order_and_contribution() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden.json parses");
    let graph = InterestGraph::new(
        golden
            .taxonomy
            .nodes
            .iter()
            .map(|n| match_core::GraphNode {
                nid: n.nid.clone(),
                label: n.label.clone(),
                parent: n.parent.clone(),
                kind: n.kind.clone(),
                sensitive: n.sensitive,
            })
            .collect(),
        golden
            .taxonomy
            .links
            .iter()
            .map(|l| match_core::GraphLink {
                a: l.a.clone(),
                b: l.b.clone(),
                kind: l.kind.clone(),
                weight: l.weight,
            })
            .collect(),
    )
    .expect("golden taxonomy is valid");
    let matcher = Matcher::new(&graph);
    let corpus = Corpus::new(golden.corpus.size, golden.corpus.df);

    for p in &golden.pairs {
        let m = matcher
            .score(&profile(&p.a), &profile(&p.b), &corpus)
            .expect("golden pair reasons");
        assert_eq!(
            m.reasons.len(),
            p.reasons.len(),
            "reason count on {:?} x {:?}",
            p.a,
            p.b
        );
        for (got, want) in m.reasons.iter().zip(p.reasons.iter()) {
            assert_eq!(got.kind.as_str(), want.kind, "reason kind on {}", want.node);
            assert_eq!(got.node, want.node, "reason node order");
            assert!(
                (got.contribution - want.contribution).abs() < TOLERANCE,
                "contribution drift on {}: {} != {}",
                want.node,
                got.contribution,
                want.contribution
            );
        }
    }
}

#[test]
fn scoring_is_bit_deterministic_across_runs() {
    // TR-10: identical inputs and corpus state produce identical output —
    // bit-identical here, across two independent engine constructions, so
    // hash-seed randomisation cannot leak into results.
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden.json parses");
    let build = || {
        let graph = InterestGraph::new(
            golden
                .taxonomy
                .nodes
                .iter()
                .map(|n| match_core::GraphNode {
                    nid: n.nid.clone(),
                    label: n.label.clone(),
                    parent: n.parent.clone(),
                    kind: n.kind.clone(),
                    sensitive: n.sensitive,
                })
                .collect(),
            golden
                .taxonomy
                .links
                .iter()
                .map(|l| match_core::GraphLink {
                    a: l.a.clone(),
                    b: l.b.clone(),
                    kind: l.kind.clone(),
                    weight: l.weight,
                })
                .collect(),
        )
        .expect("valid");
        let corpus = Corpus::new(golden.corpus.size, golden.corpus.df.clone());
        (graph, corpus)
    };
    let (g1, c1) = build();
    let (g2, c2) = build();
    let p = &golden.pairs[0];
    let r1 = Matcher::new(&g1).score(&profile(&p.a), &profile(&p.b), &c1).unwrap();
    let r2 = Matcher::new(&g2).score(&profile(&p.a), &profile(&p.b), &c2).unwrap();
    assert_eq!(r1.score.to_bits(), r2.score.to_bits());
    for (a, b) in r1.reasons.iter().zip(r2.reasons.iter()) {
        assert_eq!(a.contribution.to_bits(), b.contribution.to_bits());
    }
}

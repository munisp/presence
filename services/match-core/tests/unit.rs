//! Unit tests for the match core's structural contract: graph validation,
//! the TR-36 prior blend, and the FR-10 sensitive-node discipline.

use match_core::{
    Corpus, GraphLink, GraphNode, InterestGraph, Matcher, Profile, DECAY, EXPANSION_DEPTH,
    EXACT_OVERLAP_BONUS, MAX_DEPTH, PRIOR_FADE_N,
};
use std::collections::HashMap;

fn node(nid: &str, parent: Option<&str>) -> GraphNode {
    GraphNode {
        nid: nid.to_string(),
        label: nid.rsplit('.').next().unwrap_or(nid).to_string(),
        parent: parent.map(str::to_string),
        kind: "test".to_string(),
        sensitive: false,
    }
}

fn small_graph() -> InterestGraph {
    InterestGraph::new(
        vec![
            node("root", None),
            node("root.a", Some("root")),
            node("root.b", Some("root")),
            node("root.a.1", Some("root.a")),
        ],
        vec![GraphLink {
            a: "root.a".to_string(),
            b: "root.b".to_string(),
            kind: "neighbour".to_string(),
            weight: 0.4,
        }],
    )
    .expect("small graph is valid")
}

#[test]
fn governed_constants_match_the_score_contract() {
    assert_eq!(DECAY, 0.55); // TR-04
    assert_eq!(EXPANSION_DEPTH, 4); // TR-04
    assert_eq!(MAX_DEPTH, 5); // TR-17
    assert_eq!(EXACT_OVERLAP_BONUS, 0.05);
    assert_eq!(PRIOR_FADE_N, 30.0); // TR-36
}

#[test]
fn closure_decays_point_five_five_per_hop_up_to_four() {
    let g = small_graph();
    let closure = g.closure("root.a.1", 1.0).unwrap();
    assert_eq!(closure[0], ("root.a.1".to_string(), 1.0));
    assert_eq!(closure[1], ("root.a".to_string(), 0.55));
    assert_eq!(closure[2], ("root".to_string(), 0.55f64.powi(2)));
}

#[test]
fn graph_rejects_unknown_link_endpoints() {
    let err = InterestGraph::new(
        vec![node("a", None)],
        vec![GraphLink {
            a: "a".to_string(),
            b: "ghost".to_string(),
            kind: "neighbour".to_string(),
            weight: 0.5,
        }],
    )
    .unwrap_err();
    assert!(err.contains("unknown node ghost"));
}

#[test]
fn graph_rejects_unknown_parents() {
    let err = InterestGraph::new(vec![node("a", Some("ghost"))], vec![]).unwrap_err();
    assert!(err.contains("unknown parent ghost"));
}

#[test]
fn graph_rejects_cycles() {
    let err = InterestGraph::new(
        vec![node("a", Some("b")), node("b", Some("a"))],
        vec![],
    )
    .unwrap_err();
    assert!(err.contains("cycle"));
}

#[test]
fn graph_rejects_depth_beyond_five() {
    let err = InterestGraph::new(
        vec![
            node("d0", None),
            node("d1", Some("d0")),
            node("d2", Some("d1")),
            node("d3", Some("d2")),
            node("d4", Some("d3")),
            node("d5", Some("d4")),
            node("d6", Some("d5")),
        ],
        vec![],
    )
    .unwrap_err();
    assert!(err.contains("exceeds hierarchy depth 5"));
}

#[test]
fn vector_excludes_sensitive_declarations() {
    let mut sensitive = node("secret", None);
    sensitive.sensitive = true;
    let g = InterestGraph::new(vec![sensitive, node("open", None)], vec![]).unwrap();
    let m = Matcher::new(&g);
    let profile: Profile = vec![("secret".to_string(), 1.0), ("open".to_string(), 1.0)];
    let v = m.vector(&profile, true).unwrap();
    assert!(!v.contains_key("secret"));
    assert!(v.contains_key("open"));
}

#[test]
fn links_contribute_at_authored_weight_but_never_to_df() {
    let g = small_graph();
    let m = Matcher::new(&g);
    let profile: Profile = vec![("root.a".to_string(), 1.0)];
    let with_links = m.vector(&profile, true).unwrap();
    let link_free = m.vector(&profile, false).unwrap();
    assert_eq!(with_links.get("root.b"), Some(&(0.4 * 1.0)));
    assert!(!link_free.contains_key("root.b"));
}

#[test]
fn prior_blend_fades_to_exactly_zero_at_thirty() {
    let mut prior_df = HashMap::new();
    prior_df.insert("root".to_string(), 100.0);
    let mut df = HashMap::new();
    df.insert("root".to_string(), 3.0);

    let mut small = Corpus::new(5, df.clone());
    small.set_prior(prior_df.clone(), 10_000);
    let legacy = (1.0 + 5.0 / 4.0f64).ln().sqrt();
    assert!(small.idf("root") != legacy, "prior active below the fade point");

    let mut at_fade = Corpus::new(30, df);
    at_fade.set_prior(prior_df, 10_000);
    let legacy_at_fade = (1.0 + 30.0 / 4.0f64).ln().sqrt();
    assert_eq!(
        at_fade.idf("root").to_bits(),
        legacy_at_fade.to_bits(),
        "at N = 30 the blend is bit-identical to the legacy formula"
    );
}

#[test]
fn exact_overlap_bonus_is_capped_at_one() {
    let g = small_graph();
    let m = Matcher::new(&g);
    let mut df = HashMap::new();
    df.insert("root.a".to_string(), 1.0);
    df.insert("root".to_string(), 2.0);
    let corpus = Corpus::new(2, df);
    let a: Profile = vec![("root.a".to_string(), 1.0)];
    let result = m.score(&a, &a, &corpus).unwrap();
    assert_eq!(result.score, 1.0, "self-match saturates at the cap");
}

#[test]
fn reasons_are_ordered_by_contribution_then_node() {
    let g = small_graph();
    let m = Matcher::new(&g);
    let mut df = HashMap::new();
    df.insert("root.a.1".to_string(), 1.0);
    df.insert("root.a".to_string(), 2.0);
    df.insert("root".to_string(), 2.0);
    let corpus = Corpus::new(2, df);
    let a: Profile = vec![("root.a.1".to_string(), 1.0)];
    let b: Profile = vec![("root.a.1".to_string(), 1.0), ("root.b".to_string(), 1.0)];
    let result = m.score(&a, &b, &corpus).unwrap();
    assert!(!result.reasons.is_empty());
    for pair in result.reasons.windows(2) {
        let (r1, r2) = (&pair[0], &pair[1]);
        assert!(
            r1.contribution > r2.contribution
                || (r1.contribution == r2.contribution && r1.node < r2.node),
            "reason order broken: {r1:?} before {r2:?}"
        );
    }
}

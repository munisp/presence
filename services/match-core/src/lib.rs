//! Presence match core (TECH-18) — the ARC-allocated Rust implementation of
//! the interest-matching engine.
//!
//! Port of the verified TypeScript engine (services/match/src/engine.ts),
//! which is itself a port of the Python reference (presence/matching.py).
//! All three are pinned to the same golden corpus (services/match/test/
//! golden.json — 120 pairs) to 1e-9 on scores and on the full ordered
//! reason lists; the parity suite lives in tests/golden.rs and runs in CI.
//!
//! Score contract:
//!
//!   sim(A,B) = sum_n idf(n) * wA(n) * wB(n) / (||vA|| * ||vB||)
//!
//! with an exact-overlap bonus of 5% per node declared by both profiles,
//! capped at 1.0.
//!
//!   TR-04  closure weights decay 0.55 per hop, max four hops; multiple
//!          declarations reaching one ancestor combine by max
//!   TR-05  document frequency over link-free closures
//!   TR-06  idf(n) = sqrt(ln(1 + N / (1 + df(n)))) — sqrt-compressed,
//!          log-smoothed, so one rare shared interest cannot dominate
//!   TR-07  semantic links contribute one hop at the authored weight and are
//!          excluded from document frequency
//!   TR-08  ordered reason list with node ids, labels and contributions
//!   TR-09  reason text is deterministic; no LLM
//!   TR-10  scoring is deterministic for identical inputs and corpus state —
//!          every accumulation iterates in sorted node order, so results are
//!          bit-stable across processes and hash seeds

use std::cell::RefCell;
use std::collections::HashMap;

pub mod verticals;

pub const DECAY: f64 = 0.55; // TR-04
pub const EXPANSION_DEPTH: usize = 4; // TR-04
pub const MAX_DEPTH: usize = 5; // TR-17
pub const EXACT_OVERLAP_BONUS: f64 = 0.05;
pub const PRIOR_FADE_N: f64 = 30.0; // TR-36

#[derive(Debug, Clone)]
pub struct GraphNode {
    pub nid: String,
    pub label: String,
    pub parent: Option<String>,
    pub kind: String,
    pub sensitive: bool,
}

#[derive(Debug, Clone)]
pub struct GraphLink {
    pub a: String,
    pub b: String,
    pub kind: String, // rivalry | neighbour | co_occurs
    pub weight: f64,
}

/// A profile is its declarations in authored order — the explains()
/// tie-break (TR-09) is by profile order, so order is part of the contract.
pub type Profile = Vec<(String, f64)>;

#[derive(Debug, Default)]
pub struct InterestGraph {
    nodes: HashMap<String, GraphNode>,
    links: HashMap<String, Vec<(String, GraphLink)>>,
    depth_cache: RefCell<HashMap<String, usize>>,
}

impl InterestGraph {
    pub fn new(nodes: Vec<GraphNode>, links: Vec<GraphLink>) -> Result<Self, String> {
        let mut node_map = HashMap::with_capacity(nodes.len());
        for n in nodes {
            node_map.insert(n.nid.clone(), n);
        }
        let mut link_map: HashMap<String, Vec<(String, GraphLink)>> = HashMap::new();
        for link in links {
            for nid in [&link.a, &link.b] {
                if !node_map.contains_key(nid) {
                    return Err(format!("link references unknown node {nid}"));
                }
            }
            link_map
                .entry(link.a.clone())
                .or_default()
                .push((link.b.clone(), link.clone()));
            link_map
                .entry(link.b.clone())
                .or_default()
                .push((link.a.clone(), link));
        }
        let graph = InterestGraph {
            nodes: node_map,
            links: link_map,
            depth_cache: RefCell::new(HashMap::new()),
        };
        graph.validate()?;
        Ok(graph)
    }

    fn validate(&self) -> Result<(), String> {
        for (nid, node) in &self.nodes {
            if let Some(parent) = &node.parent {
                if !self.nodes.contains_key(parent) {
                    return Err(format!("{nid} has unknown parent {parent}"));
                }
            }
        }
        for nid in self.nodes.keys() {
            let mut seen = std::collections::HashSet::new();
            let mut depth = 0usize;
            let mut cur = nid.clone();
            while let Some(parent) = &self.nodes[&cur].parent {
                if !seen.insert(cur.clone()) {
                    return Err(format!("cycle through {nid}"));
                }
                depth += 1;
                cur = parent.clone();
            }
            if depth > MAX_DEPTH {
                return Err(format!("{nid} exceeds hierarchy depth {MAX_DEPTH}"));
            }
        }
        Ok(())
    }

    pub fn get(&self, nid: &str) -> Result<&GraphNode, String> {
        self.nodes.get(nid).ok_or_else(|| format!("unknown node {nid}"))
    }

    pub fn has(&self, nid: &str) -> bool {
        self.nodes.contains_key(nid)
    }

    pub fn all_nodes(&self) -> impl Iterator<Item = &GraphNode> {
        self.nodes.values()
    }

    /// (ancestor, hops) walking up the hierarchy, self excluded.
    pub fn ancestors(&self, nid: &str) -> Result<Vec<(String, usize)>, String> {
        self.ancestors_bounded(nid, EXPANSION_DEPTH)
    }

    pub fn ancestors_bounded(&self, nid: &str, max_depth: usize) -> Result<Vec<(String, usize)>, String> {
        let mut out = Vec::new();
        let mut cur = self.get(nid)?;
        let mut hops = 0usize;
        while let Some(parent) = &cur.parent {
            if hops >= max_depth {
                break;
            }
            hops += 1;
            cur = self.get(parent)?;
            out.push((cur.nid.clone(), hops));
        }
        Ok(out)
    }

    pub fn depth(&self, nid: &str) -> usize {
        if let Some(d) = self.depth_cache.borrow().get(nid) {
            return *d;
        }
        let mut d = 0usize;
        let mut cur = nid.to_string();
        while let Some(parent) = &self.nodes[&cur].parent {
            d += 1;
            cur = parent.clone();
        }
        self.depth_cache.borrow_mut().insert(nid.to_string(), d);
        d
    }

    pub fn links_from(&self, nid: &str) -> &[(String, GraphLink)] {
        self.links.get(nid).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The link-free taxonomy closure of one declared interest: the node
    /// itself at `weight`, each ancestor at weight * DECAY^hops (TR-04).
    pub fn closure(&self, nid: &str, weight: f64) -> Result<Vec<(String, f64)>, String> {
        let mut out = vec![(nid.to_string(), weight)];
        for (anc, hops) in self.ancestors(nid)? {
            out.push((anc, weight * DECAY.powi(hops as i32)));
        }
        Ok(out)
    }
}

/// Document frequency over link-free closures (TR-05), with idf (TR-06)
/// and the optional TR-36 global prior.
#[derive(Debug, Default)]
pub struct Corpus {
    pub size: usize,
    pub df: HashMap<String, f64>,
    prior_df: Option<HashMap<String, f64>>,
    prior_size: f64,
}

impl Corpus {
    pub fn new(size: usize, df: HashMap<String, f64>) -> Self {
        Corpus {
            size,
            df,
            prior_df: None,
            prior_size: 0.0,
        }
    }

    pub fn from_vectors(vectors: &[HashMap<String, f64>]) -> Self {
        let mut df: HashMap<String, f64> = HashMap::new();
        for v in vectors {
            for nid in v.keys() {
                *df.entry(nid.clone()).or_insert(0.0) += 1.0;
            }
        }
        Corpus::new(vectors.len(), df)
    }

    /// TR-36: pseudo-count blend that fades linearly to exactly zero at
    /// N = PRIOR_FADE_N live documents.
    pub fn set_prior(&mut self, prior_df: HashMap<String, f64>, prior_size: usize) {
        self.prior_df = Some(prior_df);
        self.prior_size = prior_size as f64;
    }

    pub fn clear_prior(&mut self) {
        self.prior_df = None;
        self.prior_size = 0.0;
    }

    /// Square-root-compressed, log-smoothed idf (TR-06; TR-36 blended).
    pub fn idf(&self, nid: &str) -> f64 {
        let n = self.df.get(nid).copied().unwrap_or(0.0);
        let legacy = |size: f64, df: f64| (1.0 + size / (1.0 + df)).ln().sqrt();
        let Some(prior_df) = &self.prior_df else {
            return legacy(self.size as f64, n);
        };
        if self.prior_size <= 0.0 {
            return legacy(self.size as f64, n);
        }
        let w = ((PRIOR_FADE_N - self.size as f64) / PRIOR_FADE_N).max(0.0);
        if w == 0.0 {
            return legacy(self.size as f64, n);
        }
        let s = w * PRIOR_FADE_N;
        let p0 = prior_df.get(nid).copied().unwrap_or(0.0) / self.prior_size;
        (1.0 + (self.size as f64 + s) / (1.0 + n + s * p0)).ln().sqrt()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasonKind {
    Same,
    Related,
    Sibling,
    Ancestor,
}

impl ReasonKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ReasonKind::Same => "same",
            ReasonKind::Related => "related",
            ReasonKind::Sibling => "sibling",
            ReasonKind::Ancestor => "ancestor",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Reason {
    pub kind: ReasonKind,
    pub node: String,
    pub label: String,
    pub contribution: f64,
    pub yours: String,
    pub theirs: String,
    pub yours_label: String,
    pub theirs_label: String,
}

#[derive(Debug, Clone)]
pub struct MatchResult {
    pub score: f64,
    pub reasons: Vec<Reason>,
}

pub struct Matcher<'g> {
    graph: &'g InterestGraph,
}

impl<'g> Matcher<'g> {
    pub fn new(graph: &'g InterestGraph) -> Self {
        Matcher { graph }
    }

    /// Expand a profile into its weighted closure vector (TR-04, max-combine).
    /// Semantic links add the linked node at its authored weight (TR-07).
    /// Pass with_links=false for anything feeding document frequency (TR-05).
    pub fn vector(&self, profile: &Profile, with_links: bool) -> Result<HashMap<String, f64>, String> {
        let mut out: HashMap<String, f64> = HashMap::new();
        for (nid, w) in profile {
            if self.graph.get(nid)?.sensitive {
                continue; // TR-22 / FR-10
            }
            for (c_nid, c_w) in self.graph.closure(nid, *w)? {
                let entry = out.entry(c_nid).or_insert(0.0);
                if c_w > *entry {
                    *entry = c_w;
                }
            }
        }
        if with_links {
            for (nid, w) in profile {
                if self.graph.get(nid)?.sensitive {
                    continue;
                }
                for (other, link) in self.graph.links_from(nid) {
                    let entry = out.entry(other.clone()).or_insert(0.0);
                    let contribution = link.weight * w;
                    if contribution > *entry {
                        *entry = contribution;
                    }
                }
            }
        }
        Ok(out)
    }

    /// Score a pair. Deterministic for identical inputs and corpus (TR-10):
    /// every accumulation iterates in sorted node order.
    pub fn score(&self, a: &Profile, b: &Profile, corpus: &Corpus) -> Result<MatchResult, String> {
        let va = self.vector(a, true)?;
        let vb = self.vector(b, true)?;
        if va.is_empty() || vb.is_empty() {
            return Ok(MatchResult {
                score: 0.0,
                reasons: Vec::new(),
            });
        }
        let mut num = 0.0;
        let mut shared_keys: Vec<&String> = va.keys().filter(|k| vb.contains_key(*k)).collect();
        shared_keys.sort();
        for nid in shared_keys {
            num += corpus.idf(nid) * va[nid] * vb[nid];
        }
        let norm = |v: &HashMap<String, f64>| {
            let mut keys: Vec<&String> = v.keys().collect();
            keys.sort();
            keys.iter()
                .map(|n| corpus.idf(n) * v[*n] * v[*n])
                .sum::<f64>()
                .sqrt()
        };
        let norm_a = norm(&va);
        let norm_b = norm(&vb);
        if norm_a == 0.0 || norm_b == 0.0 {
            return Ok(MatchResult {
                score: 0.0,
                reasons: Vec::new(),
            });
        }
        let declared_b = declared(b, self.graph)?;
        let shared = declared(a, self.graph)?
            .iter()
            .filter(|n| declared_b.contains(n))
            .count();
        let score = (num / (norm_a * norm_b)) * (1.0 + EXACT_OVERLAP_BONUS * shared as f64);
        Ok(MatchResult {
            score: score.min(1.0),
            reasons: self.reasons(a, b, corpus)?,
        })
    }

    /// Ordered reason list (TR-08), deterministic (TR-09, TR-10). Ordered by
    /// (-contribution, node).
    fn reasons(&self, a: &Profile, b: &Profile, corpus: &Corpus) -> Result<Vec<Reason>, String> {
        let reduced_a = self.reduced(a)?;
        let reduced_b = self.reduced(b)?;
        let va = self.vector(&reduced_a, true)?;
        let vb = self.vector(&reduced_b, true)?;
        let mut candidates: Vec<Reason> = Vec::new();
        let mut shared: Vec<&String> = va.keys().filter(|k| vb.contains_key(*k)).collect();
        shared.sort();
        for n in shared {
            candidates.push(self.make_reason(n, a, b, corpus.idf(n) * va[n] * vb[n])?);
        }
        candidates.sort_by(|r1, r2| {
            r2.contribution
                .total_cmp(&r1.contribution)
                .then_with(|| r1.node.cmp(&r2.node))
        });
        Ok(candidates)
    }

    /// The profile with subsumed declarations removed for reasoning.
    fn reduced(&self, profile: &Profile) -> Result<Profile, String> {
        let mut covered = std::collections::HashSet::new();
        let mut declared_nids: Vec<&String> = Vec::new();
        for (n, _w) in profile {
            if self.graph.get(n)?.sensitive {
                continue;
            }
            declared_nids.push(n);
        }
        for n in &declared_nids {
            for (anc, _hops) in self.graph.ancestors(n)? {
                if profile.iter().any(|(p, _)| p == &anc) {
                    covered.insert(anc);
                }
            }
        }
        Ok(profile
            .iter()
            .filter(|(n, _)| declared_nids.contains(&n) && !covered.contains(n))
            .cloned()
            .collect())
    }

    /// The most specific declared node that reaches `node`, via taxonomy
    /// closure or one semantic link (TR-07). Ties break by profile order.
    fn explains(&self, node: &str, declared_profile: &Profile) -> Result<Option<String>, String> {
        let mut best: Option<String> = None;
        let mut best_depth: isize = -1;
        for (d, _w) in declared_profile {
            let reaches = if d == node {
                true
            } else if self.graph.ancestors(d)?.iter().any(|(a, _)| a == node) {
                true
            } else {
                self.graph.links_from(d).iter().any(|(o, _)| o == node)
            };
            if !reaches {
                continue;
            }
            let depth = self.graph.depth(d) as isize;
            if depth > best_depth {
                best = Some(d.clone());
                best_depth = depth;
            }
        }
        Ok(best)
    }

    fn make_reason(
        &self,
        node: &str,
        a: &Profile,
        b: &Profile,
        contribution: f64,
    ) -> Result<Reason, String> {
        let da = self
            .explains(node, a)?
            .ok_or_else(|| format!("no declarer of {node} in profile a"))?;
        let db = self
            .explains(node, b)?
            .ok_or_else(|| format!("no declarer of {node} in profile b"))?;
        let la = self.graph.get(&da)?.label.clone();
        let lb = self.graph.get(&db)?.label.clone();
        let linked = self.graph.links_from(&da).iter().any(|(o, _)| o == &db);
        let kind = if da == db {
            ReasonKind::Same
        } else if linked {
            ReasonKind::Related
        } else if self.graph.get(&da)?.parent.is_some()
            && self.graph.get(&da)?.parent == self.graph.get(&db)?.parent
        {
            ReasonKind::Sibling
        } else {
            ReasonKind::Ancestor
        };
        Ok(Reason {
            kind,
            node: node.to_string(),
            label: self.graph.get(node)?.label.clone(),
            contribution,
            yours: da,
            theirs: db,
            yours_label: la,
            theirs_label: lb,
        })
    }
}

/// The non-sensitive declared nodes of a profile (FR-10), in profile order.
pub fn declared(profile: &Profile, graph: &InterestGraph) -> Result<Vec<String>, String> {
    profile
        .iter()
        .filter(|(n, _)| !graph.get(n).map(|g| g.sensitive).unwrap_or(false))
        .map(|(n, _)| {
            graph.get(n)?; // unknown nodes are an error, not silent drops
            Ok(n.clone())
        })
        .collect()
}

/// Render the top reason deterministically (TR-09, FR-27). No LLM.
pub fn icebreaker(result: &MatchResult) -> String {
    let Some(r) = result.reasons.first() else {
        return String::new();
    };
    match r.kind {
        ReasonKind::Same => format!("Both into {}", r.label),
        ReasonKind::Related => format!("{} and {} are neighbours", r.yours_label, r.theirs_label),
        ReasonKind::Sibling => format!("Both follow {}: {} vs {}", r.label, r.yours_label, r.theirs_label),
        ReasonKind::Ancestor => format!("Both into {}: {} and {}", r.label, r.yours_label, r.theirs_label),
    }
}

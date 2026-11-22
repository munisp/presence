"""Build the ACC-10 evaluation set.

Emits:
  eval/key.csv           hidden truth: score, band, venue, rank, control flags
  eval/rating-pack.xlsx  blinded workbook for three raters
  eval/MANIFEST.json     counts, config, effort estimate

Sampling is deliberately stratified by score band. A uniform sample of pairs is
dominated by near-zero scores, which teaches you that strangers are strangers.

The graph here is a purpose-built evaluation vocabulary of ~90 human-readable
leaves. Point `--graph production` at the real taxonomy release before running
for acceptance; the harness ships with this one so the pipeline is runnable.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from dataclasses import dataclass
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from .graph import InterestGraph, Link, Node
from .matching import Corpus, Matcher, icebreaker

OUT = Path("eval")
FONT = "Arial"
INK, GREY = "1F1F1B", "676B71"
F_TITLE = Font(name=FONT, size=13, bold=True, color=INK)
F_SUB = Font(name=FONT, size=9, italic=True, color=GREY)
F_H = Font(name=FONT, size=9, bold=True, color=INK)
F_B = Font(name=FONT, size=9, color=INK)
F_ID = Font(name=FONT, size=8, color="1F4E5F")
HEAD = PatternFill("solid", fgColor="EFEDE6")
WRAP = Alignment(wrap_text=True, vertical="top")

BANDS = [(0.05, 0.15), (0.15, 0.30), (0.30, 0.50), (0.50, 1.01)]
SUGGEST = 0.12


# ----------------------------------------------------------------- graph ---

CLUBS_PL = ["arsenal", "crystal-palace", "chelsea", "tottenham", "liverpool",
            "man-united", "man-city", "newcastle", "everton", "aston-villa",
            "west-ham", "brighton"]
CLUBS_ES = ["real-madrid", "barcelona", "atletico", "sevilla"]
CLUBS_IT = ["juventus", "inter", "milan", "napoli"]


def _label(slug: str) -> str:
    return " ".join(w.capitalize() for w in slug.split("-"))


def eval_graph() -> InterestGraph:
    nodes: list[Node] = []
    links: list[Link] = []

    def add(nid, label, parent, kind):
        nodes.append(Node(nid, label, parent, kind))

    add("sports", "sport", None, "domain")
    add("sports.football", "football", "sports", "sport")
    for league, clubs, label in (
        ("premier-league", CLUBS_PL, "the Premier League"),
        ("laliga", CLUBS_ES, "La Liga"),
        ("serie-a", CLUBS_IT, "Serie A"),
    ):
        lid = f"sports.football.{league}"
        add(lid, label, "sports.football", "league")
        for c in clubs:
            add(f"{lid}.{c}", _label(c), lid, "club")
    for s in ("tennis", "running", "cycling", "swimming"):
        add(f"sports.{s}", s, "sports", "sport")
    for leaf, lab in (("atp", "the ATP tour"), ("wta", "the WTA tour")):
        add(f"sports.tennis.{leaf}", lab, "sports.tennis", "league")
    for leaf, lab in (("marathon", "marathons"), ("parkrun", "parkrun"), ("trail", "trail running")):
        add(f"sports.running.{leaf}", lab, "sports.running", "topic")

    add("travel", "travel", None, "domain")
    for region in ("europe", "asia"):
        add(f"travel.{region}", region.capitalize(), "travel", "region")
    add("travel.europe.iberia", "the Iberian peninsula", "travel.europe", "region")
    for cid, lab, country in (("lisbon", "Lisbon", "portugal"), ("porto", "Porto", "portugal")):
        add(f"travel.europe.iberia.{country}", _label(country), "travel.europe.iberia", "country")
        add(f"travel.europe.iberia.{country}.{cid}", lab, f"travel.europe.iberia.{country}", "city")
    add("travel.europe.iberia.spain", "Spain", "travel.europe.iberia", "country")
    for cid, lab in (("barcelona", "Barcelona"), ("madrid", "Madrid"), ("seville", "Seville")):
        add(f"travel.europe.iberia.spain.{cid}", lab, "travel.europe.iberia.spain", "city")
    for country, cities in (("france", ["paris", "lyon", "marseille"]),
                            ("italy", ["rome", "florence", "naples"])):
        add(f"travel.europe.{country}", _label(country), "travel.europe", "country")
        for c in cities:
            add(f"travel.europe.{country}.{c}", _label(c), f"travel.europe.{country}", "city")
    add("travel.asia.japan", "Japan", "travel.asia", "country")
    for c in ("tokyo", "kyoto", "osaka"):
        add(f"travel.asia.japan.{c}", _label(c), "travel.asia.japan", "city")
    add("travel.asia.thailand", "Thailand", "travel.asia", "country")
    for c in ("bangkok", "chiang-mai"):
        add(f"travel.asia.thailand.{c}", _label(c), "travel.asia.thailand", "city")

    add("music", "music", None, "domain")
    for g, lab in (("indie", "indie"), ("jazz", "jazz"), ("techno", "techno"),
                   ("hiphop", "hip-hop"), ("classical", "classical"), ("folk", "folk"),
                   ("metal", "metal"), ("soul", "soul")):
        add(f"music.{g}", lab, "music", "genre")

    add("food", "food", None, "domain")
    for g, lab in (("coffee", "speciality coffee"), ("pizza", "pizza"), ("ramen", "ramen"),
                   ("wine", "wine"), ("baking", "baking"), ("bbq", "barbecue")):
        add(f"food.{g}", lab, "food", "topic")

    add("film", "film", None, "domain")
    for g in ("arthouse", "scifi", "horror", "documentary"):
        add(f"film.{g}", g, "film", "genre")

    add("books", "books", None, "domain")
    for g in ("scifi", "crime", "history", "poetry"):
        add(f"books.{g}", g, "books", "genre")

    add("outdoors", "the outdoors", None, "domain")
    for g in ("hiking", "climbing", "surfing", "camping"):
        add(f"outdoors.{g}", g, "outdoors", "topic")

    add("games", "games", None, "domain")
    for g in ("boardgames", "videogames", "chess"):
        add(f"games.{g}", g, "games", "topic")

    links += [
        Link("sports.football.premier-league.arsenal",
             "sports.football.premier-league.tottenham", "rivalry", 0.55),
        Link("sports.football.premier-league.arsenal",
             "sports.football.premier-league.chelsea", "rivalry", 0.5),
        Link("sports.football.laliga.barcelona",
             "sports.football.laliga.real-madrid", "rivalry", 0.55),
        Link("travel.europe.iberia.portugal.lisbon",
             "travel.europe.iberia.spain", "neighbour", 0.5),
        Link("travel.asia.japan.tokyo", "food.ramen", "co_occurs", 0.35),
    ]
    return InterestGraph(nodes, links)


# --------------------------------------------------------------- venues ---

@dataclass(frozen=True)
class Venue:
    key: str
    label: str
    weights: tuple          # ((domain, share), ...)
    breadth: float


UNIFORM = (("sports", 0.22), ("travel", 0.22), ("music", 0.18), ("food", 0.14),
           ("film", 0.08), ("books", 0.08), ("outdoors", 0.05), ("games", 0.03))

VENUES = (
    Venue("conference", "Conference hall", UNIFORM, 3.4),
    Venue("pub", "Pub", (("sports", 0.45), ("music", 0.15), ("food", 0.2),
                         ("travel", 0.1), ("games", 0.1)), 2.6),
    Venue("gym", "Gym", (("sports", 0.6), ("outdoors", 0.2), ("food", 0.2)), 2.2),
    Venue("festival", "Festival", (("music", 0.7), ("food", 0.15), ("film", 0.15)), 2.4),
)


def leaves_by_domain(graph: InterestGraph) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for nid, node in graph._nodes.items():
        root = nid.split(".")[0]
        if node.parent is not None and "parent_of" not in "":
            pass
    for nid, node in graph._nodes.items():
        if node.kind in ("club", "city", "genre", "topic", "league", "sport"):
            if node.parent and graph[node.parent].kind not in ("club",):
                out.setdefault(nid.split(".")[0], []).append(nid)
    return out


def make_profile(graph, venues_leaves, venue: Venue, rng: random.Random) -> dict[str, float]:
    target = max(2, int(round(rng.gauss(venue.breadth, 0.7))))
    picks: dict[str, float] = {}
    guard = 0
    while len(picks) < target and guard < 40:
        guard += 1
        domain = rng.choices([d for d, _ in venue.weights],
                             weights=[w for _, w in venue.weights])[0]
        pool = venues_leaves.get(domain, [])
        if not pool:
            continue
        picks[rng.choice(pool)] = 1.0
    return picks


# ----------------------------------------------------------------- pairs ---

def render_share(matcher: Matcher, reason) -> str:
    if reason.kind == "same":
        return f"Both into {reason.label}"
    if reason.kind == "related":
        return f"{reason.yours_label} and {reason.theirs_label} are neighbours"
    if reason.kind == "sibling":
        return f"Both follow {reason.label}: {reason.yours_label} vs {reason.theirs_label}"
    return f"Both into {reason.label}: {reason.yours_label} and {reason.theirs_label}"


def profile_text(graph, profile: dict[str, float]) -> str:
    return ", ".join(sorted(graph[k].label for k in profile))


def band_of(score: float) -> str:
    for lo, hi in BANDS:
        if lo <= score < hi:
            return f"{lo:.2f}-{hi:.2f}"
    return "below"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", type=int, default=600)
    ap.add_argument("--scans", type=int, default=150)
    ap.add_argument("--pool", type=int, default=25)
    ap.add_argument("--per-scan", type=int, default=5, help="top 3 plus extras")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    graph = eval_graph()
    matcher = Matcher(graph)
    by_domain = leaves_by_domain(graph)

    # reference corpus: a fixed population so scores are comparable across items
    ref = []
    for _ in range(900):
        v = rng.choice(VENUES)
        ref.append(make_profile(graph, by_domain, v, rng))
    corpus = Corpus.from_vectors([matcher.vector(p, with_links=False) for p in ref])

    items: list[dict] = []

    # ---- stratified pairs -------------------------------------------------
    per_band = args.pairs // len(BANDS)
    buckets: dict[str, list[dict]] = {f"{lo:.2f}-{hi:.2f}": [] for lo, hi in BANDS}
    attempts = 0
    while any(len(b) < per_band for b in buckets.values()) and attempts < 400_000:
        attempts += 1
        v = rng.choice(VENUES)
        a = make_profile(graph, by_domain, v, rng)
        b = make_profile(graph, by_domain, v, rng)
        m = matcher.score(a, b, corpus)
        if not m.reasons:
            continue
        band = band_of(m.score)
        if band in buckets and len(buckets[band]) < per_band:
            buckets[band].append({
                "kind": "pair", "score": m.score, "band": band, "venue": v.key,
                "rank": 0, "scan_id": "",
                "a": profile_text(graph, a), "b": profile_text(graph, b),
                "share": render_share(matcher, m.reasons[0]),
                "control": "",
            })

    # ---- controls ---------------------------------------------------------
    for _ in range(20):                      # known-good: identical interests
        v = rng.choice(VENUES)
        a = make_profile(graph, by_domain, v, rng)
        m = matcher.score(a, a, corpus)
        buckets[f"{BANDS[3][0]:.2f}-{BANDS[3][1]:.2f}"].append({
            "kind": "pair", "score": 1.0, "band": "control-good", "venue": v.key,
            "rank": 0, "scan_id": "",
            "a": profile_text(graph, a), "b": profile_text(graph, a),
            "share": render_share(matcher, m.reasons[0]) if m.reasons else "identical profiles",
            "control": "good",
        })
    for _ in range(20):                      # known-bad: no shared node
        for _try in range(200):
            a = make_profile(graph, by_domain, rng.choice(VENUES), rng)
            b = make_profile(graph, by_domain, rng.choice(VENUES), rng)
            m = matcher.score(a, b, corpus)
            if m.score < 0.05:
                break
        buckets[f"{BANDS[0][0]:.2f}-{BANDS[0][1]:.2f}"].append({
            "kind": "pair", "score": m.score, "band": "control-bad", "venue": "mixed",
            "rank": 0, "scan_id": "",
            "a": profile_text(graph, a), "b": profile_text(graph, b),
            "share": "— (no shared interest)",
            "control": "bad",
        })

    for band_items in buckets.values():
        items.extend(band_items)

    # ---- simulated scans --------------------------------------------------
    for s in range(args.scans):
        v = rng.choice(VENUES)
        focal = make_profile(graph, by_domain, v, rng)
        pool = [make_profile(graph, by_domain, v, rng) for _ in range(args.pool)]
        scored = sorted(
            ((matcher.score(focal, p, corpus), p) for p in pool if p != focal),
            key=lambda t: -t[0].score,
        )
        chosen, used_reasons = [], set()
        for m, p in scored:                       # crude MMR: one per reason node
            node = m.reasons[0].node if m.reasons else ""
            if node in used_reasons and len(chosen) < 3:
                continue
            chosen.append((m, p))
            used_reasons.add(node)
            if len(chosen) == 3:
                break
        for i, (m, p) in enumerate(chosen, start=1):
            items.append({
                "kind": "scan", "score": m.score, "band": band_of(m.score),
                "venue": v.key, "rank": i, "scan_id": f"S{s+1:03d}",
                "a": profile_text(graph, focal), "b": profile_text(graph, p),
                "share": render_share(matcher, m.reasons[0]) if m.reasons else "—",
                "control": "",
            })
        rest = [p for m, p in scored if (m, p) not in chosen]
        for p in rng.sample(rest, min(args.per_scan - 3, len(rest))):
            m = matcher.score(focal, p, corpus)
            items.append({
                "kind": "scan", "score": m.score, "band": band_of(m.score),
                "venue": v.key, "rank": 4, "scan_id": f"S{s+1:03d}",
                "a": profile_text(graph, focal), "b": profile_text(graph, p),
                "share": render_share(matcher, m.reasons[0]) if m.reasons else "—",
                "control": "",
            })

    # ---- blind and write --------------------------------------------------
    rng.shuffle(items)
    OUT.mkdir(exist_ok=True)

    key_path = OUT / "key.csv"
    with key_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["item_id", "kind", "score", "band", "venue", "rank",
                    "scan_id", "control", "profile_a", "profile_b", "shared"])
        for i, it in enumerate(items, start=1):
            it["item_id"] = f"IT-{i:04d}"
            w.writerow([it["item_id"], it["kind"], f"{it['score']:.4f}", it["band"],
                        it["venue"], it["rank"], it["scan_id"], it["control"],
                        it["a"], it["b"], it["share"]])

    wb = Workbook()
    ins = wb.active
    ins.title = "Instructions"
    ins.column_dimensions["A"].width = 3
    ins.column_dimensions["B"].width = 26
    ins.column_dimensions["C"].width = 94
    ins["B2"] = "Presence — introduction rating pack"
    ins["B2"].font = F_TITLE
    ins["B3"] = f"{len(items)} items · rate independently · do not discuss until the calibration session"
    ins["B3"].font = F_SUB

    rows = [
        ("What you are judging", "Each row is two people in the same venue and the reason the system believes they should meet. You are judging the introduction, not the people."),
        ("Validity", "Claim the reason is true? Choose yes or no. If the stated reason does not follow from the two profiles, answer no."),
        ("Usefulness", "Would this start a conversation? 2 = yes, a specific and true reason I would act on. 1 = true but too generic to open with (\"you both like sport\"). 0 = no, wrong, trivial or creepy."),
        ("Do not guess", "If you cannot tell, mark usefulness 1 and say why in the note column. Guessing is worse than a considered 1."),
        ("Independence", "Do not look at other raters' columns. Do not infer which items are supposed to be good."),
        ("Time", "About 8 seconds per item. 1,350 items is roughly three hours per rater, split across a week."),
        ("Calibration", "Rate the 30 items on the Calibration sheet first, then join a 45-minute session to align on disagreements before rating the main sheet."),
        ("Control items", "Some rows are deliberately trivial or deliberately nonsensical. They measure scale drift, not you. Rate them honestly."),
    ]
    r = 5
    for label, text in rows:
        ins.cell(r, 2, label).font = F_H
        c = ins.cell(r, 3, text)
        c.font = F_B
        c.alignment = WRAP
        ins.row_dimensions[r].height = 40
        r += 1

    def rating_sheet(name: str, subset: list[dict]) -> None:
        ws = wb.create_sheet(name)
        heads = ["Item", "Person A follows / likes", "Person B follows / likes",
                 "What they share", "Valid?", "Usefulness", "Notes"]
        widths = [10, 34, 34, 40, 10, 12, 30]
        for j, (h, w) in enumerate(zip(heads, widths), start=1):
            c = ws.cell(1, j, h)
            c.font = F_H
            c.fill = HEAD
            ws.column_dimensions[get_column_letter(j)].width = w
        for i, it in enumerate(subset, start=2):
            ws.cell(i, 1, it["item_id"]).font = F_ID
            for j, v in ((2, it["a"]), (3, it["b"]), (4, it["share"])):
                c = ws.cell(i, j, v)
                c.font = F_B
                c.alignment = WRAP
            ws.cell(i, 5).fill = PatternFill("solid", fgColor="FFF3B0")
            ws.cell(i, 6).fill = PatternFill("solid", fgColor="FFF3B0")
        dv_v = DataValidation(type="list", formula1='"yes,no"', allow_blank=True)
        dv_u = DataValidation(type="list", formula1='"0,1,2"', allow_blank=True)
        ws.add_data_validation(dv_v)
        ws.add_data_validation(dv_u)
        dv_v.add(f"E2:E{len(subset) + 1}")
        dv_u.add(f"F2:F{len(subset) + 1}")
        ws.freeze_panes = "B2"

    rating_sheet("Calibration", items[:30])
    rating_sheet("Rating", items)

    pack = OUT / "rating-pack.xlsx"
    wb.save(pack)

    minutes = len(items) * 8 / 60
    manifest = {
        "items": len(items), "pairs": sum(1 for i in items if i["kind"] == "pair"),
        "scans": args.scans, "per_item_seconds": 8,
        "rater_hours": round(minutes / 60, 1),
        "raters_needed": 3, "bands": [f"{lo:.2f}-{hi:.2f}" for lo, hi in BANDS],
        "seed": args.seed, "graph_nodes": len(graph),
    }
    (OUT / "MANIFEST.json").write_text(json.dumps(manifest, indent=2))

    print(f"items {manifest['items']} "
          f"({manifest['pairs']} pair / {args.scans} scans)")
    print(f"rater effort: {manifest['rater_hours']} h each x 3 raters")
    print(f"wrote {pack} and {key_path}")


if __name__ == "__main__":
    main()

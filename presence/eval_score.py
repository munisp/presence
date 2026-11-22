"""Score a completed rating pack against the hidden key.

Reports:
  Krippendorff's alpha (ordinal) for usefulness
  precision@3 per scan, with a bootstrap confidence interval
  the score-band vs human-judgement curve (what sets the threshold)
  per-venue breakdown

Usage:
  python -m presence.eval_score                 # score eval/rating-pack.xlsx
  python -m presence.eval_score --simulate      # self-test with synthetic ratings

`--simulate` writes ratings derived from the engine score plus noise. It exists to
prove the maths and the pipeline run end to end. Its output is NOT a result and
must never be reported as one.
"""

from __future__ import annotations

import argparse
import csv
import random
from collections import defaultdict
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.styles import Alignment, Font, PatternFill

EVAL = Path("eval")
FONT = "Arial"
F_TITLE = Font(name=FONT, size=13, bold=True, color="1F1F1B")
F_SUB = Font(name=FONT, size=9, italic=True, color="676B71")
F_H = Font(name=FONT, size=9, bold=True)
F_B = Font(name=FONT, size=9)
HEAD = PatternFill("solid", fgColor="EFEDE6")
WRAP = Alignment(wrap_text=True, vertical="top")

RELEVANT = 2          # usefulness at or above this counts for precision@3
RATER_COLS = 3        # three rater blocks, each Item/Valid/Useful/Notes


def load_key() -> dict[str, dict]:
    key = {}
    with (EVAL / "key.csv").open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            key[row["item_id"]] = row
    return key


def load_ratings(path: Path) -> dict[str, list[tuple[str, int]]]:
    """Return item_id -> [(validity, usefulness), ...] across rater blocks.

    The pack ships one sheet per rater in production; this reader accepts either
    that shape (sheet per rater) or a single sheet with repeated column blocks.
    """
    wb = load_workbook(path, data_only=True)
    out: dict[str, list[tuple[str, int]]] = defaultdict(list)

    def take(ws, id_col, val_col, use_col, start_row=2):
        for r in range(start_row, ws.max_row + 1):
            iid = ws.cell(r, id_col).value
            if not iid:
                continue
            valid = (ws.cell(r, val_col).value or "").strip().lower()
            try:
                use = int(ws.cell(r, use_col).value)
            except (TypeError, ValueError):
                continue
            out[str(iid)].append((valid if valid in ("yes", "no") else "", use))

    for name in wb.sheetnames:
        if name.startswith("Rating"):
            take(wb[name], 1, 5, 6)
    return out


def krippendorff_ordinal(units: list[list[int]]) -> float | None:
    """Ordinal alpha over units, each a list of ratings (missing values omitted)."""
    units = [u for u in units if len(u) >= 2]
    if not units:
        return None
    values = sorted({v for u in units for v in u})
    rank = {v: i for i, v in enumerate(values)}
    k = len(values)
    if k < 2:
        return None

    o = [[0.0] * k for _ in range(k)]
    for u in units:
        n_u = len(u)
        for i in range(n_u):
            for j in range(n_u):
                if i != j:
                    o[rank[u[i]]][rank[u[j]]] += 1.0 / (n_u - 1)

    n_c = [sum(row) for row in o]
    n = sum(n_c)
    if n == 0:
        return None

    def delta2(c: int, d: int) -> float:
        lo, hi = min(c, d), max(c, d)
        inner = sum(n_c[g] for g in range(lo, hi + 1)) - (n_c[lo] + n_c[hi]) / 2.0
        return inner * inner

    do = sum(o[c][d] * delta2(c, d) for c in range(k) for d in range(k)) / n
    de = sum(n_c[c] * n_c[d] * delta2(c, d)
             for c in range(k) for d in range(k)) / (n * (n - 1))
    if de == 0:
        return 1.0
    return 1.0 - do / de


def bootstrap_ci(values: list[float], b: int = 2000, seed: int = 3) -> tuple[float, float]:
    if len(values) < 2:
        return (0.0, 0.0)
    rng = random.Random(seed)
    means = []
    for _ in range(b):
        sample = [rng.choice(values) for _ in values]
        means.append(sum(sample) / len(sample))
    means.sort()
    return (means[int(0.025 * b)], means[int(0.975 * b) - 1])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default=str(EVAL / "rating-pack.xlsx"))
    ap.add_argument("--simulate", action="store_true")
    ap.add_argument("--target", type=float, default=0.33,
                    help="precision@3 floor derived from the wave-rate chain")
    args = ap.parse_args()

    key = load_key()
    if args.simulate:
        rng = random.Random(11)
        ratings: dict[str, list[tuple[str, int]]] = {}
        for iid, row in key.items():
            s = float(row["score"])
            noise = rng.random()
            base = 2 if s > 0.45 else (1 if s > 0.2 else 0)
            if noise < 0.18:                       # rater noise both directions
                base = max(0, min(2, base + rng.choice((-1, 1))))
            vals = []
            for _r in range(3):
                v = base + (rng.choice((-1, 0, 0, 1)) if rng.random() < 0.35 else 0)
                vals.append(("yes" if s > 0.08 else "no", max(0, min(2, v))))
            ratings[iid] = vals
    else:
        ratings = load_ratings(Path(args.pack))
        if not ratings:
            raise SystemExit("no ratings found — fill the pack, or run with --simulate to test the maths")

    # ---- alpha ------------------------------------------------------------
    units = [[u for _, u in v] for v in ratings.values()]
    alpha = krippendorff_ordinal(units)

    # ---- precision@3 per scan --------------------------------------------
    by_scan: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for iid, r in ratings.items():
        row = key.get(iid)
        if not row or row["kind"] != "scan" or int(row["rank"]) > 3:
            continue
        mean_use = sum(u for _, u in r) / len(r)
        by_scan[row["scan_id"]].append((int(row["rank"]), mean_use))

    per_scan = []
    for scan, rows in by_scan.items():
        if len(rows) < 2:
            continue
        hits = sum(1 for _, m in rows if m >= RELEVANT - 0.5)
        per_scan.append(hits / len(rows))
    precision = sum(per_scan) / len(per_scan) if per_scan else 0.0
    lo, hi = bootstrap_ci(per_scan)

    # ---- score band vs human ---------------------------------------------
    band_rows: dict[str, list[float]] = defaultdict(list)
    for iid, r in ratings.items():
        row = key.get(iid)
        if not row or row["kind"] != "pair" or row["control"]:
            continue
        band_rows[row["band"]].append(sum(u for _, u in r) / len(r))

    venue_rows: dict[str, list[float]] = defaultdict(list)
    for iid, r in ratings.items():
        row = key.get(iid)
        if not row:
            continue
        venue_rows[row["venue"]].append(1.0 if (sum(u for _, u in r) / len(r)) >= 1.5 else 0.0)

    # ---- write ------------------------------------------------------------
    wb = load_workbook(args.pack) if Path(args.pack).exists() and not args.simulate else None
    from openpyxl import Workbook
    out = Workbook()
    ws = out.active
    ws.title = "Results"
    ws.column_dimensions["A"].width = 34
    for col in "BCD":
        ws.column_dimensions[col].width = 16

    ws["A1"] = "ACC-10 evaluation — results"
    ws["A1"].font = F_TITLE
    ws["A2"] = ("SIMULATED — pipeline self-test, not a measurement" if args.simulate
                else "Measured from the completed rating pack")
    ws["A2"].font = F_SUB

    summary = [
        ("Items rated", len(ratings)),
        ("Krippendorff alpha (ordinal)", "n/a" if alpha is None else round(alpha, 3)),
        ("Alpha verdict", ("usable" if alpha and alpha >= 0.8 else
                           "exploratory only" if alpha and alpha >= 0.67 else
                           "rubric unreliable — rewrite before believing any number")),
        ("Scans scored", len(per_scan)),
        ("precision@3", round(precision, 3)),
        ("95% CI", f"{lo:.3f} – {hi:.3f}"),
        ("Target", args.target),
        ("Verdict", "PASS" if precision >= args.target and (alpha or 0) >= 0.67 else "FAIL"),
    ]
    for i, (label, value) in enumerate(summary, start=4):
        ws.cell(i, 1, label).font = F_H
        ws.cell(i, 2, value).font = F_B

    r = 14
    ws.cell(r, 1, "Score band").font = F_H
    ws.cell(r, 2, "n").font = F_H
    ws.cell(r, 3, "mean usefulness").font = F_H
    ws.cell(r, 4, "share at 2").font = F_H
    for j in range(1, 5):
        ws.cell(r, j).fill = HEAD
    r += 1
    for band in sorted(band_rows):
        vals = band_rows[band]
        ws.cell(r, 1, band).font = F_B
        ws.cell(r, 2, len(vals)).font = F_B
        ws.cell(r, 3, round(sum(vals) / len(vals), 2)).font = F_B
        ws.cell(r, 4, round(sum(1 for v in vals if v >= 1.5) / len(vals), 2)).font = F_B
        r += 1

    r += 2
    ws.cell(r, 1, "Venue").font = F_H
    ws.cell(r, 2, "n").font = F_H
    ws.cell(r, 3, "useful rate").font = F_H
    for j in range(1, 4):
        ws.cell(r, j).fill = HEAD
    r += 1
    for v in sorted(venue_rows):
        vals = venue_rows[v]
        ws.cell(r, 1, v).font = F_B
        ws.cell(r, 2, len(vals)).font = F_B
        ws.cell(r, 3, round(sum(vals) / len(vals), 2)).font = F_B
        r += 1

    ws.cell(r + 2, 1,
            "Read: alpha below 0.67 means the rubric is ambiguous, not that the raters were wrong. "
            "A low validity rate points at reason extraction; a low usefulness rate with high "
            "validity points at a taxonomy that is too generic.").font = F_SUB
    ws.cell(r + 2, 1).alignment = WRAP

    path = EVAL / "results.xlsx"
    out.save(path)

    print(f"items {len(ratings)} | alpha {alpha if alpha is None else round(alpha, 3)}")
    print(f"scans {len(per_scan)} | precision@3 {precision:.3f} "
          f"(95% CI {lo:.3f}-{hi:.3f}) | target {args.target}")
    print("bands:", {b: round(sum(v) / len(v), 2) for b, v in sorted(band_rows.items())})
    print("venues:", {k: round(sum(v) / len(v), 2) for k, v in sorted(venue_rows.items())})
    print(f"wrote {path}")


if __name__ == "__main__":
    main()

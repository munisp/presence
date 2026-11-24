#!/usr/bin/env python3
"""TR-39 CI gate: every gold table is catalogued before any product surface
may use it.

Fails (exit 1) when:
  - a table in analytics/gold.py's GOLD_REGISTRY has no catalogue entry;
  - a catalogue entry misses owner / grain / freshness SLO / retention;
  - a catalogue entry claims a retention beyond the NFR-23 25-month cap;
  - the catalogue lists a table the code cannot produce.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from analytics.catalogue import CatalogueError, check, load_catalogue  # noqa: E402
from analytics.gold import GOLD_REGISTRY  # noqa: E402

CATALOGUE_PATH = ROOT / "docs" / "analytics" / "catalogue.yaml"


def main() -> int:
    try:
        tables = load_catalogue(CATALOGUE_PATH)
    except CatalogueError as exc:
        print(f"CATALOGUE INVALID: {exc}")
        return 1
    problems = check(GOLD_REGISTRY, tables)
    if problems:
        for p in problems:
            print(f"CATALOGUE VIOLATION: {p}")
        return 1
    print(f"gold catalogue OK — {len(GOLD_REGISTRY)} tables registered "
          f"({CATALOGUE_PATH.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

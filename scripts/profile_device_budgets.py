#!/usr/bin/env python3
"""Device-profiling harness — validates physical-device measurements against
the budgets the client contracts pin (NFR-04/05 startup, NFR-29/30 power,
NFR-35 frame).

The five measurable partials close only with evidence from a physical
device; this harness defines the evidence format and validates it
fail-closed. A profiling run is a JSON document:

    {
      "device": "Pixel 6a",
      "os": {"name": "android", "version": 34},
      "build": "<git sha of the profiled build>",
      "startup": {
        "coldMs": [1710, 1690, 1722],   // >= 3 runs, process dead start
        "warmMs": [410, 398, 405]       // >= 3 runs, background to foreground
      },
      "power": {
        "standardModeMilliPercentPerHour": 1830,   // 60 min foreground soak
        "reducedModeMilliPercentPerHour": 950,
        "backgroundOffMilliPercentPerHour": 0      // presence off: no work
      },
      "frames": {
        "matchSurfaceP95Ms": 14.2,      // p95 frame time, 60 fps target
        "weakestDeviceP95Ms": 31.8      // p95 on the floor device, 30 fps floor
      }
    }

Validation is fail-closed: a missing field, a non-numeric reading, too few
runs, or an out-of-budget median all fail. The budgets are the pinned
contract values — the harness reads them out of the client modules at run
time rather than restating them, so the harness can never drift from the
code it validates.

Run: python3 scripts/profile_device_budgets.py <report.json>
     python3 scripts/profile_device_budgets.py --self-test
"""

from __future__ import annotations

import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STARTUP = (ROOT / "client/src/presence/startupBudget.ts").read_text()
POWER = (ROOT / "client/src/presence/powerBudget.ts").read_text()
FRAME = (ROOT / "client/src/presence/frameBudget.ts").read_text()

MIN_RUNS = 3


def _pinned(source: str, name: str) -> float:
    """Read a pinned numeric constant out of a client contract module.

    The value may be a plain integer (1800) or an integer division
    expression (1000 / 60); both are evaluated, nothing else is.
    """
    match = re.search(rf"{name}\s*=\s*(\d+)\s*(?:/\s*(\d+))?\s*;", source)
    if match is None:
        raise SystemExit(f"harness error: {name} not found in its contract module")
    numerator, divisor = int(match.group(1)), match.group(2)
    return numerator / int(divisor) if divisor else float(numerator)


COLD_BUDGET_MS = _pinned(STARTUP, "COLD_START_BUDGET_MS")
WARM_BUDGET_MS = _pinned(STARTUP, "WARM_START_BUDGET_MS")
POWER_CEILING_MPH = 2000  # NFR-29: 2 %/h in milli-percent per hour.
FRAME_TARGET_MS = _pinned(FRAME, "FRAME_BUDGET_MS")   # 1000 / 60
FRAME_FLOOR_MS = _pinned(FRAME, "FRAME_FLOOR_MS")     # 1000 / 30


def _median_reading(report: dict, section: str, field: str) -> float:
    """Median of a run list, fail-closed on shape and count."""
    runs = report.get(section, {}).get(field)
    if not isinstance(runs, list) or len(runs) < MIN_RUNS:
        raise ValueError(f"{section}.{field}: need >= {MIN_RUNS} runs")
    if any(not isinstance(r, (int, float)) or r < 0 for r in runs):
        raise ValueError(f"{section}.{field}: non-numeric or negative run")
    return statistics.median(runs)


def _scalar(report: dict, section: str, field: str) -> float:
    value = report.get(section, {}).get(field)
    if not isinstance(value, (int, float)) or value < 0:
        raise ValueError(f"{section}.{field}: missing, non-numeric or negative")
    return float(value)


def validate_report(report: dict) -> list[str]:
    """Validate one profiling report; returns the list of failures (empty = pass)."""
    failures: list[str] = []

    for field in ("device", "os", "build"):
        if field not in report:
            failures.append(f"missing field: {field}")
    if failures:
        return failures
    os_info = report.get("os", {})
    if not isinstance(os_info, dict) or not isinstance(os_info.get("version"), (int, float)):
        failures.append("os.version: missing or non-numeric")

    try:
        cold = _median_reading(report, "startup", "coldMs")
        if cold > COLD_BUDGET_MS:
            failures.append(f"NFR-04 cold start {cold:.0f} ms > {COLD_BUDGET_MS} ms budget")
    except ValueError as exc:
        failures.append(f"NFR-04 {exc}")
    try:
        warm = _median_reading(report, "startup", "warmMs")
        if warm > WARM_BUDGET_MS:
            failures.append(f"NFR-05 warm start {warm:.0f} ms > {WARM_BUDGET_MS} ms budget")
    except ValueError as exc:
        failures.append(f"NFR-05 {exc}")

    for mode in ("standardModeMilliPercentPerHour", "reducedModeMilliPercentPerHour"):
        try:
            rate = _scalar(report, "power", mode)
            if rate > POWER_CEILING_MPH:
                failures.append(f"NFR-29 {mode} {rate:.0f} mp/h > {POWER_CEILING_MPH} mp/h ceiling")
        except ValueError as exc:
            failures.append(f"NFR-29 {exc}")
    try:
        background = _scalar(report, "power", "backgroundOffMilliPercentPerHour")
        if background != 0:
            failures.append(
                f"NFR-30 background with presence off measured {background:.0f} mp/h — must be 0"
            )
    except ValueError as exc:
        failures.append(f"NFR-30 {exc}")

    try:
        p95 = _scalar(report, "frames", "matchSurfaceP95Ms")
        if p95 > FRAME_TARGET_MS:
            failures.append(f"NFR-35 match surface p95 {p95:.1f} ms > {FRAME_TARGET_MS} ms frame")
    except ValueError as exc:
        failures.append(f"NFR-35 {exc}")
    try:
        floor_p95 = _scalar(report, "frames", "weakestDeviceP95Ms")
        if floor_p95 > FRAME_FLOOR_MS:
            failures.append(
                f"NFR-35 weakest-device p95 {floor_p95:.1f} ms > {FRAME_FLOOR_MS} ms floor"
            )
    except ValueError as exc:
        failures.append(f"NFR-35 floor {exc}")

    return failures


PASSING_REPORT = {
    "device": "Pixel 6a",
    "os": {"name": "android", "version": 34},
    "build": "self-test",
    "startup": {"coldMs": [1700, 1710, 1690], "warmMs": [400, 410, 395]},
    "power": {
        "standardModeMilliPercentPerHour": 1800,
        "reducedModeMilliPercentPerHour": 900,
        "backgroundOffMilliPercentPerHour": 0,
    },
    "frames": {"matchSurfaceP95Ms": 14.0, "weakestDeviceP95Ms": 31.0},
}


def _self_test() -> int:
    if validate_report(PASSING_REPORT) != []:
        print("FAIL: the reference report must pass")
        return 1
    over_budget = json.loads(json.dumps(PASSING_REPORT))
    over_budget["startup"]["coldMs"] = [COLD_BUDGET_MS + 1] * MIN_RUNS
    if not any("NFR-04" in failure for failure in validate_report(over_budget)):
        print("FAIL: an over-budget cold start must fail NFR-04")
        return 1
    background_work = json.loads(json.dumps(PASSING_REPORT))
    background_work["power"]["backgroundOffMilliPercentPerHour"] = 5
    if not any("NFR-30" in failure for failure in validate_report(background_work)):
        print("FAIL: background work with presence off must fail NFR-30")
        return 1
    too_few_runs = json.loads(json.dumps(PASSING_REPORT))
    too_few_runs["startup"]["warmMs"] = [400]
    if not any("NFR-05" in failure for failure in validate_report(too_few_runs)):
        print("FAIL: fewer than the minimum runs must fail closed")
        return 1
    garbage = json.loads(json.dumps(PASSING_REPORT))
    garbage["frames"]["matchSurfaceP95Ms"] = "fast"
    if not any("NFR-35" in failure for failure in validate_report(garbage)):
        print("FAIL: a non-numeric frame reading must fail closed")
        return 1
    print("self-test: PASS (reference passes; budget breach, background work, "
          "short run list and garbage all fail closed)")
    return 0


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return _self_test()
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    report = json.loads(Path(sys.argv[1]).read_text())
    failures = validate_report(report)
    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    print(f"PASS {report['device']} ({report['os']['name']} {report['os']['version']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

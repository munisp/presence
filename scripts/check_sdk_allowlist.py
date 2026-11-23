#!/usr/bin/env python3
"""SEC-18: enforce the third-party SDK allowlist in CI.

Fail-closed gate over every client dependency manifest found under
``client/``:

  package.json            -> npm        (dependencies + devDependencies)
  pubspec.yaml            -> pub        (dependencies + dev_dependencies)
  Podfile / *.podspec     -> cocoapods  (pod 'Name', 'version')
  build.gradle[.kts]      -> maven      (implementation "group:artifact:version")

A dependency with no matching allowlist entry — or a version that does not
satisfy the entry's constraint — fails the build. With no client directory
the gate passes and says so; the first manifest that lands is held to the
allowlist from its first commit.

Run: python3 scripts/check_sdk_allowlist.py
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALLOWLIST_PATH = ROOT / "docs/security/sdk-allowlist.json"
CLIENT_ROOT = ROOT / "client"

ALLOWLIST_VERSION = "sdk-allowlist/v1"
ECOSYSTEMS = ("npm", "pub", "cocoapods", "maven")
REQUIRED_FIELDS = ("name", "ecosystem", "versionConstraint", "justification", "dataAccess", "approvedBy")


@dataclass(frozen=True)
class Dependency:
    ecosystem: str
    name: str
    version: str
    manifest: str


# ---------------------------------------------------------- allowlist ------

def load_allowlist(path: Path = ALLOWLIST_PATH) -> list[dict]:
    doc = json.loads(path.read_text())
    if doc.get("version") != ALLOWLIST_VERSION:
        raise SystemExit(f"allowlist version must be {ALLOWLIST_VERSION}")
    entries = doc.get("sdks")
    if not isinstance(entries, list):
        raise SystemExit("allowlist must carry an sdks array")
    seen: set[tuple[str, str]] = set()
    for entry in entries:
        missing = [f for f in REQUIRED_FIELDS if not entry.get(f)]
        if missing:
            raise SystemExit(f"allowlist entry {entry.get('name', '?')} missing {missing}")
        if entry["ecosystem"] not in ECOSYSTEMS:
            raise SystemExit(f"unknown ecosystem {entry['ecosystem']}")
        key = (entry["ecosystem"], entry["name"])
        if key in seen:
            raise SystemExit(f"duplicate allowlist entry {key}")
        seen.add(key)
    return entries


# --------------------------------------------------------- version math ----

def _parse_semver(v: str) -> tuple[int, int, int] | None:
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.\-]+)?", v.strip())
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def satisfies(version: str, constraint: str) -> bool:
    """Exact, caret and tilde matching — the only forms the allowlist allows."""
    v = _parse_semver(version)
    if v is None:
        return False
    c = constraint.strip()
    if c.startswith("^"):
        base = _parse_semver(c[1:])
        if base is None:
            return False
        if v < base:
            return False
        # Caret keeps the left-most non-zero component fixed.
        if base[0] > 0:
            return v[0] == base[0]
        if base[1] > 0:
            return v[0] == 0 and v[1] == base[1]
        return v == base
    if c.startswith("~"):
        base = _parse_semver(c[1:])
        return base is not None and v >= base and v[:2] == base[:2]
    exact = _parse_semver(c)
    return exact is not None and v == exact


# -------------------------------------------------------- manifest scan ----

def scan_manifests(client_root: Path = CLIENT_ROOT) -> list[Dependency]:
    deps: list[Dependency] = []
    if not client_root.is_dir():
        return deps
    for path in sorted(client_root.rglob("*")):
        rel = str(path.relative_to(client_root.parent))
        if path.name == "package.json":
            pkg = json.loads(path.read_text())
            for section in ("dependencies", "devDependencies"):
                for name, spec in (pkg.get(section) or {}).items():
                    m = re.search(r"(\d+\.\d+\.\d+)", str(spec))
                    if m:
                        deps.append(Dependency("npm", name, m.group(1), rel))
        elif path.name == "pubspec.yaml":
            current = None
            for line in path.read_text().splitlines():
                if re.match(r"^(dev_)?dependencies:\s*$", line):
                    current = line.strip().rstrip(":")
                    continue
                if line and not line.startswith((" ", "\t")):
                    current = None
                m = re.match(r"^\s{2}(\w[\w]*):\s*\^?(\d+\.\d+\.\d+)", line)
                if current and m:
                    deps.append(Dependency("pub", m.group(1), m.group(2), rel))
        elif path.name == "Podfile" or path.suffix == ".podspec":
            for m in re.finditer(r"pod\s+['\"]([\w/+\-.]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]", path.read_text()):
                ver = re.search(r"(\d+\.\d+\.\d+)", m.group(2))
                if ver:
                    deps.append(Dependency("cocoapods", m.group(1), ver.group(1), rel))
        elif path.name.startswith("build.gradle"):
            for m in re.finditer(
                r"(?:implementation|api|compileOnly)\s*[\(\"']+([\w.\-]+):([\w.\-]+):([\w.\-]+)",
                path.read_text(),
            ):
                deps.append(Dependency("maven", f"{m.group(1)}:{m.group(2)}", m.group(3), rel))
    return deps


# ---------------------------------------------------------------- gate -----

def check(deps: list[Dependency], entries: list[dict]) -> list[str]:
    violations: list[str] = []
    index = {(e["ecosystem"], e["name"]): e for e in entries}
    for dep in deps:
        entry = index.get((dep.ecosystem, dep.name))
        if entry is None:
            violations.append(f"{dep.manifest}: {dep.ecosystem}:{dep.name} is not on the SEC-18 allowlist")
        elif not satisfies(dep.version, entry["versionConstraint"]):
            violations.append(
                f"{dep.manifest}: {dep.ecosystem}:{dep.name}@{dep.version} violates allowlisted "
                f"constraint {entry['versionConstraint']}"
            )
    return violations


def main() -> int:
    entries = load_allowlist()
    deps = scan_manifests()
    if not deps:
        print(f"SEC-18: no client manifests found; allowlist holds {len(entries)} entries — gate passes")
        return 0
    violations = check(deps, entries)
    if violations:
        for v in violations:
            print(f"FAIL  {v}")
        return 1
    print(f"SEC-18: {len(deps)} dependencies across client manifests, all allowlisted")
    return 0


if __name__ == "__main__":
    sys.exit(main())

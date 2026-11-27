#!/usr/bin/env python3
"""AMD-MAP-01: deterministic static-tile builder (TR-44).

Renders the governed in-repo vector basemap (maps/basemap/lagos.json) into a
static XYZ tile pyramid (Web Mercator, 256px PNG) plus a manifest and a
vector overlay bundle. This is the ONLY tile pipeline: there is no runtime
tile server and never will be — the output of this script is what nginx
serves, byte for byte (AMD-MAP-06). A bundle rebuild is the only way a pixel
changes, and a rebuild is versioned, hash-pinned and published through the
map_tile_bundles registry (AMD-MAP-02).

Determinism contract: same source + same Pillow version => identical bytes.
--check re-renders and compares against the manifest already on disk, so CI
fails the moment a render drifts.

Usage:
    python3 scripts/build_tiles.py [--source maps/basemap/lagos.json]
                                   [--out build/tiles]
                                   [--check]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

TILE_SIZE = 256
# Web Mercator hard limit — poles are unprojectable.
MAX_MERCATOR_LAT = 85.05112878

SCHEMA = "presence-basemap/1"
MANIFEST_SCHEMA = "presence-tile-manifest/1"
VECTOR_SCHEMA = "presence-tile-vectors/1"


# ------------------------------------------------------------ mercator -----

def lonlat_to_world(lng: float, lat: float, zoom: int) -> tuple[float, float]:
    """Degrees -> world pixel coordinates at zoom (origin NW)."""
    lat = max(-MAX_MERCATOR_LAT, min(MAX_MERCATOR_LAT, lat))
    scale = TILE_SIZE * (2 ** zoom)
    x = (lng + 180.0) / 360.0 * scale
    siny = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * scale
    return x, y


def tile_cover(bbox: dict, zoom: int) -> list[tuple[int, int, int]]:
    """All z/x/y tiles intersecting the bbox at zoom."""
    x0, y0 = lonlat_to_world(bbox["west"], bbox["north"], zoom)
    x1, y1 = lonlat_to_world(bbox["east"], bbox["south"], zoom)
    tx0, ty0 = int(x0 // TILE_SIZE), int(y0 // TILE_SIZE)
    tx1, ty1 = int(x1 // TILE_SIZE), int(y1 // TILE_SIZE)
    n = 2 ** zoom
    return [
        (zoom, x, y)
        for x in range(max(0, tx0), min(n - 1, tx1) + 1)
        for y in range(max(0, ty0), min(n - 1, ty1) + 1)
    ]


# ------------------------------------------------------------ rendering ----

def _hex(col: str) -> tuple[int, int, int]:
    col = col.lstrip("#")
    return (int(col[0:2], 16), int(col[2:4], 16), int(col[4:6], 16))


def _project(points, zoom, ox, oy):
    return [
        (lonlat_to_world(lng, lat, zoom)[0] - ox,
         lonlat_to_world(lng, lat, zoom)[1] - oy)
        for lng, lat in points
    ]


def render_tile(src: dict, zoom: int, tx: int, ty: int) -> Image.Image:
    """Render one tile. Layer order is the cartographic contract:
    background -> districts -> parks -> islands -> water -> roads -> marks.
    """
    style = src["style"]
    ox, oy = tx * TILE_SIZE, ty * TILE_SIZE
    img = Image.new("RGB", (TILE_SIZE, TILE_SIZE), _hex(style["background"]))
    draw = ImageDraw.Draw(img)
    layers = src["layers"]

    # Only draw geometry that can intersect this tile: bbox-padded clip.
    pad = 64
    def visible(points) -> bool:
        proj = _project(points, zoom, ox, oy)
        xs = [p[0] for p in proj]
        ys = [p[1] for p in proj]
        return (max(xs) >= -pad and min(xs) <= TILE_SIZE + pad
                and max(ys) >= -pad and min(ys) <= TILE_SIZE + pad)

    for d in layers.get("districts", []):
        if visible(d["polygon"]):
            draw.polygon(_project(d["polygon"], zoom, ox, oy),
                         fill=_hex(style["district"]),
                         outline=_hex(style["districtLine"]))
    for p in layers.get("parks", []):
        if visible(p["polygon"]):
            draw.polygon(_project(p["polygon"], zoom, ox, oy),
                         fill=_hex(style["park"]))
    for i in layers.get("islands", []):
        if visible(i["polygon"]):
            draw.polygon(_project(i["polygon"], zoom, ox, oy),
                         fill=_hex(style["island"]))
    for w in layers.get("water", []):
        if visible(w["polygon"]):
            draw.polygon(_project(w["polygon"], zoom, ox, oy),
                         fill=_hex(style["water"]),
                         outline=_hex(style["waterLine"]))

    # Roads: casing pass then fill pass, expressways over arterials.
    roads = layers.get("roads", [])
    width = {"expressway": max(2, zoom - 8), "arterial": max(1, zoom - 10)}
    for cls in ("arterial", "expressway"):
        for r in roads:
            if r.get("class") != cls or not visible(r["line"]):
                continue
            pts = _project(r["line"], zoom, ox, oy)
            draw.line(pts, fill=_hex(style["roadCasing"]),
                      width=width.get(cls, 1) + 2, joint="curve")
    for cls in ("arterial", "expressway"):
        for r in roads:
            if r.get("class") != cls or not visible(r["line"]):
                continue
            fill = style["roadExpressway" if cls == "expressway"
                         else "roadArterial"]
            draw.line(_project(r["line"], zoom, ox, oy), fill=_hex(fill),
                      width=width.get(cls, 1), joint="curve")

    # Landmarks: text-free by design (AMD-MAP-01) — client surfaces draw
    # labels from the vector overlay bundle, so tiles stay deterministic
    # across environments regardless of installed fonts.
    radius = max(2, zoom - 10)
    for m in layers.get("landmarks", []):
        x, y = _project([m["point"]], zoom, ox, oy)[0]
        if -pad <= x <= TILE_SIZE + pad and -pad <= y <= TILE_SIZE + pad:
            col = style["landmarkUniversity" if m.get("kind") == "university"
                        else "landmark"]
            draw.ellipse([x - radius, y - radius, x + radius, y + radius],
                         fill=_hex(col))
    return img


# ------------------------------------------------------------ manifest -----

def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(source: Path, out: Path) -> dict:
    src = json.loads(source.read_text())
    if src.get("schema") != SCHEMA:
        raise SystemExit(f"unsupported basemap schema: {src.get('schema')}")
    version = src["version"]
    bbox = src["bbox"]
    zmin, zmax = src["zoom"]["min"], src["zoom"]["max"]

    root = out / version
    if root.exists():
        import shutil
        shutil.rmtree(root)
    tiles_index: dict[str, str] = {}
    per_zoom: dict[str, int] = {}
    for zoom in range(zmin, zmax + 1):
        for z, x, y in tile_cover(bbox, zoom):
            path = root / str(z) / str(x) / f"{y}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            render_tile(src, z, x, y).save(path, format="PNG", optimize=True)
            rel = f"{z}/{x}/{y}.png"
            tiles_index[rel] = sha256_file(path)
            per_zoom[str(z)] = per_zoom.get(str(z), 0) + 1

    vectors = {
        "schema": VECTOR_SCHEMA,
        "version": version,
        # Overlay bundle: labels + geometry the clients draw ABOVE the
        # raster — landmark labels, road names, district names. Geometry
        # already lives server-side (geofences/cells); this bundle is the
        # basemap's own annotation layer.
        "labels": [
            {"name": m["name"], "kind": m["kind"], "point": m["point"]}
            for m in src["layers"].get("landmarks", [])
        ] + [
            {"name": d["name"], "kind": "district",
             "point": _centroid(d["polygon"])}
            for d in src["layers"].get("districts", [])
        ],
        "roadNames": [
            {"name": r["name"], "class": r["class"],
             "point": _centroid(r["line"])}
            for r in src["layers"].get("roads", [])
        ],
    }
    vpath = root / "vectors.json"
    vpath.write_text(json.dumps(vectors, separators=(",", ":"),
                                sort_keys=True))

    tiles_sha = hashlib.sha256(
        json.dumps(tiles_index, sort_keys=True).encode()).hexdigest()
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "id": src["id"],
        "label": src["label"],
        "version": version,
        "attribution": src["attribution"],
        "bbox": bbox,
        "zoom": {"min": zmin, "max": zmax},
        "tileSize": TILE_SIZE,
        "tileCount": len(tiles_index),
        "tilesPerZoom": dict(sorted(per_zoom.items(), key=lambda kv: int(kv[0]))),
        "tilesSha256": tiles_sha,
        "vectorsSha256": sha256_file(vpath),
        "urlTemplate": "/tiles/{z}/{x}/{y}.png",
        "vectorsUrl": "/tiles/vectors.json",
    }
    (root / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def _centroid(points) -> list[float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return [round(sum(xs) / len(xs), 6), round(sum(ys) / len(ys), 6)]


def check(source: Path, out: Path) -> bool:
    src = json.loads(source.read_text())
    manifest_path = out / src["version"] / "manifest.json"
    if not manifest_path.exists():
        print(f"CHECK FAIL: no manifest at {manifest_path} — build first")
        return False
    recorded = json.loads(manifest_path.read_text())

    # Re-render into a scratch tree and compare, byte for byte.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        rebuilt = build(source, Path(tmp))
    comparable = [(k, recorded[k], rebuilt[k]) for k in
                  ("tileCount", "tilesSha256", "vectorsSha256")]
    ok = all(a == b for _, a, b in comparable)
    for key, old, new in comparable:
        print(f"  {key}: {'OK' if old == new else f'DRIFT {old} != {new}'}")
    print("CHECK OK — deterministic render" if ok else "CHECK FAIL — drift")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="maps/basemap/lagos.json")
    ap.add_argument("--out", default="build/tiles")
    ap.add_argument("--check", action="store_true",
                    help="re-render and verify the on-disk bundle matches")
    args = ap.parse_args()
    source, out = Path(args.source), Path(args.out)
    if args.check:
        return 0 if check(source, out) else 1
    manifest = build(source, out)
    print(f"built {manifest['tileCount']} tiles "
          f"(z{manifest['zoom']['min']}-{manifest['zoom']['max']}) "
          f"version {manifest['version']} sha {manifest['tilesSha256'][:12]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# Next-gen maps (batch 70 — AMD-MAP-01..06; TR-44)

The map surfaces are built on a simple bargain: the platform renders a
beautiful, fast, offline-honest map of the launch market without ever
learning where a member is. Everything on the map is either static
imagery the platform rendered itself, geometry it already governs
(venue geofences), or the member's own presence cell — the exact
disclosure the member already made (TR-29). No coordinate ever crosses
a map surface (TR-15/SEC-08).

## What ships

- **A governed basemap** (AMD-MAP-01): the Lagos launch market as an
  in-repo vector source (`maps/basemap/lagos.json`) rendered into a
  static XYZ tile pyramid by `scripts/build_tiles.py`. The render is
  deterministic — `--check` in CI re-renders and compares hashes — and
  text-free by design: labels are drawn client-side from the vector
  overlay bundle (`vectors.json`), so tiles are identical in every
  environment regardless of installed fonts.
- **Static-tile serving** (AMD-MAP-06, TR-44): nginx serves the
  rendered bytes. There is no runtime tile server and never will be —
  a bundle bump is a new image, and the immutable year-long cache
  headers mean a CDN in front is a config change (the cost model's
  TR-44 egress lever). The member PWA and the ops console proxy
  `/tiles/` same-origin, so imagery never leaves the platform origin
  and CSP stays `'self'`. Tile fetches are not access-logged (z/x/y
  triples are location-revealing in aggregate).
- **A bundle registry** (AMD-MAP-02): `map_tile_bundles` decides WHICH
  rendered bundle the platform serves — one published bundle (partial
  unique index), version-monotonic publication (a stale render can
  never displace a newer one), venue-ops gated, append-only events.
  The member discovers the serving bundle via `GET /v1/maps/manifest`;
  the RN client additionally learns the tile host from the bootstrap
  config's `maps.tilesBaseUrl`.
- **Three surfaces, one engine** (AMD-MAP-03, AMD-MAP-04, AMD-MAP-05): the Web Mercator
  math, the fetch discipline and the bounded tile cache live in
  `client/src/presence/mapSurface.ts` and are mirrored zero-dependency
  into the console and PWA engines (cross-pinned tests). The member
  PWA's explore map renders nearby partner venues as their published
  geofences and the member's own presence halo as the r9 cell
  boundary — never a coordinate dot. The console's estate map renders
  every venue geofence with its QA status, and the AMD-CON-05 geofence
  editor gains the basemap as a backdrop (the polygon contract is
  unchanged — the backdrop is decoration, never validation).

## The offline contract (AMD-NET-04 made concrete)

The map is the platform's most bandwidth-hungry surface, so the fetch
discipline is explicit and pinned:

- **Full link** — tiles fetch on demand; the cache warms as the member
  pans. Prefetch beyond the visible cover is pinned at zero: the launch
  bundle is one market, and speculative imagery on a metered link is
  exactly the waste the connectivity pack forbids.
- **Degraded link** — the map runs from the tile cache only, silently.
  No spinners, no nagging: cached tiles render, uncached tiles are
  styled placeholders carrying the bundle's attribution.
- **Offline** — cache-only with the pinned notice ("Map is offline —
  showing what's already on this device."). The venue overlay falls
  back to the last read; the halo is the last published cell.
- **Bundle change** — the tile cache wipes wholesale when the serving
  bundle version changes; a tile from 1.0.0 never renders beside a tile
  from 1.1.0. The manifest itself is revalidated every load (the
  version inside is the cache key), so staleness is impossible to
  mistake.

## Member experience

The explore map opens centred on the member's own presence — the
centroid of the cell boundary they published, not a GPS dot. Venues
appear as their real geofences with a check-in affordance; indoors,
check-in remains the primary path and the map says so (FR-89's pinned
notice). A member outside the launch market's coverage sees the pinned
coverage notice, not a broken grid. A deployment with no published
bundle serves `{available:false}` and the surfaces stay geometry-only
— geofences and halos on the styled background, never an error.

## Ops experience

The estate map answers "where are our venues and which ones are
broken" at a glance: every published geofence, styled by its QA state
(coverage gaps, density errors, overlap conflicts), over the same
basemap the members see. The bundle registry surface lists every
registered bundle with its state; publishing a new bundle is a
venue-ops action against the registry, and the version-monotonic gate
makes an accidental downgrade unrepresentable.

## What the map never does

- No member coordinates — requests carry cells or nothing (the PWA
  resolves the member's live presence server-side; its cell never
  crosses the wire).
- No third-party tile hosts — a member's tile fetches never leave the
  platform, so no outside party sees their browsing trail.
- No runtime rendering — a tile is a static byte string, attested by
  the registry's pinned hash.
- No unbounded caches — the tile LRU is capped (320 tiles ≈ 20
  zoom-14 viewports) and wipes on bundle change.

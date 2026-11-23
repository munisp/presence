/**
 * TR-37/TR-16: per-market resolution calibration, held in configuration.
 *
 * The TR-12/14 storage-resolution ladder (res 9 → 10 → 11 as live venue
 * density climbs) was code constants; now it lives in market_config so each
 * market calibrates independently. The edge resolves the market for a
 * presence cell through the native h3-pg column (TR-16) and caches the
 * ladder briefly in Valkey — configuration changes propagate within a
 * minute without a deploy.
 *
 * The governed fallback equals the seeded Lagos ladder, so behaviour is
 * unchanged when no market covers a cell (P0 is single-metro, BR-01).
 */

import { EdgeContext } from "./context.js";

export interface ResolutionLadder {
  resDefault: number;
  resBusy: number;
  resCrowd: number;
  busyMinPresences: number;
  crowdMinPresences: number;
}

/** Governed defaults — identical to the seeded Lagos market_config row. */
export const FALLBACK_LADDER: ResolutionLadder = {
  resDefault: 9,
  resBusy: 10,
  resCrowd: 11,
  busyMinPresences: 2_000,
  crowdMinPresences: 10_000,
};

export const MARKET_CACHE_TTL_S = 60;

/** TR-12/14: pick the storage resolution from live venue density, per the
 * market's configured ladder. */
export function resolutionFor(livePresences: number, ladder: ResolutionLadder): number {
  if (livePresences > ladder.crowdMinPresences) return ladder.resCrowd;
  if (livePresences > ladder.busyMinPresences) return ladder.resBusy;
  return ladder.resDefault;
}

const LADDER_CACHE = (marketId: string) => `market:ladder:${marketId}`;
const CELL_MARKET_CACHE = (cell: string) => `market:for:${cell}`;

/** Resolve the ladder for a presence cell: market lookup via the native
 * h3-pg function, cached per cell and per market for a minute. Cells no
 * active market covers get the governed fallback. */
export async function ladderForCell(ctx: EdgeContext, cell: string): Promise<ResolutionLadder> {
  const cachedMarket = await ctx.valkey.get(CELL_MARKET_CACHE(cell));
  if (cachedMarket !== null) {
    return ladderForMarket(ctx, cachedMarket);
  }
  const res = await ctx.pg.query("SELECT market_for_cell($1::h3index) AS market", [cell]);
  const marketId = (res.rows[0]?.market as string | null) ?? "";
  // Negative results are cached too — config flips propagate within a minute.
  await ctx.valkey.set(CELL_MARKET_CACHE(cell), marketId, "EX", MARKET_CACHE_TTL_S);
  if (marketId === "") return FALLBACK_LADDER;
  return ladderForMarket(ctx, marketId);
}

async function ladderForMarket(ctx: EdgeContext, marketId: string): Promise<ResolutionLadder> {
  const cached = await ctx.valkey.get(LADDER_CACHE(marketId));
  if (cached !== null) return JSON.parse(cached) as ResolutionLadder;
  const res = await ctx.pg.query(
    `SELECT res_default, res_busy, res_crowd, busy_min_presences, crowd_min_presences
       FROM market_config WHERE market_id = $1 AND active`,
    [marketId],
  );
  if (res.rows.length === 0) return FALLBACK_LADDER;
  const r = res.rows[0];
  const ladder: ResolutionLadder = {
    resDefault: Number(r.res_default),
    resBusy: Number(r.res_busy),
    resCrowd: Number(r.res_crowd),
    busyMinPresences: Number(r.busy_min_presences),
    crowdMinPresences: Number(r.crowd_min_presences),
  };
  await ctx.valkey.set(LADDER_CACHE(marketId), JSON.stringify(ladder), "EX", MARKET_CACHE_TTL_S);
  return ladder;
}

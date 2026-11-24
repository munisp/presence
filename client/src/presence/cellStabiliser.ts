/**
 * FR-92: the published cell is stabilised over a five-minute window.
 *
 * Positioning noise around a cell edge flips a stationary user between
 * cohorts — matches appear and vanish between scans with no real-world
 * change. The SRS therefore requires: where the computed cell changes
 * without the device moving more than one cell, the published value MUST
 * remain the modal cell of the window.
 *
 * The rules this module implements, in order:
 *  1. REAL MOVEMENT WINS. If the new computed cell is more than
 *     MOVEMENT_THRESHOLD_CELLS grid steps from the last computed cell,
 *     the device actually moved — publish the new cell immediately. A
 *     stabiliser that lags a moving user would be its own defect.
 *  2. FLAPPING SETTLES. Otherwise (distance <= 1, the boundary-noise
 *     case) the published cell is the MODE of the window — the cell the
 *     device has computed most often over the last five minutes. Ties
 *     keep the currently published cell (hysteresis): "remain the modal
 *     cell" means the published value never moves without a strict
 *     majority behind the move.
 *  3. UNMEASURABLE = MOVED. h3-js cannot measure every pair (pentagon
 *     discontinuities, extreme distances). A measurement failure means
 *     "far or incomparable", never "same place" — treat it as movement
 *     and publish fresh. A failed ruler must not freeze a user in a
 *     stale cohort.
 *
 * Determinism is part of the contract: the mode breaks ties by the
 * published cell (hysteresis), then most recent observation, then cell
 * id ascending, so client and tests always agree. Samples older than
 * the window are evicted on every observation, so memory stays bounded
 * by the publish cadence.
 *
 * The only import is h3-js (already the TR-29 cell dependency); the
 * stabiliser itself holds no platform state and never sees coordinates —
 * computed cells go in, published cells come out.
 */

import { gridDistance } from "h3-js";

/** FR-92: the stabilisation window is five minutes. */
export const STABILISATION_WINDOW_MS = 5 * 60 * 1000;

/**
 * FR-92: "without the device moving more than one cell" — movement of at
 * most one grid step is treated as boundary noise and settles to the
 * modal cell; anything further is real movement and publishes fresh.
 */
export const MOVEMENT_THRESHOLD_CELLS = 1;

export type StabilisationReason =
  /** First observation — nothing to stabilise against yet. */
  | "initial"
  /** The device moved more than one cell — publish the fresh cell now. */
  | "moved"
  /** Boundary noise — publish the modal cell of the window. */
  | "modal";

export interface StabilisedObservation {
  /** The cell that MUST be published for this observation. */
  readonly publishCell: string;
  /** Whether the published cell changed with this observation. */
  readonly changed: boolean;
  readonly reason: StabilisationReason;
  /** The raw computed cell this observation carried (for diagnostics). */
  readonly computedCell: string;
}

interface Sample {
  readonly cell: string;
  readonly at: number;
}

/**
 * The modal cell of a sample list: highest frequency wins; ties keep the
 * currently published cell (hysteresis — the published value only moves
 * behind a strict majority), then most recent observation, then cell id
 * ascending — a total order, so the result never depends on iteration
 * quirks.
 */
function modalCell(samples: readonly Sample[], published: string): string {
  const stats = new Map<string, { count: number; lastAt: number }>();
  for (const s of samples) {
    const cur = stats.get(s.cell);
    if (cur) {
      cur.count += 1;
      if (s.at > cur.lastAt) cur.lastAt = s.at;
    } else {
      stats.set(s.cell, { count: 1, lastAt: s.at });
    }
  }
  let best: string | null = null;
  let bestCount = -1;
  let bestLastAt = -1;
  let bestIsPublished = false;
  for (const [cell, { count, lastAt }] of stats) {
    const isPublished = cell === published;
    if (
      count > bestCount ||
      (count === bestCount && isPublished && !bestIsPublished) ||
      (count === bestCount && isPublished === bestIsPublished && lastAt > bestLastAt) ||
      (count === bestCount &&
        isPublished === bestIsPublished &&
        lastAt === bestLastAt &&
        best !== null &&
        cell < best)
    ) {
      best = cell;
      bestCount = count;
      bestLastAt = lastAt;
      bestIsPublished = isPublished;
    }
  }
  // samples is never empty here — observe() always records first.
  return best as string;
}

/** Grid distance, with the FR-92 rule that unmeasurable means "moved". */
function movedBeyondThreshold(from: string, to: string): boolean {
  try {
    return gridDistance(from, to) > MOVEMENT_THRESHOLD_CELLS;
  } catch {
    // Pentagon discontinuity or an incomparable pair — treat as movement
    // so a measurement failure can never pin a user to a stale cell.
    return true;
  }
}

export interface CellStabiliser {
  /**
   * Observe a freshly computed cell at time `at` (epoch ms) and decide
   * what may be published. Timestamps are injected (never read from the
   * platform clock) so the unit tests are fully deterministic.
   */
  observe(cell: string, at: number): StabilisedObservation;
}

/**
 * Create a stabiliser. State is the sliding window of samples and the
 * last computed/published cells — a few dozen entries at realistic
 * cadences, evicted aggressively.
 */
export function createCellStabiliser(): CellStabiliser {
  let samples: Sample[] = [];
  let lastComputed: string | null = null;
  let lastPublished: string | null = null;

  return {
    observe(cell: string, at: number): StabilisedObservation {
      // Slide the window: keep only samples inside the last five minutes.
      samples = samples.filter((s) => at - s.at < STABILISATION_WINDOW_MS);
      samples.push({ cell, at });

      if (lastComputed === null || lastPublished === null) {
        lastComputed = cell;
        lastPublished = cell;
        return { publishCell: cell, changed: true, reason: "initial", computedCell: cell };
      }

      let publishCell: string;
      let reason: StabilisationReason;
      if (movedBeyondThreshold(lastComputed, cell)) {
        // Rule 1/3: real movement (or an unmeasurable pair) publishes fresh.
        publishCell = cell;
        reason = "moved";
      } else {
        // Rule 2: boundary noise settles to the mode of the window, with
        // hysteresis — a tie keeps the currently published cell.
        publishCell = modalCell(samples, lastPublished);
        reason = "modal";
      }

      const changed = publishCell !== lastPublished;
      lastComputed = cell;
      lastPublished = publishCell;
      return { publishCell, changed, reason, computedCell: cell };
    },
  };
}

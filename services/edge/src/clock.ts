/**
 * TECH-15: time, randomness and identifiers are injectable. Routes read the
 * wall clock and mint identifiers only through the context's clock/ids, so
 * expiry and rotation behaviour is testable without sleeping — tests hand
 * the context a fake clock and a deterministic id sequence.
 *
 * Already injectable by design: notification quiet-window checks take `now`
 * (notifications.ts shouldNotify), recurrence day math takes a day ordinal
 * (scan.ts), and the match ranker takes tieBreakSeed for rotation.
 */

import { randomBytes } from "node:crypto";

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface IdSource {
  /** FR-16 presence session id — 128-bit random, hex. */
  sessionId(): string;
}

export const randomIds: IdSource = {
  sessionId: () => randomBytes(16).toString("hex"),
};

/**
 * AMD-CRT-03: the outbox pump — one drain in flight, always, and the
 * queue on disk after every mutation.
 *
 * outbox.ts owns the DRAIN SEMANTICS (FIFO, backoff, poison, pause);
 * this module owns WHEN drains run and WHO may run them:
 *
 *   - TRIGGERS — an enqueue that is due, the app returning to the
 *     foreground, a connectivity promotion out of offline, and the
 *     session recovering from the 401 pause. A dead link never spins
 *     the pump: kicks while offline are skipped, not buffered;
 *   - SINGLE-FLIGHT — concurrent kicks join the in-flight cycle; a kick
 *     that lands mid-flight marks the cycle dirty and exactly ONE
 *     follow-up pass runs, so triggers are never lost and never
 *     multiplied. A venue-full of foreground events produces one drain;
 *   - PERSISTENCE — the queue is serialized and written after every
 *     cycle that touched it (ack, backoff, poison, pause all mutate),
 *     so a crash between cycles loses nothing;
 *   - NEXT WAKE — after a cycle ends "waiting" (the head is in
 *     backoff), the caller asks {@link nextWakeAtMs} when to kick
 *     again; the pump itself owns no timers.
 *
 * Framework-free: send, clock, randomness and storage are injected, so
 * the unit tests run under plain node --test.
 */

import {
  drainOutbox,
  serializeOutbox,
  type DrainOutcome,
  type OutboxEntry,
  type SendEffect,
} from "./outbox.js";
import type { ConnectivitySample } from "./connectivity.js";

export type PumpTrigger =
  /** AMD-CRT-01 queued a mutation that is due now. */
  | "enqueue"
  /** The app returned to the foreground. */
  | "foreground"
  /** The AMD-NET-03 classifier promoted the link out of offline. */
  | "connectivity-promotion"
  /** The session recovered from the 401 pause (AMD-CRT-02). */
  | "session-resumed"
  /** The backoff wake timer fired. */
  | "timer";

export interface PumpEffects {
  /** Sends one entry (outbox.ts SendEffect); THROWS on network failure. */
  send: SendEffect;
  nowMs(): number;
  /** Uniform [0, 1) — full-jitter source for backoff. */
  random(): number;
  /** Writes the serialized queue under OUTBOX_STORAGE_KEY. */
  persist(serialized: string): Promise<void>;
}

export type PumpCycleOutcome = DrainOutcome | "skipped-offline";

export interface PumpCycleResult {
  outcome: PumpCycleOutcome;
  queue: OutboxEntry[];
  /** True when the queue was written back this cycle. */
  persisted: boolean;
}

/** A dead link never spins the pump — enqueueing is the offline story. */
export function pumpAllowed(connectivity: ConnectivitySample): boolean {
  return connectivity.state !== "offline";
}

/**
 * The wall-clock moment the next entry becomes due, or null when nothing
 * is sendable. The caller arms its wake timer with this after a
 * "waiting" cycle; poisoned entries never schedule a wake.
 */
export function nextWakeAtMs(queue: readonly OutboxEntry[]): number | null {
  let earliest: number | null = null;
  for (const entry of queue) {
    if (entry.poisoned) continue;
    if (earliest === null || entry.nextAttemptAtMs < earliest) {
      earliest = entry.nextAttemptAtMs;
    }
  }
  return earliest;
}

export interface OutboxPump {
  /**
   * Request a drain. Joins the in-flight cycle when one is running; a
   * mid-flight kick marks the cycle dirty and exactly one follow-up
   * pass runs after it. Kicks while offline resolve immediately as
   * "skipped-offline" without touching storage.
   */
  kick(trigger: PumpTrigger, connectivity: ConnectivitySample): Promise<PumpCycleResult>;
  /** Replace the in-memory queue (enqueue paths feed the pump here). */
  setQueue(queue: readonly OutboxEntry[]): void;
  /** The current queue snapshot. */
  queue(): OutboxEntry[];
  /** True while a cycle is running. */
  inFlight(): boolean;
}

export function createOutboxPump(
  effects: PumpEffects,
  initialQueue: readonly OutboxEntry[] = [],
): OutboxPump {
  let queue: OutboxEntry[] = [...initialQueue];
  let inFlight: Promise<PumpCycleResult> | null = null;
  let dirty = false;

  async function runCycle(): Promise<PumpCycleResult> {
    for (;;) {
      dirty = false;
      const before = serializeOutbox(queue);
      const { queue: after, outcome } = await drainOutbox(queue, effects.send, {
        nowMs: effects.nowMs,
        uuid: () => {
          // drainOutbox never mints ids; the context shape requires one.
          throw new Error("outboxPump: uuid must not be called during a drain");
        },
        random: effects.random,
      });
      queue = after;
      // Persist after every mutation: any pass that ran a send moved
      // attempts/backoff/poison/ack state, and a crash must not lose it.
      // A pass that found nothing to do leaves the serialization
      // byte-identical and skips the write.
      const persisted = serializeOutbox(after) !== before;
      if (persisted) {
        await effects.persist(serializeOutbox(after));
      }
      if (!dirty) return { outcome, queue: [...queue], persisted };
      // A kick landed mid-flight — run exactly one more pass; further
      // kicks during that pass simply re-mark the flag.
    }
  }

  return {
    kick(_trigger: PumpTrigger, connectivity: ConnectivitySample): Promise<PumpCycleResult> {
      if (!pumpAllowed(connectivity)) {
        return Promise.resolve({
          outcome: "skipped-offline",
          queue: [...queue],
          persisted: false,
        });
      }
      if (inFlight !== null) {
        dirty = true;
        return inFlight;
      }
      const run = runCycle().finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },
    setQueue(next: readonly OutboxEntry[]): void {
      queue = [...next];
    },
    queue(): OutboxEntry[] {
      return [...queue];
    },
    inFlight(): boolean {
      return inFlight !== null;
    },
  };
}

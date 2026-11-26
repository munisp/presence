/**
 * AMD-NET-01: the action outbox — a tap taken on a 2G uplink is never
 * silently dropped.
 *
 * State-changing requests (publish, message send, withdrawal, booking
 * actions) are enqueued with a uuid4 idempotency key minted AT ENQUEUE
 * TIME — retrying the entry can therefore never double-apply server-side.
 * The queue drains strictly FIFO, acknowledges only on 2xx, retries at
 * most {@link OUTBOX_MAX_ATTEMPTS} times with full-jitter exponential
 * backoff (base 2 s, cap 5 min), and classifies failures deliberately:
 *
 *   - 401       — PAUSE the drain (the session is refreshing; AMD-NET-03);
 *   - 426       — POISON (the client is too old; retrying cannot help);
 *   - other 4xx — POISON (the request itself is wrong; surface it);
 *   - 5xx / network failure — bounded retry with backoff.
 *
 * Content in flight is a reviewed, bounded exception to TR-30's no-cache
 * stance: entries are write-only until acknowledged, are never read back
 * into the UI, persist under the single allowlisted key
 * "presence.outbox.queue", and are wiped by the same logout and duress
 * wipes as the session — by construction, because the wipe iterates the
 * TR-30 allowlist.
 *
 * Framework-free: clock, randomness, uuid, storage and the send effect
 * are injected, so the unit tests run under plain node --test.
 */

/** Hard caps — fail closed, surfaced to the member. */
export const OUTBOX_MAX_ENTRIES = 100;
export const OUTBOX_MAX_BODY_BYTES = 64 * 1024;
export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BACKOFF_BASE_MS = 2_000;
export const OUTBOX_BACKOFF_CAP_MS = 5 * 60_000;

/** Single persistence key, on the TR-30 allowlist (localState.ts). */
export const OUTBOX_STORAGE_KEY = "presence.outbox.queue";

export type OutboxMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface OutboxEntry {
  /** Entry id — uuid4, minted at enqueue. */
  id: string;
  method: OutboxMethod;
  path: string;
  /** Serialized request body (JSON text). */
  body: string;
  /** Server-visible idempotency key — minted at enqueue, never re-minted. */
  idempotencyKey: string;
  enqueuedAtMs: number;
  /** Send attempts so far; {@link OUTBOX_MAX_ATTEMPTS} poisons. */
  attempts: number;
  /** Earliest next send moment (backoff schedule). */
  nextAttemptAtMs: number;
  /** Poisoned entries are kept for the UI to surface, never re-sent. */
  poisoned: boolean;
}

export interface OutboxDraft {
  method: OutboxMethod;
  path: string;
  body: string;
}

export interface OutboxContext {
  nowMs(): number;
  uuid(): string;
  /** Uniform [0, 1) — full-jitter source. */
  random(): number;
}

// ---------------------------------------------------------------- enqueue --

export type EnqueueResult =
  | { ok: true; entry: OutboxEntry }
  | { ok: false; reason: "queue-full" | "body-too-large" };

/**
 * Enqueue a draft. The idempotency key is minted HERE, at enqueue time —
 * a retry is the same logical action, never a new one. Fail closed when
 * the caps are exceeded: a queue that grows without bound on a dead link
 * is a data-loss machine.
 */
export function enqueueAction(
  queue: readonly OutboxEntry[],
  draft: OutboxDraft,
  ctx: OutboxContext,
): { queue: OutboxEntry[]; result: EnqueueResult } {
  if (queue.length >= OUTBOX_MAX_ENTRIES) {
    return { queue: [...queue], result: { ok: false, reason: "queue-full" } };
  }
  if (byteLength(draft.body) > OUTBOX_MAX_BODY_BYTES) {
    return { queue: [...queue], result: { ok: false, reason: "body-too-large" } };
  }
  const entry: OutboxEntry = {
    id: ctx.uuid(),
    method: draft.method,
    path: draft.path,
    body: draft.body,
    idempotencyKey: ctx.uuid(),
    enqueuedAtMs: ctx.nowMs(),
    attempts: 0,
    nextAttemptAtMs: ctx.nowMs(),
    poisoned: false,
  };
  return { queue: [...queue, entry], result: { ok: true, entry } };
}

function byteLength(text: string): number {
  // Node + Hermes both provide TextEncoder; UTF-8 is the wire encoding.
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------- backoff --

/**
 * Full-jitter exponential backoff: base 2 s doubling per attempt, capped
 * at 5 minutes, uniformly randomized in [0, delay]. Full jitter (not
 * "equal jitter") because a venue-full of clients recovering together
 * must not thunder the edge in lock-step.
 */
export function backoffDelayMs(attempts: number, random: () => number): number {
  const exponential = OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, OUTBOX_BACKOFF_CAP_MS);
  return Math.floor(random() * capped);
}

// ------------------------------------------------------------- responses --

export type ResponseClass = "ack" | "pause" | "poison" | "retry";

/**
 * What a response status means for the head entry. 2xx is the ONLY
 * acknowledgement; 401 pauses the whole drain (AMD-NET-03 owns the
 * session recovery); 426 means the server refuses this client version,
 * so retrying cannot help; any other 4xx is a defect in the request.
 */
export function classifyResponse(status: number): ResponseClass {
  if (status >= 200 && status < 300) return "ack";
  if (status === 401) return "pause";
  if (status === 426) return "poison";
  if (status >= 400 && status < 500) return "poison";
  return "retry";
}

// ------------------------------------------------------------------ drain --

/** The send effect: resolves with the HTTP status, THROWS on network failure. */
export type SendEffect = (entry: OutboxEntry) => Promise<{ status: number }>;

export type DrainOutcome = "drained" | "paused" | "waiting";

/**
 * Drain due entries strictly FIFO. Stops at the first entry that is not
 * yet due, and pauses the whole queue on a 401 — the entries behind the
 * head must not leapfrog it (ordering is the point of the outbox).
 */
export async function drainOutbox(
  queue: readonly OutboxEntry[],
  send: SendEffect,
  ctx: OutboxContext,
): Promise<{ queue: OutboxEntry[]; outcome: DrainOutcome }> {
  let current = [...queue];
  let outcome: DrainOutcome = "drained";
  for (;;) {
    const head = current.find((e) => !e.poisoned);
    if (!head) break;
    if (head.nextAttemptAtMs > ctx.nowMs()) {
      outcome = "waiting";
      break;
    }
    const attempts = head.attempts + 1;
    let cls: ResponseClass;
    try {
      cls = classifyResponse((await send({ ...head, attempts })).status);
    } catch {
      cls = "retry"; // network failure — indistinguishable from a 5xx here
    }
    if (cls === "ack") {
      current = current.filter((e) => e.id !== head.id);
      continue;
    }
    if (cls === "pause") {
      current = current.map((e) => (e.id === head.id ? { ...e, attempts } : e));
      outcome = "paused";
      break;
    }
    if (cls === "poison" || attempts >= OUTBOX_MAX_ATTEMPTS) {
      current = current.map((e) =>
        e.id === head.id ? { ...e, attempts, poisoned: true } : e,
      );
      continue; // poison skips to the next entry — it never blocks the queue
    }
    const delay = backoffDelayMs(attempts, ctx.random);
    current = current.map((e) =>
      e.id === head.id
        ? { ...e, attempts, nextAttemptAtMs: ctx.nowMs() + delay }
        : e,
    );
    outcome = "waiting";
    break; // the head is rescheduled; FIFO means nothing behind it runs yet
  }
  return { queue: current, outcome };
}

/** Pending (sendable) entries — the UI badge count. */
export function pendingCount(queue: readonly OutboxEntry[]): number {
  return queue.filter((e) => !e.poisoned).length;
}

/** Poisoned entries — the UI surfaces these for manual review/retry. */
export function poisonedEntries(queue: readonly OutboxEntry[]): OutboxEntry[] {
  return queue.filter((e) => e.poisoned);
}

/** Manual retry of a poisoned entry: reset, never re-mint the keys. */
export function retryPoisoned(
  queue: readonly OutboxEntry[],
  id: string,
  nowMs: number,
): OutboxEntry[] {
  return queue.map((e) =>
    e.id === id && e.poisoned
      ? { ...e, poisoned: false, attempts: 0, nextAttemptAtMs: nowMs }
      : e,
  );
}

/** Discard a poisoned entry the member chose not to retry. */
export function discardEntry(queue: readonly OutboxEntry[], id: string): OutboxEntry[] {
  return queue.filter((e) => e.id !== id);
}

// ------------------------------------------------------------ persistence --

export function serializeOutbox(queue: readonly OutboxEntry[]): string {
  return JSON.stringify({ version: 1, entries: queue });
}

/**
 * Load a persisted queue. Corrupt JSON or a shape mismatch is an EMPTY
 * queue — a poisoned store must never crash startup, and the write-only
 * discipline means nothing user-visible is lost silently.
 */
export function loadOutbox(raw: string | null): OutboxEntry[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter(isOutboxEntry);
  } catch {
    return [];
  }
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.method === "string" &&
    typeof e.path === "string" &&
    typeof e.body === "string" &&
    typeof e.idempotencyKey === "string" &&
    typeof e.enqueuedAtMs === "number" &&
    typeof e.attempts === "number" &&
    typeof e.nextAttemptAtMs === "number" &&
    typeof e.poisoned === "boolean"
  );
}

/**
 * AMD-PWA-04 (the mutation outbox): a tap taken on a 2G uplink is never
 * silently dropped — the lite client mirrors the native AMD-NET-01.
 *
 * State-changing requests (consent express/decline/open, notification
 * prefs, device revoke) are enqueued with a uuid4 idempotency key minted
 * AT ENQUEUE TIME — retrying the entry can therefore never double-apply
 * server-side. The queue drains strictly FIFO and single-flight,
 * acknowledges only on 2xx, retries at most {@link OUTBOX_MAX_ATTEMPTS}
 * times with full-jitter exponential backoff (base 2 s, cap 5 min), and
 * classifies failures deliberately:
 *
 *   - 401       — PAUSE the drain (the session is refreshing);
 *   - 426       — POISON (the client is too old; retrying cannot help);
 *   - other 4xx — POISON (the request itself is wrong; surface it);
 *   - 5xx / network failure — bounded retry with backoff.
 *
 * Entries are write-only until acknowledged, are never read back as
 * truth (the read cache is the only readable persistence), persist under
 * the single allowlisted key "presence.pwa.outbox", and are wiped by
 * sign-out exactly like the read cache.
 *
 * Framework-free: clock, uuid, storage and the send effect are injected,
 * so the unit tests run under plain node --test.
 */

/** Hard caps — fail closed, surfaced to the member. */
export const OUTBOX_MAX_ENTRIES = 50;
export const OUTBOX_MAX_BODY_BYTES = 32 * 1024;
export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BACKOFF_BASE_MS = 2_000;
export const OUTBOX_BACKOFF_CAP_MS = 5 * 60_000;

/** Single persistence key, on the AMD-PWA-06 wipe contract. */
export const OUTBOX_STORAGE_KEY = "presence.pwa.outbox";

export type OutboxMethod = "POST" | "PUT" | "DELETE";

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
  body: unknown;
}

export interface OutboxEffects {
  nowMs(): number;
  uuid(): string;
  /** 0..1 exclusive — full jitter. */
  random(): number;
}

/** Minimal storage shape — localStorage in the shell, a Map in tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function loadQueue(storage: KeyValueStorage): OutboxEntry[] {
  const raw = storage.getItem(OUTBOX_STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

function persistQueue(storage: KeyValueStorage, queue: OutboxEntry[]): void {
  storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(queue));
}

/**
 * Enqueue a mutation. Fails closed at the caps: an over-length body or a
 * full queue is refused LOUDLY (the member sees "couldn't queue that"),
 * never silently dropped.
 */
export function enqueue(
  storage: KeyValueStorage,
  draft: OutboxDraft,
  effects: OutboxEffects,
): OutboxEntry {
  const queue = loadQueue(storage);
  const active = queue.filter((e) => !e.poisoned);
  if (active.length >= OUTBOX_MAX_ENTRIES) {
    throw new Error("outbox-full");
  }
  const body = JSON.stringify(draft.body ?? {});
  if (body.length > OUTBOX_MAX_BODY_BYTES) {
    throw new Error("outbox-body-too-large");
  }
  const entry: OutboxEntry = {
    id: effects.uuid(),
    method: draft.method,
    path: draft.path,
    body,
    idempotencyKey: effects.uuid(),
    enqueuedAtMs: effects.nowMs(),
    attempts: 0,
    nextAttemptAtMs: effects.nowMs(),
    poisoned: false,
  };
  queue.push(entry);
  persistQueue(storage, queue);
  return entry;
}

export function pendingEntries(storage: KeyValueStorage): OutboxEntry[] {
  return loadQueue(storage).filter((e) => !e.poisoned);
}

export function poisonedEntries(storage: KeyValueStorage): OutboxEntry[] {
  return loadQueue(storage).filter((e) => e.poisoned);
}

export type SendResult =
  | { kind: "ack" }
  | { kind: "pause" } // 401 — the session is refreshing
  | { kind: "poison" } // 4xx/426 — the request itself is wrong
  | { kind: "retry" }; // 5xx/network — bounded backoff

/**
 * Single-flight drain: at most one entry in flight. Returns after the
 * first pause/poison so the UI can surface immediately.
 */
export async function drainOnce(
  storage: KeyValueStorage,
  send: (entry: OutboxEntry) => Promise<SendResult>,
  effects: OutboxEffects,
): Promise<{ sent: number; paused: boolean; poisoned: number }> {
  let queue = loadQueue(storage);
  let sent = 0;
  let poisoned = 0;
  for (;;) {
    const now = effects.nowMs();
    const head = queue.find((e) => !e.poisoned && e.nextAttemptAtMs <= now);
    if (!head) return { sent, paused: false, poisoned };
    const result = await send(head);
    queue = loadQueue(storage); // re-read: the send effect may have mutated
    const current = queue.find((e) => e.id === head.id);
    if (!current) return { sent, paused: false, poisoned };
    if (result.kind === "ack") {
      queue = queue.filter((e) => e.id !== head.id);
      persistQueue(storage, queue);
      sent += 1;
      continue;
    }
    if (result.kind === "pause") {
      return { sent, paused: true, poisoned };
    }
    if (result.kind === "poison" || current.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) {
      current.attempts += 1;
      current.poisoned = true;
      persistQueue(storage, queue);
      poisoned += 1;
      continue;
    }
    current.attempts += 1;
    const backoff = Math.min(
      OUTBOX_BACKOFF_CAP_MS,
      OUTBOX_BACKOFF_BASE_MS * 2 ** (current.attempts - 1),
    );
    current.nextAttemptAtMs = now + Math.floor(effects.random() * backoff);
    persistQueue(storage, queue);
    return { sent, paused: false, poisoned };
  }
}

/** Sign-out and the AMD-PWA-06 wipe both land here. */
export function wipeOutbox(storage: KeyValueStorage): void {
  storage.removeItem(OUTBOX_STORAGE_KEY);
}

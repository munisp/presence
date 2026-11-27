/**
 * AMD-CRT-01: the API client — the single HTTP chokepoint.
 *
 * Every request the client makes flows through this module:
 *
 *   - HEADERS — the bearer and the FR-05 device id (session.ts), the
 *     TR-27 client protocol version, and on mutations an
 *     Idempotency-Key minted before the first byte flies;
 *   - OBSERVATION — every outcome feeds the AMD-NET-03 classifier
 *     (round-trip on success, failure otherwise). The classifier is fed
 *     by real traffic, never by synthetic pings;
 *   - READS — attempt the network; on a network failure the caller is
 *     told exactly that, so it can fall back to the AMD-NET-02 read
 *     cache with the staleness marker — never silently;
 *   - MUTATIONS — when the classifier says offline the request enqueues
 *     straight into the AMD-NET-01 outbox; otherwise it is attempted,
 *     and a network failure enqueues THE SAME request — same body, same
 *     idempotency key — for the AMD-CRT-03 pump. A tap is never
 *     silently dropped and never applied twice;
 *   - TIMEOUTS — per-call, sized inside the AMD-NET-05 budgets;
 *   - 401 — the existing exactly-one-refresh-retry discipline
 *     (session.ts); a second 401 is re-authentication, never a loop.
 *
 * Framework-free: fetch, the clock, uuid, and randomness are injected,
 * so the unit tests run under plain node --test.
 */

import { authHeaders, onUnauthorized, type SessionTokens } from "./session.js";
import { CLIENT_PROTOCOL_VERSION } from "./versioning.js";
import type { ConnectivitySample } from "./connectivity.js";
import { enqueueAction, type OutboxEntry, type OutboxMethod } from "./outbox.js";

/** Default per-call timeout — inside every AMD-NET-05 surface budget. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface WireRequest {
  method: OutboxMethod | "GET";
  path: string;
  body?: string;
  /** Override the default timeout (must stay inside the budgets). */
  timeoutMs?: number;
}

export interface WireResponse {
  status: number;
  /** Raw response text; callers parse fail-closed. */
  body: string;
  /** Server round-trip as measured by this client, milliseconds. */
  rttMs: number;
}

/** The injected fetch: resolves with status + body, THROWS on network failure. */
export type FetchEffect = (
  req: { method: string; path: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
) => Promise<WireResponse>;

export interface ApiClientEffects {
  fetch: FetchEffect;
  nowMs(): number;
  uuid(): string;
  random(): number;
  /** Observation sink — the caller folds these into the classifier. */
  record(result: { ok: boolean; rttMs?: number }): void;
}

export type ReadOutcome =
  | { kind: "response"; response: WireResponse }
  /** Network failure — the caller falls back to the read cache. */
  | { kind: "network-failure" };

export type MutationOutcome =
  | { kind: "response"; response: WireResponse }
  /** Queued for the pump — the idempotency key travels with it. */
  | { kind: "queued"; entry: OutboxEntry }
  /** The outbox refused (caps) — fail closed, surfaced to the member. */
  | { kind: "refused"; reason: "queue-full" | "body-too-large" };

export interface MutationResult {
  outcome: MutationOutcome;
  queue: OutboxEntry[];
}

function baseHeaders(tokens: SessionTokens | null): Record<string, string> {
  return {
    ...(tokens ? authHeaders(tokens) : {}),
    "x-client-version": String(CLIENT_PROTOCOL_VERSION),
    accept: "application/json",
  };
}

async function attempt(
  effects: ApiClientEffects,
  req: { method: string; path: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<WireResponse | null> {
  try {
    const res = await effects.fetch(req, timeoutMs);
    effects.record({ ok: true, rttMs: Math.max(0, res.rttMs) });
    return res;
  } catch {
    effects.record({ ok: false });
    return null;
  }
}

/**
 * Read path: network first, honest failure. The read-cache fallback is
 * the CALLER's job (it owns the staleness copy) — this layer reports
 * exactly what happened.
 */
export async function executeRead(
  effects: ApiClientEffects,
  tokens: SessionTokens | null,
  req: WireRequest,
): Promise<ReadOutcome> {
  const res = await attempt(
    effects,
    { method: req.method, path: req.path, headers: baseHeaders(tokens), body: req.body },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return res === null ? { kind: "network-failure" } : { kind: "response", response: res };
}

/**
 * Mutation path. The idempotency key is minted BEFORE the send; an
 * offline link skips the doomed attempt and queues; a failed attempt
 * queues the SAME request with the SAME key (the server may or may not
 * have processed the first attempt — the key is what makes that safe).
 */
export async function executeMutation(
  effects: ApiClientEffects,
  tokens: SessionTokens,
  connectivity: ConnectivitySample,
  req: WireRequest,
  queue: readonly OutboxEntry[],
): Promise<MutationResult> {
  const idempotencyKey = effects.uuid();
  const draft = {
    method: req.method as OutboxMethod,
    path: req.path,
    body: req.body ?? "{}",
    idempotencyKey,
  };

  if (connectivity.state === "offline") {
    const { queue: next, result } = enqueueAction(queue, draft, effects);
    if (!result.ok) {
      return { outcome: { kind: "refused", reason: result.reason }, queue: next };
    }
    return { outcome: { kind: "queued", entry: result.entry }, queue: next };
  }

  const headers = {
    ...baseHeaders(tokens),
    "idempotency-key": idempotencyKey,
    "content-type": "application/json",
  };
  const res = await attempt(
    effects,
    { method: draft.method, path: draft.path, headers, body: draft.body },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res !== null) {
    return { outcome: { kind: "response", response: res }, queue: [...queue] };
  }
  // The wire failed — enqueue the same request with the same key.
  const { queue: next, result } = enqueueAction(queue, draft, effects);
  if (!result.ok) {
    return { outcome: { kind: "refused", reason: result.reason }, queue: next };
  }
  return { outcome: { kind: "queued", entry: result.entry }, queue: next };
}

/**
 * The 401 decision, re-exported through the chokepoint so callers never
 * reach into session.ts directly: exactly one refresh-retry, then
 * re-authentication.
 */
export function onMutationUnauthorized(alreadyRetried: boolean): "refresh-retry" | "reauthenticate" {
  return onUnauthorized(alreadyRetried);
}

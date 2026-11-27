/**
 * AMD-PWA-03 (member transport): ONE chokepoint for every member API
 * call, mirroring the member client's AMD-CRT-01 discipline — the bearer
 * is attached centrally, every mutation mints its Idempotency-Key BEFORE
 * send, the timeout is bounded, and failures are typed so the render half
 * can tell "sign in again" (401) from "not allowed" (403) from "not
 * there yet" (404 — a normal state for a member who has not set up an
 * identity) from "the edge is unreachable" (network/5xx, which the
 * AMD-PWA-04 connectivity classifier degrades on).
 *
 * Every call ALSO reports an observation (ok + round-trip) to the
 * connectivity classifier — the transport is the sensor network for the
 * offline-honest surfaces.
 */

export const MEMBER_TIMEOUT_MS = 10_000;
/** Stamped as x-client-version so the edge version contract applies. */
export const MEMBER_CLIENT_VERSION = "presence-pwa/0.1.0";

export interface MemberRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface MemberResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type MemberFetch = (url: string, init: MemberRequestInit) => Promise<MemberResponse>;

export interface MemberApiEffects {
  fetch: MemberFetch;
  uuid(): string;
  nowMs(): number;
  /** AMD-PWA-04: every completed request feeds the link classifier. */
  observe(observation: { ok: boolean; rttMs?: number }): void;
}

export class MemberApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MemberApiError";
  }
}

/** 401 — the session is dead; the only remedy is a fresh sign-in. */
export class MemberAuthError extends MemberApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "MemberAuthError";
  }
}

/** 403 — authenticated, but the member may not do this. */
export class MemberForbiddenError extends MemberApiError {
  constructor(message: string) {
    super(403, message);
    this.name = "MemberForbiddenError";
  }
}

/** 404 — e.g. identity not set up yet: a normal member state, not a bug. */
export class MemberNotFoundError extends MemberApiError {
  constructor(message: string) {
    super(404, message);
    this.name = "MemberNotFoundError";
  }
}

export interface MemberApi {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown, idempotencyKey?: string): Promise<T>;
  put<T = unknown>(path: string, body: unknown, idempotencyKey?: string): Promise<T>;
  delete<T = unknown>(path: string, idempotencyKey?: string): Promise<T>;
}

export function createMemberApi(
  baseUrl: string,
  tokenProvider: () => string | null,
  effects: MemberApiEffects,
): MemberApi {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const bearer = tokenProvider();
    if (bearer === null) throw new MemberAuthError("no member session");
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`,
      accept: "application/json",
      "x-client-version": MEMBER_CLIENT_VERSION,
    };
    let payload: string | undefined;
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      // Minted BEFORE send — or supplied by the AMD-PWA-04 outbox, whose
      // entries carry their enqueue-time key so a re-driven action
      // replays the SAME key and the edge idempotency store dedupes it.
      headers["idempotency-key"] = idempotencyKey ?? effects.uuid();
      payload = JSON.stringify(body ?? {});
    }
    const started = effects.nowMs();
    let res: MemberResponse;
    try {
      res = await effects.fetch(`${root}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(MEMBER_TIMEOUT_MS),
      });
    } catch {
      // A fetch reject is a network-class failure: it never reached a
      // status line, so it feeds the classifier as a failure and
      // surfaces as an unreachable-edge error, not an auth event.
      effects.observe({ ok: false });
      throw new MemberApiError(0, `${method} ${path} unreachable`);
    }
    effects.observe({ ok: res.status < 500, rttMs: Math.max(0, effects.nowMs() - started) });
    if (res.status === 401) throw new MemberAuthError("member session rejected");
    if (res.status === 403) throw new MemberForbiddenError(`${method} ${path} refused`);
    if (res.status === 404) throw new MemberNotFoundError(`${method} ${path} not found`);
    if (!res.ok) throw new MemberApiError(res.status, `${method} ${path} answered ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string) => request<T>("GET", path, undefined),
    post: <T>(path: string, body: unknown, idempotencyKey?: string) =>
      request<T>("POST", path, body, idempotencyKey),
    put: <T>(path: string, body: unknown, idempotencyKey?: string) =>
      request<T>("PUT", path, body, idempotencyKey),
    delete: <T>(path: string, idempotencyKey?: string) =>
      request<T>("DELETE", path, undefined, idempotencyKey),
  };
}

/**
 * AMD-CON-03 (console transport): ONE chokepoint for every workforce API
 * call, mirroring the member client's AMD-CRT-01 discipline — the bearer
 * is attached centrally, every mutation mints its Idempotency-Key BEFORE
 * send, the timeout is bounded, and failures are typed so the render half
 * can tell "sign in again" (401) from "your role cannot do this" (403)
 * from "the edge is down" (network/5xx).
 */

export const CONSOLE_TIMEOUT_MS = 10_000;
/** Stamped as x-client-version so the edge version contract applies. */
export const CONSOLE_CLIENT_VERSION = "presence-console/0.1.0";

export interface ConsoleRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface ConsoleResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type ConsoleFetch = (url: string, init: ConsoleRequestInit) => Promise<ConsoleResponse>;

export interface ConsoleApiEffects {
  fetch: ConsoleFetch;
  uuid(): string;
}

export class ConsoleApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConsoleApiError";
  }
}

/** 401 — the session is dead; the only remedy is a fresh sign-in. */
export class ConsoleAuthError extends ConsoleApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "ConsoleAuthError";
  }
}

/** 403 — authenticated, but the role does not cover this surface. */
export class ConsoleForbiddenError extends ConsoleApiError {
  constructor(message: string) {
    super(403, message);
    this.name = "ConsoleForbiddenError";
  }
}

export interface ConsoleApi {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

export function createConsoleApi(
  baseUrl: string,
  tokenProvider: () => string | null,
  effects: ConsoleApiEffects,
): ConsoleApi {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(method: string, path: string, body: unknown): Promise<T> {
    const bearer = tokenProvider();
    if (bearer === null) throw new ConsoleAuthError("no workforce session");
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`,
      accept: "application/json",
      "x-client-version": CONSOLE_CLIENT_VERSION,
    };
    let payload: string | undefined;
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      // Minted BEFORE send: a retried or re-driven action replays the SAME
      // key, so the edge idempotency store can dedupe it.
      headers["idempotency-key"] = effects.uuid();
      payload = JSON.stringify(body ?? {});
    }
    const res = await effects.fetch(`${root}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
    });
    if (res.status === 401) throw new ConsoleAuthError("workforce session rejected");
    if (res.status === 403) throw new ConsoleForbiddenError(`${method} ${path} refused for this role`);
    if (!res.ok) throw new ConsoleApiError(res.status, `${method} ${path} answered ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string) => request<T>("GET", path, undefined),
    post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  };
}

/**
 * FR-01: the consumer session — token lifecycle and logout discipline.
 *
 * The access token is short-lived (SEC-02: the consumer realm issues
 * 5-minute tokens); the refresh token is the only credential the device
 * persists, under the TR-30 allowlisted key "presence.session.refreshToken"
 * in the platform secure store. This module is the pure decision layer:
 *
 *   - WHEN to refresh — REFRESH_MARGIN_S before expiry, so one retry
 *     window fits inside the token's remaining life;
 *   - what a 401 MEANS — exactly one refresh-and-retry; a second 401 is
 *     re-authentication, never a retry loop;
 *   - how logout is ORDERED — withdraw presence FIRST (that call needs a
 *     still-valid access token), then RP-initiated logout at the IdP,
 *     then the TR-30 local wipe. Any other order strands presence on the
 *     server or leaves a live IdP session that silently re-logs-in;
 *   - what every authed call CARRIES — the bearer plus the FR-05 device
 *     id, so server-side revocation (SEC-02) bites within its budget.
 *
 * The second-device rule of FR-01 lives one call away: a new device
 * completes this same sign-in, then enrols through the attestation-gated
 * POST /v1/devices (device-cap trigger rejects a fourth), so enrolment is
 * always anchored on an authenticated session; the recovery path is the
 * SEC-09 recovery phone, never a password reset — there is no password.
 *
 * Hermes-safe and framework-free: effects (HTTP, browser, storage) are
 * injected, so the unit tests run under plain node --test.
 */

import { clearLocalState, type KeyValueBackend, type LocalStateKey } from "./localState.js";
import { WITHDRAWAL_WIRE } from "./presenceLifecycle.js";

/** SEC-02: the consumer realm issues 5-minute access tokens. */
export const ACCESS_TOKEN_LIFESPAN_S = 300;

/**
 * Refresh this far before expiry. One slow retry (network + IdP) fits in
 * the margin without the token dying mid-refresh.
 */
export const REFRESH_MARGIN_S = 30;

/**
 * TR-30 allowlisted persistence key for the refresh token. Typed as a
 * {@link LocalStateKey} so drift against the allowlist is a compile
 * error — the allowlist stays the single source of truth.
 */
export const SESSION_REFRESH_TOKEN_KEY: LocalStateKey = "presence.session.refreshToken";

export interface SessionTokens {
  accessToken: string;
  /** Epoch milliseconds after which the access token is refused. */
  expiresAtMs: number;
  refreshToken: string;
  /** FR-05: the enrolled device id, attached to every authed call. */
  deviceId: string;
  /** RP-initiated logout hint, when the IdP returned one. */
  idToken?: string | undefined;
}

export type SessionState =
  | { status: "signed-out" }
  | { status: "active"; tokens: SessionTokens }
  | { status: "reauthenticate" };

// --------------------------------------------------------------- refresh --

/** The wall-clock moment the client should start refreshing. */
export function refreshDueAtMs(tokens: SessionTokens): number {
  return tokens.expiresAtMs - REFRESH_MARGIN_S * 1000;
}

export function isAccessTokenUsable(tokens: SessionTokens, nowMs: number): boolean {
  return nowMs < tokens.expiresAtMs;
}

export function shouldRefresh(tokens: SessionTokens, nowMs: number): boolean {
  return nowMs >= refreshDueAtMs(tokens);
}

// --------------------------------------------------------------- headers --

/**
 * FR-05/SEC-02: every authed call carries the bearer and the device id.
 * The device id is what lets server-side revocation deny a revoked
 * device's session inside the 60-second budget.
 */
export function authHeaders(tokens: SessionTokens): Record<string, string> {
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    "x-device-id": tokens.deviceId,
  };
}

// ------------------------------------------------------------------- 401 --

export type UnauthorizedDecision = "refresh-retry" | "reauthenticate";

/**
 * Exactly one refresh-and-retry per request. A second 401 means the
 * refresh token itself is dead (revoked device, expired session) — the
 * honest next step is re-authentication, never a retry loop.
 */
export function onUnauthorized(alreadyRetried: boolean): UnauthorizedDecision {
  return alreadyRetried ? "reauthenticate" : "refresh-retry";
}

// --------------------------------------------------------- token mapping --

export interface TokenResponseLike {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
}

/**
 * Map a token-endpoint response onto session tokens — FAIL CLOSED on
 * garbage: a response without a usable access token, lifetime, or refresh
 * token is not a session.
 */
export function sessionFromTokenResponse(
  json: TokenResponseLike,
  deviceId: string,
  nowMs: number,
): SessionTokens | null {
  if (typeof json.access_token !== "string" || json.access_token.length === 0) return null;
  if (typeof json.expires_in !== "number" || !(json.expires_in > 0)) return null;
  if (typeof json.refresh_token !== "string" || json.refresh_token.length === 0) return null;
  return {
    accessToken: json.access_token,
    expiresAtMs: nowMs + json.expires_in * 1000,
    refreshToken: json.refresh_token,
    deviceId,
    idToken: typeof json.id_token === "string" ? json.id_token : undefined,
  };
}

/**
 * SEC-02: refresh responses may rotate the refresh token (the realm
 * revokes on use); keep the previous one only when the response omits a
 * replacement — never drop the credential on the floor.
 */
export function refreshedSession(
  previous: SessionTokens,
  json: TokenResponseLike,
  nowMs: number,
): SessionTokens | null {
  if (typeof json.access_token !== "string" || json.access_token.length === 0) return null;
  if (typeof json.expires_in !== "number" || !(json.expires_in > 0)) return null;
  const refreshToken =
    typeof json.refresh_token === "string" && json.refresh_token.length > 0
      ? json.refresh_token
      : previous.refreshToken;
  return {
    ...previous,
    accessToken: json.access_token,
    expiresAtMs: nowMs + json.expires_in * 1000,
    refreshToken,
    idToken: typeof json.id_token === "string" ? json.id_token : previous.idToken,
  };
}

// ------------------------------------------------------------ persistence --

/** Restore a persisted refresh token — empty/garbage never restores. */
export function restoreRefreshToken(stored: string | null): string | null {
  if (stored === null) return null;
  const trimmed = stored.trim();
  return trimmed.length > 0 ? stored : null;
}

/** Persist under the TR-30 allowlisted key (secure store only). */
export async function persistRefreshToken(
  backend: KeyValueBackend,
  refreshToken: string,
): Promise<void> {
  await backend.setItem(SESSION_REFRESH_TOKEN_KEY, refreshToken);
}

// ------------------------------------------------------------- pipelines --

/**
 * FR-01 first sign-in order, pinned: exchange the code, enrol the device
 * (attestation-gated, capped at three), persist the refresh token LAST —
 * a device that cannot enrol never holds a resumable credential.
 */
export const FIRST_SIGN_IN_PIPELINE = [
  "exchange-code",
  "enrol-device",
  "persist-refresh-token",
] as const;

/** FR-05: device enrolment is attestation-gated and capped at three. */
export const DEVICE_ENROLMENT_WIRE = { method: "POST", path: "/v1/devices" } as const;

/**
 * FR-19 logout order, pinned: withdraw (needs a valid access token) →
 * IdP logout (or the next authorize silently re-logs-in) → TR-30 wipe.
 */
export const LOGOUT_PIPELINE = [
  "withdraw-presence",
  "rp-initiated-logout",
  "clear-local-state",
] as const;

export interface LogoutEffects {
  /** Executes {@link WITHDRAWAL_WIRE} with the given auth headers. */
  withdrawPresence: (headers: Record<string, string>) => Promise<void>;
  /** Opens the RP-initiated logout URL in the system browser. */
  endIdpSession: (logoutUrl: string) => Promise<void>;
}

/**
 * Logout with the pinned order. Withdraw FIRST: the call needs a
 * still-valid access token, and the FR-19 presence-withdrawal contract
 * does not wait for the IdP round-trip. The local wipe runs LAST and
 * covers every allowlisted key by construction (TR-30).
 */
export async function executeLogout(
  tokens: SessionTokens,
  logoutUrl: string,
  effects: LogoutEffects,
  backend: KeyValueBackend,
): Promise<void> {
  await effects.withdrawPresence(authHeaders(tokens));
  await effects.endIdpSession(logoutUrl);
  await clearLocalState(backend);
}

/** The wire the logout's first step travels on (FR-19's withdrawal). */
export const LOGOUT_WITHDRAWAL_WIRE = WITHDRAWAL_WIRE;

/** Guard: the logout order is exactly the pinned FR-19 order. */
export function logoutHonoursFr19(steps: readonly string[]): boolean {
  return (
    steps.length === 3 &&
    steps[0] === "withdraw-presence" &&
    steps[1] === "rp-initiated-logout" &&
    steps[2] === "clear-local-state"
  );
}

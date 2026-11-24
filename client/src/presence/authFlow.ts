/**
 * FR-01: passkey sign-in — the client half of the ceremony.
 *
 * The SRS acceptance is release-blocking: a platform passkey is created
 * during onboarding and no password is ever set. The passkey ceremony
 * itself runs where platform authenticators already live — in the SYSTEM
 * BROWSER (ASWebAuthenticationSession on iOS, a Custom Tab on Android) —
 * against the passkey-only `consumer` Keycloak realm (TECH-07): its
 * `consumer passkey browser` flow requires a passwordless WebAuthn
 * authenticator and enrols one as a required action, so passwords are not
 * merely discouraged, they are absent from the flow. This app therefore
 * needs no raw WebAuthn native dependency: it opens an OpenID Connect
 * Authorization Code + PKCE (S256) request and receives the redirect.
 *
 * What this module owns (pure logic, Hermes-safe, framework-free):
 *
 *   - the PKCE verifier and S256 challenge (RFC 7636) — the digest comes
 *     from the in-repo pure-TypeScript SHA-256, because Hermes ships no
 *     crypto primitives and a native crypto package would add a SEC-18
 *     allowlist entry for one digest;
 *   - the authorize / token / refresh / logout URLs and form bodies, built
 *     with manual query encoding (no URL/URLSearchParams — Hermes's
 *     implementation is historically incomplete);
 *   - the redirect-callback parse, which FAILS CLOSED: a state mismatch
 *     is a rejection, never a best-effort sign-in;
 *   - the bootstrap-config resolution, which also fails closed: an empty
 *     issuer or client id is "cannot sign in", not "guess an endpoint".
 *
 * Randomness is INJECTED ({@link RandomSource}): production wires the
 * platform CSPRNG (expo-crypto / react-native-get-random-values adapter
 * under src/platform/), tests wire a deterministic source. The network
 * and the browser are effects owned by the composition layer.
 */

import { sha256, toHex, utf8 } from "./sha256.js";

/** The realm-exported client id is not a secret; it names this app. */
export interface ClientAuthConfig {
  /** Public issuer URL of the consumer realm (device-reachable). */
  issuer: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
}

/**
 * Redirect URIs registered on the realm's `presence-app` client
 * (deploy/keycloak/realm-consumer.json) — changing them here without
 * changing the realm breaks sign-in, so they are pinned constants.
 */
export const APP_REDIRECT_URI = "presence://auth/callback";
export const APP_POST_LOGOUT_REDIRECT_URI = "presence://auth/logout";

/** RFC 7636: the only challenge method the realm client advertises. */
export const PKCE_CHALLENGE_METHOD = "S256" as const;

/** Randomness source: fill `bytes` with fresh entropy. */
export type RandomSource = (bytes: number) => Uint8Array;

// ------------------------------------------------------------------ base64 --

/** unpadded base64url (RFC 4648 §5) — small inputs only. */
function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += alphabet[b2 & 0x3f];
  }
  return out;
}

/** Manual query encoding — Hermes's URL/URLSearchParams is not assumed. */
function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// -------------------------------------------------------------------- PKCE --

/** RFC 7636 verifier: 32 random bytes, unpadded base64url → 43 chars. */
export function generateVerifier(random: RandomSource): string {
  return base64UrlEncode(random(32));
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))). */
export function deriveChallenge(verifier: string): string {
  return base64UrlEncode(sha256(utf8(verifier)));
}

/** CSRF token for the redirect round-trip: 16 random bytes, hex. */
export function generateState(random: RandomSource): string {
  return toHex(random(16));
}

// ------------------------------------------------------------- endpoints ---

function endpoints(cfg: ClientAuthConfig) {
  const base = `${cfg.issuer}/protocol/openid-connect`;
  return { authorize: `${base}/auth`, token: `${base}/token`, logout: `${base}/logout` };
}

/** One in-flight attempt: the URL to open plus the secrets to hold. */
export interface AuthorizationAttempt {
  /** Open this in the system browser (ASWebAuthenticationSession/Custom Tab). */
  url: string;
  /** Hold in memory until the callback; never persisted. */
  verifier: string;
  /** Hold in memory until the callback; the callback must echo it. */
  state: string;
}

/**
 * Build the authorize request. The scope is `openid` only — the realm's
 * passkey-only browser flow owns authentication; this app never sees a
 * credential, which is precisely how "no password is ever set" holds.
 */
export function beginAuthorization(cfg: ClientAuthConfig, random: RandomSource): AuthorizationAttempt {
  const verifier = generateVerifier(random);
  const state = generateState(random);
  const url =
    `${endpoints(cfg).authorize}?` +
    query([
      ["response_type", "code"],
      ["client_id", cfg.clientId],
      ["redirect_uri", cfg.redirectUri],
      ["scope", "openid"],
      ["state", state],
      ["code_challenge", deriveChallenge(verifier)],
      ["code_challenge_method", PKCE_CHALLENGE_METHOD],
    ]);
  return { url, verifier, state };
}

// --------------------------------------------------------------- callback --

export type CallbackResult =
  | { ok: true; code: string }
  | { ok: false; reason: "state-mismatch" | "provider-error" | "missing-code"; detail?: string };

/**
 * Parse the redirect callback. FAIL CLOSED on every anomaly: a state
 * mismatch is a rejection (a confused-deputy sign-in is worse than none),
 * a provider error is surfaced, and a missing code is not retried here.
 */
export function parseCallback(callbackUrl: string, expectedState: string): CallbackResult {
  const qIndex = callbackUrl.indexOf("?");
  const fIndex = callbackUrl.indexOf("#");
  const raw =
    qIndex >= 0 ? callbackUrl.slice(qIndex + 1) : fIndex >= 0 ? callbackUrl.slice(fIndex + 1) : "";
  const params = new Map<string, string>();
  for (const pair of raw.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    const value = eq >= 0 ? pair.slice(eq + 1) : "";
    params.set(decodeURIComponent(key), decodeURIComponent(value.replace(/\+/g, " ")));
  }
  const error = params.get("error");
  if (error !== undefined) return { ok: false, reason: "provider-error", detail: error };
  if (params.get("state") !== expectedState) return { ok: false, reason: "state-mismatch" };
  const code = params.get("code");
  if (code === undefined || code.length === 0) return { ok: false, reason: "missing-code" };
  return { ok: true, code };
}

// --------------------------------------------------------- token endpoint --

export interface FormPost {
  url: string;
  headers: { "content-type": "application/x-www-form-urlencoded" };
  body: string;
}

/** Exchange the authorization code for tokens (PKCE verifier attached). */
export function buildTokenExchange(
  cfg: ClientAuthConfig,
  code: string,
  verifier: string,
): FormPost {
  return {
    url: endpoints(cfg).token,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: query([
      ["grant_type", "authorization_code"],
      ["client_id", cfg.clientId],
      ["redirect_uri", cfg.redirectUri],
      ["code", code],
      ["code_verifier", verifier],
    ]),
  };
}

/** Exchange the refresh token (SEC-02: access tokens live 5 minutes). */
export function buildRefreshExchange(cfg: ClientAuthConfig, refreshToken: string): FormPost {
  return {
    url: endpoints(cfg).token,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: query([
      ["grant_type", "refresh_token"],
      ["client_id", cfg.clientId],
      ["refresh_token", refreshToken],
    ]),
  };
}

/**
 * RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0): end the
 * IdP session too, or the next authorize silently re-logs-in.
 */
export function buildLogoutUrl(cfg: ClientAuthConfig, idToken: string | undefined): string {
  const params: Array<readonly [string, string]> = [];
  if (idToken !== undefined && idToken.length > 0) params.push(["id_token_hint", idToken]);
  params.push(["post_logout_redirect_uri", cfg.postLogoutRedirectUri]);
  params.push(["client_id", cfg.clientId]);
  return `${endpoints(cfg).logout}?${query(params)}`;
}

// --------------------------------------------------------------- bootstrap --

/** The route the bootstrap block travels on (TR-33 channel, b36 `api` sibling). */
export const AUTH_BOOTSTRAP_PATH = "/v1/client/config";

/**
 * Resolve the auth block of GET /v1/client/config into a client config.
 * FAIL CLOSED: an empty issuer or client id means the environment is not
 * configured for sign-in — the honest UI is "sign-in unavailable", never
 * a request to a guessed endpoint.
 */
export function resolveAuthConfig(bootstrap: {
  auth?: { issuer?: unknown; clientId?: unknown } | undefined;
}): ClientAuthConfig | null {
  const issuerRaw = bootstrap.auth?.issuer;
  const clientIdRaw = bootstrap.auth?.clientId;
  const issuer = typeof issuerRaw === "string" ? issuerRaw.replace(/\/+$/, "") : "";
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw.trim() : "";
  if (issuer.length === 0 || clientId.length === 0) return null;
  return {
    issuer,
    clientId,
    redirectUri: APP_REDIRECT_URI,
    postLogoutRedirectUri: APP_POST_LOGOUT_REDIRECT_URI,
  };
}

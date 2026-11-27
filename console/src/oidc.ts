/**
 * AMD-CON-02 (workforce sign-in): the console is a public OIDC client of
 * the Keycloak workforce realm — authorization code with PKCE (S256), no
 * client secret, and tokens held in MEMORY ONLY (never localStorage: an
 * XSS payload must not be able to walk off with a workforce session; a
 * full reload deliberately signs the operator out). Only the PKCE
 * transaction (state + verifier, not credentials) crosses the redirect in
 * sessionStorage, because the flow cannot survive the redirect otherwise.
 *
 * Claims decoded from the access token drive VISIBILITY ONLY — every
 * workforce route re-checks realm and role server-side
 * (requireModerator / requireVenueOps), so a forged or stale claim can at
 * worst render a surface the edge then refuses.
 */

export interface OidcConfig {
  /** Realm issuer, e.g. https://auth.presence.example/realms/workforce. */
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

export interface OidcEffects {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  nowMs(): number;
}

export const PKCE_VERIFIER_BYTES = 32;
export const STATE_BYTES = 16;
export const NONCE_BYTES = 16;
/** Refresh the access token this far ahead of expiry. */
export const SESSION_REFRESH_MARGIN_MS = 30_000;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): string {
  return atob(text.replaceAll("-", "+").replaceAll("_", "/"));
}

/** The state that must survive the redirect to Keycloak and back. */
export interface PkceTransaction {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}

export function endpoint(config: OidcConfig, path: string): string {
  return `${config.issuer.replace(/\/+$/, "")}/protocol/openid-connect/${path}`;
}

/**
 * Mint a fresh PKCE transaction and the authorization URL that carries it.
 * Every sign-in starts a NEW transaction — state is single-use.
 */
export async function beginAuthorization(
  config: OidcConfig,
  effects: OidcEffects,
): Promise<{ url: string; transaction: PkceTransaction }> {
  const verifier = base64url(effects.randomBytes(PKCE_VERIFIER_BYTES));
  const challenge = base64url(await effects.sha256(new TextEncoder().encode(verifier)));
  const transaction: PkceTransaction = {
    verifier,
    challenge,
    state: base64url(effects.randomBytes(STATE_BYTES)),
    nonce: base64url(effects.randomBytes(NONCE_BYTES)),
  };
  const url = new URL(endpoint(config, "auth"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", transaction.state);
  url.searchParams.set("nonce", transaction.nonce);
  url.searchParams.set("code_challenge", transaction.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), transaction };
}

export type CallbackResult =
  | { kind: "code"; code: string }
  | { kind: "error"; error: string };

/**
 * Validate the authorization response. State mismatch fails CLOSED — a
 * callback that does not echo the transaction state is never exchanged.
 */
export function parseCallback(callbackUrl: string, expectedState: string): CallbackResult {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { kind: "error", error: "unparseable callback URL" };
  }
  const providerError = url.searchParams.get("error");
  if (providerError) return { kind: "error", error: providerError };
  const state = url.searchParams.get("state");
  if (!state || state !== expectedState) return { kind: "error", error: "state-mismatch" };
  const code = url.searchParams.get("code");
  if (!code) return { kind: "error", error: "missing authorization code" };
  return { kind: "code", code };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute access-token expiry on the local clock. */
  expiresAtMs: number;
}

interface TokenResponseLike {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export type TokenFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function tokenRequest(
  config: OidcConfig,
  effects: OidcEffects,
  fetchImpl: TokenFetch,
  fields: Record<string, string>,
): Promise<TokenSet> {
  const body = new URLSearchParams({ client_id: config.clientId, ...fields });
  const res = await fetchImpl(endpoint(config, "token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
  const json = (await res.json()) as TokenResponseLike;
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number" ||
    !(json.expires_in > 0)
  ) {
    // A well-formed-looking but incomplete token response is garbage:
    // refuse it rather than half-authenticating the operator.
    throw new Error("malformed token response");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAtMs: effects.nowMs() + json.expires_in * 1000,
  };
}

export function exchangeCode(
  config: OidcConfig,
  code: string,
  verifier: string,
  effects: OidcEffects,
  fetchImpl: TokenFetch,
): Promise<TokenSet> {
  return tokenRequest(config, effects, fetchImpl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
}

export function refreshTokens(
  config: OidcConfig,
  refreshToken: string,
  effects: OidcEffects,
  fetchImpl: TokenFetch,
): Promise<TokenSet> {
  return tokenRequest(config, effects, fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export type SessionState = "active" | "refresh-due" | "expired";

export function sessionState(tokens: TokenSet, nowMs: number): SessionState {
  if (nowMs >= tokens.expiresAtMs) return "expired";
  return tokens.expiresAtMs - nowMs <= SESSION_REFRESH_MARGIN_MS ? "refresh-due" : "active";
}

export function endSessionUrl(config: OidcConfig, postLogoutRedirectUri: string): string {
  const url = new URL(endpoint(config, "logout"));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  return url.toString();
}

/**
 * Decode (NOT verify — the edge verifies) the realm roles out of an access
 * token for surface visibility. Garbage in → no roles, never a throw.
 */
export function rolesOf(accessToken: string): string[] {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return [];
  try {
    const payload = JSON.parse(base64urlDecode(parts[1])) as {
      realm_access?: { roles?: unknown };
    };
    const roles = payload.realm_access?.roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

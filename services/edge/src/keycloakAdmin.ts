/**
 * SEC-03: the automated Keycloak binding for JIT elevation.
 *
 * Migration 0022 is the source of truth for grants; this client replays the
 * grant window into the workforce realm by adding/removing the `moderator`
 * realm role via the Keycloak Admin API. The grant window is authoritative
 * in Postgres — if a binding call fails the audit trail still records the
 * decision, and the next expiry/revoke retries the unbind (the Admin API
 * mapping calls are idempotent: adding an existing mapping and removing an
 * absent one both succeed).
 *
 * Env-gated like the push providers (FR-56): without credentials the
 * binding is a documented no-op and operators bind manually in the admin
 * console (compose/dev). Configured in the cluster through the optional
 * ExternalSecret refs on the edge Deployment.
 *
 *   KEYCLOAK_ADMIN_BASE_URL       e.g. http://keycloak:8080
 *   KEYCLOAK_ADMIN_CLIENT_ID      service-account client (realm-management
 *                                 manage-users + view-users)
 *   KEYCLOAK_ADMIN_CLIENT_SECRET  its secret
 *   KEYCLOAK_ADMIN_REALM          target realm (default "workforce")
 *   KEYCLOAK_ADMIN_TOKEN_REALM    realm the client authenticates in
 *                                 (default "master")
 */

export interface KeycloakAdminConfig {
  baseUrl: string;
  realm: string;
  tokenRealm: string;
  clientId: string;
  clientSecret: string;
  /**
   * AMD-ONB-05: the realm venue partner accounts live in — the venue_ids
   * attribute replay targets this realm (default "consumer").
   */
  venueRealm: string;
}

/** Null unless every required variable is present — the documented no-op. */
export function keycloakAdminFromEnv(env: NodeJS.ProcessEnv = process.env): KeycloakAdminConfig | null {
  const {
    KEYCLOAK_ADMIN_BASE_URL,
    KEYCLOAK_ADMIN_CLIENT_ID,
    KEYCLOAK_ADMIN_CLIENT_SECRET,
    KEYCLOAK_ADMIN_REALM,
    KEYCLOAK_ADMIN_TOKEN_REALM,
    KEYCLOAK_ADMIN_VENUE_REALM,
  } = env;
  if (!KEYCLOAK_ADMIN_BASE_URL || !KEYCLOAK_ADMIN_CLIENT_ID || !KEYCLOAK_ADMIN_CLIENT_SECRET) {
    return null;
  }
  return {
    baseUrl: KEYCLOAK_ADMIN_BASE_URL.replace(/\/+$/, ""),
    realm: KEYCLOAK_ADMIN_REALM ?? "workforce",
    tokenRealm: KEYCLOAK_ADMIN_TOKEN_REALM ?? "master",
    clientId: KEYCLOAK_ADMIN_CLIENT_ID,
    clientSecret: KEYCLOAK_ADMIN_CLIENT_SECRET,
    venueRealm: KEYCLOAK_ADMIN_VENUE_REALM ?? "consumer",
  };
}

interface RoleRep {
  id: string;
  name: string;
}

/**
 * Minimal Admin API client for the role binding. Tokens are cached until
 * 30 s before expiry; every method is idempotent so retries are safe.
 */
export class KeycloakAdminClient {
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: KeycloakAdminConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Add the moderator realm role to the subject (grant window opens). */
  async grantModeratorRole(subject: string): Promise<void> {
    const role = await this.roleRep();
    const res = await this.fetchImpl(
      `${this.cfg.baseUrl}/admin/realms/${this.cfg.realm}/users/${subject}/role-mappings/realm`,
      {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify([role]),
      },
    );
    if (!res.ok) throw new Error(`role grant failed: HTTP ${res.status}`);
  }

  /** Remove the moderator realm role (grant window closes/lapses). */
  async revokeModeratorRole(subject: string): Promise<void> {
    const role = await this.roleRep();
    const res = await this.fetchImpl(
      `${this.cfg.baseUrl}/admin/realms/${this.cfg.realm}/users/${subject}/role-mappings/realm`,
      {
        method: "DELETE",
        headers: await this.headers(),
        body: JSON.stringify([role]),
      },
    );
    if (!res.ok) throw new Error(`role revoke failed: HTTP ${res.status}`);
  }

  private async roleRep(): Promise<RoleRep> {
    const res = await this.fetchImpl(
      `${this.cfg.baseUrl}/admin/realms/${this.cfg.realm}/roles/moderator`,
      { headers: await this.headers() },
    );
    if (!res.ok) throw new Error(`role lookup failed: HTTP ${res.status}`);
    return (await res.json()) as RoleRep;
  }

  /**
   * AMD-ONB-05: add a venue id to the operator's venue_ids attribute in the
   * venue realm (get-merge-put; adding an id already present is a no-op).
   */
  async addVenueId(subject: string, venueId: string): Promise<void> {
    await this.mergeVenueIds(subject, (ids) =>
      ids.includes(venueId) ? ids : [...ids, venueId],
    );
  }

  /** AMD-ONB-05: remove a venue id (offboard replay); absent id is a no-op. */
  async removeVenueId(subject: string, venueId: string): Promise<void> {
    await this.mergeVenueIds(subject, (ids) => ids.filter((id) => id !== venueId));
  }

  private async mergeVenueIds(
    subject: string,
    merge: (ids: string[]) => string[],
  ): Promise<void> {
    const userUrl = `${this.cfg.baseUrl}/admin/realms/${this.cfg.venueRealm}/users/${subject}`;
    const current = await this.fetchImpl(userUrl, { headers: await this.headers() });
    if (!current.ok) throw new Error(`user lookup failed: HTTP ${current.status}`);
    const rep = (await current.json()) as { attributes?: Record<string, unknown> };
    const attributes = (rep.attributes ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(attributes.venue_ids)
      ? (attributes.venue_ids as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const next = merge(existing);
    const res = await this.fetchImpl(userUrl, {
      method: "PUT",
      headers: await this.headers(),
      body: JSON.stringify({ attributes: { ...attributes, venue_ids: next } }),
    });
    if (!res.ok) throw new Error(`attribute update failed: HTTP ${res.status}`);
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.token()}`,
      "content-type": "application/json",
    };
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.value;
    }
    const res = await this.fetchImpl(
      `${this.cfg.baseUrl}/realms/${this.cfg.tokenRealm}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
        }).toString(),
      },
    );
    if (!res.ok) throw new Error(`admin token failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    // Refresh 30 s early so a long tick never rides an expiring token.
    this.cachedToken = {
      value: body.access_token,
      expiresAt: now + Math.max(0, body.expires_in - 30) * 1000,
    };
    return body.access_token;
  }
}

/**
 * Fire-and-forget binding for the request paths and the lifecycle tick.
 * Never throws: the Postgres grant record is authoritative, a binding
 * failure is logged and repaired by the next transition. Returns without
 * doing anything when the admin client is not configured.
 */
export async function bindModeratorRole(
  cfg: KeycloakAdminConfig | null,
  action: "grant" | "revoke",
  subject: string,
  client?: KeycloakAdminClient,
): Promise<void> {
  if (!cfg) return;
  const admin = client ?? new KeycloakAdminClient(cfg);
  try {
    if (action === "grant") {
      await admin.grantModeratorRole(subject);
    } else {
      await admin.revokeModeratorRole(subject);
    }
  } catch (err) {
    console.error("keycloak role binding failed", { action, error: String(err) });
  }
}

/**
 * AMD-ONB-05: fire-and-forget venue_ids attribute replay. Never throws —
 * the venue_accounts row is authoritative, a binding failure is logged and
 * repaired on the next transition. No-op when the admin client is not
 * configured.
 */
export async function bindVenueId(
  cfg: KeycloakAdminConfig | null,
  action: "add" | "remove",
  subject: string,
  venueId: string,
  client?: KeycloakAdminClient,
): Promise<void> {
  if (!cfg) return;
  const admin = client ?? new KeycloakAdminClient(cfg);
  try {
    if (action === "add") {
      await admin.addVenueId(subject, venueId);
    } else {
      await admin.removeVenueId(subject, venueId);
    }
  } catch (err) {
    console.error("keycloak venue binding failed", { action, error: String(err) });
  }
}

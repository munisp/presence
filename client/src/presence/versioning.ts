/**
 * TR-27: unsupported-version detection — the client must NOTICE that the
 * server considers it too old and prompt for an update, never fail
 * silently.
 *
 * Two detection channels, both evaluated against this build's protocol
 * version:
 *
 *   1. Bootstrap — GET /v1/client/config carries `api.version` and
 *      `api.minClientVersion`; the client evaluates them at startup,
 *      before login (the route is unauthenticated on purpose, see
 *      clientConfig.ts on the edge). If the server's floor is above this
 *      build, the only honest UI is the update prompt.
 *   2. In-band — every edge response carries `x-api-version`, and a
 *      server that has fully retired this build answers 426
 *      upgrade_required through the TR-25 error contract. Either signal
 *      flips the client to the same update prompt mid-session.
 *
 * TR-35 folds in here: a scan payload stamped with a diagram spec this
 * build does not know is an unsupported-version signal too — rendering
 * guessed node/edge semantics would be failing silently.
 *
 * Fail-open rule (shared with TR-33): a MALFORMED version signal never
 * prompts an update — a server bug must not brick installs. Only a
 * well-formed signal that names this build as too old does.
 *
 * This module is pure and import-free: Hermes ships no Intl/URL extras we
 * could lean on, and the version verdict must be testable in plain node.
 */

/** This build's protocol version. Bump when the wire contract changes. */
export const CLIENT_PROTOCOL_VERSION = 1;

/** TR-35: diagram spec versions this build can render. */
export const SUPPORTED_DIAGRAM_SPEC_VERSIONS: readonly number[] = [1];

/** The `api` object of GET /v1/client/config. */
export interface ApiVersionInfo {
  version: number;
  minClientVersion: number;
}

export type UpdateReason =
  /** The server's floor (minClientVersion) is above this build. */
  | "below-minimum"
  /** The server speaks a newer API major than this build understands. */
  | "api-too-new"
  /** The server answered 426 upgrade_required for this build. */
  | "server-refused"
  /** TR-35: a scan result carries a diagram spec we cannot render. */
  | "diagram-spec";

export type VersionVerdict =
  | { status: "supported" }
  | { status: "update-required"; reason: UpdateReason; detail: string };

/** TR-27: the prompt copy — an explicit update path, never a silent gap. */
export const UPDATE_PROMPT = {
  title: "Update Presence",
  body: "This version of Presence is no longer supported. Update to keep discovering people nearby.",
  action: "Update",
} as const;

function isWellFormedVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/**
 * Channel 1 — evaluate the `api` object of the bootstrap config at
 * startup. Malformed fields fail open (supported): they carry no evidence
 * that THIS build is too old.
 */
export function evaluateBootstrapVersion(api: ApiVersionInfo): VersionVerdict {
  if (isWellFormedVersion(api.minClientVersion) && CLIENT_PROTOCOL_VERSION < api.minClientVersion) {
    return {
      status: "update-required",
      reason: "below-minimum",
      detail: `server requires client >= ${api.minClientVersion}, this build is ${CLIENT_PROTOCOL_VERSION}`,
    };
  }
  if (isWellFormedVersion(api.version) && api.version > CLIENT_PROTOCOL_VERSION) {
    return {
      status: "update-required",
      reason: "api-too-new",
      detail: `server speaks API ${api.version}, this build understands ${CLIENT_PROTOCOL_VERSION}`,
    };
  }
  return { status: "supported" };
}

/**
 * Channel 2 — evaluate one response's status and x-api-version header.
 * 426 is the server's explicit refusal; a newer header major means the
 * contract has moved under us. A missing or malformed header says
 * nothing, so it cannot condemn the build.
 */
export function evaluateResponseVersion(
  status: number,
  apiVersionHeader: string | null,
): VersionVerdict {
  if (status === 426) {
    return {
      status: "update-required",
      reason: "server-refused",
      detail: "server answered 426 upgrade_required",
    };
  }
  if (apiVersionHeader !== null) {
    const parsed = Number.parseInt(apiVersionHeader, 10);
    if (Number.isInteger(parsed) && parsed > CLIENT_PROTOCOL_VERSION) {
      return {
        status: "update-required",
        reason: "api-too-new",
        detail: `response carries x-api-version ${parsed}, this build understands ${CLIENT_PROTOCOL_VERSION}`,
      };
    }
  }
  return { status: "supported" };
}

/**
 * TR-35 folded into TR-27: a diagram spec this build does not know is an
 * unsupported-version signal. Rendering guessed node/edge semantics would
 * be failing silently, so the verdict is the same update prompt.
 */
export function evaluateDiagramSpec(specVersion: unknown): VersionVerdict {
  if (
    typeof specVersion === "number" &&
    SUPPORTED_DIAGRAM_SPEC_VERSIONS.includes(specVersion)
  ) {
    return { status: "supported" };
  }
  return {
    status: "update-required",
    reason: "diagram-spec",
    detail: `diagram spec ${String(specVersion)} is not in [${SUPPORTED_DIAGRAM_SPEC_VERSIONS.join(", ")}]`,
  };
}

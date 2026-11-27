/**
 * Log scrubber (SEC-29).
 *
 * Application logs must never carry raw coordinates, H3 cells paired with
 * user identifiers, message/announcement content, or bearer material. Every
 * log line passes through here via pino's hooks.logMethod (wired in app.ts);
 * the scrubber walks the arguments and rewrites anything sensitive. This is
 * defence in depth — routes are already careful about what they log; this is
 * the guarantee that a careless future log call cannot leak.
 *
 * Redactions:
 *   - coordinate-shaped fields (lat/lon/latitude/longitude/coordinates/geo)
 *   - 15-hex-character strings (H3 cell ids) when the same object also
 *     carries a user-ish key — the cell+user pairing is what SEC-29 forbids
 *   - bearer/apikey/JWT-shaped strings anywhere
 *   - authorization / cookie / x-api-key headers outright
 *   - content fields (body/text/content/envelope/ciphertext/reason)
 *   - phone numbers (AMD-WA-05): phone-shaped fields outright, and
 *     E.164-shaped substrings inside free strings
 */

/** Fields whose values are coordinates. */
const COORD_KEY_RE = /^(lat|lon|lng|latitude|longitude|coordinates?|geo(location)?)$/i;

/** Fields whose values are user-generated content. */
const CONTENT_KEY_RE = /^(body|text|content|envelope|ciphertext|reason|details)$/i;

/** Header fields that carry credentials. */
const CREDENTIAL_KEY_RE = /^(authorization|cookie|x-api-key|proxy-authorization)$/i;

/** AMD-WA-05: fields whose values are phone numbers (E.164 or not). */
const PHONE_KEY_RE = /^(phone|phone_?e164|msisdn|wa_?id|whatsapp_?id)$/i;

/** User-identifying fields — pairing one with a cell is what we redact. */
const USER_KEY_RE = /^(user_?id|actor|publisher|responder|reporter|reported|counterpart|sender|uid)$/i;

/** Cell fields. */
const CELL_KEY_RE = /^(cell|cell_?id|h3)$/i;

/** 15-hex H3 cell id (replace form; H3_TEST_RE for boolean checks). */
const H3_RE = /\b[0-9a-f]{15}\b/g;
const H3_TEST_RE = /\b[0-9a-f]{15}\b/;

/** Bearer / apikey / JWT material inside arbitrary strings. */
const BEARER_RE = /Bearer\s+\S+/gi;
const APIKEY_RE = /apikey\s+\S+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g;

/** AMD-WA-05: E.164-shaped substrings inside free strings. */
const PHONE_RE = /\+[1-9]\d{7,14}\b/g;

const REDACTED = "[redacted]";
const CONTENT = "[content]";
const CELL = "[cell]";
const PHONE = "[phone]";

/** Scrub credential-shaped substrings out of a free string. */
export function scrubText(s: string): string {
  return s
    .replace(JWT_RE, REDACTED)
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(APIKEY_RE, "apikey [redacted]")
    .replace(PHONE_RE, PHONE);
}

function scrubString(value: string, key?: string): string {
  if (key && COORD_KEY_RE.test(key)) return REDACTED;
  if (key && CONTENT_KEY_RE.test(key)) return CONTENT;
  if (key && PHONE_KEY_RE.test(key)) return PHONE;
  // Cells are redacted by the pairing rule in scrubObject, not here — a
  // cell on its own identifies nobody and is useful in ops logs.
  return scrubText(value);
}

function hasUserKey(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((k) => USER_KEY_RE.test(k));
}

/**
 * Deep-scrub one log argument. Objects are copied (logs are shared objects —
 * mutating them would corrupt the request lifecycle); arrays recurse; the
 * second pass applies the cell+user pairing rule within each object.
 */
export function scrubObject(value: unknown, key?: string): unknown {
  if (typeof value === "string") return scrubString(value, key);
  if (typeof value === "number") {
    if (key && COORD_KEY_RE.test(key)) return REDACTED;
    if (key && PHONE_KEY_RE.test(key)) return PHONE;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrubObject(v));
  if (value instanceof Error) {
    // keep type and message (scrubbed); the stack is server-side only
    const err = new (value.constructor as new (msg: string) => Error)(scrubText(value.message));
    err.stack = value.stack;
    return err;
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (CREDENTIAL_KEY_RE.test(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = scrubObject(v, k);
    }
    // SEC-29: a cell next to a user identifier is identifying even though
    // neither is on its own — redact every cell-ish value in the object.
    if (hasUserKey(out)) {
      for (const k of Object.keys(out)) {
        if (CELL_KEY_RE.test(k)) out[k] = CELL;
        else if (typeof out[k] === "string" && H3_TEST_RE.test(out[k] as string)) {
          out[k] = (out[k] as string).replace(H3_RE, CELL);
        }
      }
    }
    return out;
  }
  return value;
}

/** pino hooks.logMethod adapter: scrub every argument, then log. */
export function scrubLogArgs<T extends unknown[]>(args: T): T {
  return args.map((a) => scrubObject(a)) as T;
}

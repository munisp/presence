/**
 * First-message screening (FR-38, SEC-21).
 *
 * The first message each sender posts to a pair is screened before storage:
 * links, phone numbers, e-mail addresses, platform-bypass phrases and common
 * scam patterns are rejected with an inline explanation naming the *category*
 * — never the matched text, so the explanation cannot be mined for evasion.
 *
 * Detection is deterministic pattern matching, consistent with TR-09 (no LLM
 * anywhere near a user-facing decision). Room notes (FR-46) reuse screenText
 * when the rooms surface (FR-44) lands.
 *
 * Boundary: production envelopes are opaque MLS ciphertext (FR-36/SEC-10),
 * which nothing server-side can screen. While MLS client integration is
 * pending, P0 envelopes are UTF-8 text and are screened here; with MLS the
 * same classifier ships in the client's compose path (TECH-08), and the
 * server-side check stays as the defence for unencrypted payloads.
 */

export type ScreeningCategory = "link" | "phone" | "email" | "bypass" | "scam";

export interface ScreeningFinding {
  category: ScreeningCategory;
}

/** FR-38: the inline explanation names what was found, not the pattern. */
export const SCREENING_EXPLANATION: Record<ScreeningCategory, string> = {
  link: "links",
  phone: "phone numbers",
  email: "e-mail addresses",
  bypass: "invitations to move to another app",
  scam: "requests the community rules prohibit",
};

// http(s)://…, www.…, or a bare domain with a known-ish TLD.
const LINK_RE =
  /(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9][-a-z0-9]*(?:\.[a-z0-9][-a-z0-9]*)*\.(?:com|net|org|io|co|app|me|ng|uk|de|fr|xyz|site|online|link|click)\b/i;

// local@domain.tld
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;

// 7+ digits allowing international punctuation: +234 801 234 5678, (0)801-234-5678.
const PHONE_RE = /(?<![\w])(?:\+?\d[\d\s().-]{6,}\d)(?![\w])/;

// Platform-bypass phrases: moving the conversation off-platform is the classic
// romance-scam first move; first messages may not attempt it.
const BYPASS_PHRASES = [
  "whatsapp",
  "whats app",
  "telegram",
  "signal app",
  "add me on",
  "text me",
  "call me",
  "dm me",
  "message me on",
  "chat on",
  "my number is",
  "my e-mail is",
  "my email is",
];

// Scam / solicitation patterns (SEC-21 "abuse patterns"): financial extraction.
const SCAM_PHRASES = [
  "gift card",
  "giftcard",
  "western union",
  "moneygram",
  "send money",
  "wire transfer",
  "bank transfer",
  "bitcoin investment",
  "crypto investment",
  "double your money",
  "urgent help",
];

function phraseHits(text: string, phrases: string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((p) => lower.includes(p));
}

/** Screen decoded text; one finding per violated category, in stable order. */
export function screenText(text: string): ScreeningFinding[] {
  const found: ScreeningFinding[] = [];
  // An e-mail address contains a domain; strip addresses before link
  // detection so an address reports as "email" only, not "link" too.
  const sansEmail = text.replace(EMAIL_RE, " ");
  if (LINK_RE.test(sansEmail)) found.push({ category: "link" });
  if (EMAIL_RE.test(text)) found.push({ category: "email" });
  if (PHONE_RE.test(text)) found.push({ category: "phone" });
  if (phraseHits(text, BYPASS_PHRASES)) found.push({ category: "bypass" });
  if (phraseHits(text, SCAM_PHRASES)) found.push({ category: "scam" });
  return found;
}

/**
 * Screen an envelope. Returns null when the payload is not printable UTF-8 —
 * real MLS ciphertext, which only the client-side classifier can see.
 */
export function screenEnvelope(envelope: Buffer): ScreeningFinding[] | null {
  const text = envelope.toString("utf8");
  // Reject-on-replacement: undecodable bytes become U+FFFD under toString.
  if (text.includes("\uFFFD")) return null;
  return screenText(text);
}

/** User-facing rejection: categories inline, matched text never leaves. */
export function screeningErrorMessage(findings: ScreeningFinding[]): string {
  const what = findings.map((f) => SCREENING_EXPLANATION[f.category]).join(", ");
  return `first messages can't include ${what} — keep the conversation here until you both know each other`;
}

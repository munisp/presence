/** FR-65/SEC-34 link validation unit tests (pure functions). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_LINK_DOMAINS,
  isAllowedLinkHost,
  LINK_MAX_LEN,
  parseSharedLink,
} from "../src/links.js";

test("SEC-34: the allowlist is code-owned and non-empty", () => {
  assert.ok(ALLOWED_LINK_DOMAINS.length >= 5);
  assert.ok(ALLOWED_LINK_DOMAINS.every((d) => !d.includes("/") && !d.startsWith(".")));
});

test("isAllowedLinkHost matches exact hosts and subdomains only", () => {
  assert.equal(isAllowedLinkHost("instagram.com"), true);
  assert.equal(isAllowedLinkHost("www.instagram.com"), true);
  assert.equal(isAllowedLinkHost("INSTAGRAM.COM"), true);
  assert.equal(isAllowedLinkHost("notinstagram.com"), false);
  assert.equal(isAllowedLinkHost("instagram.com.evil.example"), false);
  assert.equal(isAllowedLinkHost("evil-instagram.com"), false);
  assert.equal(isAllowedLinkHost(""), false);
});

test("parseSharedLink accepts allowlisted https URLs", () => {
  const r = parseSharedLink("https://www.instagram.com/p/abc123/?hl=en");
  assert.ok(r.ok);
  assert.equal(r.link.domain, "instagram.com");
  assert.equal(r.link.url, "https://www.instagram.com/p/abc123/?hl=en");
});

test("parseSharedLink rejects http, credentials, and unknown domains", () => {
  for (const bad of [
    "http://instagram.com/p/abc",
    "https://user:pass@instagram.com/p/abc",
    "https://mastodon.example/@user",
    "ftp://instagram.com/x",
    "not a url",
    "",
    42,
    null,
  ]) {
    const r = parseSharedLink(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.ok(r.error.length > 0);
  }
});

test("parseSharedLink enforces the length bound", () => {
  const long = `https://instagram.com/${"a".repeat(LINK_MAX_LEN)}`;
  assert.equal(parseSharedLink(long).ok, false);
  const atLimit = `https://t.me/${"a".repeat(LINK_MAX_LEN - "https://t.me/".length)}`;
  assert.equal(parseSharedLink(atLimit).ok, true);
});

test("parseSharedLink normalizes host case and Unicode to punycode", () => {
  const r = parseSharedLink("HTTPS://WWW.X.COM/User");
  assert.ok(r.ok);
  assert.equal(r.link.domain, "x.com");
});

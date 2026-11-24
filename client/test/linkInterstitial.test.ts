/**
 * SEC-34: external links render as plain text behind a confirmation
 * interstitial, restricted to the governed allowlist, never prefetched.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_LINK_DOMAINS,
  classifyExternalLink,
  isAllowedLinkHost,
  LINK_INTERSTITIAL,
  resolveInterstitial,
} from "../src/presence/linkInterstitial.js";

test("every allowlisted domain renders plain-text behind the interstitial", () => {
  for (const d of ALLOWED_LINK_DOMAINS) {
    const v = classifyExternalLink(`https://${d}/some/path`);
    assert.equal(v.render, "plain-text");
    assert.equal(v.preview, "forbidden");
    assert.equal(v.open, "interstitial");
    assert.equal(v.allowed, true);
    assert.equal(v.domain, d);
  }
});

test("subdomains of allowlisted domains are allowed; lookalikes are not", () => {
  assert.equal(isAllowedLinkHost("www.instagram.com"), true);
  assert.equal(isAllowedLinkHost("instagram.com.evil.example"), false);
  assert.equal(isAllowedLinkHost("notinstagram.com"), false);
});

test("non-allowlisted hosts get no open affordance — plain inert text", () => {
  const v = classifyExternalLink("https://evil.example/phish");
  assert.equal(v.allowed, false);
  assert.equal(v.open, "never");
  assert.equal(v.render, "plain-text");
  assert.equal(v.preview, "forbidden");
});

test("http, credential-bearing, malformed and non-string links degrade to inert text", () => {
  for (const raw of [
    "http://instagram.com/insecure",
    "https://user:pass@instagram.com/x",
    "not a url",
    "",
    42,
    null,
    undefined,
  ]) {
    const v = classifyExternalLink(raw);
    assert.equal(v.render, "plain-text");
    assert.equal(v.preview, "forbidden");
    assert.equal(v.open, "never");
    assert.equal(v.allowed, false);
  }
});

test("the interstitial is the only path to opening — confirm opens, cancel dismisses", () => {
  assert.equal(resolveInterstitial("confirm"), "open");
  assert.equal(resolveInterstitial("cancel"), "dismiss");
});

test("interstitial copy warns and offers a way back (SEC-34)", () => {
  assert.ok(LINK_INTERSTITIAL.title.length > 0);
  assert.ok(LINK_INTERSTITIAL.body.includes("external site"));
  assert.ok(LINK_INTERSTITIAL.confirmLabel.length > 0);
  assert.ok(LINK_INTERSTITIAL.cancelLabel.length > 0);
});

test("the allowlist mirror stays small and code-owned", () => {
  assert.equal(ALLOWED_LINK_DOMAINS.length, 11);
  assert.deepEqual([...ALLOWED_LINK_DOMAINS].sort(), [...ALLOWED_LINK_DOMAINS]);
});

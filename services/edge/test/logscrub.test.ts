/** SEC-29 log scrubber unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubObject, scrubText } from "../src/logscrub.js";

test("coordinate-shaped fields are redacted", () => {
  const out = scrubObject({ lat: 6.5244, lon: 3.3792, score: 0.9 }) as Record<string, unknown>;
  assert.equal(out.lat, "[redacted]");
  assert.equal(out.lon, "[redacted]");
  assert.equal(out.score, 0.9); // unrelated numbers pass through
});

test("nested coordinates are redacted", () => {
  const out = scrubObject({ fix: { latitude: 6.5, longitude: 3.4 } }) as Record<string, unknown>;
  const fix = out.fix as Record<string, unknown>;
  assert.equal(fix.latitude, "[redacted]");
  assert.equal(fix.longitude, "[redacted]");
});

test("bearer, apikey and JWT material is redacted inside strings", () => {
  assert.equal(scrubText("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [redacted]");
  assert.equal(scrubText("apikey supersecretkey"), "apikey [redacted]");
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.signaturepart";
  assert.equal(scrubText(`token ${jwt} ok`), "token [redacted] ok");
});

test("credential headers are redacted outright", () => {
  const out = scrubObject({
    headers: { authorization: "Bearer x.y.z", cookie: "s=1", "content-type": "application/json" },
  }) as Record<string, unknown>;
  const headers = out.headers as Record<string, unknown>;
  assert.equal(headers.authorization, "[redacted]");
  assert.equal(headers.cookie, "[redacted]");
  assert.equal(headers["content-type"], "application/json");
});

test("user content fields are redacted", () => {
  const out = scrubObject({ body: "hello there", envelope: "ciphertext", state: "ok" }) as Record<
    string,
    unknown
  >;
  assert.equal(out.body, "[content]");
  assert.equal(out.envelope, "[content]");
  assert.equal(out.state, "ok");
});

test("a cell next to a user id is redacted (the pairing is what leaks)", () => {
  const out = scrubObject({
    userId: "4b0f7f1e-0000-4000-8000-0000000000aa",
    cell: "8a1f2d35b6c4fff",
    venue: "v1",
  }) as Record<string, unknown>;
  assert.equal(out.cell, "[cell]");
  assert.equal(out.userId, "4b0f7f1e-0000-4000-8000-0000000000aa");
  assert.equal(out.venue, "v1");
});

test("a cell with no user id in the object passes through", () => {
  const out = scrubObject({ cell: "8a1f2d35b6c4fff", count: 3 }) as Record<string, unknown>;
  assert.equal(out.cell, "8a1f2d35b6c4fff");
});

test("arrays recurse", () => {
  const out = scrubObject([{ lat: 1 }, "plain"]) as unknown[];
  assert.deepEqual(out, [{ lat: "[redacted]" }, "plain"]);
});

test("scores, bands and states pass through untouched", () => {
  const line = { msg: "scan served", score: 0.42, band: "nearby", state: "ok", pairId: "p1" };
  assert.deepEqual(scrubObject(line), line);
});

test("input objects are not mutated", () => {
  const original = { lat: 6.5244, nested: { body: "hi" } };
  scrubObject(original);
  assert.equal(original.lat, 6.5244);
  assert.equal(original.nested.body, "hi");
});

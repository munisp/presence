/**
 * Batch 25 — venue registry ops & trace propagation: the pure contracts.
 *
 * The SQL-side invariants (partner-status vocabulary, schedule shape check,
 * sync trigger, SECURITY DEFINER functions, identity columns) are pinned by
 * tests/test_venue_registry.py against the migration source; these tests
 * pin the edge-side behavior: BR-14 presence purging and NFR-31 trace-id
 * resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EdgeContext } from "../src/context.js";
import { resolveRequestId } from "../src/requestid.js";
import { purgeVenuePresence } from "../src/routes/venue.js";

test("NFR-31: a well-formed incoming id is honored verbatim", () => {
  const incoming = "4f3c2a1b-9d8e-4c7a-b6f5-0123456789ab";
  assert.equal(resolveRequestId(incoming), incoming);
});

test("NFR-31: malformed ids are replaced with a minted uuid", () => {
  for (const bad of [undefined, null, 42, ["a"], "", "has space", "tab\tinside", "x".repeat(129)]) {
    const id = resolveRequestId(bad);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
});

test("NFR-31: minted ids are unique", () => {
  assert.notEqual(resolveRequestId(undefined), resolveRequestId(undefined));
});

/** Minimal Valkey stub: captures writes, serves the given presence entries. */
function fakeValkey(entries: Record<string, string | null>, members: string[]) {
  const sets: Array<{ key: string; value: string; flags: unknown[] }> = [];
  const dels: string[] = [];
  const valkey = {
    smembers: async (_key: string) => members,
    pipeline() {
      const ops: Array<{ cmd: string; args: unknown[] }> = [];
      const pipe = {
        get(k: string) { ops.push({ cmd: "get", args: [k] }); return pipe; },
        set(...args: unknown[]) { ops.push({ cmd: "set", args }); return pipe; },
        del(k: string) { ops.push({ cmd: "del", args: [k] }); return pipe; },
        async exec() {
          return ops.map((op) => {
            if (op.cmd === "get") return [null, entries[op.args[0] as string] ?? null];
            if (op.cmd === "set") {
              sets.push({ key: op.args[0] as string, value: op.args[1] as string, flags: op.args.slice(2) });
              return [null, "OK"];
            }
            dels.push(op.args[0] as string);
            return [null, 1];
          });
        },
      };
      return pipe;
    },
  };
  return { valkey, sets, dels };
}

test("BR-14: suspension strips venue attribution, keeps cell presence and TTL", async () => {
  const entries = {
    "presence:user:u1": JSON.stringify({ cell: "abc", venueId: "v1", floorId: "f1", sessionId: "s1" }),
    "presence:user:u2": JSON.stringify({ cell: "abc", venueId: "v1", sessionId: "s2" }),
    "presence:user:u3": JSON.stringify({ cell: "abc", venueId: "v2", sessionId: "s3" }),
    "presence:user:u4": null, // expired between SMEMBERS and GET
  };
  const { valkey, sets, dels } = fakeValkey(entries, ["u1", "u2", "u3", "u4"]);
  await purgeVenuePresence({ valkey } as unknown as EdgeContext, "v1");

  assert.deepEqual(dels, ["presence:venue:v1"]);
  assert.equal(sets.length, 2);
  for (const s of sets) {
    const body = JSON.parse(s.value) as Record<string, unknown>;
    assert.equal("venueId" in body, false);
    assert.equal("floorId" in body, false);
    assert.ok(body.cell); // cell presence untouched
    // KEEPTTL + XX: remaining TTL preserved, no resurrection of expired keys.
    assert.deepEqual(s.flags, ["KEEPTTL", "XX"]);
  }
  assert.ok(sets.every((s) => s.key !== "presence:user:u3")); // other venue untouched
});

test("BR-14: purging an empty venue still drops the venue set", async () => {
  const { valkey, sets, dels } = fakeValkey({}, []);
  await purgeVenuePresence({ valkey } as unknown as EdgeContext, "v9");
  assert.deepEqual(dels, ["presence:venue:v9"]);
  assert.equal(sets.length, 0);
});

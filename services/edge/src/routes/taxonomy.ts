/**
 * Taxonomy CMS routes (PRS-SRS-001 §4 taxonomy) — FR-59, TR-20.
 *
 *   POST /v1/taxonomy/releases                 — create a draft release
 *   GET  /v1/taxonomy/releases                 — list releases (newest first)
 *   GET  /v1/taxonomy/releases/:releaseId      — release detail with ops
 *   POST /v1/taxonomy/releases/:releaseId/submit   — draft → in_review
 *   POST /v1/taxonomy/releases/:releaseId/approve  — in_review → approved;
 *                                                    second person only
 *   POST /v1/taxonomy/releases/:releaseId/publish  — apply, snapshot, version,
 *                                                    rebuild closure, re-sync
 *                                                    embeddings — one txn
 *   POST /v1/taxonomy/releases/:releaseId/rollback — restore the snapshot;
 *                                                    latest published only
 *
 * Every route is gated by requireTaxonomist (workforce realm) and runs under
 * the app.taxonomist GUC, which the taxonomy write-guard triggers require.
 * Publish and rollback are audited in admin_audit (FR-60).
 */

import { FastifyInstance } from "fastify";
import { AuthedRequest, requireTaxonomist, withTaxonomist } from "../auth.js";
import { EdgeContext } from "../context.js";
import { EMBEDDER_ID, embed, nodeText, toVectorLiteral } from "../linking.js";
import {
  TaxonomyLink,
  TaxonomyNode,
  TaxonomyState,
  applyOps,
  diffSummary,
  linkKey,
  parseReleaseBody,
} from "../taxonomy.js";

function UUID_PARAMS(keys: string[]) {
  return {
    type: "object",
    required: keys,
    properties: Object.fromEntries(keys.map((k) => [k, { type: "string", format: "uuid" }])),
  };
}

const RELEASE_COLS = `release_id, version, status, author, reviewer, message, summary,
  published_by, rolled_back_by, created_at, submitted_at, reviewed_at, published_at, rolled_back_at`;

function releaseJson(r: Record<string, unknown>) {
  return {
    releaseId: r.release_id,
    version: r.version === null ? null : Number(r.version),
    status: r.status,
    author: r.author,
    reviewer: r.reviewer,
    message: r.message,
    summary: r.summary,
    publishedBy: r.published_by,
    rolledBackBy: r.rolled_back_by,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
    publishedAt: r.published_at,
    rolledBackAt: r.rolled_back_at,
  };
}

/** Load the live taxonomy into the in-memory apply model. */
async function loadState(client: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<TaxonomyState> {
  const nodes = new Map<string, TaxonomyNode>();
  const links = new Map<string, TaxonomyLink>();
  const n = await client.query(
    "SELECT node_id, label, parent_id, kind, sensitive, redirect_to, depth FROM taxonomy_nodes",
  );
  for (const r of n.rows) {
    nodes.set(r.node_id as string, {
      nodeId: r.node_id as string,
      label: r.label as string,
      parentId: r.parent_id as string | null,
      kind: r.kind as string,
      sensitive: r.sensitive as boolean,
      redirectTo: r.redirect_to as string | null,
      depth: Number(r.depth),
    });
  }
  const l = await client.query("SELECT a_id, b_id, kind, weight FROM taxonomy_links");
  for (const r of l.rows) {
    const link: TaxonomyLink = {
      aId: r.a_id as string,
      bId: r.b_id as string,
      kind: r.kind as TaxonomyLink["kind"],
      weight: Number(r.weight),
    };
    links.set(linkKey(link), link);
  }
  return { nodes, links };
}

/** Persist the full post-apply state (small, governed reference data), then
 * rebuild the closure and re-sync the embedding search space (TR-18/TR-22). */
async function persistState(
  client: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  before: TaxonomyState,
  after: TaxonomyState,
): Promise<void> {
  // Nodes: upsert everything in `after`, delete what vanished (nothing can
  // vanish via ops — only rollback deletes, and it restores instead).
  for (const node of after.nodes.values()) {
    const prev = before.nodes.get(node.nodeId);
    if (
      prev === undefined ||
      prev.label !== node.label ||
      prev.parentId !== node.parentId ||
      prev.kind !== node.kind ||
      prev.sensitive !== node.sensitive ||
      prev.redirectTo !== node.redirectTo ||
      prev.depth !== node.depth
    ) {
      await client.query(
        `INSERT INTO taxonomy_nodes (node_id, label, parent_id, kind, sensitive, redirect_to, depth)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (node_id) DO UPDATE SET
           label = EXCLUDED.label, parent_id = EXCLUDED.parent_id, kind = EXCLUDED.kind,
           sensitive = EXCLUDED.sensitive, redirect_to = EXCLUDED.redirect_to, depth = EXCLUDED.depth`,
        [node.nodeId, node.label, node.parentId, node.kind, node.sensitive, node.redirectTo, node.depth],
      );
    }
  }
  // Links: insert new, delete removed.
  for (const link of after.links.values()) {
    if (!before.links.has(linkKey(link))) {
      await client.query(
        "INSERT INTO taxonomy_links (a_id, b_id, kind, weight) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [link.aId, link.bId, link.kind, link.weight],
      );
    }
  }
  for (const link of before.links.values()) {
    if (!after.links.has(linkKey(link))) {
      await client.query(
        "DELETE FROM taxonomy_links WHERE a_id = $1 AND b_id = $2 AND kind = $3",
        [link.aId, link.bId, link.kind],
      );
    }
  }
  await client.query("SELECT rebuild_taxonomy_closure()");
  await resyncEmbeddings(client, after);
}

/** TR-22: embeddings are derived state — rebuilt from the live taxonomy on
 * every release mutation; sensitive and redirected nodes never hold one. */
async function resyncEmbeddings(
  client: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  state: TaxonomyState,
): Promise<void> {
  await client.query("DELETE FROM taxonomy_node_embeddings");
  for (const node of state.nodes.values()) {
    if (node.sensitive || node.redirectTo !== null) continue;
    await client.query(
      "INSERT INTO taxonomy_node_embeddings (node_id, embedding, embedder) VALUES ($1, $2::vector, $3)",
      [node.nodeId, toVectorLiteral(embed(nodeText(node.nodeId, node.label))), EMBEDDER_ID],
    );
  }
}

export function registerTaxonomyRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // FR-59: create a draft release. Ops are validated against live state at
  // publish time again — the draft stage is where shape errors surface.
  app.post(
    "/v1/taxonomy/releases",
    { preHandler: requireTaxonomist },
    async (req, reply) => {
      const parsed = parseReleaseBody(req.body);
      if (!parsed.ok) return reply.code(422).send({ error: parsed.error });
      const author = (req as AuthedRequest).userId;
      const created = await withTaxonomist(ctx.pg, async (client) => {
        const ins = await client.query(
          `INSERT INTO taxonomy_releases (author, message) VALUES ($1, $2) RETURNING ${RELEASE_COLS}`,
          [author, parsed.message],
        );
        const releaseId = ins.rows[0].release_id as string;
        for (let i = 0; i < parsed.ops.length; i++) {
          await client.query(
            "INSERT INTO taxonomy_release_ops (release_id, op_seq, op) VALUES ($1, $2, $3)",
            [releaseId, i + 1, JSON.stringify(parsed.ops[i])],
          );
        }
        return ins.rows[0];
      });
      return reply.code(201).send(releaseJson(created));
    },
  );

  app.get("/v1/taxonomy/releases", { preHandler: requireTaxonomist }, async (req, reply) => {
    const rows = await withTaxonomist(ctx.pg, async (client) => {
      const res = await client.query(
        `SELECT ${RELEASE_COLS} FROM taxonomy_releases
         ORDER BY created_at DESC, release_id DESC LIMIT 100`,
      );
      return res.rows;
    });
    return reply.send({ releases: rows.map(releaseJson) });
  });

  app.get(
    "/v1/taxonomy/releases/:releaseId",
    { schema: { params: UUID_PARAMS(["releaseId"]) }, preHandler: requireTaxonomist },
    async (req, reply) => {
      const { releaseId } = req.params as { releaseId: string };
      const out = await withTaxonomist(ctx.pg, async (client) => {
        const res = await client.query(`SELECT ${RELEASE_COLS} FROM taxonomy_releases WHERE release_id = $1`, [releaseId]);
        if (res.rows.length === 0) return null;
        const ops = await client.query(
          "SELECT op_seq, op FROM taxonomy_release_ops WHERE release_id = $1 ORDER BY op_seq",
          [releaseId],
        );
        return { release: res.rows[0], ops: ops.rows };
      });
      if (out === null) return reply.code(404).send({ error: "release not found" });
      return reply.send({ ...releaseJson(out.release), ops: out.ops.map((o) => o.op) });
    },
  );

  // draft → in_review (author or any taxonomist; second-person rule bites at approve).
  app.post(
    "/v1/taxonomy/releases/:releaseId/submit",
    { schema: { params: UUID_PARAMS(["releaseId"]) }, preHandler: requireTaxonomist },
    async (req, reply) => {
      const { releaseId } = req.params as { releaseId: string };
      const out = await withTaxonomist(ctx.pg, async (client) => {
        const res = await client.query(
          `UPDATE taxonomy_releases SET status = 'in_review', submitted_at = now()
           WHERE release_id = $1 AND status = 'draft' RETURNING ${RELEASE_COLS}`,
          [releaseId],
        );
        return res.rows[0] ?? null;
      });
      if (out === null) return reply.code(409).send({ error: "release not found or not a draft" });
      return reply.send(releaseJson(out));
    },
  );

  // FR-59: review is a second person — the author can never approve their
  // own release.
  app.post(
    "/v1/taxonomy/releases/:releaseId/approve",
    { schema: { params: UUID_PARAMS(["releaseId"]) }, preHandler: requireTaxonomist },
    async (req, reply) => {
      const { releaseId } = req.params as { releaseId: string };
      const reviewer = (req as AuthedRequest).userId;
      const out = await withTaxonomist(ctx.pg, async (client) => {
        const res = await client.query(
          `UPDATE taxonomy_releases SET status = 'approved', reviewer = $2, reviewed_at = now()
           WHERE release_id = $1 AND status = 'in_review' AND author <> $2 RETURNING ${RELEASE_COLS}`,
          [releaseId, reviewer],
        );
        return res.rows[0] ?? null;
      });
      if (out === null) {
        return reply.code(409).send({ error: "release not in review, or review requires a second person" });
      }
      return reply.send(releaseJson(out));
    },
  );

  // FR-59/TR-20: publish — snapshot, apply, version, closure, embeddings,
  // audit; all in one transaction.
  app.post(
    "/v1/taxonomy/releases/:releaseId/publish",
    { schema: { params: UUID_PARAMS(["releaseId"]) }, preHandler: requireTaxonomist },
    async (req, reply) => {
      const { releaseId } = req.params as { releaseId: string };
      const publisher = (req as AuthedRequest).userId;
      try {
        const out = await withTaxonomist(ctx.pg, async (client) => {
          const res = await client.query(
            `SELECT ${RELEASE_COLS} FROM taxonomy_releases WHERE release_id = $1 FOR UPDATE`,
            [releaseId],
          );
          if (res.rows.length === 0) throw Object.assign(new Error("release not found"), { code: 404 });
          const release = res.rows[0];
          if (release.status !== "approved") {
            throw Object.assign(new Error("release must be approved before publish"), { code: 409 });
          }
          const opsRes = await client.query(
            "SELECT op FROM taxonomy_release_ops WHERE release_id = $1 ORDER BY op_seq",
            [releaseId],
          );
          const ops = opsRes.rows.map((r) => r.op as Parameters<typeof applyOps>[1][number]);

          const before = await loadState(client);
          // TR-20 provenance: the pre-publish state is the rollback basis.
          const snapshot = {
            nodes: [...before.nodes.values()],
            links: [...before.links.values()],
          };
          const after: TaxonomyState = {
            nodes: new Map([...before.nodes.entries()].map(([k, v]) => [k, { ...v }])),
            links: new Map(before.links),
          };
          applyOps(after, ops); // re-validated against live state, inside the txn
          await persistState(client, before, after);

          const summary = diffSummary(ops);
          const updated = await client.query(
            `UPDATE taxonomy_releases
                SET status = 'published', version = nextval('taxonomy_release_version'),
                    summary = $2, snapshot = $3, published_by = $4, published_at = now()
              WHERE release_id = $1 RETURNING ${RELEASE_COLS}`,
            [releaseId, JSON.stringify(summary), JSON.stringify(snapshot), publisher],
          );
          await client.query(
            "SELECT admin_audit_log($1, 'taxonomy.release.published', 'taxonomy_release', 'taxonomy_release', $2, NULL, $3)",
            [publisher, releaseId, JSON.stringify({ version: Number(updated.rows[0].version), summary })],
          );
          return updated.rows[0];
        });
        return reply.send(releaseJson(out));
      } catch (err) {
        const e = err as { code?: number | string; message?: string };
        if (e.code === 404) return reply.code(404).send({ error: e.message });
        if (e.code === 409) return reply.code(409).send({ error: e.message });
        // applyOps violations are client-visible 422s.
        if (typeof e.message === "string" && e.code === undefined) {
          return reply.code(422).send({ error: e.message });
        }
        throw err;
      }
    },
  );

  // FR-59: one-action rollback. Only the latest published release may be
  // rolled back; the restore is refused while user data references nodes the
  // release added (deprecate them in a new release instead).
  app.post(
    "/v1/taxonomy/releases/:releaseId/rollback",
    { schema: { params: UUID_PARAMS(["releaseId"]) }, preHandler: requireTaxonomist },
    async (req, reply) => {
      const { releaseId } = req.params as { releaseId: string };
      const actor = (req as AuthedRequest).userId;
      try {
        const out = await withTaxonomist(ctx.pg, async (client) => {
          const res = await client.query(
            `SELECT ${RELEASE_COLS}, snapshot FROM taxonomy_releases WHERE release_id = $1 FOR UPDATE`,
            [releaseId],
          );
          if (res.rows.length === 0) throw Object.assign(new Error("release not found"), { code: 404 });
          const release = res.rows[0];
          if (release.status !== "published") {
            throw Object.assign(new Error("only a published release can be rolled back"), { code: 409 });
          }
          const latest = await client.query(
            "SELECT max(version) AS v FROM taxonomy_releases WHERE status = 'published'",
          );
          if (Number(latest.rows[0].v) !== Number(release.version)) {
            throw Object.assign(new Error("only the latest published release can be rolled back"), { code: 409 });
          }
          const snapshot = release.snapshot as { nodes: TaxonomyNode[]; links: TaxonomyLink[] };
          const before = await loadState(client);
          const added = [...before.nodes.keys()].filter((id) => !snapshot.nodes.some((n) => n.nodeId === id));
          if (added.length > 0) {
            const refs = await client.query("SELECT taxonomy_rollback_reference_count($1::text[]) AS n", [added]);
            if (Number(refs.rows[0].n) > 0) {
              throw Object.assign(
                new Error(`rollback blocked: live data references ${added.length} added node(s); deprecate them instead`),
                { code: 409 },
              );
            }
          }
          // Restore the snapshot as a delta — never touching rows that user
          // data references. Order matters for the FK web:
          //   0. derived state (embeddings, closure) goes first — always safe
          //   1. snapshot nodes back in place (clears redirect_to to added nodes)
          //   2. live links not in the snapshot go (unblocks node deletion)
          //   3. added nodes are deleted — now unreferenced everywhere
          //   4. missing snapshot links return; closure + embeddings rebuild
          await client.query("DELETE FROM taxonomy_node_embeddings");
          await client.query("DELETE FROM taxonomy_closure");
          for (const n of snapshot.nodes) {
            await client.query(
              `INSERT INTO taxonomy_nodes (node_id, label, parent_id, kind, sensitive, redirect_to, depth)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (node_id) DO UPDATE SET
                 label = EXCLUDED.label, parent_id = EXCLUDED.parent_id, kind = EXCLUDED.kind,
                 sensitive = EXCLUDED.sensitive, redirect_to = EXCLUDED.redirect_to, depth = EXCLUDED.depth`,
              [n.nodeId, n.label, n.parentId, n.kind, n.sensitive, n.redirectTo, n.depth],
            );
          }
          const snapshotLinkKeys = new Set(snapshot.links.map((l) => linkKey(l)));
          for (const l of before.links.values()) {
            if (!snapshotLinkKeys.has(linkKey(l))) {
              await client.query(
                "DELETE FROM taxonomy_links WHERE a_id = $1 AND b_id = $2 AND kind = $3",
                [l.aId, l.bId, l.kind],
              );
            }
          }
          if (added.length > 0) {
            await client.query("DELETE FROM taxonomy_nodes WHERE node_id = ANY($1::text[])", [added]);
          }
          for (const l of snapshot.links) {
            if (!before.links.has(linkKey(l))) {
              await client.query(
                "INSERT INTO taxonomy_links (a_id, b_id, kind, weight) VALUES ($1, $2, $3, $4)",
                [l.aId, l.bId, l.kind, l.weight],
              );
            }
          }
          await client.query("SELECT rebuild_taxonomy_closure()");
          await resyncEmbeddings(client, await loadState(client));

          const updated = await client.query(
            `UPDATE taxonomy_releases
                SET status = 'rolled_back', rolled_back_by = $2, rolled_back_at = now()
              WHERE release_id = $1 RETURNING ${RELEASE_COLS}`,
            [releaseId, actor],
          );
          await client.query(
            "SELECT admin_audit_log($1, 'taxonomy.release.rolled_back', 'taxonomy_release', 'taxonomy_release', $2, NULL, $3)",
            [actor, releaseId, JSON.stringify({ version: Number(release.version) })],
          );
          return updated.rows[0];
        });
        return reply.send(releaseJson(out));
      } catch (err) {
        const e = err as { code?: number | string; message?: string };
        if (e.code === 404) return reply.code(404).send({ error: e.message });
        if (e.code === 409) return reply.code(409).send({ error: e.message });
        throw err;
      }
    },
  );
}

/**
 * Data plane for the match service: Postgres for taxonomy and profiles,
 * Valkey for live presence. The scan path itself touches only Valkey and
 * in-memory structures — Postgres reads happen on the refresh loops, never
 * inline in a scan (PRS-SRS-001 §8: async work stays off the scan path).
 *
 * Valkey key model (shared with the edge; see docs/presence-model.md):
 *   presence:user:{userId}   JSON {cell, venueId}  — EX 900 (FR-14)
 *   presence:cell:{cellId}   SET of userIds        — filtered at read time
 */

// Valkey speaks RESP; the client is ioredis (the registry mirror's iovalkey
// fork lags at 0.x). Swap the import once iovalkey stabilises — the calls are
// identical.
import Postgres from "pg";
import { Redis as Valkey } from "ioredis";
import { Corpus, InterestGraph, Matcher, Profile } from "./engine.js";

export const CORPUS_REFRESH_MS = 60_000; // TR-05: at least every 60 seconds
export const PRESENCE_TTL_S = 900;       // FR-14

export interface PresenceEntry {
  userId: string;
  cell: string;
  venueId: string | null;
}

export class Store {
  private graph: InterestGraph | null = null;
  private corpus: Corpus | null = null;
  private profileCache = new Map<string, { profile: Profile; at: number }>();
  private corpusTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pg: Postgres.Pool,
    public readonly valkey: Valkey,
  ) {}

  /** Taxonomy is near-static; loaded at boot and on demand after import. */
  async loadGraph(): Promise<InterestGraph> {
    const nodes = await this.pg.query(
      "SELECT node_id AS nid, label, parent_id AS parent, kind, sensitive FROM taxonomy_nodes",
    );
    const links = await this.pg.query(
      "SELECT a_id AS a, b_id AS b, kind, weight FROM taxonomy_links",
    );
    this.graph = new InterestGraph(nodes.rows, links.rows);
    return this.graph;
  }

  getGraph(): InterestGraph {
    if (!this.graph) throw new Error("graph not loaded yet");
    return this.graph;
  }

  /** Profile with a short cache; Postgres is never hit twice per minute per user. */
  async profile(userId: string): Promise<Profile | null> {
    const cached = this.profileCache.get(userId);
    if (cached && Date.now() - cached.at < CORPUS_REFRESH_MS) return cached.profile;
    const rows = await this.pg.query(
      "SELECT node_id, weight FROM profile_interests WHERE user_id = $1",
      [userId],
    );
    if (rows.rows.length === 0) return null;
    const profile: Profile = {};
    for (const r of rows.rows) profile[r.node_id] = r.weight;
    this.profileCache.set(userId, { profile, at: Date.now() });
    return profile;
  }

  /** Live presence for one user, or null when the TTL has lapsed (FR-14). */
  async presence(userId: string): Promise<PresenceEntry | null> {
    const raw = await this.valkey.get(`presence:user:${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cell: string; venueId?: string };
    return { userId, cell: parsed.cell, venueId: parsed.venueId ?? null };
  }

  /** Members of a cell, with stale set entries filtered at read time. */
  async cellMembers(cell: string): Promise<string[]> {
    const members = await this.valkey.smembers(`presence:cell:${cell}`);
    if (members.length === 0) return [];
    const pipe = this.valkey.pipeline();
    for (const m of members) pipe.exists(`presence:user:${m}`);
    const res = await pipe.exec();
    return members.filter((_: string, i: number) => res?.[i]?.[1] === 1);
  }

  /**
   * TR-05: document frequency over the link-free closures of the live
   * population, rebuilt on a timer (at least every 60 s).
   */
  async rebuildCorpus(): Promise<Corpus> {
    const matcher = new Matcher(this.getGraph());
    const userIds: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await this.valkey.scan(cursor, "MATCH", "presence:user:*", "COUNT", 200);
      cursor = next;
      userIds.push(...keys.map((k: string) => k.slice("presence:user:".length)));
    } while (cursor !== "0");

    const vectors = [];
    for (const uid of userIds) {
      const profile = await this.profile(uid);
      if (profile && Object.keys(profile).length >= 2) { // FR-11
        vectors.push(matcher.vector(profile, false));    // link-free (TR-05)
      }
    }
    this.corpus = Corpus.fromVectors(vectors);
    return this.corpus;
  }

  getCorpus(): Corpus {
    if (!this.corpus) throw new Error("corpus not built yet");
    return this.corpus;
  }

  /** Boot: graph once, corpus now and on the TR-05 refresh interval. */
  async start(): Promise<void> {
    await this.loadGraph();
    await this.rebuildCorpus();
    this.corpusTimer = setInterval(() => {
      this.rebuildCorpus().catch((err) => console.error("corpus refresh failed", err));
    }, CORPUS_REFRESH_MS);
    this.corpusTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.corpusTimer) clearInterval(this.corpusTimer);
    await this.pg.end();
    this.valkey.disconnect();
  }
}

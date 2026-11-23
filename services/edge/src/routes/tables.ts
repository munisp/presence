/**
 * Group surface routes (PRS-SRS-001 §4 group features).
 *
 *   POST /v1/tables                        — FR-66: create a table; the
 *     creator becomes its designated host (FR-69). Requires live presence
 *     at the venue; the name is screened like any member-visible text.
 *   GET /v1/tables                         — FR-75: lists the caller's own
 *     memberships only. There is deliberately no venue-wide listing.
 *   GET /v1/tables/:tableId                — member-only detail; members
 *     carry name+role from the scoped directory (FR-69).
 *   DELETE /v1/tables/:tableId             — host closes the table (FR-74,
 *     audited). Open slots are cancelled with it.
 *   POST /v1/tables/:tableId/join          — FR-66: self-serve join while
 *     live at the venue. Joining is the act that shares the interest
 *     snapshot (FR-67); the seventh join is refused (SEC-33).
 *   DELETE /v1/tables/:tableId/members/:userId — leave yourself, or the
 *     host removes a member (FR-74, audited). A host with members cannot
 *     leave — close the table instead.
 *   GET /v1/tables/:tableId/cards          — FR-67: conversation cards from
 *     shared declared interests, every card labelled generated.
 *   POST /v1/tables/:tableId/slots         — FR-68: offer a 1:1 slot.
 *   GET /v1/tables/:tableId/slots          — member-only slot list.
 *   POST /v1/slots/:slotId/book            — FR-68: the booking is the
 *     consent act; a conditional state flip plus the booking primary key
 *     make double-booking impossible.
 *   DELETE /v1/slots/:slotId/book          — booker or offerer cancels;
 *     a future slot re-opens, a past one lapses.
 *
 * Non-members always receive 404 on table-scoped routes — existence is
 * never leaked (FR-75). TR-23: strict params/body throughout.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  buildCards,
  parseSlot,
  parseTableName,
  SharedNodeRow,
  TABLE_MEMBER_CAP,
} from "../groups.js";
import { SCREENING_EXPLANATION, screenText } from "../screening.js";

const UUID_PARAMS = (names: string[]) => ({
  type: "object" as const,
  required: names,
  additionalProperties: false as const,
  properties: Object.fromEntries(names.map((n) => [n, { type: "string", format: "uuid" }])),
});

interface PgError {
  code?: string;
  message?: string;
}

interface DirectoryRow {
  user_id: string;
  handle: string | null;
  role: string;
  joined_at: string;
}

export function registerTableRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/tables",
    {
      schema: {
        body: {
          type: "object",
          required: ["venueId", "name"],
          additionalProperties: false,
          properties: {
            venueId: { type: "string", format: "uuid" },
            eventId: { type: "string", format: "uuid" },
            name: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) => {
      const { venueId, eventId, name: rawName } = req.body as {
        venueId: string;
        eventId?: string;
        name: string;
      };
      const name = parseTableName(rawName);
      if (!name) {
        return reply.code(422).send({ error: "table name must be 1-80 characters" });
      }
      const findings = screenText(name);
      if (findings.length > 0) {
        const categories = [...new Set(findings.map((f) => SCREENING_EXPLANATION[f.category]))];
        return reply.code(422).send({
          error: `table name cannot contain ${categories.join(", ")}`,
          categories: findings.map((f) => f.category),
        });
      }
      const venue = await ctx.pg.query(
        "SELECT venue_id FROM venues WHERE venue_id = $1 AND active",
        [venueId],
      );
      if (venue.rows.length === 0) {
        return reply.code(404).send({ error: "unknown venue" });
      }
      if (eventId) {
        const ev = await ctx.pg.query(
          "SELECT 1 FROM events WHERE event_id = $1 AND venue_id = $2",
          [eventId, venueId],
        );
        if (ev.rows.length === 0) {
          return reply.code(422).send({ error: "event does not belong to the venue" });
        }
      }
      // Group tables are a venue surface: creating or joining requires live
      // presence, same as every other venue-scoped feature.
      const present = await ctx.valkey.sismember(`presence:venue:${venueId}`, req.userId);
      if (!present) {
        return reply.code(403).send({ error: "live presence at the venue is required" });
      }
      const row = await withRls(ctx.pg, req.userId, async (c) => {
        const t = await c.query(
          `INSERT INTO group_tables (venue_id, event_id, name, created_by)
           VALUES ($1, $2, $3, $4) RETURNING table_id, created_at`,
          [venueId, eventId ?? null, name, req.userId],
        );
        const tableId = t.rows[0].table_id as string;
        await c.query(
          "INSERT INTO group_table_members (table_id, user_id, role) VALUES ($1, $2, 'host')",
          [tableId, req.userId],
        );
        await c.query(
          `INSERT INTO group_table_interests (table_id, user_id, node_id, weight)
           SELECT $1, user_id, node_id, weight FROM profile_interests WHERE user_id = $2`,
          [tableId, req.userId],
        );
        return { tableId, createdAt: t.rows[0].created_at as string };
      });
      return reply.code(201).send({
        tableId: row.tableId,
        name,
        venueId,
        eventId: eventId ?? null,
        state: "open",
        role: "host",
        createdAt: row.createdAt,
      });
    },
  );

  app.get(
    "/v1/tables",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { venueId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (req, reply) => {
      const { venueId } = req.query as { venueId?: string };
      // FR-75: only the caller's own memberships are ever returned.
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query(
          `SELECT t.table_id, t.name, t.venue_id, t.event_id, t.state, t.created_at, m.role
             FROM group_tables t
             JOIN group_table_members m
               ON m.table_id = t.table_id AND m.user_id = $1
            WHERE t.state = 'open' ${venueId ? "AND t.venue_id = $2" : ""}
            ORDER BY t.created_at DESC
            LIMIT 50`,
          venueId ? [req.userId, venueId] : [req.userId],
        ),
      );
      return reply.send({
        tables: rows.rows.map((r) => ({
          tableId: r.table_id,
          name: r.name,
          venueId: r.venue_id,
          eventId: r.event_id,
          state: r.state,
          role: r.role,
          createdAt: r.created_at,
        })),
      });
    },
  );

  app.get(
    "/v1/tables/:tableId",
    { schema: { params: UUID_PARAMS(["tableId"]) } },
    async (req, reply) => {
      const { tableId } = req.params as { tableId: string };
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const t = await c.query(
          `SELECT table_id, name, venue_id, event_id, state, created_at
             FROM group_tables WHERE table_id = $1`,
          [tableId],
        );
        if (t.rows.length === 0) return null; // FR-75: indistinguishable
        const dir = await c.query(
          "SELECT user_id, handle, role, joined_at FROM group_member_directory($1)",
          [tableId],
        );
        return { table: t.rows[0], members: dir.rows as DirectoryRow[] };
      });
      if (!out) return reply.code(404).send({ error: "table not found" });
      const t = out.table;
      return reply.send({
        tableId: t.table_id,
        name: t.name,
        venueId: t.venue_id,
        eventId: t.event_id,
        state: t.state,
        createdAt: t.created_at,
        members: out.members.map((m) => ({
          userId: m.user_id,
          handle: m.handle,
          role: m.role,
          joinedAt: m.joined_at,
        })),
      });
    },
  );

  app.post(
    "/v1/tables/:tableId/join",
    { schema: { params: UUID_PARAMS(["tableId"]) } },
    async (req, reply) => {
      const { tableId } = req.params as { tableId: string };
      // FR-75: the join probe reveals only venue + headcount of open tables.
      const info = await ctx.pg.query(
        "SELECT venue_id, member_count FROM group_join_info($1)",
        [tableId],
      );
      if (info.rows.length === 0) {
        return reply.code(404).send({ error: "table not found" });
      }
      if ((info.rows[0].member_count as number) >= TABLE_MEMBER_CAP) {
        return reply.code(409).send({ error: "table is full" });
      }
      const present = await ctx.valkey.sismember(
        `presence:venue:${info.rows[0].venue_id as string}`,
        req.userId,
      );
      if (!present) {
        return reply.code(403).send({ error: "live presence at the venue is required" });
      }
      try {
        const out = await withRls(ctx.pg, req.userId, async (c) => {
          let already = false;
          try {
            await c.query(
              "INSERT INTO group_table_members (table_id, user_id, role) VALUES ($1, $2, 'member')",
              [tableId, req.userId],
            );
          } catch (err) {
            if ((err as PgError).code === "23505") already = true; // re-join is idempotent
            else throw err;
          }
          // FR-67: (re-)joining refreshes the shared interest snapshot.
          await c.query(
            "DELETE FROM group_table_interests WHERE table_id = $1 AND user_id = $2",
            [tableId, req.userId],
          );
          await c.query(
            `INSERT INTO group_table_interests (table_id, user_id, node_id, weight)
             SELECT $1, user_id, node_id, weight FROM profile_interests WHERE user_id = $2`,
            [tableId, req.userId],
          );
          return { already };
        });
        return reply
          .code(out.already ? 200 : 201)
          .send({ tableId, role: "member", alreadyMember: out.already });
      } catch (err) {
        if ((err as PgError).message?.includes("SEC-33")) {
          return reply.code(409).send({ error: "table is full" });
        }
        throw err;
      }
    },
  );

  app.delete(
    "/v1/tables/:tableId",
    { schema: { params: UUID_PARAMS(["tableId"]) } },
    async (req, reply) => {
      const { tableId } = req.params as { tableId: string };
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const t = await c.query(
          "SELECT table_id, state FROM group_tables WHERE table_id = $1",
          [tableId],
        );
        if (t.rows.length === 0) return { status: 404 as const };
        const dir = await c.query(
          "SELECT user_id, role FROM group_member_directory($1)",
          [tableId],
        );
        const me = (dir.rows as DirectoryRow[]).find((m) => m.user_id === req.userId);
        if (me?.role !== "host") return { status: 403 as const };
        if (t.rows[0].state === "closed") return { status: 200 as const };
        await c.query(
          "UPDATE table_slots SET state = 'cancelled' WHERE table_id = $1 AND state = 'open'",
          [tableId],
        );
        await c.query("UPDATE group_tables SET state = 'closed' WHERE table_id = $1", [tableId]);
        // FR-74: closing is a host accountability event.
        await c.query(
          `SELECT admin_audit_log($1, 'group.table.close', 'host_discretion',
                                  'group_table', $2,
                                  jsonb_build_object('state', 'open'),
                                  jsonb_build_object('state', 'closed'))`,
          [req.userId, tableId],
        );
        return { status: 200 as const };
      });
      if (out.status === 404) return reply.code(404).send({ error: "table not found" });
      if (out.status === 403) return reply.code(403).send({ error: "only the host can close the table" });
      return reply.send({ tableId, state: "closed" });
    },
  );

  app.delete(
    "/v1/tables/:tableId/members/:userId",
    { schema: { params: UUID_PARAMS(["tableId", "userId"]) } },
    async (req, reply) => {
      const { tableId, userId } = req.params as { tableId: string; userId: string };
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const dir = await c.query(
          "SELECT user_id, role FROM group_member_directory($1)",
          [tableId],
        );
        const members = dir.rows as DirectoryRow[];
        if (members.length === 0) return { status: 404 as const };
        const me = members.find((m) => m.user_id === req.userId);
        if (!me) return { status: 404 as const };
        const target = members.find((m) => m.user_id === userId);
        if (!target) return { status: 404 as const };
        const self = userId === req.userId;
        if (!self && me.role !== "host") {
          return { status: 403 as const, error: "only the host can remove members" };
        }
        if (self && me.role === "host" && members.length > 1) {
          return {
            status: 409 as const,
            error: "the host cannot leave while members remain; close the table instead",
          };
        }
        // Cancel the departing member's open offers, drop their shared
        // snapshot, then the membership itself (order matters for RLS).
        await c.query(
          "UPDATE table_slots SET state = 'cancelled' WHERE table_id = $1 AND offerer = $2 AND state = 'open'",
          [tableId, userId],
        );
        await c.query(
          "DELETE FROM group_table_interests WHERE table_id = $1 AND user_id = $2",
          [tableId, userId],
        );
        await c.query(
          "DELETE FROM group_table_members WHERE table_id = $1 AND user_id = $2",
          [tableId, userId],
        );
        if (!self) {
          // FR-74: removals are host accountability events.
          await c.query(
            `SELECT admin_audit_log($1, 'group.member.remove', 'host_discretion',
                                    'group_table', $2,
                                    jsonb_build_object('userId', $3, 'role', $4), NULL)`,
            [req.userId, tableId, userId, target.role],
          );
        }
        // The last member out (necessarily the host) closes the table.
        if (members.length === 1 && self && me.role === "host") {
          await c.query("UPDATE group_tables SET state = 'closed' WHERE table_id = $1", [tableId]);
        }
        return { status: 204 as const };
      });
      if (out.status === 404) return reply.code(404).send({ error: "table not found" });
      if (out.status === 403) return reply.code(403).send({ error: out.error });
      if (out.status === 409) return reply.code(409).send({ error: out.error });
      return reply.code(204).send();
    },
  );

  app.get(
    "/v1/tables/:tableId/cards",
    { schema: { params: UUID_PARAMS(["tableId"]) } },
    async (req, reply) => {
      const { tableId } = req.params as { tableId: string };
      const rows = await withRls(ctx.pg, req.userId, async (c) => {
        const t = await c.query("SELECT 1 FROM group_tables WHERE table_id = $1", [tableId]);
        if (t.rows.length === 0) return null;
        return c.query(
          `SELECT g.node_id, tn.label,
                  array_agg(DISTINCT g.user_id ORDER BY g.user_id) AS members
             FROM group_table_interests g
             JOIN taxonomy_nodes tn ON tn.node_id = g.node_id AND NOT tn.sensitive
            WHERE g.table_id = $1
            GROUP BY g.node_id, tn.label
           HAVING count(DISTINCT g.user_id) >= 2`,
          [tableId],
        );
      });
      if (!rows) return reply.code(404).send({ error: "table not found" });
      const shared: SharedNodeRow[] = rows.rows.map((r) => ({
        nodeId: r.node_id as string,
        label: r.label as string,
        members: r.members as string[],
      }));
      return reply.send({ cards: buildCards(shared) });
    },
  );

  app.post(
    "/v1/tables/:tableId/slots",
    {
      schema: {
        params: UUID_PARAMS(["tableId"]),
        body: {
          type: "object",
          required: ["startsAt"],
          additionalProperties: false,
          properties: {
            startsAt: { type: "string", format: "date-time" },
            durationMinutes: { type: "integer", minimum: 5, maximum: 60 },
          },
        },
      },
    },
    async (req, reply) => {
      const { tableId } = req.params as { tableId: string };
      const { startsAt, durationMinutes } = req.body as {
        startsAt: string;
        durationMinutes?: number;
      };
      const slot = parseSlot(startsAt, durationMinutes);
      if (!slot) {
        return reply
          .code(422)
          .send({ error: "startsAt must be a future timestamp; duration 5-60 minutes" });
      }
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const t = await c.query("SELECT state FROM group_tables WHERE table_id = $1", [tableId]);
        if (t.rows.length === 0) return { status: 404 as const };
        if (t.rows[0].state !== "open") return { status: 409 as const };
        const r = await c.query(
          `INSERT INTO table_slots (table_id, offerer, starts_at, duration_minutes)
           VALUES ($1, $2, $3, $4)
           RETURNING slot_id, created_at`,
          [tableId, req.userId, slot.startsAt.toISOString(), slot.durationMinutes],
        );
        return { status: 201 as const, row: r.rows[0] };
      });
      if (out.status === 404) return reply.code(404).send({ error: "table not found" });
      if (out.status === 409) return reply.code(409).send({ error: "table is closed" });
      return reply.code(201).send({
        slotId: out.row.slot_id,
        tableId,
        offerer: req.userId,
        startsAt: slot.startsAt.toISOString(),
        durationMinutes: slot.durationMinutes,
        state: "open",
        createdAt: out.row.created_at,
      });
    },
  );

  app.get(
    "/v1/tables/:tableId/slots",
    { schema: { params: UUID_PARAMS(["tableId"]) } },
    async (req, reply) => {
      const { tableId } = req.params as { tableId: string };
      const rows = await withRls(ctx.pg, req.userId, async (c) => {
        const t = await c.query("SELECT 1 FROM group_tables WHERE table_id = $1", [tableId]);
        if (t.rows.length === 0) return null;
        return c.query(
          `SELECT ts.slot_id, ts.offerer, ts.starts_at, ts.duration_minutes, ts.state,
                  sb.booker, sb.booked_at, sb.cancelled_at
             FROM table_slots ts
             LEFT JOIN slot_bookings sb ON sb.slot_id = ts.slot_id
            WHERE ts.table_id = $1
              AND ts.state <> 'cancelled'
              AND ts.starts_at > now() - interval '1 day'
            ORDER BY ts.starts_at
            LIMIT 50`,
          [tableId],
        );
      });
      if (!rows) return reply.code(404).send({ error: "table not found" });
      return reply.send({
        slots: rows.rows.map((r) => ({
          slotId: r.slot_id,
          offerer: r.offerer,
          startsAt: r.starts_at,
          durationMinutes: r.duration_minutes,
          state: r.state,
          booking: r.booker
            ? { booker: r.booker, bookedAt: r.booked_at, cancelledAt: r.cancelled_at }
            : null,
        })),
      });
    },
  );

  app.post(
    "/v1/slots/:slotId/book",
    { schema: { params: UUID_PARAMS(["slotId"]) } },
    async (req, reply) => {
      const { slotId } = req.params as { slotId: string };
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const s = await c.query(
          "SELECT slot_id, offerer, starts_at, state FROM table_slots WHERE slot_id = $1",
          [slotId],
        );
        if (s.rows.length === 0) return { status: 404 as const };
        const slot = s.rows[0];
        if (slot.offerer === req.userId) {
          return { status: 422 as const, error: "you cannot book your own slot" };
        }
        if (new Date(slot.starts_at as string).getTime() <= Date.now()) {
          return { status: 410 as const };
        }
        // The conditional flip is the race guard; the slot_bookings primary
        // key is the data-layer guarantee (FR-68/SEC-33).
        const flip = await c.query(
          "UPDATE table_slots SET state = 'booked' WHERE slot_id = $1 AND state = 'open' RETURNING slot_id",
          [slotId],
        );
        if (flip.rows.length === 0) return { status: 409 as const };
        // FR-68: this row is the consent act — actor and timestamp, once.
        const b = await c.query(
          "INSERT INTO slot_bookings (slot_id, booker) VALUES ($1, $2) RETURNING booked_at",
          [slotId, req.userId],
        );
        return { status: 201 as const, bookedAt: b.rows[0].booked_at as string };
      });
      if (out.status === 404) return reply.code(404).send({ error: "slot not found" });
      if (out.status === 410) return reply.code(410).send({ error: "slot has passed" });
      if (out.status === 409) return reply.code(409).send({ error: "slot is no longer bookable" });
      if (out.status === 422) return reply.code(422).send({ error: out.error });
      return reply.code(201).send({ slotId, booker: req.userId, bookedAt: out.bookedAt });
    },
  );

  app.delete(
    "/v1/slots/:slotId/book",
    { schema: { params: UUID_PARAMS(["slotId"]) } },
    async (req, reply) => {
      const { slotId } = req.params as { slotId: string };
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const s = await c.query(
          `SELECT ts.slot_id, ts.offerer, ts.starts_at,
                  sb.booker, sb.booked_at, sb.cancelled_at
             FROM table_slots ts
             LEFT JOIN slot_bookings sb ON sb.slot_id = ts.slot_id
            WHERE ts.slot_id = $1`,
          [slotId],
        );
        if (s.rows.length === 0 || !s.rows[0].booker) return { status: 404 as const };
        const slot = s.rows[0];
        if (slot.booker !== req.userId && slot.offerer !== req.userId) {
          return { status: 403 as const };
        }
        if (slot.cancelled_at) {
          return { status: 200 as const, cancelledAt: slot.cancelled_at as string };
        }
        const u = await c.query(
          "UPDATE slot_bookings SET cancelled_at = now() WHERE slot_id = $1 AND cancelled_at IS NULL RETURNING cancelled_at",
          [slotId],
        );
        // A future slot re-opens for someone else; a past one just lapses.
        await c.query(
          `UPDATE table_slots
              SET state = CASE WHEN starts_at > now() THEN 'open' ELSE 'cancelled' END
            WHERE slot_id = $1`,
          [slotId],
        );
        return { status: 200 as const, cancelledAt: u.rows[0].cancelled_at as string };
      });
      if (out.status === 404) return reply.code(404).send({ error: "no booking found" });
      if (out.status === 403) {
        return reply.code(403).send({ error: "only the booker or the offerer can cancel" });
      }
      return reply.send({ slotId, state: "cancelled", cancelledAt: out.cancelledAt });
    },
  );
}

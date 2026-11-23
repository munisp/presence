-- Presence — offer lifecycle (PRS-SRS-001 §5.4)
--
-- Requirement anchors:
--   FR-32   silent decline — the counterpart sees only expiry
--   FR-33   offers expire server-side 30 minutes after the last action
--   FR-34   blocking: immediate, silent, permanent mutual discovery removal
--   FR-37   conversations auto-close 24 h after OPEN unless both sides keep
--   NFR-19  expired/declined offers remain visible (as "expired") for 24 h
--   NFR-20  conversation ciphertext is purged 24 h after close
--
-- Forward-only migration; run after 0001_init.sql.

BEGIN;

-- ------------------------------------------------------- offer windows -----
-- expires_at  : offer deadline (FR-33). Set at first surfacing (DETECTED) and
--               renewed on every user action; NULL once OPEN.
-- closes_at   : conversation deadline (FR-37) = opened_at + 24 h; cleared when
--               both members keep the conversation.
-- closed_at / close_reason : terminal marker. 'declined' and 'blocked' are
--               never exposed to the counterpart (FR-32/34) — the edge masks
--               them; only 'expired' and 'lapsed' are client-visible.

ALTER TABLE matches
    ADD COLUMN expires_at   timestamptz,
    ADD COLUMN closes_at    timestamptz,
    ADD COLUMN closed_at    timestamptz,
    ADD COLUMN close_reason text CHECK (close_reason IN ('expired','declined','blocked','lapsed')),
    ADD COLUMN declined_by  uuid REFERENCES users (user_id),
    ADD COLUMN keep_lo      boolean NOT NULL DEFAULT false,
    ADD COLUMN keep_hi      boolean NOT NULL DEFAULT false;

CREATE INDEX matches_expiry_idx ON matches (expires_at) WHERE closed_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX matches_close_idx  ON matches (closes_at)  WHERE closed_at IS NULL AND closes_at IS NOT NULL;

-- ------------------------------------------------------------- blocking ----
-- FR-34: one-directional, permanent, silent. The blocker can read their own
-- rows; the blocked party can read nothing (RLS below) and is never notified.

CREATE TABLE blocks (
    blocker    uuid NOT NULL REFERENCES users (user_id),
    blocked    uuid NOT NULL REFERENCES users (user_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker, blocked),
    CHECK (blocker <> blocked)
);

ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY blocks_owner_read ON blocks
    FOR SELECT USING (blocker = app_user());
CREATE POLICY blocks_owner_write ON blocks
    FOR INSERT WITH CHECK (blocker = app_user());

GRANT SELECT, INSERT ON blocks TO presence_app;
-- no UPDATE/DELETE grants: a block is permanent (FR-34)

-- Scan-time exclusion set for a user: everyone they blocked UNION everyone
-- who blocked them, direction erased. SECURITY DEFINER so the app role can
-- resolve the blocked-by side (invisible under RLS by design) without ever
-- learning which direction any row points. Backs up the Valkey block keys,
-- which are lost on a cache flush; the table is the durable record.
CREATE OR REPLACE FUNCTION blocked_users_for(uid uuid) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT blocked FROM blocks WHERE blocker = uid
    UNION
    SELECT blocker FROM blocks WHERE blocked = uid
$$;

REVOKE ALL ON FUNCTION blocked_users_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION blocked_users_for(uuid) TO presence_app;

-- ------------------------------------------- messaging gate on closed pairs
-- A lapsed/expired/declined/blocked pair can no longer exchange or read
-- envelopes, even though its state column still reads OPEN (the consent enum
-- is a forward-only machine; closure lives in closed_at).

DROP POLICY messages_open_members ON messages;
CREATE POLICY messages_open_members ON messages
    USING (EXISTS (SELECT 1 FROM matches m
                    WHERE m.pair_id = messages.pair_id
                      AND m.state = 'OPEN'
                      AND m.closed_at IS NULL
                      AND app_user() IN (m.user_lo, m.user_hi)))
    WITH CHECK (sender = app_user() AND EXISTS (
                    SELECT 1 FROM matches m
                     WHERE m.pair_id = messages.pair_id
                       AND m.state = 'OPEN'
                       AND m.closed_at IS NULL
                       AND app_user() IN (m.user_lo, m.user_hi)));

-- -------------------------------------------------- the lifecycle tick -----
-- One SECURITY DEFINER function, invoked by the edge every minute (and by
-- tests directly). Running as the table owner it crosses the RLS boundary;
-- the app role only gets EXECUTE, never the underlying write access.
--
-- Order matters: expiry first (an offer whose clock ran out), then
-- conversation lapse, then ciphertext purge.

CREATE OR REPLACE FUNCTION lifecycle_tick() RETURNS TABLE (
    offers_expired integer,
    conversations_lapsed integer,
    envelopes_purged integer
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    -- FR-33: offers (any pre-OPEN state) past their deadline close as expired.
    UPDATE matches
       SET closed_at = now(), close_reason = 'expired'
     WHERE closed_at IS NULL
       AND state <> 'OPEN'
       AND expires_at IS NOT NULL
       AND expires_at < now();
    GET DIAGNOSTICS offers_expired = ROW_COUNT;

    -- FR-37: OPEN conversations past 24 h close unless BOTH members kept them
    -- (the keep handler clears closes_at when the second keep arrives, so a
    -- row reaching this point with closes_at set has at most one keeper).
    UPDATE matches
       SET closed_at = now(), close_reason = 'lapsed'
     WHERE closed_at IS NULL
       AND state = 'OPEN'
       AND closes_at IS NOT NULL
       AND closes_at < now()
       AND NOT (keep_lo AND keep_hi);
    GET DIAGNOSTICS conversations_lapsed = ROW_COUNT;

    -- NFR-20: ciphertext lives at most 24 h past close.
    DELETE FROM messages m
     USING matches p
     WHERE m.pair_id = p.pair_id
       AND p.closed_at IS NOT NULL
       AND p.closed_at < now() - interval '24 hours';
    GET DIAGNOSTICS envelopes_purged = ROW_COUNT;

    RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION lifecycle_tick() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_tick() TO presence_app;

-- The edge sets offer/conversation windows and closure markers directly;
-- state transitions remain ledger-only (FR-29/35).
GRANT UPDATE (expires_at, closes_at, closed_at, close_reason, declined_by, keep_lo, keep_hi)
    ON matches TO presence_app;

COMMIT;

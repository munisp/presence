-- Presence — account deletion, age declaration, DSAR tooling
-- (PRS-SRS-001 §4.1/§4.9/§7)
--
-- Requirement anchors:
--   FR-02   age declaration with a neutral under-18 block on discovery
--   FR-03   account deletion as a single authenticated call
--   FR-04   deletion purge: presence/offers <=60 s, ledger anonymisation
--           after the retention hold, index removal
--   FR-62   data-subject assemble/erase tooling (DSAR)
--   SEC-14  DSAR 30-day / erasure 72-h tooling (these respond in seconds)
--   NFR-19  expired/declined offers are hard-deleted after the 24-h window
--   NFR-21  ledger retained under a 90-day abuse hold, then anonymised
--
-- Forward-only migration; run after 0002_offer_lifecycle.sql.

BEGIN;

-- ------------------------------------------------------- age + tombstone ---
-- FR-02: a declaration is a birth YEAR only — no birth date, no documents
-- (SEC-17 picks the assurance method later). Year precision fails toward
-- blocking at the 18 boundary. deleted_at marks a tombstoned account: the row
-- stays so matches/ledger/reports foreign keys hold, but every personal
-- column is gone by then (delete_account below).

ALTER TABLE users
    ADD COLUMN birth_year      smallint CHECK (birth_year BETWEEN 1900 AND 2100),
    ADD COLUMN age_declared_at timestamptz,
    ADD COLUMN age_blocked     boolean NOT NULL DEFAULT false,
    ADD COLUMN deleted_at      timestamptz;

-- The edge upserts the declaration and flips the block flag; nothing else
-- about a user row is writable by the app role.
GRANT INSERT ON users TO presence_app;
GRANT UPDATE (birth_year, age_declared_at, age_blocked) ON users TO presence_app;

-- ------------------------------------------- governed purge mode (FR-35) ---
-- The ledger stays append-only for every application path. A single
-- escape hatch — transaction-local app.purge = 'on' — exists solely so the
-- SECURITY DEFINER lifecycle tick can enforce retention (NFR-19 hard delete,
-- NFR-21 anonymisation). No application code can set it: the app role has no
-- UPDATE/DELETE grants on consent_ledger, so the exception is unreachable
-- outside the definer functions.

CREATE OR REPLACE FUNCTION consent_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.purge', true) = 'on' THEN
        IF TG_OP = 'UPDATE' THEN RETURN NEW; ELSE RETURN OLD; END IF;
    END IF;
    RAISE EXCEPTION 'consent_ledger is append-only (FR-35)';
END $$;

-- ----------------------------------------------------------- DSAR export ---
-- FR-62: everything the platform holds on the requester, one document.
-- Masking rules still apply: a counterpart's decline shows as 'expired'
-- (FR-32) and blocked pairs are invisible (FR-34) — the export must not
-- become a backdoor around either. The requester's own block list IS their
-- data and is included.

CREATE OR REPLACE FUNCTION dsar_export(uid uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT jsonb_build_object(
        'user', (SELECT jsonb_build_object(
                        'userId', u.user_id, 'createdAt', u.created_at,
                        'birthYear', u.birth_year, 'ageDeclaredAt', u.age_declared_at)
                   FROM users u WHERE u.user_id = uid),
        'identity', (SELECT jsonb_build_object(
                        'handle', i.handle, 'photoUrl', i.photo_url, 'updatedAt', i.updated_at)
                       FROM user_identities i WHERE i.user_id = uid),
        'interests', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'nodeId', p.node_id, 'weight', p.weight) ORDER BY p.node_id)
                       FROM profile_interests p WHERE p.user_id = uid), '[]'::jsonb),
        'pairs', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'pairId', m.pair_id, 'state', m.state,
                        'openedAt', m.opened_at, 'closedAt', m.closed_at,
                        'closeReason', CASE WHEN m.close_reason = 'declined' THEN 'expired'
                                            ELSE m.close_reason END)
                       ORDER BY m.opened_at DESC NULLS LAST)
                       FROM matches m
                       WHERE uid IN (m.user_lo, m.user_hi)
                         AND (m.close_reason IS NULL OR m.close_reason <> 'blocked')),
                       '[]'::jsonb),
        'ledgerActions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'pairId', l.pair_id, 'from', l.from_state, 'to', l.to_state, 'at', l.at)
                       ORDER BY l.at)
                       FROM consent_ledger l WHERE l.actor = uid), '[]'::jsonb),
        'blocksFiled', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'blocked', b.blocked, 'at', b.created_at) ORDER BY b.created_at)
                       FROM blocks b WHERE b.blocker = uid), '[]'::jsonb),
        'reportsFiled', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'reportId', r.report_id, 'reason', r.reason, 'details', r.details,
                        'createdAt', r.created_at, 'status', r.status) ORDER BY r.created_at)
                       FROM reports r WHERE r.reporter = uid), '[]'::jsonb)
    )
$$;

REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app;

-- ------------------------------------------------------ account deletion ---
-- FR-03/04: one call erases the account. Everything personal goes
-- synchronously (well inside the 60-s bar): message envelopes, block rows,
-- profile, interests, identity. Pairs close with a neutral reason — 'expired'
-- pre-OPEN, 'lapsed' once OPEN — so the counterpart learns nothing about WHY
-- (same masking contract as FR-32). The users row stays as an anonymous
-- tombstone for foreign keys; the ledger keeps its rows under the 90-day
-- abuse hold, anonymised afterwards by the tick (NFR-21).

CREATE OR REPLACE FUNCTION delete_account(uid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM messages
     WHERE pair_id IN (SELECT pair_id FROM matches WHERE uid IN (user_lo, user_hi));

    UPDATE matches
       SET closed_at = now(),
           close_reason = CASE WHEN state = 'OPEN' THEN 'lapsed' ELSE 'expired' END
     WHERE closed_at IS NULL
       AND uid IN (user_lo, user_hi);

    DELETE FROM blocks WHERE blocker = uid OR blocked = uid;
    DELETE FROM profile_interests WHERE user_id = uid;
    DELETE FROM user_identities WHERE user_id = uid;

    UPDATE users
       SET deleted_at = now(), age_blocked = true
     WHERE user_id = uid AND deleted_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION delete_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_account(uuid) TO presence_app;

-- ------------------------------------------------- lifecycle tick, round 2
-- Extends 0002's tick with retention enforcement. New columns are additive;
-- callers selecting by name are unaffected.
--
-- Order: expire → lapse → purge ciphertext → hard-delete dead offers →
-- anonymise aged deletions.

-- The replacement widens the return row (two additive columns), which
-- CREATE OR REPLACE cannot do; drop first so fresh-environment applies of
-- the full chain succeed (caught by the AMD-ESC-03 rehearsal).
DROP FUNCTION lifecycle_tick();

CREATE OR REPLACE FUNCTION lifecycle_tick() RETURNS TABLE (
    offers_expired integer,
    conversations_lapsed integer,
    envelopes_purged integer,
    offers_purged integer,
    ledgers_anonymised integer
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

    -- FR-37: OPEN conversations past 24 h close unless BOTH members kept them.
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

    PERFORM set_config('app.purge', 'on', true);

    -- NFR-19: offers that closed (expired/declined) more than 24 h ago are
    -- hard-deleted together with their ledger rows. Only never-OPEN pairs —
    -- an opened conversation's ledger stays for the abuse hold below.
    DELETE FROM consent_ledger l
     USING matches p
     WHERE l.pair_id = p.pair_id
       AND p.closed_at IS NOT NULL
       AND p.closed_at < now() - interval '24 hours'
       AND p.state <> 'OPEN';
    DELETE FROM matches p
     WHERE p.closed_at IS NOT NULL
       AND p.closed_at < now() - interval '24 hours'
       AND p.state <> 'OPEN';
    GET DIAGNOSTICS offers_purged = ROW_COUNT;

    -- FR-04 / NFR-21: accounts deleted more than 90 days ago have their
    -- ledger attribution erased (actor -> NULL, the system marker). The rows
    -- themselves survive — append-only history without personal data.
    UPDATE consent_ledger l
       SET actor = NULL
     WHERE l.actor IN (SELECT user_id FROM users
                        WHERE deleted_at IS NOT NULL
                          AND deleted_at < now() - interval '90 days');
    GET DIAGNOSTICS ledgers_anonymised = ROW_COUNT;

    RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION lifecycle_tick() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_tick() TO presence_app;

COMMIT;

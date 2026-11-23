-- Presence — discovery safety: visibility switch, announcements, dashboard
-- (PRS-SRS-001 §3.6/§4.7/§4.10/§7)
--
-- Requirement anchors:
--   FR-18   global invisible switch — persistent, immediate
--   FR-93   announcement publish path: trust floor + 4-h cap + category
--   FR-94   inverted-consent responses — anonymous until acceptance
--   FR-95   one live announcement / 1 publish per 24 h / 1 response each
--   FR-97   'work' category reserved for verified organisations (BR-33)
--   FR-98   auto-removal after 2 reports in 10 min, evidence retained
--   SEC-38  responder enumeration caps; no identity before acceptance
--   BR-12   aggregate-only venue dashboard (endpoint is edge-side)
--
-- Forward-only migration; run after 0003_account_deletion.sql.

BEGIN;

-- ------------------------------------------------------- invisible (FR-18) --
-- The switch is a durable account flag. The edge purges live presence keys
-- the moment it flips on and refuses publishes while it is set; the flag
-- itself persists across sessions and devices (no confirmation dialogue is
-- a client contract — the API simply honours the write).

ALTER TABLE users
    ADD COLUMN invisible    boolean NOT NULL DEFAULT false,
    ADD COLUMN invisible_at timestamptz;

GRANT UPDATE (invisible, invisible_at) ON users TO presence_app;

-- The DSAR document must include the flag (FR-62 completeness).
CREATE OR REPLACE FUNCTION dsar_export(uid uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT jsonb_build_object(
        'user', (SELECT jsonb_build_object(
                        'userId', u.user_id, 'createdAt', u.created_at,
                        'birthYear', u.birth_year, 'ageDeclaredAt', u.age_declared_at,
                        'invisible', u.invisible)
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

-- -------------------------------------------------------- announcements -----
-- FR-93/96/BR-33: a publisher, a fixed category set and removal bookkeeping
-- join the existing time-windowed table. 'work' rows may only be published
-- by verified organisations (enforced at the edge, FR-97).

ALTER TABLE announcements
    ADD COLUMN publisher      uuid REFERENCES users (user_id),
    ADD COLUMN category       text NOT NULL DEFAULT 'notice'
        CHECK (category IN ('social', 'work', 'lost_found', 'notice')),
    ADD COLUMN removed_at     timestamptz,
    ADD COLUMN removal_reason text;

GRANT INSERT ON announcements TO presence_app;
GRANT UPDATE (removed_at, removal_reason) ON announcements TO presence_app;

-- FR-94/95/SEC-38: responses are inverted-consent — the responder is
-- anonymous until the publisher accepts. One response per account per
-- announcement.
CREATE TABLE announcement_responses (
    response_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    announcement_id uuid NOT NULL REFERENCES announcements (announcement_id),
    responder       uuid NOT NULL REFERENCES users (user_id),
    body            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    accepted_at     timestamptz,
    withdrawn_at    timestamptz,
    UNIQUE (announcement_id, responder)
);
CREATE INDEX announcement_responses_a_idx ON announcement_responses (announcement_id, created_at);

ALTER TABLE announcement_responses ENABLE ROW LEVEL SECURITY;

-- The responder manages their own rows…
CREATE POLICY aresp_responder ON announcement_responses
    USING (responder = app_user())
    WITH CHECK (responder = app_user());
-- …and the publisher can read/accept responses on their own announcements
-- (identity exposure is decided by the edge, not the policy — SEC-38).
CREATE POLICY aresp_publisher ON announcement_responses
    USING (EXISTS (SELECT 1 FROM announcements a
                    WHERE a.announcement_id = announcement_responses.announcement_id
                      AND a.publisher = app_user()));

GRANT SELECT, INSERT ON announcement_responses TO presence_app;
GRANT UPDATE (accepted_at, withdrawn_at) ON announcement_responses TO presence_app;

-- ------------------------------------------------------ reports anchor -----
-- FR-98: reports can anchor to an announcement so the auto-removal rule has
-- something to count.

ALTER TABLE reports
    ADD COLUMN announcement_id uuid REFERENCES announcements (announcement_id);

-- FR-98: two reports inside ten minutes remove the announcement. SECURITY
-- DEFINER because the app role cannot read back reports (INSERT-only
-- policy); the function returns the publisher id only when it actually
-- removed, so the edge can notify. Rows are never deleted — reports and the
-- announcement body stay as evidence.
CREATE OR REPLACE FUNCTION maybe_remove_announcement(aid uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n   integer;
    pub uuid;
BEGIN
    SELECT count(*) INTO n
      FROM reports
     WHERE announcement_id = aid
       AND created_at > now() - interval '10 minutes';
    IF n >= 2 THEN
        UPDATE announcements
           SET removed_at = now(), removal_reason = 'reports'
         WHERE announcement_id = aid
           AND removed_at IS NULL
        RETURNING publisher INTO pub;
    END IF;
    RETURN pub;   -- NULL = threshold not reached (or already removed)
END $$;

REVOKE ALL ON FUNCTION maybe_remove_announcement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maybe_remove_announcement(uuid) TO presence_app;

COMMIT;

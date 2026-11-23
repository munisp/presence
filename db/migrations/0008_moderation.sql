-- Presence — trust and moderation stack
-- (PRS-SRS-001 §4 trust & safety; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   FR-52   per-account trust score from verification, report outcomes and
--           account age — one deterministic SQL function, moderation-only
--   FR-53   silent investigation removal (a users flag; no notification is
--           ever sent) plus the appeal path (appeals table, one open
--           appeal per account)
--   FR-54   moderation console support: reports gain outcomes, moderators
--           read/act through the app.moderator GUC — never message content
--   FR-55   independent suspension of attestation key, handle, or payment
--           instrument; one active suspension per (user, dimension)
--
-- The moderator gate mirrors the app.user_id trust model: the edge sets
-- app.moderator='on' via SET LOCAL only on workforce-gated routes, and the
-- policies below key on it. Client traffic can never reach it.
--
-- Forward-only migration; run after 0007_group_surface.sql.

BEGIN;

-- ------------------------------------------------------------ FR-55 --------
CREATE TYPE suspension_dimension AS ENUM ('attestation_key','handle','payment_instrument');

CREATE TABLE suspensions (
    suspension_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users (user_id),
    dimension     suspension_dimension NOT NULL,
    reason_code   text NOT NULL,               -- governed vocabulary (edge)
    report_id     uuid REFERENCES reports (report_id),
    created_by    uuid,                        -- workforce subject; NULL = system
    created_at    timestamptz NOT NULL DEFAULT now(),
    lifted_at     timestamptz,
    lifted_by     uuid,
    lift_reason   text
);
-- One active suspension per (user, dimension): independence means each
-- dimension is its own switch (FR-55).
CREATE UNIQUE INDEX suspensions_one_active
    ON suspensions (user_id, dimension) WHERE lifted_at IS NULL;
CREATE INDEX suspensions_user_idx ON suspensions (user_id, created_at DESC);

-- ------------------------------------------------------------ FR-53 --------
-- Silent by construction: nothing here notifies the account; the edge
-- purges live presence without a realtime event and the discovery gate
-- answers the same neutral error as an age block.
ALTER TABLE users
    ADD COLUMN investigation_removed_at timestamptz,
    ADD COLUMN investigation_reason_code text;

CREATE TABLE appeals (
    appeal_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (user_id),
    suspension_id uuid REFERENCES suspensions (suspension_id),  -- NULL when
        -- appealing an investigation removal
    body         text NOT NULL,                  -- screened at write (edge)
    created_at   timestamptz NOT NULL DEFAULT now(),
    state        text NOT NULL DEFAULT 'open' CHECK (state IN ('open','upheld','overturned')),
    resolved_by  uuid,
    resolved_at  timestamptz,
    resolution_note text
);
-- The appeal path is always open but never spammable: one open appeal.
CREATE UNIQUE INDEX appeals_one_open ON appeals (user_id) WHERE state = 'open';

-- ------------------------------------------------------------ FR-52 --------
-- Report outcomes feed the trust score; only the console sets them.
ALTER TABLE reports
    ADD COLUMN outcome text CHECK (outcome IN ('actioned','dismissed')),
    ADD COLUMN resolved_by uuid,
    ADD COLUMN resolved_at timestamptz;

-- Deterministic trust score (FR-52). Inputs, and only these:
--   verification   +0.20 when the account completed age declaration
--   account age    +0.10 at 30 days, +0.10 at 180 days
--   report outcomes -0.15 per actioned report (cap -0.45),
--                   +0.05 per dismissed report (cap +0.15),
--                   -0.02 per unresolved report (cap -0.10)
-- Clamped to [0, 1]. SECURITY DEFINER so the console can call it under the
-- moderator GUC without granting reports broadly.
CREATE OR REPLACE FUNCTION trust_score(p_user uuid) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    s numeric := 0.50;
    u record;
    n_actioned integer;
    n_dismissed integer;
    n_open integer;
BEGIN
    SELECT created_at, age_declared_at INTO u FROM users WHERE user_id = p_user;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF u.age_declared_at IS NOT NULL THEN s := s + 0.20; END IF;
    IF u.created_at <= now() - interval '30 days' THEN s := s + 0.10; END IF;
    IF u.created_at <= now() - interval '180 days' THEN s := s + 0.10; END IF;
    SELECT count(*) FILTER (WHERE outcome = 'actioned'),
           count(*) FILTER (WHERE outcome = 'dismissed'),
           count(*) FILTER (WHERE status <> 'closed')
      INTO n_actioned, n_dismissed, n_open
      FROM reports
     WHERE reported = p_user;
    s := s - LEAST(n_actioned * 0.15, 0.45)
           + LEAST(n_dismissed * 0.05, 0.15)
           - LEAST(n_open * 0.02, 0.10);
    RETURN round(greatest(0.0, least(1.0, s))::numeric, 3);
END $$;

-- FR-55: handle suspension masks the handle wherever identity is displayed.
CREATE OR REPLACE FUNCTION display_handle(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT CASE WHEN EXISTS (SELECT 1 FROM suspensions
                              WHERE user_id = p_user
                                AND dimension = 'handle'
                                AND lifted_at IS NULL)
                THEN NULL
                ELSE (SELECT handle FROM user_identities WHERE user_id = p_user)
           END
$$;

-- FR-55: the edge checks attestation suspensions on presence writes without
-- holding the RLS GUC, so this helper runs as owner.
CREATE OR REPLACE FUNCTION has_active_suspension(p_user uuid, p_dimension suspension_dimension)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM suspensions
                    WHERE user_id = p_user
                      AND dimension = p_dimension
                      AND lifted_at IS NULL)
$$;

-- FR-55: apply the mask inside the group directory (created in 0007).
CREATE OR REPLACE FUNCTION group_member_directory(p_table_id uuid)
RETURNS TABLE (user_id uuid, handle text, role text, joined_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public AS $$
DECLARE
    v_caller uuid := app_user();
BEGIN
    IF v_caller IS NULL OR NOT is_group_member(p_table_id, v_caller) THEN
        RETURN;
    END IF;
    RETURN QUERY
      SELECT gm.user_id, display_handle(gm.user_id) AS handle, gm.role, gm.joined_at
        FROM group_table_members gm
       WHERE gm.table_id = p_table_id
       ORDER BY gm.joined_at;
END $$;

-- FR-54: ledger stats for the account card — aggregate counts only, never
-- content, and only for moderators.
CREATE OR REPLACE FUNCTION account_ledger_stats(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    out jsonb;
BEGIN
    IF NOT app_moderator() THEN RETURN NULL; END IF;
    SELECT jsonb_object_agg(to_state, n) INTO out
      FROM (SELECT cl.to_state, count(*) AS n
              FROM consent_ledger cl
              JOIN matches m ON m.pair_id = cl.pair_id
             WHERE p_user IN (m.user_lo, m.user_hi)
             GROUP BY cl.to_state) s;
    RETURN coalesce(out, '{}'::jsonb);
END $$;

-- ------------------------------------------------- moderator gate (FR-54) --
CREATE OR REPLACE FUNCTION app_moderator() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.moderator', true) = 'on' $$;

-- reports is already RLS-enabled (0001); the app role could only INSERT.
ALTER TABLE suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE appeals     ENABLE ROW LEVEL SECURITY;

-- Moderators read and resolve reports; nothing else changes.
CREATE POLICY reports_moderation_select ON reports
    FOR SELECT USING (app_moderator());
CREATE POLICY reports_moderation_update ON reports
    FOR UPDATE USING (app_moderator()) WITH CHECK (app_moderator());

-- Suspensions: a user sees their own (the appeal path needs to know what
-- it is appealing); only moderators write.
CREATE POLICY suspensions_own ON suspensions
    FOR SELECT USING (user_id = app_user());
CREATE POLICY suspensions_moderation_select ON suspensions
    FOR SELECT USING (app_moderator());
CREATE POLICY suspensions_moderation_insert ON suspensions
    FOR INSERT WITH CHECK (app_moderator());
CREATE POLICY suspensions_moderation_update ON suspensions
    FOR UPDATE USING (app_moderator()) WITH CHECK (app_moderator());

-- Appeals: file and read your own; moderators resolve.
CREATE POLICY appeals_own_select ON appeals
    FOR SELECT USING (user_id = app_user());
CREATE POLICY appeals_own_insert ON appeals
    FOR INSERT WITH CHECK (user_id = app_user());
CREATE POLICY appeals_moderation_select ON appeals
    FOR SELECT USING (app_moderator());
CREATE POLICY appeals_moderation_update ON appeals
    FOR UPDATE USING (app_moderator()) WITH CHECK (app_moderator());

-- ------------------------------------------------------------- grants -----
REVOKE ALL ON FUNCTION trust_score(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION display_handle(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION has_active_suspension(uuid, suspension_dimension) FROM PUBLIC;
REVOKE ALL ON FUNCTION account_ledger_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trust_score(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION display_handle(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION has_active_suspension(uuid, suspension_dimension) TO presence_app;
GRANT EXECUTE ON FUNCTION account_ledger_stats(uuid) TO presence_app;

GRANT SELECT ON reports TO presence_app;
GRANT UPDATE (status, outcome, resolved_by, resolved_at) ON reports TO presence_app;
GRANT SELECT, INSERT ON suspensions TO presence_app;
GRANT UPDATE (lifted_at, lifted_by, lift_reason) ON suspensions TO presence_app;
GRANT SELECT, INSERT ON appeals TO presence_app;
GRANT UPDATE (state, resolved_by, resolved_at, resolution_note) ON appeals TO presence_app;
GRANT UPDATE (investigation_removed_at, investigation_reason_code) ON users TO presence_app;

COMMIT;

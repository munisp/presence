-- Presence — profile write surface, message revocation, notification
-- switches, admin audit log, venue feature flags, structured prompts
-- (PRS-SRS-001 §4; PRS-ARC-002 §5)
--
-- Requirement anchors:
--   FR-08   profile write API: profile_interests replace-set needs DELETE
--   FR-41   24-h own-message revocation: messages.revoked_at + sender-only,
--           column-limited UPDATE under a RESTRICTIVE policy
--   FR-58   per-category notification switches (safety exempt — enforced
--           in the edge; the column is a plain jsonb bag)
--   FR-60   immutable admin audit log (actor, reason code, before/after) —
--           append-only like consent_ledger
--   FR-63   per-venue feature flags; the edge consults them before serving
--           flag-gated surfaces (announcements first)
--   FR-64   structured prompts (<=3 x 120 chars, screened, reason material,
--           not searchable — no search endpoint, no content index)
--
-- Forward-only migration; run after 0005_floors_checkin.sql.

BEGIN;

-- ------------------------------------------------------------ FR-41 --------
ALTER TABLE messages
    ADD COLUMN revoked_at timestamptz;

-- The app role may flip only these two columns, only on rows the sender
-- owns. messages_open_members (permissive, ALL commands) already scopes row
-- visibility to OPEN pair members; this RESTRICTIVE policy ANDs the sender
-- condition on top, so a counterpart cannot revoke or blank a message.
CREATE POLICY messages_revoke_own ON messages
    AS RESTRICTIVE FOR UPDATE TO presence_app
    USING (sender = app_user())
    WITH CHECK (sender = app_user());

GRANT UPDATE (revoked_at, envelope) ON messages TO presence_app;

-- ------------------------------------------------------------ FR-58 --------
ALTER TABLE users
    ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

GRANT UPDATE (notification_prefs) ON users TO presence_app;

-- ------------------------------------------------------------ FR-08 --------
-- Replace-set profile writes delete the rows the set no longer contains.
-- profile_owner (ALL commands) keeps the row scope owner-only.
GRANT DELETE ON profile_interests TO presence_app;

-- ------------------------------------------------------------ FR-60 --------
-- Same append-only discipline as consent_ledger: the app role can INSERT
-- and SELECT; UPDATE/DELETE are blocked by trigger for every role.
CREATE TABLE admin_audit (
    seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor       uuid,                           -- NULL = system/ops
    action      text NOT NULL,
    reason_code text NOT NULL,                  -- governed vocabulary, never free text
    target_type text NOT NULL,
    target_id   text NOT NULL,
    before      jsonb,
    after       jsonb,
    at          timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION admin_audit_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'admin_audit is append-only (FR-60)';
END $$;

CREATE TRIGGER admin_audit_immutable
    BEFORE UPDATE OR DELETE ON admin_audit
    FOR EACH ROW EXECUTE FUNCTION admin_audit_immutable();

-- Internal writer for ops and (later) the moderation console (FR-54). Runs
-- as owner so the row lands regardless of the caller's grants; the trigger
-- above still bars any later mutation.
CREATE OR REPLACE FUNCTION admin_audit_log(
    p_actor       uuid,
    p_action      text,
    p_reason_code text,
    p_target_type text,
    p_target_id   text,
    p_before      jsonb DEFAULT NULL,
    p_after       jsonb DEFAULT NULL
) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    new_seq bigint;
BEGIN
    INSERT INTO admin_audit (actor, action, reason_code, target_type, target_id, before, after)
    VALUES (p_actor, p_action, p_reason_code, p_target_type, p_target_id, p_before, p_after)
    RETURNING seq INTO new_seq;
    RETURN new_seq;
END $$;

GRANT SELECT, INSERT ON admin_audit TO presence_app;
GRANT EXECUTE ON FUNCTION admin_audit_log(uuid, text, text, text, text, jsonb, jsonb) TO presence_app;

-- ------------------------------------------------------------ FR-63 --------
-- Flags are written by ops (SQL) with an admin_audit row, never by client
-- traffic, so no write grant is given to the app role. A missing row means
-- the feature is ON — flags only ever narrow behaviour.
CREATE TABLE venue_features (
    venue_id   uuid NOT NULL REFERENCES venues (venue_id) ON DELETE CASCADE,
    feature    text NOT NULL CHECK (feature IN
                 ('announcements','offers','rooms','tables','booking','checkin')),
    enabled    boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (venue_id, feature)
);

ALTER TABLE venue_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY venue_features_read_all ON venue_features FOR SELECT USING (true);

GRANT SELECT ON venue_features TO presence_app;

-- ------------------------------------------------------------ FR-64 --------
CREATE TABLE profile_prompts (
    user_id    uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    slot       smallint NOT NULL CHECK (slot BETWEEN 1 AND 3),
    body       varchar(120) NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, slot)
);

ALTER TABLE profile_prompts ENABLE ROW LEVEL SECURITY;

-- Writes are owner-only. Reads are open to the app role: prompts are reason
-- material the edge attaches to surfaced scan candidates, and the only
-- exposure path is that curated endpoint (never a search, never an index).
CREATE POLICY prompts_owner_write ON profile_prompts
    FOR INSERT TO presence_app
    WITH CHECK (user_id = app_user());
CREATE POLICY prompts_owner_change ON profile_prompts
    FOR UPDATE TO presence_app
    USING (user_id = app_user())
    WITH CHECK (user_id = app_user());
CREATE POLICY prompts_owner_delete ON profile_prompts
    FOR DELETE TO presence_app
    USING (user_id = app_user());
CREATE POLICY prompts_read_all ON profile_prompts
    FOR SELECT TO presence_app
    USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_prompts TO presence_app;

COMMIT;

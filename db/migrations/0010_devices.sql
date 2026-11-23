-- Presence — device registry and attestation-key dedupe
-- (PRS-SRS-001 §4 account; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   FR-05   at most three concurrent devices per account, with an enrolment
--           notification to the account's other sessions
--   FR-07   duplicate-account detection on the attestation key: the same
--           key showing up under a second account is recorded silently and
--           surfaced to moderation — never to the enrolling client
--
-- The device cap mirrors the SEC-33 discipline: enforced by trigger under a
-- row lock, so racing enrolments cannot both win. The dedupe registry runs
-- through one SECURITY DEFINER function so detection, recording and audit
-- are atomic and the edge learns nothing it could leak.
--
-- Forward-only migration; run after 0009_rooms.sql.

BEGIN;

-- ------------------------------------------------------------ FR-05 --------
CREATE TABLE devices (
    device_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users (user_id),
    label          text,                       -- optional, screened at write
    key_fingerprint text NOT NULL,             -- sha256 of the device public key
    enrolled_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at     timestamptz
);
-- One active device per key fingerprint, platform-wide.
CREATE UNIQUE INDEX devices_active_fingerprint
    ON devices (key_fingerprint) WHERE revoked_at IS NULL;
CREATE INDEX devices_user_idx ON devices (user_id) WHERE revoked_at IS NULL;

-- FR-05: the fourth concurrent device is rejected under a row lock, the
-- same discipline as the group-table cap (SEC-33). A re-enrolment under a
-- fingerprint the account already holds live is a refresh (the partial
-- unique index turns it into an UPDATE), so it does not count against the
-- cap — otherwise a user at three devices could never refresh one.
CREATE OR REPLACE FUNCTION device_cap() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    n integer;
BEGIN
    PERFORM 1 FROM users WHERE user_id = NEW.user_id FOR UPDATE;
    SELECT count(*) INTO n FROM devices
     WHERE user_id = NEW.user_id AND revoked_at IS NULL
       AND key_fingerprint <> NEW.key_fingerprint;
    IF n >= 3 THEN
        RAISE EXCEPTION 'device limit reached (FR-05)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER device_cap
    BEFORE INSERT ON devices
    FOR EACH ROW EXECUTE FUNCTION device_cap();

-- ------------------------------------------------------------ FR-07 --------
-- The attestation-key registry. Clients never read it; the enrolment path
-- writes through register_attestation_key() only.
CREATE TABLE attestation_keys (
    key_hash     text PRIMARY KEY,             -- sha256 of the attestation key
    user_id      uuid NOT NULL REFERENCES users (user_id),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Every cross-account collision, kept for the moderation console.
CREATE TABLE attestation_duplicates (
    duplicate_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash      text NOT NULL,
    existing_user uuid NOT NULL REFERENCES users (user_id),
    incoming_user uuid NOT NULL REFERENCES users (user_id),
    detected_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attestation_duplicates_users_idx
    ON attestation_duplicates (existing_user, incoming_user);

-- One atomic enrol-or-detect step. Returns 'enrolled', 'refreshed' or
-- 'duplicate'; on a collision the key stays with its original account, the
-- collision is recorded and audited, and the caller gets the same neutral
-- response regardless — detection must not tip off the duplicate.
CREATE OR REPLACE FUNCTION register_attestation_key(p_key_hash text, p_user uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_existing uuid;
BEGIN
    SELECT user_id INTO v_existing
      FROM attestation_keys WHERE key_hash = p_key_hash FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO attestation_keys (key_hash, user_id) VALUES (p_key_hash, p_user);
        RETURN 'enrolled';
    END IF;
    IF v_existing = p_user THEN
        UPDATE attestation_keys SET last_seen_at = now() WHERE key_hash = p_key_hash;
        RETURN 'refreshed';
    END IF;
    INSERT INTO attestation_duplicates (key_hash, existing_user, incoming_user)
    VALUES (p_key_hash, v_existing, p_user);
    PERFORM admin_audit_log(
        NULL,                                   -- system actor
        'moderation.duplicate.detected',
        'impersonation',
        'user', p_user::text,
        jsonb_build_object('keyHashPrefix', left(p_key_hash, 8)),
        jsonb_build_object('existingUser', v_existing::text)
    );
    RETURN 'duplicate';
END $$;

-- ------------------------------------------------------------- RLS ---------
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE attestation_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE attestation_duplicates ENABLE ROW LEVEL SECURITY;

-- Devices: the owner manages their own list; nothing else.
CREATE POLICY devices_own_select ON devices
    FOR SELECT USING (user_id = app_user());
CREATE POLICY devices_own_insert ON devices
    FOR INSERT WITH CHECK (user_id = app_user());
CREATE POLICY devices_own_revoke ON devices
    FOR UPDATE USING (user_id = app_user()) WITH CHECK (user_id = app_user());
CREATE POLICY devices_moderation_select ON devices
    FOR SELECT USING (app_moderator());

-- The dedupe registry is console-only.
CREATE POLICY attestation_keys_moderation ON attestation_keys
    FOR SELECT USING (app_moderator());
CREATE POLICY attestation_duplicates_moderation ON attestation_duplicates
    FOR SELECT USING (app_moderator());

-- ------------------------------------------------------------- grants ------
GRANT SELECT, INSERT ON devices TO presence_app;
GRANT UPDATE (revoked_at, last_seen_at) ON devices TO presence_app;
GRANT SELECT ON attestation_keys TO presence_app;
GRANT SELECT ON attestation_duplicates TO presence_app;

REVOKE ALL ON FUNCTION register_attestation_key(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_attestation_key(text, uuid) TO presence_app;

COMMIT;

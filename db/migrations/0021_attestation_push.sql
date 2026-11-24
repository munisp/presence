-- Presence — attestation verification, documented fallback, push tokens
-- (PRS-SRS-001 §4 account, §4.9 notifications, §7.1 access control)
--
-- Requirement anchors:
--   FR-51   every new account must pass device attestation before it can
--           appear in another user's results — the verified key registry
--           and the attested_accounts discovery gate
--   SEC-19  attestation before discovery, with a documented fallback for
--           devices that cannot attest (moderator-approved, audited,
--           revocable waivers)
--   FR-56   the push pipeline's device-token registry (payload minimalism
--           is enforced in the edge, services/edge/src/push.ts)
--
-- Forward-only migration; run after 0020_venue_registry.sql.

BEGIN;

-- ------------------------------------------------- FR-51 / SEC-19 ----------
-- The attestation-key registry gains the cryptographic verification fields.
-- Legacy rows (pre-verification) keep verified_at NULL: they stay enrolled
-- devices, but the account is not discovery-eligible until it verifies.
ALTER TABLE attestation_keys
    ADD COLUMN platform text CHECK (platform IN ('app_attest', 'play_integrity')),
    ADD COLUMN public_key text,                  -- base64 SPKI (P-256)
    ADD COLUMN sign_count integer NOT NULL DEFAULT 0,
    ADD COLUMN verified_at timestamptz;

-- One atomic verified-enrol step: dedupe (FR-07 semantics), monotonic
-- counter (replay regression never honours the write) and the verified
-- stamp in a single function, so the edge learns nothing it could leak.
-- Returns 'enrolled' | 'refreshed' | 'duplicate' | 'counter_regressed'.
CREATE OR REPLACE FUNCTION register_verified_attestation(
    p_key_hash text, p_user uuid, p_platform text, p_public_key text, p_sign_count integer)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_existing uuid;
    v_count integer;
BEGIN
    IF p_platform NOT IN ('app_attest', 'play_integrity') THEN
        RAISE EXCEPTION 'unknown attestation platform';
    END IF;
    SELECT user_id, sign_count INTO v_existing, v_count
      FROM attestation_keys WHERE key_hash = p_key_hash FOR UPDATE;
    IF FOUND THEN
        IF v_existing <> p_user THEN
            -- FR-07: a key registered to another account is recorded and
            -- audited; the key never moves, and the caller sees the same
            -- neutral response as any other outcome.
            INSERT INTO attestation_duplicates (key_hash, existing_user, incoming_user)
            VALUES (p_key_hash, v_existing, p_user);
            PERFORM admin_audit_log(
                NULL,
                'moderation.duplicate.detected',
                'impersonation',
                'user', p_user::text,
                jsonb_build_object('keyHashPrefix', left(p_key_hash, 8)),
                jsonb_build_object('existingUser', v_existing::text)
            );
            RETURN 'duplicate';
        END IF;
        IF p_sign_count <= v_count THEN
            -- Replay of an earlier assertion: refused without touching the
            -- registry. The outcome is consumed server-side only.
            RETURN 'counter_regressed';
        END IF;
        UPDATE attestation_keys
           SET last_seen_at = now(),
               platform = p_platform,
               public_key = p_public_key,
               sign_count = p_sign_count,
               verified_at = now()
         WHERE key_hash = p_key_hash;
        RETURN 'refreshed';
    END IF;
    INSERT INTO attestation_keys
        (key_hash, user_id, platform, public_key, sign_count, verified_at)
    VALUES
        (p_key_hash, p_user, p_platform, p_public_key, p_sign_count, now());
    RETURN 'enrolled';
END $$;

-- SEC-19: the documented fallback. A device that genuinely cannot attest
-- (older hardware, broken secure enclave) is approved by a moderator after
-- manual review; the waiver is one-open-per-account, audited and revocable.
CREATE TABLE attestation_fallbacks (
    fallback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (user_id),
    reason_code text NOT NULL CHECK (reason_code IN ('device_cannot_attest')),
    approved_at timestamptz NOT NULL DEFAULT now(),
    approved_by text,
    revoked_at  timestamptz
);
CREATE UNIQUE INDEX attestation_fallbacks_one_open
    ON attestation_fallbacks (user_id) WHERE revoked_at IS NULL;

-- FR-51/SEC-19: the discovery gate consumed by the match service. Account
-- ids only — no key material, no hashes, nothing else leaves the OLTP side.
CREATE VIEW attested_accounts AS
    SELECT user_id FROM attestation_keys WHERE verified_at IS NOT NULL
    UNION
    SELECT user_id FROM attestation_fallbacks WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION approve_attestation_fallback(p_user uuid, p_actor text)
RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id uuid;
BEGIN
    IF NOT app_moderator() THEN
        RAISE EXCEPTION 'moderator role required';
    END IF;
    SELECT fallback_id INTO v_id FROM attestation_fallbacks
     WHERE user_id = p_user AND revoked_at IS NULL;
    IF FOUND THEN
        RETURN v_id;                          -- idempotent re-approval
    END IF;
    INSERT INTO attestation_fallbacks (user_id, reason_code, approved_by)
    VALUES (p_user, 'device_cannot_attest', p_actor)
    RETURNING fallback_id INTO v_id;
    PERFORM admin_audit_log(
        p_actor,
        'attestation.fallback.approved',
        'device_cannot_attest',
        'user', p_user::text,
        NULL,
        jsonb_build_object('fallbackId', v_id::text)
    );
    RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION revoke_attestation_fallback(p_user uuid, p_actor text)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id uuid;
BEGIN
    IF NOT app_moderator() THEN
        RAISE EXCEPTION 'moderator role required';
    END IF;
    UPDATE attestation_fallbacks SET revoked_at = now()
     WHERE user_id = p_user AND revoked_at IS NULL
    RETURNING fallback_id INTO v_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    PERFORM admin_audit_log(
        p_actor,
        'attestation.fallback.revoked',
        'device_cannot_attest',
        'user', p_user::text,
        jsonb_build_object('fallbackId', v_id::text),
        NULL
    );
    RETURN true;
END $$;

-- ------------------------------------------------------------- FR-56 -------
-- Push tokens: one current token per device, platform-tagged. The token is
-- an APNs/FCM delivery address — it never joins the match path.
CREATE TABLE device_push_tokens (
    device_id  uuid PRIMARY KEY REFERENCES devices (device_id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (user_id),
    platform   text NOT NULL CHECK (platform IN ('ios', 'android')),
    token      text NOT NULL UNIQUE,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_push_tokens_user_idx ON device_push_tokens (user_id);

-- The dispatch path reads through definers so the table itself can stay
-- owner-only under RLS — the same discipline as register_attestation_key.
CREATE OR REPLACE FUNCTION push_tokens_for(p_user uuid)
RETURNS TABLE(device_id uuid, platform text, token text)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT device_id, platform, token FROM device_push_tokens
     WHERE user_id = p_user;
$$;

-- A provider reports a token dead (APNs 410 / FCM UNREGISTERED): drop it.
CREATE OR REPLACE FUNCTION drop_push_token(p_token text)
RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    DELETE FROM device_push_tokens WHERE token = p_token;
$$;

-- ------------------------------------------------------------- RLS ---------
ALTER TABLE attestation_fallbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_push_tokens ENABLE ROW LEVEL SECURITY;

-- Waivers are console-visible only; writes go through the definers.
CREATE POLICY attestation_fallbacks_moderation ON attestation_fallbacks
    FOR SELECT USING (app_moderator());

-- Tokens are owner-managed; the dispatch path uses the definers above.
CREATE POLICY device_push_tokens_own ON device_push_tokens
    FOR ALL USING (user_id = app_user()) WITH CHECK (user_id = app_user());

-- ------------------------------------------------------------- grants ------
GRANT SELECT ON attested_accounts TO presence_match;
GRANT SELECT, INSERT, UPDATE, DELETE ON device_push_tokens TO presence_app;

REVOKE ALL ON FUNCTION register_verified_attestation(text, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_verified_attestation(text, uuid, text, text, integer) TO presence_app;
REVOKE ALL ON FUNCTION approve_attestation_fallback(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_attestation_fallback(uuid, text) TO presence_app;
REVOKE ALL ON FUNCTION revoke_attestation_fallback(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_attestation_fallback(uuid, text) TO presence_app;
REVOKE ALL ON FUNCTION push_tokens_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_tokens_for(uuid) TO presence_app;
REVOKE ALL ON FUNCTION drop_push_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION drop_push_token(text) TO presence_app;

COMMIT;

-- Presence — universal KYC gate + avatar identity layer
-- (SRS Addendum 001: AMD-KYC-01..05, AMD-AVT-01..04)
--
-- Requirement anchors:
--   AMD-KYC-01  discovery eligibility = attested device (FR-51) AND
--               kyc_state = 'verified' — the gate fails closed: every
--               account starts pending and leaves discovery until verified
--   AMD-KYC-02  data minimisation — the platform stores an opaque provider
--               reference, the state, the timestamp and the reviewing
--               actor; NEVER documents, legal names or dates of birth
--   AMD-KYC-03  legal transitions enforced by the database, mirroring the
--               FR-29 trigger discipline — endpoint logic cannot excuse an
--               illegal transition
--   AMD-KYC-04  inter-user privacy unchanged — KYC attributes join the
--               FR-30 boundary; the pair_avatar definer below is the ONLY
--               pre-OPEN identity read and it returns the avatar alone
--   AMD-AVT-01  the avatar is a non-photographic symbol from the curated
--               registry — a shaped key here, registry membership enforced
--               by the edge (services/edge/src/identity.ts) and mirrored
--               by the client (client/src/presence/identityAssurance.ts)
--
-- Forward-only migration; run after 0023_geofence_qa.sql.

BEGIN;

-- ------------------------------------------------- AMD-KYC-01/02 ----------
ALTER TABLE users
    ADD COLUMN kyc_state text NOT NULL DEFAULT 'pending'
        CHECK (kyc_state IN ('pending', 'verified', 'rejected', 'suspended')),
    ADD COLUMN kyc_verified_at timestamptz,
    ADD COLUMN kyc_provider_ref text,     -- opaque reference; never a document
    ADD COLUMN kyc_reviewed_by text;

-- ------------------------------------------------- AMD-KYC-03 -------------
-- One atomic decision step: legality enforced here, audited here, so the
-- edge route learns nothing it could leak. Returns
-- 'recorded' | 'illegal_transition' | 'forbidden' | 'unknown_user'.
CREATE OR REPLACE FUNCTION record_kyc_decision(
    p_user uuid, p_actor text, p_decision text, p_provider_ref text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_state text;
BEGIN
    -- Manual review (moderation console) or the provider callback route —
    -- nothing else may move a KYC state.
    IF NOT (app_moderator() OR current_setting('app.kyc_callback', true) = 'on') THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('verified', 'rejected', 'suspended', 'pending') THEN
        RETURN 'illegal_transition';
    END IF;
    SELECT kyc_state INTO v_state FROM users WHERE user_id = p_user FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_user';
    END IF;
    IF NOT (
        (v_state = 'pending'   AND p_decision IN ('verified', 'rejected')) OR
        (v_state = 'verified'  AND p_decision = 'suspended') OR
        (v_state = 'suspended' AND p_decision = 'verified') OR
        (v_state = 'rejected'  AND p_decision = 'pending')
    ) THEN
        RETURN 'illegal_transition';
    END IF;
    UPDATE users
       SET kyc_state = p_decision,
           kyc_verified_at = CASE WHEN p_decision = 'verified' THEN now()
                                  ELSE kyc_verified_at END,
           kyc_provider_ref = coalesce(p_provider_ref, kyc_provider_ref),
           kyc_reviewed_by = p_actor
     WHERE user_id = p_user;
    PERFORM admin_audit_log(
        NULL,
        'kyc.decision.' || p_decision,
        'kyc-review',
        'user', p_user::text,
        jsonb_build_object('from', v_state),
        jsonb_build_object('to', p_decision, 'actor', p_actor)
    );
    RETURN 'recorded';
END $$;

-- ------------------------------------------------- AMD-AVT-01 -------------
-- The avatar lives on the display identity so the existing FR-30 row
-- policies cover it; the pre-OPEN reveal is column-narrowed through the
-- pair_avatar definer below because RLS is row-level.
ALTER TABLE user_identities
    ADD COLUMN avatar_key text
        CHECK (avatar_key IS NULL OR avatar_key ~ '^[a-z][a-z0-9-]{2,39}$'),
    ADD COLUMN avatar_set_at timestamptz;

-- AMD-KYC-04 / AMD-AVT-02: the ONLY pre-OPEN identity read — the avatar
-- key of a counterpart in an active pair (NUDGED or later), or the
-- caller's own. Everything else about the row stays behind FR-30.
CREATE OR REPLACE FUNCTION pair_avatar(p_viewer uuid, p_counterpart uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_avatar text;
BEGIN
    IF p_viewer IS NULL OR p_counterpart IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_viewer <> p_counterpart AND NOT EXISTS (
        SELECT 1 FROM matches m
         WHERE m.state IN ('NUDGED', 'EXPRESSED', 'MUTUAL', 'OPEN')
           AND p_viewer IN (m.user_lo, m.user_hi)
           AND p_counterpart IN (m.user_lo, m.user_hi)
    ) THEN
        RETURN NULL;
    END IF;
    SELECT avatar_key INTO v_avatar
      FROM user_identities WHERE user_id = p_counterpart;
    RETURN v_avatar;
END $$;

-- ------------------------------------------------- AMD-KYC-01 gate --------
CREATE VIEW kyc_verified_accounts AS
    SELECT user_id FROM users WHERE kyc_state = 'verified';

-- The discovery gate the match service reads: attested (FR-51) AND
-- KYC-verified. attested_accounts itself is unchanged — attestation
-- remains a distinct property with its own fallback path (SEC-19).
CREATE VIEW discovery_eligible AS
    SELECT a.user_id
      FROM attested_accounts a
      JOIN kyc_verified_accounts k USING (user_id);

COMMIT;

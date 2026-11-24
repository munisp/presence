-- 0019 — reporting & compliance records
--
--   FR-40   reports anchor to the conversation: pair_id (the offer
--           identifier) and an optional message_id inside that pair
--   FR-49   reports carry a fixed category: harassment, impersonation,
--           under_age, commercial_solicitation, hate, other
--   NFR-22  reports and their moderation decisions are disposed of after
--           12 months — reports_retention_tick(), audited into
--           security_audit
--   SEC-30  security_audit: append-only security-event store, separate
--           from application logs, retained indefinitely (floor: 12
--           months), readable only through the moderator GUC
--   SEC-36  mock-location refusals are recorded server-side for abuse
--           review; there is no user-facing read path
--   SEC-13  data_processing_consents: purpose, scope, timestamp, policy
--           version, retrievable artefact; withdrawal is as easy as grant
--   BR-21   taxonomy_releases.provenance records the licence lineage at
--           publish (Wikidata-derived structure, CC0, attribution text)

-- ------------------------------------------------------- FR-49 category ---
-- The reporter picks from six fixed categories; free text stays in
-- reason/details as supporting narrative. 'other' is the backfill default
-- for rows that predate the category column.
ALTER TABLE reports
    ADD COLUMN category text NOT NULL DEFAULT 'other'
        CHECK (category IN ('harassment','impersonation','under_age',
                            'commercial_solicitation','hate','other'));

-- --------------------------------------------------------- FR-40 anchors --
-- The in-conversation report control anchors the report to the offer
-- identifier (the pair) and optionally to a specific message. Anchors are
-- evidence pointers, not ownership: when the message ciphertext is purged
-- (NFR-20) or the pair is erased the anchor detaches (SET NULL) and the
-- report itself survives until its own 12-month disposal (NFR-22).
ALTER TABLE reports
    ADD COLUMN pair_id    uuid REFERENCES matches (pair_id) ON DELETE SET NULL,
    ADD COLUMN message_id uuid REFERENCES messages (message_id) ON DELETE SET NULL;

-- Appeals reference the report they contest; disposing of the report must
-- not block on, or destroy, the appeal's own record.
ALTER TABLE appeals DROP CONSTRAINT appeals_report_id_fkey;
ALTER TABLE appeals
    ADD CONSTRAINT appeals_report_id_fkey
    FOREIGN KEY (report_id) REFERENCES reports (report_id) ON DELETE SET NULL;

-- --------------------------------------------------- SEC-30 audit store ---
-- Append-only, separate from application logs (which are scrubbed per
-- SEC-29 and rotated with the platform), kept indefinitely — the 12-month
-- floor is a minimum, not a schedule. kind is a governed vocabulary so the
-- abuse-review surface can filter without parsing free text; actor may be
-- NULL for system-origin events.
CREATE TABLE security_audit (
    event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    kind        text NOT NULL CHECK (kind IN (
                    'impossible_travel',
                    'missing_attestation',
                    'attestation_key_duplicate',
                    'mock_location_refusal',
                    'console_authorization_denied',
                    'retention.purge')),
    actor       uuid,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX security_audit_kind_time_idx ON security_audit (kind, occurred_at DESC);

CREATE OR REPLACE FUNCTION security_audit_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'security_audit is append-only (SEC-30)';
END $$;

CREATE TRIGGER security_audit_immutable
    BEFORE UPDATE OR DELETE ON security_audit
    FOR EACH ROW EXECUTE FUNCTION security_audit_immutable();

-- Internal writer: runs as owner so the row lands regardless of the
-- caller's grants; the trigger above still bars any later mutation. The
-- kind CHECK constraint rejects anything outside the vocabulary.
CREATE OR REPLACE FUNCTION record_security_event(
    p_kind   text,
    p_actor  uuid,
    p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO security_audit (kind, actor, detail)
    VALUES (p_kind, p_actor, COALESCE(p_detail, '{}'::jsonb))
    RETURNING event_id INTO v_id;
    RETURN v_id;
END $$;

ALTER TABLE security_audit ENABLE ROW LEVEL SECURITY;

-- Abuse review happens in the moderation console only. There is no user
-- read path: SEC-36 refusals must never be disclosed to other users, and
-- the reporter of a security signal learns nothing back.
CREATE POLICY security_audit_moderation_select ON security_audit
    FOR SELECT USING (app_moderator());

GRANT SELECT ON security_audit TO presence_app;
REVOKE ALL ON FUNCTION record_security_event(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_security_event(text, uuid, jsonb) TO presence_app;

-- ------------------------------------------------------ NFR-22 disposal ---
-- Reports (and the moderation decisions recorded on them: outcome,
-- resolved_by, resolved_at) are disposed of 12 months after filing. The
-- purge is itself a security-relevant event and lands in security_audit.
-- Separate from lifecycle_tick so the hot 60-second path is untouched.
CREATE OR REPLACE FUNCTION reports_retention_tick() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n integer;
BEGIN
    DELETE FROM reports WHERE created_at < now() - interval '12 months';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
        INSERT INTO security_audit (kind, actor, detail)
        VALUES ('retention.purge', NULL,
                jsonb_build_object('table', 'reports', 'deleted', n));
    END IF;
    RETURN n;
END $$;

REVOKE ALL ON FUNCTION reports_retention_tick() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reports_retention_tick() TO presence_app;

-- ------------------------------------------- SEC-13 data-processing consent
-- Distinct from the per-pair introduction consent ledger (FR-29/35): this
-- records the data-processing consents (analytics, marketing, …) with
-- purpose, scope, timestamp and policy version. The row IS the retrievable
-- artefact (surfaced by GET /v1/account/consents and the DSAR export).
-- Withdrawal sets withdrawn_at — symmetric with grant, one call, and the
-- grant artefact is never destroyed, only superseded. No DELETE policy:
-- rows leave only with the account (delete_account below).
CREATE TABLE data_processing_consents (
    user_id        uuid NOT NULL REFERENCES users (user_id),
    purpose        text NOT NULL CHECK (purpose ~ '^[a-z0-9_]{1,64}$'),
    scope          text NOT NULL,
    policy_version text NOT NULL,
    granted_at     timestamptz NOT NULL DEFAULT now(),
    withdrawn_at   timestamptz,
    PRIMARY KEY (user_id, purpose)
);

ALTER TABLE data_processing_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY consents_own_select ON data_processing_consents
    FOR SELECT USING (user_id = app_user());
CREATE POLICY consents_own_insert ON data_processing_consents
    FOR INSERT WITH CHECK (user_id = app_user());
CREATE POLICY consents_own_update ON data_processing_consents
    FOR UPDATE USING (user_id = app_user()) WITH CHECK (user_id = app_user());

GRANT SELECT, INSERT, UPDATE ON data_processing_consents TO presence_app;

-- FR-62/SEC-13: the consent artefacts join the DSAR export.
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
                        'reportId', r.report_id, 'category', r.category,
                        'reason', r.reason, 'details', r.details,
                        'createdAt', r.created_at, 'status', r.status) ORDER BY r.created_at)
                       FROM reports r WHERE r.reporter = uid), '[]'::jsonb),
        'dataProcessingConsents', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'purpose', d.purpose, 'scope', d.scope,
                        'policyVersion', d.policy_version, 'grantedAt', d.granted_at,
                        'withdrawnAt', d.withdrawn_at) ORDER BY d.purpose)
                       FROM data_processing_consents d WHERE d.user_id = uid), '[]'::jsonb)
    )
$$;

-- FR-03/04: account erasure now also disposes of the consent artefacts —
-- they are personal data like everything else.
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
    DELETE FROM data_processing_consents WHERE user_id = uid;

    UPDATE users
       SET deleted_at = now(), age_blocked = true
     WHERE user_id = uid AND deleted_at IS NULL;
END $$;

-- ------------------------------------------------------- BR-21 provenance --
-- Every published taxonomy release records its licence lineage: the
-- structure is Wikidata-derived under CC0, attribution text is retained in
-- the record, and no proprietary venue data is redistributed. Written by
-- the publish route (services/edge/src/routes/taxonomy.ts), never editable
-- afterwards — rolled-back releases keep the provenance they published
-- with.
ALTER TABLE taxonomy_releases ADD COLUMN provenance jsonb;

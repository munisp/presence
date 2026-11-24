-- 0020 — venue registry, venue self-serve suspension, profile identity
--
--   FR-42   the venue registry maps a venue to its geospatial cells (the
--           0017 cell_attribution projection), a partner status
--           (prospect/active/suspended/offboarded) and an operating
--           schedule
--   BR-14   a venue can suspend the service on its premises self-serve;
--           the suspension flips venues.active the moment it is recorded,
--           and the edge purges the venue's live presence — effective well
--           within one presence TTL (15 minutes)
--   FR-06   user_identities gains display_name (optional, defaults to the
--           handle at render time) and a one-line bio of at most 140
--           characters; both join the DSAR export

-- ------------------------------------------------------- FR-42 registry ---
-- partner_status is the governed lifecycle of the venue relationship.
-- 'prospect' venues are registered but not yet live; 'suspended' is the
-- BR-14 self-serve state; 'offboarded' is terminal (venue-ops only).
ALTER TABLE venues
    ADD COLUMN partner_status text NOT NULL DEFAULT 'active'
        CHECK (partner_status IN ('prospect','active','suspended','offboarded')),
    ADD COLUMN operating_schedule jsonb,
    ADD COLUMN suspended_at timestamptz;

-- Operating schedule shape (validated here, rendered client-side):
--   { "timezone": "Africa/Lagos",
--     "weekly": [ { "day": "mon", "open": "08:00", "close": "22:00" }, … ] }
-- Days are lowercase ISO abbreviations; times are 24-hour HH:MM. The check
-- keeps the document to that shape so the registry never drifts into
-- free-form text.
CREATE OR REPLACE FUNCTION operating_schedule_valid(s jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT s IS NULL OR (
        jsonb_typeof(s) = 'object'
        AND (NOT (s ? 'timezone') OR jsonb_typeof(s->'timezone') = 'string')
        AND jsonb_typeof(COALESCE(s->'weekly', '[]'::jsonb)) = 'array'
        AND NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(s->'weekly', '[]'::jsonb)) e
             WHERE jsonb_typeof(e) <> 'object'
                OR (e->>'day') IS NULL
                OR (e->>'day') !~ '^(mon|tue|wed|thu|fri|sat|sun)$'
                OR (e->>'open') IS NULL
                OR (e->>'open') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                OR (e->>'close') IS NULL
                OR (e->>'close') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        )
    )
$$;

ALTER TABLE venues
    ADD CONSTRAINT venues_operating_schedule_shape
        CHECK (operating_schedule_valid(operating_schedule));

-- active is derived, never set directly: a venue is live exactly when its
-- partner status is 'active'. The trigger keeps the legacy boolean that
-- scan/presence queries already filter on in sync with the registry.
CREATE OR REPLACE FUNCTION venues_sync_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.active := (NEW.partner_status = 'active');
    IF NEW.partner_status = 'suspended' AND OLD.partner_status IS DISTINCT FROM 'suspended' THEN
        NEW.suspended_at := now();
    ELSIF NEW.partner_status <> 'suspended' THEN
        NEW.suspended_at := NULL;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER venues_sync_active
    BEFORE INSERT OR UPDATE OF partner_status ON venues
    FOR EACH ROW EXECUTE FUNCTION venues_sync_active();

-- ------------------------------------------- BR-14 self-serve suspension --
-- venues grants to presence_app are SELECT-only, so every registry
-- mutation goes through a SECURITY DEFINER function that writes its own
-- admin_audit row (FR-60). The edge supplies the acting party: the venue
-- partner's account id for self-serve suspend/resume, the venue-ops
-- operator for offboard.
CREATE OR REPLACE FUNCTION venue_suspend(p_venue uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    prev venues%ROWTYPE;
BEGIN
    SELECT * INTO prev FROM venues WHERE venue_id = p_venue FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'venue not found' USING ERRCODE = 'P0002';
    END IF;
    IF prev.partner_status = 'offboarded' THEN
        RAISE EXCEPTION 'venue is offboarded' USING ERRCODE = 'P0001';
    END IF;
    UPDATE venues SET partner_status = 'suspended' WHERE venue_id = p_venue;
    PERFORM admin_audit_log(
        p_actor, 'venue.suspend', 'venue_request', 'venue', p_venue::text,
        jsonb_build_object('partnerStatus', prev.partner_status),
        jsonb_build_object('partnerStatus', 'suspended'));
    RETURN jsonb_build_object('venueId', p_venue, 'partnerStatus', 'suspended',
                              'suspendedAt', now());
END $$;

CREATE OR REPLACE FUNCTION venue_resume(p_venue uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    prev venues%ROWTYPE;
BEGIN
    SELECT * INTO prev FROM venues WHERE venue_id = p_venue FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'venue not found' USING ERRCODE = 'P0002';
    END IF;
    IF prev.partner_status <> 'suspended' THEN
        RAISE EXCEPTION 'venue is not suspended' USING ERRCODE = 'P0001';
    END IF;
    UPDATE venues SET partner_status = 'active' WHERE venue_id = p_venue;
    PERFORM admin_audit_log(
        p_actor, 'venue.resume', 'venue_request', 'venue', p_venue::text,
        jsonb_build_object('partnerStatus', 'suspended'),
        jsonb_build_object('partnerStatus', 'active'));
    RETURN jsonb_build_object('venueId', p_venue, 'partnerStatus', 'active');
END $$;

CREATE OR REPLACE FUNCTION venue_offboard(p_venue uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    prev venues%ROWTYPE;
BEGIN
    SELECT * INTO prev FROM venues WHERE venue_id = p_venue FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'venue not found' USING ERRCODE = 'P0002';
    END IF;
    IF prev.partner_status = 'offboarded' THEN
        RAISE EXCEPTION 'venue is already offboarded' USING ERRCODE = 'P0001';
    END IF;
    UPDATE venues SET partner_status = 'offboarded' WHERE venue_id = p_venue;
    PERFORM admin_audit_log(
        p_actor, 'venue.offboard', 'other_policy', 'venue', p_venue::text,
        jsonb_build_object('partnerStatus', prev.partner_status),
        jsonb_build_object('partnerStatus', 'offboarded'));
    RETURN jsonb_build_object('venueId', p_venue, 'partnerStatus', 'offboarded');
END $$;

CREATE OR REPLACE FUNCTION venue_set_schedule(p_venue uuid, p_actor uuid, p_schedule jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM 1 FROM venues WHERE venue_id = p_venue;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'venue not found' USING ERRCODE = 'P0002';
    END IF;
    UPDATE venues SET operating_schedule = p_schedule WHERE venue_id = p_venue;
    PERFORM admin_audit_log(
        p_actor, 'venue.schedule', 'venue_request', 'venue', p_venue::text,
        NULL, COALESCE(p_schedule, 'null'::jsonb));
    RETURN jsonb_build_object('venueId', p_venue, 'operatingSchedule', p_schedule);
END $$;

REVOKE ALL ON FUNCTION venue_suspend(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION venue_resume(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION venue_offboard(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION venue_set_schedule(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION venue_suspend(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION venue_resume(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION venue_offboard(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION venue_set_schedule(uuid, uuid, jsonb) TO presence_app;

-- ------------------------------------------------------- FR-06 identity ---
ALTER TABLE user_identities
    ADD COLUMN display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 80),
    ADD COLUMN bio varchar(140);

-- FR-06: the display name defaults to the handle when none is set; a
-- handle suspension still masks the whole identity (FR-55).
CREATE OR REPLACE FUNCTION display_handle(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT CASE WHEN EXISTS (SELECT 1 FROM suspensions
                              WHERE user_id = p_user
                                AND dimension = 'handle'
                                AND lifted_at IS NULL)
                THEN NULL
                ELSE (SELECT COALESCE(i.display_name, i.handle)
                        FROM user_identities i WHERE i.user_id = p_user)
           END
$$;

-- FR-06/FR-62: the identity block of the DSAR export carries the new
-- profile fields.
CREATE OR REPLACE FUNCTION dsar_export(uid uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT jsonb_build_object(
        'user', (SELECT jsonb_build_object(
                        'userId', u.user_id, 'createdAt', u.created_at,
                        'birthYear', u.birth_year, 'ageDeclaredAt', u.age_declared_at,
                        'invisible', u.invisible)
                   FROM users u WHERE u.user_id = uid),
        'identity', (SELECT jsonb_build_object(
                        'handle', i.handle, 'displayName', COALESCE(i.display_name, i.handle),
                        'bio', i.bio, 'photoUrl', i.photo_url, 'updatedAt', i.updated_at)
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

REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app;

-- Presence — just-in-time workforce elevation (PRS-SRS-001 §7.1 access control)
--
-- Requirement anchor:
--   SEC-03  workforce administrative access is just-in-time: an
--           elevation-eligible member requests a time-boxed grant, a
--           DIFFERENT moderator approves it (four-eyes), the grant expires
--           automatically inside the workforce realm's 4-hour session
--           ceiling, and every transition is audited. Role binding to
--           Keycloak is automated by the edge (services/edge/src/
--           keycloakAdmin.ts); this migration is the source of truth the
--           binding replays.
--
-- Forward-only migration; run after 0021_attestation_push.sql.

BEGIN;

-- Workforce identities live in the Keycloak workforce realm, NOT in the
-- consumer users table — the subject is a realm sub (uuid) with no FK, the
-- same discipline as admin_audit.actor.
CREATE TABLE elevation_requests (
    request_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject      uuid NOT NULL,                  -- workforce realm sub
    scope        text NOT NULL CHECK (scope IN ('moderation')),
    justification text NOT NULL CHECK (char_length(justification) BETWEEN 10 AND 500),
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'revoked', 'expired')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by   uuid,
    decided_at   timestamptz,
    expires_at   timestamptz,
    -- SEC-03 four-eyes, enforced in the storage layer as well as in the
    -- approve definer: no row may ever record the requester as its decider.
    CHECK (decided_by IS NULL OR decided_by <> subject),
    -- An approved row is complete: decider, decision time and expiry set.
    CHECK (status <> 'approved' OR (decided_by IS NOT NULL
                                    AND decided_at IS NOT NULL
                                    AND expires_at IS NOT NULL))
);

-- One open (pending or approved) request per subject and scope.
CREATE UNIQUE INDEX elevation_requests_one_open
    ON elevation_requests (subject, scope) WHERE status IN ('pending', 'approved');

-- The console queue: pending first, then most recent decisions.
CREATE INDEX elevation_requests_queue_idx
    ON elevation_requests (status, requested_at);

-- The requester: elevation-eligible per the workforce token (edge gate);
-- idempotent — retrying with an open request returns that request, the same
-- discipline as approve_attestation_fallback.
CREATE OR REPLACE FUNCTION request_elevation(
    p_subject uuid, p_scope text, p_justification text)
RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id uuid;
BEGIN
    SELECT request_id INTO v_id FROM elevation_requests
     WHERE subject = p_subject AND scope = p_scope
       AND status IN ('pending', 'approved');
    IF FOUND THEN
        RETURN v_id;                           -- idempotent re-request
    END IF;
    INSERT INTO elevation_requests (subject, scope, justification)
    VALUES (p_subject, p_scope, p_justification)
    RETURNING request_id INTO v_id;
    PERFORM admin_audit_log(
        p_subject::text,
        'elevation.requested',
        'jit_elevation',
        'workforce_subject', p_subject::text,
        NULL,
        jsonb_build_object('requestId', v_id::text, 'scope', p_scope)
    );
    RETURN v_id;
END $$;

-- The requester reads back their own requests (RLS keeps the table itself
-- console-only; this definer is the self-service read path).
CREATE OR REPLACE FUNCTION my_elevations(p_subject uuid)
RETURNS TABLE(request_id uuid, scope text, status text,
              requested_at timestamptz, decided_at timestamptz,
              expires_at timestamptz)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT request_id, scope, status, requested_at, decided_at, expires_at
      FROM elevation_requests
     WHERE subject = p_subject
     ORDER BY requested_at DESC;
$$;

-- SEC-03 four-eyes approval. The grant TTL is 4 hours — pinned to the
-- workforce realm's ssoSessionMaxLifespan (14400 s), so no elevation can
-- ever outlive the session ceiling the realm already enforces.
CREATE OR REPLACE FUNCTION approve_elevation(p_request uuid, p_actor uuid)
RETURNS TABLE(subject uuid, expires_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_subject uuid;
    v_status  text;
    v_expires timestamptz;
BEGIN
    IF NOT app_moderator() THEN
        RAISE EXCEPTION 'moderator role required';
    END IF;
    SELECT r.subject, r.status INTO v_subject, v_status
      FROM elevation_requests r
     WHERE r.request_id = p_request FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'elevation request not found';
    END IF;
    IF v_status <> 'pending' THEN
        RAISE EXCEPTION 'elevation request not pending';
    END IF;
    IF p_actor = v_subject THEN
        -- Four-eyes: the clean error mirrors the table CHECK so the console
        -- never has to surface a raw constraint violation.
        RAISE EXCEPTION 'four-eyes: approver must differ from requester';
    END IF;
    v_expires := now() + interval '4 hours';
    UPDATE elevation_requests
       SET status = 'approved', decided_by = p_actor, decided_at = now(),
           expires_at = v_expires
     WHERE request_id = p_request;
    PERFORM admin_audit_log(
        p_actor::text,
        'elevation.approved',
        'jit_elevation',
        'workforce_subject', v_subject::text,
        NULL,
        jsonb_build_object('requestId', p_request::text,
                           'expiresAt', v_expires::text)
    );
    RETURN QUERY SELECT v_subject, v_expires;
END $$;

CREATE OR REPLACE FUNCTION reject_elevation(p_request uuid, p_actor uuid)
RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_subject uuid;
    v_status  text;
BEGIN
    IF NOT app_moderator() THEN
        RAISE EXCEPTION 'moderator role required';
    END IF;
    SELECT r.subject, r.status INTO v_subject, v_status
      FROM elevation_requests r
     WHERE r.request_id = p_request FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'elevation request not found';
    END IF;
    IF v_status <> 'pending' THEN
        RAISE EXCEPTION 'elevation request not pending';
    END IF;
    UPDATE elevation_requests
       SET status = 'rejected', decided_by = p_actor, decided_at = now()
     WHERE request_id = p_request;
    PERFORM admin_audit_log(
        p_actor::text,
        'elevation.rejected',
        'jit_elevation',
        'workforce_subject', v_subject::text,
        NULL,
        jsonb_build_object('requestId', p_request::text)
    );
    RETURN v_subject;
END $$;

-- Early termination of a live grant (compromise suspicion, task finished).
CREATE OR REPLACE FUNCTION revoke_elevation(p_request uuid, p_actor uuid)
RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_subject uuid;
    v_status  text;
BEGIN
    IF NOT app_moderator() THEN
        RAISE EXCEPTION 'moderator role required';
    END IF;
    SELECT r.subject, r.status INTO v_subject, v_status
      FROM elevation_requests r
     WHERE r.request_id = p_request FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'elevation request not found';
    END IF;
    IF v_status <> 'approved' THEN
        RAISE EXCEPTION 'elevation grant not active';
    END IF;
    UPDATE elevation_requests
       SET status = 'revoked', decided_at = now()
     WHERE request_id = p_request;
    PERFORM admin_audit_log(
        p_actor::text,
        'elevation.revoked',
        'jit_elevation',
        'workforce_subject', v_subject::text,
        jsonb_build_object('expiresAt', now()::text),
        jsonb_build_object('requestId', p_request::text)
    );
    RETURN v_subject;
END $$;

-- The 60-second lifecycle tick drives this (services/edge/src/lifecycle.ts)
-- alongside reports_retention_tick. Approved grants past their expiry flip
-- to 'expired'; their subjects are RETURNED so the edge can unbind the
-- Keycloak realm role — the same separation as the disposal audit in
-- reports_retention_tick. Stale pending requests (nobody picked them up
-- within 24 hours) lapse too, keeping the queue honest.
CREATE OR REPLACE FUNCTION expire_elevations()
RETURNS TABLE(subject uuid, request_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r RECORD;
BEGIN
    -- CTE form: FOR-IN over DML+RETURNING directly is not valid plpgsql.
    FOR r IN
        WITH expired AS (
            UPDATE elevation_requests
               SET status = 'expired'
             WHERE status = 'approved' AND expires_at < now()
            RETURNING elevation_requests.subject, elevation_requests.request_id
        )
        SELECT expired.subject, expired.request_id FROM expired
    LOOP
        PERFORM admin_audit_log(
            NULL,
            'elevation.expired',
            'jit_elevation',
            'workforce_subject', r.subject::text,
            NULL,
            jsonb_build_object('requestId', r.request_id::text)
        );
        subject := r.subject;
        request_id := r.request_id;
        RETURN NEXT;
    END LOOP;

    UPDATE elevation_requests
       SET status = 'expired'
     WHERE status = 'pending'
       AND requested_at < now() - interval '24 hours';
END $$;

-- ------------------------------------------------------------- RLS ---------
ALTER TABLE elevation_requests ENABLE ROW LEVEL SECURITY;

-- Console-visible only; every write goes through the definers above, and
-- the requester's self-service read is my_elevations().
CREATE POLICY elevation_requests_moderation ON elevation_requests
    FOR SELECT USING (app_moderator());

-- ------------------------------------------------------------- grants ------
GRANT SELECT ON elevation_requests TO presence_app;

REVOKE ALL ON FUNCTION request_elevation(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_elevation(uuid, text, text) TO presence_app;
REVOKE ALL ON FUNCTION my_elevations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_elevations(uuid) TO presence_app;
REVOKE ALL ON FUNCTION approve_elevation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_elevation(uuid, uuid) TO presence_app;
REVOKE ALL ON FUNCTION reject_elevation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reject_elevation(uuid, uuid) TO presence_app;
REVOKE ALL ON FUNCTION revoke_elevation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_elevation(uuid, uuid) TO presence_app;
REVOKE ALL ON FUNCTION expire_elevations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_elevations() TO presence_app;

COMMIT;

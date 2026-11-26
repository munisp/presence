-- presence — migration 0034: vertical feature flags (batch 59, SRS
-- Addendum 001 AMD-VERT-01..05).
--
-- The platform ships several product verticals over one proximity core.
-- Until now every vertical was compiled in for every user: venue surfaces,
-- group stakes, dating mode, marketplace, wallets, trust instruments,
-- introductions and serendipity windows all answered for every account.
-- This migration makes the verticals a governed, per-user choice presented
-- during onboarding (and changeable later from settings) as feature flags.
--
-- AMD-VERT-01  vertical catalogue: the governed list of every vertical the
--              platform supports. `discovery` (presence publish, scan,
--              consent, matching) is the locked core — the platform does
--              not exist without it, so it carries locked=true and can
--              never be narrowed. Each row records whether the vertical
--              gates on KYC and/or adult status (mirroring the proof the
--              feature definers already demand: wallets/transfers,
--              escrows, bonds, stakes, marketplace and introductions all
--              prove kyc_state='verified'; dating and disclosure claims
--              additionally prove 18+). Eligibility here is advisory for
--              onboarding; the definers remain the authoritative gate.
-- AMD-VERT-02  per-user flags: one row per (user, vertical) explicit
--              choice. No row means the catalogue default (on) — every
--              existing account keeps exactly today's behaviour with zero
--              rows written. A row can only narrow (or re-affirm); the
--              model can never widen a vertical past its catalogue gates.
--              Writes happen exclusively through the definer below — the
--              app role holds SELECT only.
-- AMD-VERT-03  vertical_enabled(text): the single resolver the edge gate
--              calls. Locked core always true; an explicit row wins; else
--              the catalogue default. Unknown verticals fail closed.
-- AMD-VERT-04  list_my_verticals(): the onboarding/settings read model —
--              the full catalogue with the caller's effective state,
--              eligibility and reason, ordered for display.
-- AMD-VERT-05  set_user_verticals(jsonb, text): the batch write behind the
--              onboarding toggle screen and the settings screen. The whole
--              patch is validated before any row moves (all-or-nothing):
--              unknown keys and non-boolean values refuse the batch, the
--              locked core refuses narrowing, and enabling a gated
--              vertical re-proves KYC/adult eligibility at write time —
--              the same re-proof philosophy as AMD-DATE-05 resume.
--              Disabling never requires eligibility: narrowing is always
--              safe. Every choice records its source
--              ('onboarding' | 'settings' | 'ops').

BEGIN;

-- ------------------------------------------------------------ AMD-VERT-01 --

CREATE TABLE vertical_catalogue (
    vertical        text PRIMARY KEY CHECK (vertical ~ '^[a-z][a-z_]{1,23}$'),
    label           text NOT NULL,
    summary         text NOT NULL,
    locked          boolean NOT NULL DEFAULT false,
    requires_kyc    boolean NOT NULL DEFAULT false,
    requires_adult  boolean NOT NULL DEFAULT false,
    default_enabled boolean NOT NULL DEFAULT true,
    sort_order      smallint NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO vertical_catalogue
    (vertical, label, summary, locked, requires_kyc, requires_adult,
     default_enabled, sort_order)
VALUES
    ('discovery', 'Discovery',
     'The proximity core: publish presence, scan, consent and matching. '
     || 'Always on — the platform does not exist without it.',
     true, false, false, true, 0),
    ('venues', 'Venues',
     'Venue social surfaces: rooms, tables, booking slots, announcements '
     || 'and check-in.',
     false, false, false, true, 10),
    ('groups', 'Groups',
     'Group tables and seat stakes — commit to a shared table with a '
     || 'refundable stake.',
     false, true, false, true, 20),
    ('dating', 'Dating',
     'Dating mode: opt-in structured profile, preference-intersection '
     || 'scanning and governed counterpart reveal.',
     false, true, true, true, 30),
    ('marketplace', 'Marketplace',
     'Structured listings and escrow-backed purchases between members.',
     false, true, false, true, 40),
    ('payments', 'Payments',
     'Wallets and person-to-person transfers.',
     false, true, false, true, 50),
    ('trust', 'Trust',
     'Trust instruments: presence bonds, verified-met receipts, trust '
     || 'escrows, selective disclosure and verification attestations.',
     false, true, false, true, 60),
    ('introductions', 'Introductions',
     'Host-mediated introductions between members who both accept.',
     false, true, false, true, 70),
    ('serendipity', 'Serendipity',
     'Serendipity windows: time-boxed openness to unplanned meets.',
     false, false, false, true, 80);

ALTER TABLE vertical_catalogue ENABLE ROW LEVEL SECURITY;
CREATE POLICY vertical_catalogue_read_all ON vertical_catalogue
    FOR SELECT USING (true);

-- ------------------------------------------------------------ AMD-VERT-02 --

CREATE TABLE user_vertical_flags (
    user_id    uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    vertical   text NOT NULL REFERENCES vertical_catalogue (vertical)
               ON DELETE CASCADE,
    enabled    boolean NOT NULL,
    source     text NOT NULL CHECK (source IN ('onboarding', 'settings', 'ops')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, vertical)
);

ALTER TABLE user_vertical_flags ENABLE ROW LEVEL SECURITY;
-- Owner read only; writes go exclusively through set_user_verticals.
CREATE POLICY user_vertical_flags_owner_read ON user_vertical_flags
    FOR SELECT TO presence_app
    USING (user_id = app_user());

-- ------------------------------------------------------------ AMD-VERT-03 --

-- The single resolver. Outcomes are a bare boolean: locked core always
-- true, explicit row wins, else the catalogue default; unknown verticals
-- and a missing caller fail closed.
CREATE OR REPLACE FUNCTION vertical_enabled(p_vertical text)
RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_cat  vertical_catalogue%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN false;
    END IF;
    SELECT * INTO v_cat
      FROM vertical_catalogue c WHERE c.vertical = p_vertical;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF v_cat.locked THEN
        RETURN true;
    END IF;
    RETURN COALESCE(
        (SELECT f.enabled FROM user_vertical_flags f
          WHERE f.user_id = v_user AND f.vertical = p_vertical),
        v_cat.default_enabled);
END $$;

-- ------------------------------------------------------------ AMD-VERT-04 --

-- The onboarding/settings read model. One row per catalogue entry with the
-- caller's effective state. `eligible` reflects the catalogue gates against
-- the caller's CURRENT kyc/age posture, with `reason` naming the blocker;
-- `explicit_choice` says whether the caller holds a row of their own.
CREATE OR REPLACE FUNCTION list_my_verticals()
RETURNS TABLE (
    vertical         text,
    label            text,
    summary          text,
    locked           boolean,
    eligible         boolean,
    reason           text,
    enabled          boolean,
    explicit_choice  boolean,
    source           text,
    sort_order       smallint
)
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user  uuid := app_user();
    v_kyc   boolean := false;
    v_adult boolean := false;
BEGIN
    IF v_user IS NULL THEN
        RETURN;  -- the edge refuses unauthenticated calls before this runs
    END IF;
    SELECT u.kyc_state = 'verified',
           u.birth_year IS NOT NULL
             AND u.birth_year <= extract(year FROM now())::int - 18
      INTO v_kyc, v_adult
      FROM users u WHERE u.user_id = v_user;
    v_kyc   := COALESCE(v_kyc, false);
    v_adult := COALESCE(v_adult, false);
    RETURN QUERY
    SELECT c.vertical, c.label, c.summary, c.locked,
           ((NOT c.requires_kyc OR v_kyc)
              AND (NOT c.requires_adult OR v_adult)) AS eligible,
           CASE
               WHEN c.requires_kyc AND NOT v_kyc THEN 'kyc_required'
               WHEN c.requires_adult AND NOT v_adult THEN 'underage'
               ELSE NULL
           END AS reason,
           (c.locked OR COALESCE(f.enabled, c.default_enabled)) AS enabled,
           (f.user_id IS NOT NULL) AS explicit_choice,
           f.source,
           c.sort_order
      FROM vertical_catalogue c
      LEFT JOIN user_vertical_flags f
        ON f.vertical = c.vertical AND f.user_id = v_user
     ORDER BY c.sort_order;
END $$;

-- ------------------------------------------------------------ AMD-VERT-05 --

-- Batch write behind the onboarding toggles and the settings screen.
-- p_patch is a flat object {vertical: boolean, ...}; p_source records where
-- the choice was made. The whole patch validates before any row moves.
-- Outcomes: 'updated' | 'forbidden' | 'invalid_patch' | 'unknown_vertical'
-- | 'locked' | 'kyc_required' | 'underage'.
CREATE OR REPLACE FUNCTION set_user_verticals(p_patch jsonb, p_source text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user    uuid := app_user();
    v_key     text;
    v_enabled boolean;
    v_cat     vertical_catalogue%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object'
       OR p_patch = '{}'::jsonb
       OR p_source IS NULL
       OR p_source NOT IN ('onboarding', 'settings', 'ops') THEN
        RETURN 'invalid_patch';
    END IF;
    -- Validate the entire patch before writing anything (all-or-nothing).
    FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
        IF NOT EXISTS (SELECT 1 FROM vertical_catalogue c
                        WHERE c.vertical = v_key) THEN
            RETURN 'unknown_vertical';
        END IF;
        IF jsonb_typeof(p_patch -> v_key) IS DISTINCT FROM 'boolean' THEN
            RETURN 'invalid_patch';
        END IF;
    END LOOP;
    FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
        v_enabled := (p_patch ->> v_key)::boolean;
        SELECT * INTO v_cat
          FROM vertical_catalogue c WHERE c.vertical = v_key;
        IF v_cat.locked AND NOT v_enabled THEN
            RETURN 'locked';
        END IF;
        IF v_enabled THEN
            -- Enabling re-proves the catalogue gates at write time; the
            -- feature definers re-prove again at use (AMD-DATE-05 shape).
            IF v_cat.requires_kyc AND NOT EXISTS (
                SELECT 1 FROM users u
                 WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
                RETURN 'kyc_required';
            END IF;
            IF v_cat.requires_adult AND NOT EXISTS (
                SELECT 1 FROM users u
                 WHERE u.user_id = v_user AND u.birth_year IS NOT NULL
                   AND u.birth_year <= extract(year FROM now())::int - 18) THEN
                RETURN 'underage';
            END IF;
        END IF;
        INSERT INTO user_vertical_flags (user_id, vertical, enabled, source)
        VALUES (v_user, v_key, v_enabled, p_source)
        ON CONFLICT (user_id, vertical) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               source = EXCLUDED.source,
               updated_at = now();
    END LOOP;
    RETURN 'updated';
END $$;

-- Reads for the app role; flag writes only through the definer above.
GRANT SELECT ON vertical_catalogue, user_vertical_flags TO presence_app;
GRANT EXECUTE ON FUNCTION vertical_enabled(text) TO presence_app;
GRANT EXECUTE ON FUNCTION list_my_verticals() TO presence_app;
GRANT EXECUTE ON FUNCTION set_user_verticals(jsonb, text) TO presence_app;

COMMIT;

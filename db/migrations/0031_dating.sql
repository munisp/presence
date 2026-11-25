-- presence — migration 0031: dating mode (batch 57, SRS Addendum 001
-- AMD-DATE-01..05).
--
-- AMD-DATE-01  opt-in dating mode: a dating profile is a structured,
--              enumerated attribute set — gender, seeking, goal, age
--              range — and nothing else. FR-87 (no photos) and FR-96/SEC-37
--              (no free text) are unchanged: the schema has no column that
--              could hold either. Differentiation is verified identity
--              (AMD-KYC-01) and the avatar layer (AMD-AVT), not photos.
-- AMD-DATE-02  governed vocabularies: gender and goal come from pinned,
--              database-seeded vocabularies the application role can read
--              but never write. Loosening a vocabulary requires a
--              migration, exactly like the AMD-AVT-01 avatar registry.
-- AMD-DATE-03  preference-intersection discovery filter: when the caller's
--              dating mode is active, scan candidates are intersected with
--              mutual compatibility — both profiles active, both parties
--              KYC-verified adults, mutual seeking, mutual age range, same
--              goal, no block in either direction. The filter narrows; it
--              never widens discovery, and the FR-51/AMD-KYC-01 gate still
--              applies first. A caller without an active dating profile is
--              unaffected: the filter is inert.
-- AMD-DATE-04  privacy: a counterpart's dating attributes are revealed
--              only when the pair is mutually compatible AND the pair
--              stands at NUDGED or later — the FR-30/pair_avatar discipline
--              extended to dating attributes. Birth years never leave the
--              database: age compatibility is computed server-side and the
--              reveal carries ranges, never years. The FR-29 consent
--              machine is unchanged — dating mode changes who may be
--              surfaced, never how consent walks.
-- AMD-DATE-05  lifecycle: profiles pause and resume; reactivation
--              re-proves KYC and age because both can move while paused.
--              Rows are never deleted by the application role — the guard
--              raises; account-deletion tooling runs as the owner role.
--
-- Every definer repeats its gates; reads are RLS-governed and every write
-- flows through the definers below.
--
-- Forward-only migration; run after 0030_innovations.sql.

BEGIN;

-- ============================================================ AMD-DATE-02 ==
-- Governed vocabularies. Seeds are the whole vocabulary; the application
-- role holds SELECT only, so a vocabulary change is a migration.

CREATE TABLE dating_genders (
    gender text PRIMARY KEY CHECK (gender ~ '^[a-z][a-z_]{1,23}$')
);
INSERT INTO dating_genders (gender) VALUES ('female'), ('male'), ('nonbinary');

CREATE TABLE dating_goals (
    goal text PRIMARY KEY CHECK (goal ~ '^[a-z][a-z_]{1,23}$')
);
INSERT INTO dating_goals (goal)
VALUES ('long_term'), ('short_term'), ('friendship'), ('exploring');

-- ============================================================ AMD-DATE-01 ==
-- The dating profile. No photo, no free text, no birth date — there is no
-- column that could hold one. Age preference is a range over the declared
-- birth YEAR (FR-02), never the year itself.

CREATE TABLE dating_profiles (
    user_id    uuid PRIMARY KEY REFERENCES users (user_id),
    gender     text NOT NULL REFERENCES dating_genders (gender),
    seeking    text[] NOT NULL CHECK (cardinality(seeking) BETWEEN 1 AND 3),
    goal     text NOT NULL REFERENCES dating_goals (goal),
    age_min    smallint NOT NULL CHECK (age_min BETWEEN 18 AND 99),
    age_max    smallint NOT NULL CHECK (age_max BETWEEN 18 AND 99),
    state      text NOT NULL DEFAULT 'active'
               CHECK (state IN ('active', 'paused')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (age_max >= age_min)
);

-- Terms: the identity columns are immutable; seeking must stay inside the
-- governed vocabulary however the row arrived (definers are the only
-- writers — this is defence in depth); the application role can never
-- delete (account-deletion tooling runs as the owner role).
CREATE OR REPLACE FUNCTION dating_profiles_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_user = 'presence_app' THEN
            RAISE EXCEPTION 'dating_profiles is append-only for the application role (AMD-DATE-05)';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE'
       AND (NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at) THEN
        RAISE EXCEPTION 'dating profile identity is immutable (AMD-DATE-01)';
    END IF;
    IF NOT (NEW.seeking <@ ARRAY(SELECT gender FROM dating_genders)) THEN
        RAISE EXCEPTION 'seeking must stay inside the governed vocabulary (AMD-DATE-02)';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER dating_profiles_guard
    BEFORE INSERT OR UPDATE OR DELETE ON dating_profiles
    FOR EACH ROW EXECUTE FUNCTION dating_profiles_guard();

ALTER TABLE dating_profiles ENABLE ROW LEVEL SECURITY;
-- Owner read only. A counterpart's attributes are revealed column-narrowed
-- through dating_counterpart below — there is no browse of dating
-- profiles, exactly as there is no browse of users.
CREATE POLICY dating_profiles_owner_read ON dating_profiles
    FOR SELECT USING (user_id = app_user());

-- Set or refresh the caller's preferences. Gates are proved at write:
-- KYC-verified (AMD-KYC-01) and adult from the declared birth year
-- (SEC-17/BR-03). Vocabulary, dedup and range validation happen here and
-- are re-pinned by the guard.
-- Outcomes: 'recorded' | 'forbidden' | 'kyc_required' | 'underage'
-- | 'invalid_preferences'.
CREATE OR REPLACE FUNCTION set_dating_preferences(
    p_gender text, p_seeking text[], p_goal text,
    p_age_min smallint, p_age_max smallint)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
        RETURN 'kyc_required';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.birth_year IS NOT NULL
                      AND u.birth_year <= extract(year FROM now())::int - 18) THEN
        RETURN 'underage';
    END IF;
    IF p_gender IS NULL
       OR NOT EXISTS (SELECT 1 FROM dating_genders g WHERE g.gender = p_gender)
       OR p_goal IS NULL
       OR NOT EXISTS (SELECT 1 FROM dating_goals i WHERE i.goal = p_goal)
       OR p_seeking IS NULL
       OR cardinality(p_seeking) NOT BETWEEN 1 AND 3
       OR cardinality(p_seeking) <> (SELECT count(DISTINCT s) FROM unnest(p_seeking) s)
       OR EXISTS (SELECT 1 FROM unnest(p_seeking) s
                   WHERE NOT EXISTS (SELECT 1 FROM dating_genders g WHERE g.gender = s))
       OR p_age_min IS NULL OR p_age_max IS NULL
       OR p_age_min NOT BETWEEN 18 AND 99
       OR p_age_max NOT BETWEEN 18 AND 99
       OR p_age_max < p_age_min THEN
        RETURN 'invalid_preferences';
    END IF;
    INSERT INTO dating_profiles (user_id, gender, seeking, goal, age_min, age_max)
    VALUES (v_user, p_gender, p_seeking, p_goal, p_age_min, p_age_max)
    ON CONFLICT (user_id) DO UPDATE
       SET gender = EXCLUDED.gender,
           seeking = EXCLUDED.seeking,
           goal = EXCLUDED.goal,
           age_min = EXCLUDED.age_min,
           age_max = EXCLUDED.age_max,
           updated_at = now();
    RETURN 'recorded';
END $$;

-- Pause or resume. AMD-DATE-05: resuming re-proves both gates — a KYC
-- suspension or an age re-verification block can land while paused.
-- Outcomes: 'updated' | 'forbidden' | 'unknown_profile' | 'invalid_state'
-- | 'kyc_required' | 'underage'.
CREATE OR REPLACE FUNCTION set_dating_state(p_state text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    IF p_state NOT IN ('active', 'paused') THEN
        RETURN 'invalid_state';
    END IF;
    IF p_state = 'active' THEN
        IF NOT EXISTS (SELECT 1 FROM users u
                        WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
            RETURN 'kyc_required';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM users u
                        WHERE u.user_id = v_user AND u.birth_year IS NOT NULL
                          AND u.birth_year <= extract(year FROM now())::int - 18) THEN
            RETURN 'underage';
        END IF;
    END IF;
    UPDATE dating_profiles
       SET state = p_state, updated_at = now()
     WHERE user_id = v_user;
    IF NOT FOUND THEN
        RETURN 'unknown_profile';
    END IF;
    RETURN 'updated';
END $$;

-- AMD-DATE-03: is the caller mutually compatible with this peer, right
-- now? Both profiles active, both parties still KYC-verified adults
-- (states can move after the write), mutual seeking, mutual age range,
-- same goal, no block in either direction (FR-34 silence preserved —
-- the answer is the same boolean whatever the cause).
CREATE OR REPLACE FUNCTION dating_compatible(p_peer uuid)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user     uuid := app_user();
    v_me       dating_profiles%ROWTYPE;
    v_peer     dating_profiles%ROWTYPE;
    v_my_age   integer;
    v_peer_age integer;
BEGIN
    IF v_user IS NULL OR p_peer IS NULL OR p_peer = v_user THEN
        RETURN false;
    END IF;
    SELECT * INTO v_me FROM dating_profiles d
     WHERE d.user_id = v_user AND d.state = 'active';
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    SELECT * INTO v_peer FROM dating_profiles d
     WHERE d.user_id = p_peer AND d.state = 'active';
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM blocks b
                WHERE (b.blocker = v_user AND b.blocked = p_peer)
                   OR (b.blocker = p_peer AND b.blocked = v_user)) THEN
        RETURN false;
    END IF;
    SELECT extract(year FROM now())::int - u.birth_year INTO v_my_age
      FROM users u
     WHERE u.user_id = v_user AND u.kyc_state = 'verified'
       AND u.birth_year IS NOT NULL;
    IF v_my_age IS NULL OR v_my_age < 18 THEN
        RETURN false;
    END IF;
    SELECT extract(year FROM now())::int - u.birth_year INTO v_peer_age
      FROM users u
     WHERE u.user_id = p_peer AND u.kyc_state = 'verified'
       AND u.birth_year IS NOT NULL;
    IF v_peer_age IS NULL OR v_peer_age < 18 THEN
        RETURN false;
    END IF;
    RETURN v_me.gender = ANY(v_peer.seeking)
       AND v_peer.gender = ANY(v_me.seeking)
       AND v_me.goal = v_peer.goal
       AND v_my_age BETWEEN v_peer.age_min AND v_peer.age_max
       AND v_peer_age BETWEEN v_me.age_min AND v_me.age_max;
END $$;

-- AMD-DATE-04: the ONLY cross-user read of dating attributes. The pair
-- must stand at NUDGED or later (the pair_avatar discipline) AND be
-- mutually compatible. Returns gender, seeking, goal and the age range —
-- never a birth year, never an account attribute beyond the profile.
CREATE OR REPLACE FUNCTION dating_counterpart(p_peer uuid)
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_out  jsonb;
BEGIN
    IF v_user IS NULL OR p_peer IS NULL OR p_peer = v_user THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM matches m
                    WHERE m.state IN ('NUDGED', 'EXPRESSED', 'MUTUAL', 'OPEN')
                      AND v_user IN (m.user_lo, m.user_hi)
                      AND p_peer IN (m.user_lo, m.user_hi)) THEN
        RETURN NULL;
    END IF;
    IF NOT dating_compatible(p_peer) THEN
        RETURN NULL;
    END IF;
    SELECT jsonb_build_object(
               'gender', d.gender,
               'seeking', d.seeking,
               'goal', d.goal,
               'ageMin', d.age_min,
               'ageMax', d.age_max)
      INTO v_out
      FROM dating_profiles d
     WHERE d.user_id = p_peer;
    RETURN v_out;
END $$;

-- AMD-DATE-03: the scan-pipeline filter. Called with the matcher's
-- candidate account ids before any pair is surfaced. Dating mode off (no
-- active profile): the filter is inert and every candidate passes. Dating
-- mode on: only mutually compatible peers survive. Fail-closed: no caller
-- context, no candidates.
CREATE OR REPLACE FUNCTION dating_filter_candidates(p_peers uuid[])
RETURNS TABLE(peer uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_me   dating_profiles%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN;
    END IF;
    SELECT * INTO v_me FROM dating_profiles d
     WHERE d.user_id = v_user AND d.state = 'active';
    IF NOT FOUND THEN
        RETURN QUERY SELECT unnest(p_peers);
        RETURN;
    END IF;
    RETURN QUERY
    SELECT d.user_id
      FROM dating_profiles d
      JOIN users u ON u.user_id = d.user_id
      JOIN users me ON me.user_id = v_user
     WHERE d.user_id = ANY(p_peers)
       AND d.state = 'active'
       AND d.user_id <> v_user
       AND u.kyc_state = 'verified'
       AND u.birth_year IS NOT NULL
       AND u.birth_year <= extract(year FROM now())::int - 18
       AND me.kyc_state = 'verified'
       AND me.birth_year IS NOT NULL
       AND me.birth_year <= extract(year FROM now())::int - 18
       AND d.gender = ANY(v_me.seeking)
       AND v_me.gender = ANY(d.seeking)
       AND d.goal = v_me.goal
       AND (extract(year FROM now())::int - u.birth_year)
             BETWEEN v_me.age_min AND v_me.age_max
       AND (extract(year FROM now())::int - me.birth_year)
             BETWEEN d.age_min AND d.age_max
       AND NOT EXISTS (SELECT 1 FROM blocks b
                        WHERE (b.blocker = v_user AND b.blocked = d.user_id)
                           OR (b.blocker = d.user_id AND b.blocked = v_user));
END $$;

-- ------------------------------------------------------------ grants ------
-- Reads are RLS-governed; every write flows through the definers above.
GRANT SELECT ON dating_genders, dating_goals, dating_profiles TO presence_app;
GRANT EXECUTE ON FUNCTION set_dating_preferences(text, text[], text, smallint, smallint) TO presence_app;
GRANT EXECUTE ON FUNCTION set_dating_state(text) TO presence_app;
GRANT EXECUTE ON FUNCTION dating_compatible(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION dating_counterpart(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION dating_filter_candidates(uuid[]) TO presence_app;

COMMIT;

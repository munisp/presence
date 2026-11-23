-- Presence — product telemetry events
-- (PRS-SRS-001 §2.5 product metrics; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   NFR-32   the four §2.5 product metrics are computable from telemetry
--            within five minutes — events are written synchronously in the
--            request that caused them, so the metrics query is always
--            near-real-time (the export reports its own freshness)
--   TR-34    stable metric keys and a versioned CSV export contract
--
-- Privacy shape: events carry aggregate dimensions only (budget band,
-- surfaced count, consent target state). No user ids, no pair ids, no
-- venue cells — product telemetry must never become a tracking surface.
--
-- Forward-only migration; run after 0012_taxonomy_cms.sql.

BEGIN;

CREATE TABLE telemetry_events (
    seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_key   text NOT NULL CHECK (event_key IN (
                    'scan.completed',
                    'consent.transitioned',
                    'pair.first_message'
                )),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    dims        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX telemetry_events_key_time_idx ON telemetry_events (event_key, occurred_at);

-- The analyst console reads; the request path writes. Same GUC discipline
-- as the moderation and taxonomy consoles.
CREATE OR REPLACE FUNCTION app_analyst() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.analyst', true) = 'on' $$;

ALTER TABLE telemetry_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY telemetry_app_insert ON telemetry_events
    FOR INSERT WITH CHECK (true);
CREATE POLICY telemetry_analyst_select ON telemetry_events
    FOR SELECT USING (app_analyst());

GRANT INSERT ON telemetry_events TO presence_app;
GRANT SELECT ON telemetry_events TO presence_app;

COMMIT;

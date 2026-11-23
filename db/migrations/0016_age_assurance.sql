-- Presence — privacy-preserving age assurance
-- (PRS-SRS-001 §4 account; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   SEC-17  age assurance without ID-document storage — the method is
--           self-declaration with a moderation-triggered re-verification
--           loop; no identity document is ever uploaded, parsed or stored
--   BR-03   adults-only platform — a report that resolves underage/actioned
--           closes discovery until the account re-verifies a consistent,
--           adult birth year
--
-- Method (SEC-17): the platform already holds a birth YEAR only (FR-02 —
-- no birth date, no documents). Assurance deepens that rather than
-- replacing it: when a moderator actions an underage report, the account
-- is flagged for re-verification. While the flag stands, discovery is
-- closed with the same neutral error as every other discovery block. To
-- clear it the user must declare a birth year that is (a) adult and
-- (b) consistent with the year already on file (±1, absorbing a sloppy
-- first declaration) — a flagged account cannot jump a decade to evade
-- the block. The consistency window is checked in the edge, which is the
-- only writer of these columns.
--
-- Forward-only migration; run after 0015_recovery.sql.

BEGIN;

ALTER TABLE users
    ADD COLUMN age_reverify_required_at timestamptz,
    ADD COLUMN age_reverified_at        timestamptz;

-- Re-verification implies a declaration exists to verify against.
ALTER TABLE users
    ADD CONSTRAINT age_reverify_needs_declaration
    CHECK (age_reverify_required_at IS NULL OR birth_year IS NOT NULL);

GRANT UPDATE (age_reverify_required_at, age_reverified_at) ON users TO presence_app;

COMMIT;

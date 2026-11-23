-- Presence — account recovery phone, keyed-hash storage
-- (PRS-SRS-001 §4 account; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   SEC-09  the recovery phone number is stored as a keyed hash only — the
--           plaintext digits never touch the database, and the hash is
--           useless without the server-side key (HMAC-SHA256, key held in
--           the edge environment / presence-secrets, never in the schema)
--
-- Recovery only needs equality: "is the number the user just typed the one
-- on file?" HMAC-SHA256 answers that without ever persisting the number
-- itself. Unkeyed SHA-256 would be a phonebook — numbers are 10–15 digits,
-- so a leaked table would invert in seconds; the HMAC key is what makes the
-- column non-enumerable.
--
-- The edge normalises to E.164 before hashing, so formatting variants of
-- the same number map to one hash. The UNIQUE constraint doubles as a
-- duplicate-account signal: one number, one account. A collision is
-- answered with the same neutral rejection as an invalid number — the
-- caller cannot probe whether a number is registered elsewhere.
--
-- Forward-only migration; run after 0014_markets.sql.

BEGIN;

CREATE TABLE recovery_phones (
    user_id     uuid PRIMARY KEY REFERENCES users (user_id) ON DELETE CASCADE,
    phone_hash  text NOT NULL,                  -- hex HMAC-SHA256 of the E.164 number
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- One recovery number per account platform-wide (see header).
CREATE UNIQUE INDEX recovery_phones_hash_key ON recovery_phones (phone_hash);

-- ------------------------------------------------------------- RLS ---------
-- The row is a credential, not content: the owner replaces and removes it,
-- and nobody else — including moderators — reads it. There is nothing a
-- console could do with an HMAC it cannot invert, so the console gets no
-- policy at all.
ALTER TABLE recovery_phones ENABLE ROW LEVEL SECURITY;

CREATE POLICY recovery_phones_own_select ON recovery_phones
    FOR SELECT USING (user_id = app_user());
CREATE POLICY recovery_phones_own_insert ON recovery_phones
    FOR INSERT WITH CHECK (user_id = app_user());
CREATE POLICY recovery_phones_own_update ON recovery_phones
    FOR UPDATE USING (user_id = app_user()) WITH CHECK (user_id = app_user());
CREATE POLICY recovery_phones_own_delete ON recovery_phones
    FOR DELETE USING (user_id = app_user());

-- ------------------------------------------------------------- grants ------
GRANT SELECT, INSERT, DELETE ON recovery_phones TO presence_app;
GRANT UPDATE (phone_hash, updated_at) ON recovery_phones TO presence_app;

COMMIT;

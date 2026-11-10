-- Delegation grants (#740 S1): which agent identity may act on which human address,
-- and with which powers. This slice is the STORE and the operator routes only: nothing
-- reads a grant for authorization yet, so behaviour does not change. Later slices of
-- #740 consult it: S2 read and organize, S3 quote, S4 send_as.
--
-- grantee_id is an agent_identities.id (migration 0016). SQLite in D1 does not enforce
-- foreign keys by default, so the reference is checked by the mint itself: the INSERT is
-- conditional on the grantee being a LIVE (unrevoked) identity, in the same statement.
--
-- powers is a JSON array, a non-empty subset of read, organize, quote, send_as; every
-- power implies read, so a stored set always carries it. A row is never
-- deleted: revocation sets revoked_at, and the id is never reused. At most one ACTIVE
-- grant per (grantee, address): to change the powers, revoke and grant again, so every
-- change is its own audited event.
--
-- ADDITIVE ONLY (CREATE TABLE / CREATE INDEX), so the #112 deploy gate applies it with
-- no marker. schema.sql carries the same table for a fresh DB.

CREATE TABLE IF NOT EXISTS delegation_grants (
  id          TEXT PRIMARY KEY,
  grantee_id  TEXT NOT NULL,
  address     TEXT NOT NULL,
  powers      TEXT NOT NULL,
  label       TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_active
  ON delegation_grants(grantee_id, address) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_delegation_address ON delegation_grants(address, grantee_id);
CREATE INDEX IF NOT EXISTS idx_delegation_created ON delegation_grants(created_at, id);

-- Human-only threads (#853). A human owner marks one thread on their own address so that
-- no agent reads, quotes, organizes or replies into the owner's mail in it, whatever its
-- grants and under either AGENT_READ_SCOPE value. The agent's own mail is never hidden.
--
-- thread_id is the id the read routes report as threadId (COALESCE(thread_id, message_id)).
-- address is the owner's address; created_by the owner's principal id (prn_). One ACTIVE
-- mark per (thread, address); un-marking sets revoked_at. The partial index is also the
-- lookup the read predicate (store.ts exclusionClause) runs per row.
--
-- ADDITIVE ONLY (a new table and its indexes), so the #112 deploy gate applies it with no
-- marker. schema.sql carries the same DDL for a fresh DB.

CREATE TABLE IF NOT EXISTS delegation_exclusions (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  address     TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exclusion_active
  ON delegation_exclusions(thread_id, address) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_exclusion_address ON delegation_exclusions(address, created_at);

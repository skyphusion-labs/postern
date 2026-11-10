-- Runtime agent identities (#801, #632 S1) and the audit log they write to.
--
-- Before this, an agent credential could only be added by editing the
-- POSTERN_SEND_IDENTITIES var and redeploying, so it could not be revoked in an
-- incident without a deploy either. This table lets an operator (a `both` token)
-- mint, list and revoke one at runtime. The env var stays readable and is
-- consulted first, so an existing deploy is untouched.
--
-- agent_identities stores the sha256 HASH of each token, never the token. The
-- token is returned once, by the mint call, and is not recoverable afterwards.
-- `id` is the stable identifier other records attribute to (#740's audit trail);
-- it is never reused. A row is never deleted: revocation sets revoked_at, and the
-- resolver ignores a revoked row on the very next request (no cache).
--
-- parent_id is set when a runtime identity holding the opt-in `mint` cap minted
-- this one (delegated minting). NULL means an operator minted it. Revoking a row
-- also revokes every row below it.
--
-- audit_log is GENERIC on purpose: one row per action, naming the actor, the
-- target, and the outcome. #801 writes identity mint / list / revoke rows; #740
-- adds the agent read and write actions on another identity's mail to the same
-- table rather than starting a second log.
--
-- ADDITIVE ONLY (CREATE TABLE / CREATE INDEX), so the #112 deploy gate applies it
-- with no marker. schema.sql carries the same tables for a fresh DB.

CREATE TABLE IF NOT EXISTS agent_identities (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  from_addr    TEXT NOT NULL,
  display_name TEXT,
  label        TEXT,
  scopes       TEXT NOT NULL,
  parent_id    TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  revoked_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_identities_parent ON agent_identities(parent_id);
CREATE INDEX IF NOT EXISTS idx_agent_identities_created ON agent_identities(created_at, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor_kind  TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  outcome     TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_id, id);

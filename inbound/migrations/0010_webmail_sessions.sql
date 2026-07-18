-- Webmail v2 session store (#351, epic #338, contract docs/design/webmail-v2-contracts.md
-- section 1.5.2). A webmail session is a short-lived, server-side capability grant
-- with an HttpOnly cookie custody and instant revocation -- NOT a second identity
-- store: it is minted by verifying an EXISTING credential (native mode:
-- smtp_credentials, the same PBKDF2 the submission relay uses) and resolves to the
-- same { scope/caps, bound identity } shape a Bearer token does (contract 1.2/1.8).
--
-- We store the HASH of the opaque cookie value, never the raw id (same discipline
-- as the send registry storing token hashes, SEND-IDENTITIES.md section 5): a read
-- of this table yields no usable cookie. Resolution hashes the presented cookie and
-- looks up id_hash. csrf_hash is the sha256 of the per-session synchronizer token
-- (double-submit CSRF, contract 1.6). caps is the comma-set of granted scopes.
--
-- ADDITIVE ONLY (CREATE TABLE / CREATE INDEX): the #112 deploy gate is
-- deny-by-default for destructive statements; a bare CREATE auto-applies with no
-- override marker required. IF NOT EXISTS so a re-run is harmless. schema.sql
-- carries the same table + index for a fresh DB. No backfill, no UPDATE.
--
-- Section 2 of the contract (durable folders/flags/drafts/placement) is a SEPARATE
-- later migration (0011, #352), not this one: #351 is the auth shell only.
CREATE TABLE IF NOT EXISTS webmail_sessions (
  id_hash      TEXT PRIMARY KEY,   -- sha256hex of the opaque cookie value; RAW id never stored
  identity     TEXT NOT NULL,      -- bound From address (authoritative sender for this session)
  display_name TEXT,
  caps         TEXT NOT NULL,      -- comma-set of granted scopes, e.g. "read,send"
  csrf_hash    TEXT NOT NULL,      -- sha256hex of the synchronizer token
  issued_at    TEXT NOT NULL,      -- absolute-cap anchor
  last_seen_at TEXT NOT NULL,      -- sliding-window anchor
  expires_at   TEXT NOT NULL,      -- min(last_seen + idle, issued + absolute)
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_identity ON webmail_sessions(identity);

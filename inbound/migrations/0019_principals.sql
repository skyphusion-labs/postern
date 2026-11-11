-- The principal layer, phase M1 (#854, docs/IDENTITY.md sections 3 and 6; Conrad accepted
-- all ten D-ID recommendations). One people model for humans, agents and the operator.
--
-- principals: who. kind is human | agent | service and sets the caps CEILING. A migrated
-- agent KEEPS its agent_identities.id (idn_...) as its principal id, so every
-- delegation_grants.grantee_id and every audit_log.actor_id already written stays valid
-- with no rewrite. Humans get prn_ ids. The six static token slots are SERVICE principals
-- with fixed ids (D-ID-5), seeded below, so the audit log names which slot acted.
--
-- credentials: how they prove it, many per principal, each typed and revocable on its own.
-- principal_addresses: the mail an address's owner owns; one owner per address.
--
-- M1 is STORE ONLY. Nothing reads these tables to authorize anything: every credential
-- resolves exactly as before, from the tables and env it always did. The backfill from
-- smtp_credentials and agent_identities is NOT here, because a copy is an
-- INSERT ... SELECT, which the #112 gate rightly refuses; it is the idempotent
-- backfillPrincipals() (inbound/src/principals.ts), run by POST /api/admin/principals/backfill.
--
-- ADDITIVE ONLY (CREATE TABLE / CREATE INDEX / INSERT ... VALUES seeds), so the #112
-- deploy gate applies it with no marker. schema.sql carries the same tables and seeds.

CREATE TABLE IF NOT EXISTS principals (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  label        TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  disabled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_principals_kind ON principals(kind, id);

CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL,
  type          TEXT NOT NULL,
  lookup        TEXT,
  secret        TEXT,
  caps          TEXT NOT NULL,
  protocols     TEXT,
  label         TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  expires_at    TEXT,
  revoked_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_lookup ON credentials(type, lookup) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_credentials_principal ON credentials(principal_id, id);

CREATE TABLE IF NOT EXISTS principal_addresses (
  address      TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  is_primary   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_principal_addresses_principal ON principal_addresses(principal_id, address);

INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at) VALUES ('svc_both', 'service', 'Operator (POSTERN_API_TOKEN)', 'static slot', 'migration', '2026-11-11T00:00:00.000Z');
INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at) VALUES ('svc_read', 'service', 'POSTERN_API_TOKEN_READ', 'static slot', 'migration', '2026-11-11T00:00:00.000Z');
INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at) VALUES ('svc_send', 'service', 'POSTERN_API_TOKEN_SEND', 'static slot', 'migration', '2026-11-11T00:00:00.000Z');
INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at) VALUES ('svc_delete', 'service', 'POSTERN_API_TOKEN_DELETE', 'static slot', 'migration', '2026-11-11T00:00:00.000Z');
INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at) VALUES ('svc_imap', 'service', 'POSTERN_API_TOKEN_IMAP', 'static slot', 'migration', '2026-11-11T00:00:00.000Z');
INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at) VALUES ('svc_organize', 'service', 'POSTERN_API_TOKEN_ORGANIZE', 'static slot', 'migration', '2026-11-11T00:00:00.000Z');

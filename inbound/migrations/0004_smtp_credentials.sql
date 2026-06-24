-- M6 (#68): per-user SMTP submission credentials. The submission relay
-- (relay/submission.go) authenticates an IMAP client over 587/465 and validates
-- the login against this table via POST /api/smtp-auth. The secret is stored ONLY
-- as a PBKDF2-HMAC-SHA256 derivation (see inbound/src/smtpcreds.ts), never in
-- plaintext. On success the worker returns from_addr, the bound From identity the
-- submission daemon then enforces on the message.
--
-- This table is independent of the message store (messages/attachments): it gates
-- the SENDER per user; the mailbox/store stays the shared skyphusion.org D1.

CREATE TABLE IF NOT EXISTS smtp_credentials (
  -- The SMTP login. Lowercased on write; normally the user's @skyphusion.org
  -- address (you log in as, and send as, your own address).
  username    TEXT PRIMARY KEY,
  -- The bound From identity returned to the daemon on success. The submitted
  -- message From MUST equal this (the daemon rejects a mismatch with 550).
  from_addr   TEXT NOT NULL,
  -- pbkdf2$<iterations>$<saltB64>$<hashB64>. Never the plaintext secret.
  secret_hash TEXT NOT NULL,
  -- Soft-disable a credential without deleting it (set to 1 to revoke).
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT,
  updated_at  TEXT
);

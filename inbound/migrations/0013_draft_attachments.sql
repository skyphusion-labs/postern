-- Compose parity (#353, epic #338). Staged draft attachment bytes live in R2;
-- this table holds identity-bound metadata and the object key. Draft action
-- metadata lets one durable draft represent new mail, reply, reply-all, or
-- forward without overloading RFC threading fields.
--
-- ADDITIVE ONLY: CREATE TABLE / INDEX plus ALTER TABLE ADD COLUMN. No UPDATE,
-- backfill, table rebuild, or destructive statement. Existing drafts default to
-- compose_mode='new' and source_message_id=NULL, preserving their behavior.
--
-- Migration 0012 belongs to #342 (projected size). Compose parity is 0013.

ALTER TABLE drafts ADD COLUMN compose_mode TEXT NOT NULL DEFAULT 'new';
ALTER TABLE drafts ADD COLUMN source_message_id TEXT;

CREATE TABLE IF NOT EXISTS draft_attachments (
  id         TEXT PRIMARY KEY,
  draft_id   TEXT NOT NULL,
  identity   TEXT NOT NULL,
  filename   TEXT,
  mime       TEXT,
  size       INTEGER NOT NULL,
  r2_key     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draft_attachments_owner
  ON draft_attachments(draft_id, identity, created_at);

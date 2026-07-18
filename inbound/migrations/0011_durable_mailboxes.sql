-- Durable folders, flags, and drafts (#352, epic #338, contract
-- docs/design/webmail-v2-contracts.md sections 2-4). Phase 3 of webmail v2: the
-- INBOUND CORE that makes Drafts/Trash/Junk/Archive REAL (they were empty
-- placeholders) and adds \Flagged / \Answered beside the existing durable \Seen,
-- so webmail and the IMAP door read one store and cannot diverge (retires the
-- D5/D6/D10 finding class from the Fable product-gap review).
--
-- ADDITIVE ONLY: every statement is ALTER TABLE ... ADD COLUMN (with a DEFAULT that
-- carries every old row) or CREATE TABLE / CREATE INDEX IF NOT EXISTS. There is NO
-- UPDATE / backfill: old rows keep NULL `mailbox` (they render in their direction-
-- default INBOX/Sent view exactly as today), 0 flags, and no placement rows. That is
-- the class the #112 deploy gate (d1-migration-gate.mjs) auto-applies with no
-- destructive-override marker and no supervised window, the same discipline
-- 0006/0007/0009/0010 followed. schema.sql carries the same columns/tables for a
-- fresh DB.
--
-- Migration numbering: the auth-shell sessions table shipped as 0010 (#351); this
-- section-2 durable-mailbox migration is the SEPARATE, immutable-per-deploy 0011
-- (#352). (An earlier issue body referenced 0009; 0009/0010 already shipped, so
-- this is 0011 per the contract.)

-- 2.2 Flags beyond \Seen. \Seen stays messages.seen (row-level) + message_seen_by
-- (per-recipient override, #350); these two back the webmail star/answered UI and
-- the IMAP PERMANENTFLAGS set. Old rows default to not-flagged / not-answered.
ALTER TABLE messages ADD COLUMN flagged  INTEGER NOT NULL DEFAULT 0;  -- \Flagged / starred
ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;  -- \Answered

-- 2.3 Folder placement: ONE mutable system-box placement per message. NULL = the
-- direction-default view (inbound -> INBOX, outbound -> Sent); 'archive'|'junk' =
-- moved out of INBOX/Sent into that box; 'trash' + trashed_at = soft delete (2.5,
-- the D6 fix: Trash is recoverable, not a hard delete). All = the union regardless
-- of mailbox. Runtime UPDATEs move/restore (not a migration).
ALTER TABLE messages ADD COLUMN mailbox    TEXT;  -- NULL | 'archive' | 'trash' | 'junk'
ALTER TABLE messages ADD COLUMN trashed_at TEXT;  -- soft-delete timestamp; drives Trash recovery window + purge

-- Optional read helper for the folder views/counts (mailbox IS NULL is the common
-- case, but the durable folders scan by value).
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox);

-- 2.4 Server-side drafts. A draft is NOT a messages row (no Message-ID identity, no
-- direction, rewritten on every autosave), so it gets its own table and never
-- touches the message store / FTS / Vectorize. identity is the owning bound From
-- (the IDOR boundary: every draft route filters on it). uid is the per-folder IMAP
-- UID from mailbox_uid_counter['drafts']; a NEW uid is minted on every successful
-- write (2.4.1: autosave = EXPUNGE(old uid) + a new higher UID, RFC 3501 immutability).
CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,   -- server- or client-minted uuid; the stable draft handle
  identity     TEXT NOT NULL,      -- owning account (bound From); IDOR boundary
  to_addr      TEXT,
  cc_addr      TEXT,
  bcc_addr     TEXT,
  subject      TEXT,
  body_text    TEXT,
  body_html    TEXT,               -- stored as authored; sanitized at SEND (D-HTML-1)
  in_reply_to  TEXT,               -- set when the draft is a reply/forward
  thread_id    TEXT,               -- for reply drafts, so the composed reply threads
  uid          INTEGER NOT NULL,   -- per-folder IMAP UID; a NEW uid on every successful write (2.4.1)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL       -- optimistic-concurrency token for PUT autosave
);
CREATE INDEX IF NOT EXISTS idx_drafts_identity ON drafts(identity, updated_at);

-- 2.6 Per-folder UID ledger for the RE-POPULATED folders (Archive/Trash/Junk, and
-- Drafts via drafts.uid). INBOX/Sent/All do NOT use this: they stay append-only at
-- arrival and keep messages.id as the UID under their existing UIDVALIDITY (bumping
-- it would force every client to resync). A folder_uid is assigned monotonically
-- when a message ENTERS a folder and is NEVER reused, even across move-out-and-back
-- (a re-add mints a new folder_uid, correct RFC 3501 semantics). mailbox (2.3) is
-- the fast single-placement read for webmail; mailbox_placement is the per-folder
-- UID ledger the IMAP door reads; the same write keeps them consistent.
CREATE TABLE IF NOT EXISTS mailbox_placement (
  message_id  TEXT NOT NULL,
  folder      TEXT NOT NULL,       -- 'archive' | 'trash' | 'junk' | (later) user folder id
  folder_uid  INTEGER NOT NULL,    -- per-folder monotonic, assigned on placement, NEVER reused
  added_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, folder)
);
CREATE TABLE IF NOT EXISTS mailbox_uid_counter (
  folder      TEXT PRIMARY KEY,    -- one row per re-populated folder (incl. 'drafts')
  next_uid    INTEGER NOT NULL,    -- high-water mark; hand out then increment, never reuse
  uidvalidity INTEGER NOT NULL     -- minted once for the folder; bump only on a semantics change
);

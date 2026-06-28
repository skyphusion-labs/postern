-- #103 (audit F9, RFC 3501): convert messages.id from a bare INTEGER PRIMARY KEY
-- (rowid) to INTEGER PRIMARY KEY AUTOINCREMENT, so the id the proxy uses as the
-- IMAP UID is guaranteed never-reused, not just monotonic-while-nothing-is-deleted.
-- A bare rowid reuses the value of the highest deleted row; AUTOINCREMENT keeps a
-- high-water mark (sqlite_sequence) so a new row is always greater than any id that
-- has EVER existed. schema.sql carries the same AUTOINCREMENT for a fresh DB.
--
-- This is a CORE-TABLE REBUILD (SQLite cannot add AUTOINCREMENT via ALTER). It is
-- written FTS-safe: messages_fts is external-content keyed on messages.id
-- (content_rowid='id'), and this migration PRESERVES every id value 1:1, so the
-- existing FTS index stays valid and is never rebuilt. The messages_fts virtual
-- table is deliberately NOT touched. Apply ONCE, offline (no concurrent writers),
-- inside the migration; re-running after it is applied will error (table already
-- AUTOINCREMENT) -- skip in that case. Back up the DB first (aviation-grade: a
-- core-table rebuild on the live mail store is a deliberate, reviewed operation).
--
-- DO NOT let this auto-apply: deploy.yml runs `wrangler d1 migrations apply DB
-- --remote` on every merge to main, which would rebuild the LIVE store online with
-- no backup. The apply order is: back up skyphusion-mail -> quiesce writers ->
-- apply this offline -> verify (ids preserved 1:1, FTS integrity, high-water
-- seeded) -> seed d1_migrations to mark 0005 applied -> THEN merge, so the next
-- deploy sees it already-applied and no-ops. (Same baseline-seed pattern as the
-- 0001-0003 drift.)
--
-- HARD INVARIANT: this migration MUST be applied (or the DB must be fresh from the
-- AUTOINCREMENT schema.sql) BEFORE any message-DELETION feature ships. A bare-rowid
-- store that starts deleting rows can reuse a UID under a constant UIDVALIDITY,
-- which is exactly the RFC 3501 violation #103 closes.

-- 1. Triggers are dropped automatically with the table below, but drop them first
--    explicitly so the intermediate INSERT...SELECT copy does not fire them and
--    double-write the (already-valid) FTS rows.
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;

-- 2. New table, identical columns + AUTOINCREMENT on the rowid.
CREATE TABLE messages_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT UNIQUE,
  from_addr   TEXT,
  to_addr     TEXT,
  subject     TEXT,
  date        TEXT,
  in_reply_to TEXT,
  body_text   TEXT,
  body_html   TEXT,
  spf         TEXT,
  dkim        TEXT,
  dmarc       TEXT,
  trusted     INTEGER DEFAULT 0,
  received_at TEXT,
  direction   TEXT NOT NULL DEFAULT 'inbound',
  thread_id   TEXT
);

-- 3. Copy every row, PRESERVING id exactly (so FTS rowids still match).
INSERT INTO messages_new
  (id, message_id, from_addr, to_addr, subject, date, in_reply_to, body_text,
   body_html, spf, dkim, dmarc, trusted, received_at, direction, thread_id)
SELECT
   id, message_id, from_addr, to_addr, subject, date, in_reply_to, body_text,
   body_html, spf, dkim, dmarc, trusted, received_at, direction, thread_id
FROM messages;

-- 4. Swap.
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

-- 5. Recreate the indexes (dropped with the old table).
CREATE INDEX IF NOT EXISTS idx_from ON messages(from_addr);
CREATE INDEX IF NOT EXISTS idx_date ON messages(date);
CREATE INDEX IF NOT EXISTS idx_trusted ON messages(trusted, received_at);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id, date);

-- 6. Recreate the FTS-sync triggers against the rebuilt table.
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_text) VALUES (new.id, new.subject, new.body_text);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text) VALUES ('delete', old.id, old.subject, old.body_text);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text) VALUES ('delete', old.id, old.subject, old.body_text);
  INSERT INTO messages_fts(rowid, subject, body_text) VALUES (new.id, new.subject, new.body_text);
END;

-- 7. Seed the AUTOINCREMENT high-water mark to the largest existing id, so the
--    next auto-assigned id continues strictly above it (independent of how the
--    rename propagated the sqlite_sequence name).
DELETE FROM sqlite_sequence WHERE name = 'messages';
INSERT INTO sqlite_sequence(name, seq) SELECT 'messages', IFNULL(MAX(id), 0) FROM messages;

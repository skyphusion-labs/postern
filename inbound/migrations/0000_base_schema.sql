-- 0000: base schema. Creates the original `messages` table (plus its base
-- indexes) that migrations 0001+ build on. This is the FIRST migration, so a
-- greenfield install can bootstrap the whole store with migrations alone
-- (`wrangler d1 migrations apply DB`) -- the "Greenfield alternative" path in
-- DEPLOY.md. Before this file existed, 0001 opened with `ALTER TABLE messages
-- ADD COLUMN dmarc`, which failed on a fresh D1 with "no such table: messages",
-- since only schema.sql created the base table (#341).
--
-- IDEMPOTENT + NO-OP ON EXISTING STORES. Everything here is CREATE ... IF NOT
-- EXISTS, so on a live store already built by schema.sql (or by the historical
-- pre-wrangler base + 0001-0008), applying this is a no-op: the table and its
-- indexes already exist and SQLite leaves them untouched (it does NOT reconcile
-- column definitions against an existing table). The prod store
-- (skyphusion-mail) is baseline-seeded through 0008 but not 0000, so the next
-- deploy sees 0000 as the only pending migration and applies exactly this
-- no-op. Purely additive: it passes the #112 auto-apply gate with no marker.
--
-- The table is deliberately the ORIGINAL base shape (bare `id INTEGER PRIMARY
-- KEY`, columns through the pre-0001 store): each later migration then applies
-- on top exactly as it does on the live store. In particular 0005 rebuilds this
-- table to `id INTEGER PRIMARY KEY AUTOINCREMENT` (the current shape) and its
-- INSERT...SELECT reads only columns present by then (base + 0001 dmarc + 0002
-- direction/thread_id + 0003 body_html). Do NOT add later columns here.

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  message_id  TEXT UNIQUE,
  from_addr   TEXT,
  to_addr     TEXT,
  subject     TEXT,
  date        TEXT,
  in_reply_to TEXT,
  body_text   TEXT,
  spf         TEXT,
  dkim        TEXT,
  trusted     INTEGER DEFAULT 0,
  received_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_from ON messages(from_addr);
CREATE INDEX IF NOT EXISTS idx_date ON messages(date);
CREATE INDEX IF NOT EXISTS idx_trusted ON messages(trusted, received_at);

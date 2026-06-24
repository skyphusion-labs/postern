-- Inbound mail store. messages = one row per delivered message; attachments live
-- in R2 (referenced here); messages_fts is an external-content FTS5 index kept in
-- sync by triggers. For an existing DB, apply migrations/ instead of this file.

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
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
  -- M2 (#27): two-way + threaded. direction = 'inbound' (received) | 'outbound' (sent
  -- copies the mailbox stores back). thread_id groups a conversation, resolved on
  -- every store from in_reply_to / References (see store.ts), else this message_id.
  direction   TEXT NOT NULL DEFAULT 'inbound',
  thread_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_from ON messages(from_addr);
CREATE INDEX IF NOT EXISTS idx_date ON messages(date);
CREATE INDEX IF NOT EXISTS idx_trusted ON messages(trusted, received_at);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id, date);

-- Attachments: bytes stored in R2 (ATTACHMENTS bucket), metadata + key here.
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  message_id  TEXT NOT NULL,
  filename    TEXT,
  mime        TEXT,
  size        INTEGER,
  r2_key      TEXT NOT NULL,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_msg ON attachments(message_id);

-- Full-text search over subject + body (external content = messages).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(subject, body_text, content='messages', content_rowid='id', tokenize='porter unicode61');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_text) VALUES (new.id, new.subject, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text) VALUES ('delete', old.id, old.subject, old.body_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text) VALUES ('delete', old.id, old.subject, old.body_text);
  INSERT INTO messages_fts(rowid, subject, body_text) VALUES (new.id, new.subject, new.body_text);
END;

-- SMTP submission credentials (#68): per-user logins for the 587/465 submission
-- relay, validated via POST /api/smtp-auth. Secret stored as a PBKDF2 hash only
-- (inbound/src/smtpcreds.ts). Independent of the message store above.
CREATE TABLE IF NOT EXISTS smtp_credentials (
  username    TEXT PRIMARY KEY,
  from_addr   TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT,
  updated_at  TEXT
);

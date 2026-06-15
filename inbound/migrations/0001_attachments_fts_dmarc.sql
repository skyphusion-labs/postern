-- Apply to the existing skyphusion-mail DB (the base schema predates these).
-- ALTER ADD COLUMN is not IF NOT EXISTS; run once. Re-running errors harmlessly
-- on the dmarc line if already applied -- skip it in that case.
ALTER TABLE messages ADD COLUMN dmarc TEXT;

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, mime TEXT,
  size INTEGER, r2_key TEXT NOT NULL, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_msg ON attachments(message_id);

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

-- Backfill FTS from existing rows (idempotent enough: 'rebuild' re-derives all).
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');

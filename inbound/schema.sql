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

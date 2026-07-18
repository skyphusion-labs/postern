-- Inbound mail store. messages = one row per delivered message; attachments live
-- in R2 (referenced here); messages_fts is an external-content FTS5 index kept in
-- sync by triggers. For an existing DB, apply migrations/ instead of this file.

CREATE TABLE IF NOT EXISTS messages (
  -- AUTOINCREMENT (not a bare INTEGER PRIMARY KEY) so the rowid is assigned
  -- strictly ascending at insertion AND is NEVER reused (#103): a bare rowid
  -- reuses the value of the highest deleted row, which would violate the IMAP
  -- UID never-reuse contract (RFC 3501) under a constant UIDVALIDITY the moment
  -- a message-deletion path exists (the AFTER DELETE trigger below shows one is
  -- designed for). The proxy uses this id directly as the per-message IMAP UID.
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
  -- Read state (#seen, migration 0007). 0 = unread, 1 = read. store.put() sets this
  -- EXPLICITLY on every insert: inbound mail lands unread (0), the mailbox's own
  -- outbound sent copies land read (1). Flipped later by setSeen() (POST
  -- /api/messages/seen), which backs the IMAP \Seen flag and the webmail unread view
  -- so a human can tell new mail from mail they have read. The column DEFAULT is 1
  -- (read) so that any row inserted WITHOUT specifying seen -- and, in migration 0007,
  -- every pre-existing row -- is treated as already-read rather than dumping the whole
  -- historical mailbox back as unread; new inbound is unread only because put() says so.
  seen        INTEGER NOT NULL DEFAULT 1,
  -- M2 (#27): two-way + threaded. direction = 'inbound' (received) | 'outbound' (sent
  -- copies the mailbox stores back). thread_id groups a conversation, resolved on
  -- every store from in_reply_to / References (see store.ts), else this message_id.
  direction   TEXT NOT NULL DEFAULT 'inbound',
  thread_id   TEXT,
  -- M8 envelope fidelity v2 (#189, migration 0006). delivered_to = envelope
  -- semantics: the normalized set of bare lower-cased recipients this message was
  -- DELIVERED to, stored ",a@x,b@y," (leading + trailing commas) so membership is
  -- one delimiter-safe LIKE and the #178 merge append needs no edge-casing; this
  -- is what mailbox views filter on. cc_addr/bcc_addr/sender_addr/reply_to_addr =
  -- header fidelity: the raw RFC 5322 headers as they arrived (display names and
  -- all), so IMAP ENVELOPE and clients render the truth. bcc_addr is outbound-only
  -- (an inbound Bcc is the sender secret, not on our wire). wire_size = raw RFC822
  -- byte size at intake: stored fidelity for API consumers; the IMAP door keeps
  -- serving the PROJECTED size while BODY[] is a projection (SIZE and the literal
  -- must agree -- CONTRACT 10.3). All nullable: old rows keep NULL and render as
  -- today (reads COALESCE delivered_to -> to_addr).
  delivered_to  TEXT,
  cc_addr       TEXT,
  bcc_addr      TEXT,
  sender_addr   TEXT,
  reply_to_addr TEXT,
  wire_size     INTEGER,
  -- Durable flags + folder placement (#352, migration 0011). flagged/answered are
  -- \Flagged / \Answered beside the durable \Seen (2.2). mailbox is the ONE mutable
  -- system-box placement: NULL = the direction-default INBOX/Sent view (every old
  -- row), 'archive'|'junk' = moved into that box, 'trash' + trashed_at = soft delete
  -- (2.3/2.5, the D6 fix). All is the union regardless of mailbox.
  flagged     INTEGER NOT NULL DEFAULT 0,
  answered    INTEGER NOT NULL DEFAULT 0,
  mailbox     TEXT,
  trashed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_from ON messages(from_addr);
CREATE INDEX IF NOT EXISTS idx_date ON messages(date);
CREATE INDEX IF NOT EXISTS idx_trusted ON messages(trusted, received_at);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id, date);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox);

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

-- Vectorize id ledger (#279): one row per chunk-vector upserted. Reconcile reads
-- this set for O(ledger) expected ids instead of re-deriving from every message.
CREATE TABLE IF NOT EXISTS vector_ledger (
  vector_id   TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  chunk       INTEGER NOT NULL,
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vector_ledger_message ON vector_ledger(message_id);

-- Webmail v2 session store (#351, migration 0010). A short-lived, server-side
-- capability grant with HttpOnly-cookie custody and instant revocation; minted by
-- verifying an existing credential (native mode: smtp_credentials, same PBKDF2 as
-- the submission relay) and resolving to the same { caps, bound identity } shape a
-- Bearer token does. Stores the HASH of the opaque cookie value, never the raw id,
-- so a read of this table yields no usable cookie. See
-- docs/design/webmail-v2-contracts.md section 1.5.2 and inbound/src/session.ts.
CREATE TABLE IF NOT EXISTS webmail_sessions (
  id_hash      TEXT PRIMARY KEY,
  identity     TEXT NOT NULL,
  display_name TEXT,
  caps         TEXT NOT NULL,
  csrf_hash    TEXT NOT NULL,
  issued_at    TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_identity ON webmail_sessions(identity);

-- Per-recipient read state (#350, migration 0009). Effective seen for viewer V =
-- COALESCE(override(message_id, V), messages.seen); a sparse override layered over
-- the row-level messages.seen so a same-domain send is unread for its recipient
-- while staying seen in the sender Sent view. recipient = bare lower-cased address.
-- Written forward-only (seed at same-domain outbound insert; POST /api/messages/seen
-- with `for`); no backfill. The composite PK is the effective-seen lookup index.
CREATE TABLE IF NOT EXISTS message_seen_by (
  message_id TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  seen       INTEGER NOT NULL,
  PRIMARY KEY (message_id, recipient)
);

-- Server-side drafts (#352, migration 0011). A draft is NOT a messages row (no
-- Message-ID, no direction, rewritten on every autosave); it lives here so draft
-- churn never touches the message store / FTS / Vectorize. identity is the owning
-- bound From (the IDOR boundary). uid is the per-folder IMAP UID from
-- mailbox_uid_counter['drafts']; a NEW uid is minted on every successful write
-- (2.4.1: autosave = EXPUNGE old uid + new higher UID, RFC 3501 immutability).
-- updated_at doubles as the optimistic-concurrency token for PUT autosave.
CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,
  identity     TEXT NOT NULL,
  to_addr      TEXT,
  cc_addr      TEXT,
  bcc_addr     TEXT,
  subject      TEXT,
  body_text    TEXT,
  body_html    TEXT,
  in_reply_to  TEXT,
  thread_id    TEXT,
  -- Compose parity (#353, migration 0013). mode is new|reply|replyAll|forward;
  -- source_message_id identifies the message whose recipients/quote seeded the
  -- draft. Existing/IMAP drafts default to ordinary new-mail behavior.
  compose_mode TEXT NOT NULL DEFAULT 'new',
  source_message_id TEXT,
  uid          INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_identity ON drafts(identity, updated_at);

-- Draft attachment staging (#353, migration 0013). Bytes live under the r2_key
-- in ATTACHMENTS; identity duplicates the draft owner so every metadata/byte
-- operation has an explicit IDOR predicate. Send consumes these through the one
-- mailbox core, then removes them only after successful dispatch + sent storage.
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

-- Per-folder UID ledger + counters for the RE-POPULATED folders (#352, migration
-- 0011). Archive/Trash/Junk (and Drafts via drafts.uid) gain messages OUT of
-- arrival order, so they cannot expose messages.id as the IMAP UID (that would
-- insert a lower UID after a higher one). Each gets a per-folder monotonic
-- folder_uid assigned on placement, NEVER reused, under its own UIDVALIDITY minted
-- once. INBOX/Sent/All do NOT use these (they keep messages.id). mailbox (above) is
-- the fast single-placement read; mailbox_placement is the per-folder UID ledger.
CREATE TABLE IF NOT EXISTS mailbox_placement (
  message_id  TEXT NOT NULL,
  folder      TEXT NOT NULL,
  folder_uid  INTEGER NOT NULL,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, folder)
);
CREATE TABLE IF NOT EXISTS mailbox_uid_counter (
  folder      TEXT PRIMARY KEY,
  next_uid    INTEGER NOT NULL,
  uidvalidity INTEGER NOT NULL
);

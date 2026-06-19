-- M2 (#27): make the store two-way and threaded. Apply once to an existing
-- skyphusion-mail DB (the base schema predates these columns). ALTER ADD COLUMN
-- is not IF NOT EXISTS; re-running errors harmlessly if already applied -- skip
-- in that case. schema.sql carries the same columns for a fresh DB.

-- direction distinguishes received mail from the sent copies the mailbox stores
-- back when an agent (or a human via the API) sends/replies. Existing rows are
-- inbound.
ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound';

-- thread_id groups a conversation. Resolved on every store: inherit from the
-- in_reply_to / References parent, else start a new thread at this message_id.
ALTER TABLE messages ADD COLUMN thread_id TEXT;

CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id, date);

-- Backfill: every pre-existing message is its own thread root (no reply data was
-- captured before M2). New stores resolve threads going forward.
UPDATE messages SET thread_id = message_id WHERE thread_id IS NULL;

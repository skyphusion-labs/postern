-- claimed_id: the Message-ID a message arrived with, for a message stored under a
-- derived id because a DIFFERENT message already held that Message-ID (CONTRACT 10.x,
-- store.put). NULL on every other row, and on rows forked before this migration (their
-- original id cannot be recovered from the derived one). store.resolveThreadId reads it
-- so that, for a given id, a trusted message is preferred as the thread parent.
--
-- ADDITIVE ONLY (ALTER ADD COLUMN, CREATE INDEX), so the #112 deploy gate applies it
-- with no marker. schema.sql carries the same column and index for a fresh DB.
-- ALTER ADD COLUMN is not IF NOT EXISTS; re-running errors harmlessly if already
-- applied -- skip in that case.
ALTER TABLE messages ADD COLUMN claimed_id TEXT;
CREATE INDEX IF NOT EXISTS idx_claimed_id ON messages(claimed_id) WHERE claimed_id IS NOT NULL;

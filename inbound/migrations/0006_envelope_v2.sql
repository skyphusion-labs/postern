-- M8 (#189): envelope fidelity v2. Apply once to an existing skyphusion-mail DB.
-- ADDITIVE ONLY (ALTER ADD COLUMN): the #112 deploy gate is deny-by-default, so a
-- pure additive migration auto-applies with its code; an UPDATE/backfill would
-- block. There is NO backfill here by design: old rows keep NULL in every new
-- column and render exactly as today, and the read side COALESCEs delivered_to
-- back to to_addr so pre-0006 rows filter correctly (docs/CONTRACT.md section 10).
-- ALTER ADD COLUMN is not IF NOT EXISTS; re-running errors harmlessly if already
-- applied -- skip in that case. schema.sql carries the same columns for a fresh DB.

-- Envelope semantics: the normalized set of bare lower-cased addresses this
-- message was actually DELIVERED to, stored with LEADING AND TRAILING commas
-- (",a@x,b@y,") so membership is one delimiter-safe LIKE and the #178 merge
-- append needs no edge-casing. This is what mailbox views filter on.
ALTER TABLE messages ADD COLUMN delivered_to TEXT;

-- Header fidelity: the RFC 5322 headers as they appeared on the wire (raw decoded
-- strings, display names and all; never re-formatted, never naively split). These
-- exist so IMAP ENVELOPE and human clients can render the truth.
ALTER TABLE messages ADD COLUMN cc_addr TEXT;       -- raw Cc header
ALTER TABLE messages ADD COLUMN bcc_addr TEXT;      -- outbound only (inbound Bcc is the sender secret, not on our wire)
ALTER TABLE messages ADD COLUMN sender_addr TEXT;   -- raw Sender header
ALTER TABLE messages ADD COLUMN reply_to_addr TEXT; -- raw Reply-To header

-- The raw RFC822 byte size at intake, so IMAP RFC822.SIZE is spec-true for new
-- mail instead of a projection (NULL for old rows + outbound, which fall back).
ALTER TABLE messages ADD COLUMN wire_size INTEGER;

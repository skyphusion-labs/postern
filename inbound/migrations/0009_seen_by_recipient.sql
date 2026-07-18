-- #350: per-RECIPIENT read state, so a shared store with multiple identities can
-- answer "is this read for viewer V?" instead of only the row-global messages.seen.
-- This is the per-mailbox state CONTRACT.md 10.7 named as the precondition for a
-- normalized recipient table; it does NOT fork message identity (one row per
-- message stays the model), it layers a SPARSE override beside it.
--
-- Semantics (store.ts): effective seen for viewer V = COALESCE(override(id, V),
-- messages.seen). Absent override = today's render, so NOTHING old floods anyone's
-- unread count -- this is why there is no backfill and no seed of historical rows.
-- Overrides are written only going forward: seen=0 seeded at a same-domain outbound
-- insert for each estate recipient except the sender (store.seedSameDomainSeen), and
-- upserted by POST /api/messages/seen when a caller passes `for=<address>`.
--
-- ADDITIVE ONLY (CREATE TABLE): the #112 deploy gate is deny-by-default for
-- destructive statements; a bare CREATE auto-applies and needs no
-- `postern:allow-destructive` marker. IF NOT EXISTS so a re-run is harmless.
-- schema.sql carries the same table for a fresh DB.
--
-- recipient is the BARE lower-cased address (matches the delivered_to membership
-- key). seen: 0 = unread, 1 = read, for THIS recipient only. The composite PK is
-- the lookup index the effective-seen subquery and the id-scoped updates both use;
-- no separate index is needed.
CREATE TABLE IF NOT EXISTS message_seen_by (
  message_id TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  seen       INTEGER NOT NULL,
  PRIMARY KEY (message_id, recipient)
);

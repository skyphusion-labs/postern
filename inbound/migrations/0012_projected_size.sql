-- #342: cached IMAP projection length for RFC822.SIZE without attachment GETs.
-- ADDITIVE ONLY (ALTER ADD COLUMN): the deploy gate is deny-by-default for
-- UPDATE/backfill. Old rows keep NULL and the IMAP door falls back to a
-- placeholder hydrate (message GET, zero attachment GETs). New inserts +
-- attachment finalize write projected_size / projection_version from D1 metadata
-- only (no R2 reads). schema.sql carries the same columns for a fresh DB.

ALTER TABLE messages ADD COLUMN projected_size INTEGER;
ALTER TABLE messages ADD COLUMN projection_version INTEGER;

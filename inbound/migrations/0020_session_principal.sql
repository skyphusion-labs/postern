-- A stable principal id on every webmail session (#854 M2, the part #740 S5 needs).
--
-- A session already names its login (username, migration 0015). A login can be renamed;
-- a principal id cannot, so S5's self-service grants and audit rows key on this instead.
-- New sessions write it at mint (inbound/src/session.ts insertSession, which creates the
-- human principal on the spot if the backfill has not reached that login). A row minted
-- before this migration has NULL here and simply signs in again to get one.
--
-- ADDITIVE ONLY (ALTER TABLE ... ADD COLUMN), so the #112 deploy gate applies it with no
-- marker. schema.sql carries the same column for a fresh DB.

ALTER TABLE webmail_sessions ADD COLUMN principal_id TEXT;

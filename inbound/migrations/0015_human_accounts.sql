-- Human accounts (#790, contract docs/design/webmail-v2-contracts.md section 1.10).
-- A user is still ONE smtp_credentials row; this adds what managing people needs:
--
--   webmail_sessions.username   the login that minted the session, so disable, reset,
--                               delete and change password can end exactly that
--                               user's sessions, and resolution can re-check that the
--                               account still exists and is enabled (1.10.3). A row
--                               minted before this migration keeps NULL and is matched
--                               by identity instead.
--   smtp_credentials.display_name   the optional human name shown as "Sending as".
--
-- ADDITIVE ONLY (ALTER TABLE ... ADD COLUMN, CREATE INDEX): the #112 deploy gate is
-- deny-by-default for anything else and a bare additive statement auto-applies. No
-- backfill and no UPDATE: NULL is the honest value for both columns on old rows.
-- ALTER ADD COLUMN is not IF NOT EXISTS; re-running errors harmlessly once applied.
-- schema.sql carries the same columns and index for a fresh DB.
ALTER TABLE webmail_sessions ADD COLUMN username TEXT;
ALTER TABLE smtp_credentials ADD COLUMN display_name TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_username ON webmail_sessions(username);

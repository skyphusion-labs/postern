-- Durable brute-force counters for the webmail session mint (#409, the control
-- #351 deferred to #355 and #355 closed without). POST /api/session verifies
-- against the SAME smtp_credentials store the submission relay (relay/throttle.go)
-- and the IMAP door (imap/posternimap/throttle.py) each throttle; this table gives
-- the worker door an equivalent, DURABLE counter (a Worker isolate is not a single
-- long-lived process, so an in-memory counter would not survive).
--
-- One row per throttle scope, prefixed so all three layers share one table:
--   a:<lower-cased username>  per-account streak (the relay per-account layer)
--   i:<client ip>             per-client-IP streak (a Worker sees the real client
--                             IP; the relay dropped this layer only because behind
--                             the bastion every connection was one IP)
--   g:all                     the optional global window (default OFF; opt in with
--                             WEBMAIL_AUTH_GLOBAL_MAX)
--
-- failures        = consecutive failures in the current streak (or count in window,
--                   for the global row)
-- window_start_at = streak / window anchor
-- last_failure_at = idle-decay anchor and the prune cutoff
-- locked_until    = NULL until the threshold trips; then the backoff expiry that
--                   POST /api/session answers with 429 + Retry-After
--
-- ADDITIVE ONLY (CREATE TABLE / CREATE INDEX), matching 0010: the #112 deploy gate
-- is deny-by-default for destructive statements and a bare CREATE auto-applies with
-- no reviewed override marker needed (this comment deliberately does not quote that
-- marker token, since the gate substring-matches the raw file). IF NOT EXISTS so a
-- re-run is harmless. schema.sql carries the same table for a fresh DB. No
-- backfill, no UPDATE, no DELETE: an absent row simply means no recent failures.
CREATE TABLE IF NOT EXISTS webmail_auth_failures (
  scope_key       TEXT PRIMARY KEY,   -- "a:<username>" | "i:<ip>" | "g:all"
  failures        INTEGER NOT NULL,   -- streak length (global row: count in window)
  window_start_at TEXT NOT NULL,      -- streak / window anchor (ISO8601)
  last_failure_at TEXT NOT NULL,      -- idle-decay + prune anchor (ISO8601)
  locked_until    TEXT                -- ISO8601 while locked out, else NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_failures_last ON webmail_auth_failures(last_failure_at);

-- Read-path parity misses (#854 M2, part ii).
--
-- Resolution now consults the `credentials` table beside the old one, acts on the OLD
-- table's answer always (agree-or-fallback: a disagreement can never allow what the old
-- table denies), and counts each disagreement here. One row per (UTC day, kind), so a
-- miss is a single upsert and an agreeing sign-in writes NOTHING. No identifiers: counts
-- only. GET /api/admin/principals/parity reports them; zero misses across a release is
-- one of the criteria for retiring the fallback (docs/IDENTITY.md section 6).
--
-- ADDITIVE ONLY (CREATE TABLE), so the #112 deploy gate applies it with no marker.
-- schema.sql carries the same table for a fresh DB.

CREATE TABLE IF NOT EXISTS principal_read_misses (
  day     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  misses  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

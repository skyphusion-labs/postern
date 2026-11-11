-- The service principal for the ADMIN-ONLY token slot (#904, POSTERN_API_TOKEN_ADMIN).
--
-- That slot resolves to the `admin` scope and nothing else, so automation (the
-- post-deploy principal backfill, #901) runs admin routes without holding a key that can
-- read or send mail. Its audit rows name this principal, so they are told apart from the
-- operator's (svc_both). Seeded the same way migration 0019 seeds the other six slots.
--
-- ADDITIVE ONLY (INSERT ... VALUES seed), so the #112 deploy gate applies it with no
-- marker. schema.sql carries the same seed for a fresh DB.

INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at) VALUES ('svc_admin', 'service', 'POSTERN_API_TOKEN_ADMIN', 'static slot', 'migration', '2026-11-11T00:00:00.000Z');

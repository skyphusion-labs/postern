-- #279: durable Vectorize id ledger for exact reconcile without re-scanning D1.
-- One row per chunk-vector successfully upserted. Populated by embedAndUpsert;
-- backfill via POST /api/admin/reindex on existing stores.
CREATE TABLE IF NOT EXISTS vector_ledger (
  vector_id   TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  chunk       INTEGER NOT NULL,
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vector_ledger_message ON vector_ledger(message_id);

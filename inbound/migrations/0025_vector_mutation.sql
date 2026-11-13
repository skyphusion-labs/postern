-- #963: when an upserted vector becomes QUERYABLE. Vectorize mutations are asynchronous: the
-- upsert returns a mutation id, and the index serves the vectors only after it has processed
-- that mutation (describe(): processedUpToDatetime). The ledger row was written when the upsert
-- was sent, so it could not say whether a fresh message was searchable yet.
--   mutation_id  the upsert's mutationId (UUIDv4; NULL on a binding that returns none)
--   upserted_ms  Worker Date.now() when the upsert returned (the mutation is in the log by then)
-- Rows from before this migration stay NULL in both.
--
-- ADDITIVE ONLY (ALTER TABLE ... ADD COLUMN, nullable, no default), so the #112 deploy gate
-- applies it with no marker. schema.sql carries the same columns for a fresh DB.

ALTER TABLE vector_ledger ADD COLUMN mutation_id TEXT;
ALTER TABLE vector_ledger ADD COLUMN upserted_ms INTEGER;

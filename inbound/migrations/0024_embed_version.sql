-- #813: which embed recipe each vector was built with (inbound/src/embedtext.ts
-- EMBED_VERSION). Existing rows were built by recipe 1 (body chunks only), hence the
-- default. Reconcile counts messages below the current recipe, and
-- POST /api/admin/reindex {staleOnly: true} re-embeds only those.
--
-- ADDITIVE ONLY (ALTER TABLE ... ADD COLUMN), so the #112 deploy gate applies it with no
-- marker. schema.sql carries the same column for a fresh DB.

ALTER TABLE vector_ledger ADD COLUMN embed_version INTEGER NOT NULL DEFAULT 1;

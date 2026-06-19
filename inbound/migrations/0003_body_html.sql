-- Webmail HTML email (#57): keep the original HTML body so the webmail can render
-- it in a sandboxed iframe. Apply once to an existing DB. ALTER ADD COLUMN is not
-- IF NOT EXISTS; re-running errors harmlessly if already applied -- skip in that
-- case. schema.sql carries the column for a fresh DB.
--
-- Nullable and backward-compatible: existing rows stay NULL (text-only render),
-- nothing breaks. body_text remains the FTS index source and the render fallback;
-- this only adds the HTML alongside it.
ALTER TABLE messages ADD COLUMN body_html TEXT;

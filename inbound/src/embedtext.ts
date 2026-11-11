// What postern embeds for semantic search (#813). PURE: no imports, so the live index
// path, the backfill, reconcile, delete and the offline recall eval (inbound/eval/) all
// build exactly the same text from the same function.
//
// EMBED_VERSION names the recipe. It is stored on every vector_ledger row (migration
// 0024), so reconcile can count messages still embedded by an older recipe and the
// reindex can re-embed only those (`staleOnly`).
//   1: body chunks only (before #813).
//   2: chunk 0 carries "Subject: <subject>" ahead of the body. Short and templated mail
//      is often ALL subject, and v1 never embedded it. A message with an empty body but
//      a subject gets one subject-only chunk (v1 gave it none).

export const EMBED_VERSION = 2;

// ONE place, so live ingest and the backfill chunk identically: with the deterministic
// vector id, a backfilled vector is byte-identical to the live one for the same message.
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;
export const MAX_CHUNKS = 24; // bound embed cost on huge mail
/** bge-base takes 512 tokens per input; 1200 chars of body is about 300, so a capped
 *  subject keeps chunk 0 well inside it. */
export const SUBJECT_CAP = 200;

export function chunkText(text: string, chunk: number, overlap: number): string[] {
  const t = text.trim();
  if (t.length <= chunk) return t.length ? [t] : [];
  const out: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + chunk, t.length);
    if (end < t.length) {
      const ws = t.lastIndexOf(" ", end);
      if (ws > start + chunk * 0.5) end = ws;
    }
    out.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    start = end - overlap;
  }
  return out.filter(Boolean);
}

/** The texts one message embeds as, in chunk order. Chunk i's vector id is
 *  `<sha256(messageId)[:56]>.<i>` whatever the recipe, so a re-embed overwrites in place. */
export function embedChunks(subject: string, bodyText: string, version: number = EMBED_VERSION): string[] {
  const chunks = chunkText(bodyText, CHUNK_SIZE, CHUNK_OVERLAP).slice(0, MAX_CHUNKS);
  if (version < 2) return chunks;
  const s = (subject ?? "").replace(/\s+/g, " ").trim().slice(0, SUBJECT_CAP);
  if (!s) return chunks;
  const head = `Subject: ${s}`;
  if (chunks.length === 0) return [head];
  return [`${head}\n\n${chunks[0]}`, ...chunks.slice(1)];
}

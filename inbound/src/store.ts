// The store (docs/CONTRACT.md section 1): the ONLY code that touches D1, R2, and
// Vectorize. Both directions go through store.put() -- ingest() for received mail
// (#22) and mailbox.send()/reply() for the sent copy (#27) -- so threads are
// complete and the data model has a single owner.

import { sha256hex, chunkText } from "./ingest";

/** A message row plus its attachment metadata. Column names are the field names. */
export interface StoredMessage {
  messageId: string;
  direction: "inbound" | "outbound";
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string; // ISO
  inReplyTo: string | null;
  bodyText: string;
  /** Original HTML body when the message had one (null otherwise). The webmail
   * renders this in a sandboxed iframe; bodyText stays the FTS + fallback source. */
  bodyHtml: string | null;
  auth: { spf: string; dkim: string; dmarc: string };
  trusted: boolean;
  receivedAt: string; // ISO
  attachments: AttachmentMeta[];
}

export interface AttachmentMeta {
  filename: string | null;
  mime: string | null;
  size: number;
}

/** List view: a message without its body or attachment bytes; carries a count. */
export interface StoredMessageSummary {
  messageId: string;
  direction: "inbound" | "outbound";
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  inReplyTo: string | null;
  trusted: boolean;
  receivedAt: string;
  attachmentCount: number;
}

export interface ListQuery {
  to?: string;
  from?: string;
  thread?: string;
  direction?: "inbound" | "outbound";
  q?: string; // FTS over subject + body
  limit?: number; // default 50, max 200
  cursor?: string; // opaque; encodes (date, id) of the last row
}

export interface SearchQuery {
  q: string;
  mode?: "fts" | "semantic" | "hybrid"; // semantic/hybrid land in M4
  limit?: number;
  cursor?: string;
}

/** One page of results. cursor=null means there are no more. */
export interface Page<T> {
  items: T[];
  cursor: string | null;
}

export interface SearchHit {
  message: StoredMessageSummary;
  score?: number;
  snippet?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Normalized input to store.put(). messageId is already normalized (<>-stripped,
 * sha256 if >64 chars) by the caller. references is the parsed References list
 * (newest last) used for thread resolution; attachments carry raw bytes for R2.
 */
export interface StoreInput {
  messageId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  subject: string;
  date: string; // ISO
  inReplyTo?: string | null;
  references?: string[];
  bodyText: string;
  /** Original HTML body to persist, if any (null/undefined when text-only). */
  bodyHtml?: string | null;
  auth: { spf: string; dkim: string; dmarc: string };
  trusted: boolean;
  attachments?: { filename?: string; mimeType?: string; content: ArrayBuffer }[];
  /** Opt-in Vectorize indexing for this recipient (inbound RAG). */
  vectorize?: boolean;
}

export interface PutResult {
  messageId: string;
  stored: boolean; // false on a dedup hit
  threadId: string;
}

/**
 * Resolve the conversation a message belongs to (CONTRACT section 1):
 *   1. in_reply_to matches an existing row -> inherit its thread_id
 *   2. else any id in references matches an existing row -> inherit that thread_id
 *   3. else new thread: thread_id = this messageId
 */
async function resolveThreadId(
  db: D1Database,
  messageId: string,
  inReplyTo: string | null | undefined,
  references: string[] | undefined,
): Promise<string> {
  const candidates: string[] = [];
  if (inReplyTo) candidates.push(stripAngle(inReplyTo));
  // References: check most-recent first (closest parent wins).
  for (const r of (references ?? []).slice().reverse()) {
    const id = stripAngle(r);
    if (id && !candidates.includes(id)) candidates.push(id);
  }
  for (const parentId of candidates) {
    const row = await db
      .prepare("SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1")
      .bind(parentId)
      .first<{ thread_id: string | null }>();
    if (row && row.thread_id) return row.thread_id;
  }
  return messageId;
}

function stripAngle(s: string): string {
  return s.replace(/[<>]/g, "").trim();
}

/**
 * Insert a message (either direction) and resolve its thread. INSERT OR IGNORE
 * keeps message_id UNIQUE dedup; the FTS5 triggers stay in sync automatically.
 * Attachments (R2) and opt-in Vectorize run via ctx.waitUntil (best-effort).
 */
export async function put(env: Env, input: StoreInput, ctx: ExecutionContext): Promise<PutResult> {
  const receivedAt = new Date().toISOString();
  const threadId = await resolveThreadId(env.DB, input.messageId, input.inReplyTo, input.references);

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages
       (message_id, from_addr, to_addr, subject, date, in_reply_to,
        body_text, body_html, spf, dkim, dmarc, trusted, received_at, direction, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.messageId,
      input.from,
      input.to,
      input.subject,
      input.date,
      input.inReplyTo ?? null,
      input.bodyText,
      input.bodyHtml ?? null,
      input.auth.spf,
      input.auth.dkim,
      input.auth.dmarc,
      input.trusted ? 1 : 0,
      receivedAt,
      input.direction,
      threadId,
    )
    .run();

  if (result.meta.changes === 0) {
    // Dedup hit: return the existing row's thread so callers stay consistent.
    const existing = await env.DB.prepare("SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1")
      .bind(input.messageId)
      .first<{ thread_id: string | null }>();
    return { messageId: input.messageId, stored: false, threadId: existing?.thread_id ?? threadId };
  }

  const attachments = input.attachments ?? [];
  if (attachments.length > 0) {
    ctx.waitUntil(storeAttachments(env, input.messageId, attachments, receivedAt));
  }

  if (input.vectorize && input.bodyText.length > 0) {
    ctx.waitUntil(indexVectors(env, input));
  }

  return { messageId: input.messageId, stored: true, threadId };
}

async function storeAttachments(
  env: Env,
  messageId: string,
  attachments: { filename?: string; mimeType?: string; content: ArrayBuffer }[],
  receivedAt: string,
): Promise<void> {
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    try {
      const bytes = att.content;
      if (!bytes || bytes.byteLength === 0) continue;
      const safeName = (att.filename || `attachment-${i}`).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
      const key = `att/${messageId}/${i}-${safeName}`;
      await env.ATTACHMENTS.put(key, bytes, {
        httpMetadata: { contentType: att.mimeType || "application/octet-stream" },
      });
      await env.DB.prepare(
        `INSERT INTO attachments (message_id, filename, mime, size, r2_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(messageId, att.filename ?? null, att.mimeType ?? null, bytes.byteLength, key, receivedAt)
        .run();
    } catch (e) {
      console.error("attachment store failed", i, e);
    }
  }
}

async function indexVectors(env: Env, input: StoreInput): Promise<void> {
  // Skip cleanly when the AI/Vectorize bindings are not configured (a deployment
  // that does not want semantic recall just omits them); never throw from the
  // best-effort indexing path.
  if (!env.AI || !env.VECTORIZE) return;
  try {
    const chunks = chunkText(input.bodyText, 1200, 150).slice(0, 24); // bound cost on huge mail
    const base = (await sha256hex(input.messageId)).slice(0, 56);
    const embed = (await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: chunks })) as { data: number[][] };
    const vectors = embed.data.map((values, i) => ({
      id: `${base}.${i}`,
      values,
      metadata: {
        message_id: input.messageId,
        chunk: i,
        from: input.from,
        to: input.to.toLowerCase(),
        date: input.date,
        subject: input.subject,
      },
    }));
    if (vectors.length) await env.VECTORIZE.upsert(vectors);
  } catch (e) {
    console.error("vectorize upsert failed", e);
  }
}

// --- Reads (CONTRACT section 1 / section 4) ---

interface MessageRow {
  message_id: string;
  direction: string;
  thread_id: string | null;
  from_addr: string;
  to_addr: string;
  subject: string;
  date: string;
  in_reply_to: string | null;
  body_text: string;
  body_html: string | null;
  spf: string;
  dkim: string;
  dmarc: string;
  trusted: number;
  received_at: string;
}

function rowToMessage(row: MessageRow, attachments: AttachmentMeta[]): StoredMessage {
  return {
    messageId: row.message_id,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    threadId: row.thread_id ?? row.message_id,
    from: row.from_addr,
    to: row.to_addr,
    subject: row.subject,
    date: row.date,
    inReplyTo: row.in_reply_to,
    bodyText: row.body_text,
    bodyHtml: row.body_html ?? null,
    auth: { spf: row.spf, dkim: row.dkim, dmarc: row.dmarc },
    trusted: row.trusted === 1,
    receivedAt: row.received_at,
    attachments,
  };
}

async function attachmentsFor(db: D1Database, messageId: string): Promise<AttachmentMeta[]> {
  const res = await db
    .prepare("SELECT filename, mime, size FROM attachments WHERE message_id = ? ORDER BY id")
    .bind(messageId)
    .all<{ filename: string | null; mime: string | null; size: number }>();
  return (res.results ?? []).map((a) => ({ filename: a.filename, mime: a.mime, size: a.size }));
}

/** One attachment's bytes + metadata, addressed by its 0-based index in the
 * message's attachment list (the same order store.get returns: ORDER BY id).
 * Returns null if the message/index does not exist or the R2 object is gone. */
export interface AttachmentBytes {
  body: ReadableStream;
  filename: string | null;
  mime: string | null;
  size: number;
}

export async function getAttachment(
  env: Env,
  messageId: string,
  index: number,
): Promise<AttachmentBytes | null> {
  if (!Number.isInteger(index) || index < 0) return null;
  // LIMIT 1 OFFSET index over the same ORDER BY id the metadata list uses, so the
  // API index lines up 1:1 with the attachments[] the caller saw in store.get.
  const row = await env.DB.prepare(
    `SELECT filename, mime, size, r2_key FROM attachments
       WHERE message_id = ? ORDER BY id LIMIT 1 OFFSET ?`,
  )
    .bind(messageId, index)
    .first<{ filename: string | null; mime: string | null; size: number; r2_key: string }>();
  if (!row) return null;
  const obj = await env.ATTACHMENTS.get(row.r2_key);
  if (!obj) return null;
  return { body: obj.body, filename: row.filename, mime: row.mime, size: row.size };
}

/** Full message + attachment metadata, or null if not found. */
export async function get(env: Env, messageId: string): Promise<StoredMessage | null> {
  const row = await env.DB.prepare(
    `SELECT message_id, direction, thread_id, from_addr, to_addr, subject, date,
            in_reply_to, body_text, body_html, spf, dkim, dmarc, trusted, received_at
       FROM messages WHERE message_id = ? LIMIT 1`,
  )
    .bind(messageId)
    .first<MessageRow>();
  if (!row) return null;
  return rowToMessage(row, await attachmentsFor(env.DB, messageId));
}

/** All messages in a thread, oldest first. */
export async function thread(env: Env, threadId: string): Promise<StoredMessage[]> {
  const res = await env.DB.prepare(
    `SELECT message_id, direction, thread_id, from_addr, to_addr, subject, date,
            in_reply_to, body_text, body_html, spf, dkim, dmarc, trusted, received_at
       FROM messages WHERE thread_id = ? ORDER BY date, id`,
  )
    .bind(threadId)
    .all<MessageRow>();
  const rows = res.results ?? [];
  const out: StoredMessage[] = [];
  for (const row of rows) {
    out.push(rowToMessage(row, await attachmentsFor(env.DB, row.message_id)));
  }
  return out;
}

// --- List / search (CONTRACT section 1 / section 4) ---

// Summary rows carry the rowid for keyset pagination + an attachment count, but
// not the body. Ordering is (date DESC, id DESC); the cursor encodes the last
// (date, id) so the next page is a strict keyset seek, stable under inserts.
interface SummaryRow {
  id: number;
  message_id: string;
  direction: string;
  thread_id: string | null;
  from_addr: string;
  to_addr: string;
  subject: string;
  date: string;
  in_reply_to: string | null;
  trusted: number;
  received_at: string;
  attachment_count: number;
}

function rowToSummary(row: SummaryRow): StoredMessageSummary {
  return {
    messageId: row.message_id,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    threadId: row.thread_id ?? row.message_id,
    from: row.from_addr,
    to: row.to_addr,
    subject: row.subject,
    date: row.date,
    inReplyTo: row.in_reply_to,
    trusted: row.trusted === 1,
    receivedAt: row.received_at,
    attachmentCount: row.attachment_count,
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function encodeCursor(date: string, id: number): string {
  // Opaque to callers; base64url of the keyset tuple.
  return btoa(JSON.stringify([date, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string | undefined): { date: string; id: number } | null {
  if (!cursor) return null;
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(b64)) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "number") {
      return { date: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

// Turn arbitrary user text into a safe FTS5 MATCH expression. FTS5 query syntax
// would otherwise throw on quotes/operators (and could be abused), so we extract
// word tokens and quote each as a phrase, OR-joined. Empty input -> no MATCH.
function toFtsQuery(q: string): string {
  const tokens = (q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * List / filter messages, newest first, keyset-paginated. q (when present) is an
 * FTS match over subject + body. All filter values are bound params; the FTS
 * query is sanitized to a phrase expression (no injection, no syntax errors).
 */
export async function list(env: Env, q: ListQuery): Promise<Page<StoredMessageSummary>> {
  const limit = clampLimit(q.limit);
  const where: string[] = [];
  const binds: unknown[] = [];

  const useFts = typeof q.q === "string" && q.q.trim().length > 0;
  const ftsExpr = useFts ? toFtsQuery(q.q as string) : "";

  if (useFts && ftsExpr) {
    where.push("m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
    binds.push(ftsExpr);
  } else if (useFts && !ftsExpr) {
    // q was all punctuation/whitespace: matches nothing.
    return { items: [], cursor: null };
  }

  if (q.to) {
    where.push("lower(m.to_addr) LIKE ?");
    binds.push(`%${q.to.toLowerCase()}%`);
  }
  if (q.from) {
    where.push("lower(m.from_addr) LIKE ?");
    binds.push(`%${q.from.toLowerCase()}%`);
  }
  if (q.thread) {
    where.push("m.thread_id = ?");
    binds.push(q.thread);
  }
  if (q.direction === "inbound" || q.direction === "outbound") {
    where.push("m.direction = ?");
    binds.push(q.direction);
  }

  const cur = decodeCursor(q.cursor);
  if (cur) {
    // Keyset seek: rows strictly older than the cursor tuple (date, id).
    where.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
    binds.push(cur.date, cur.date, cur.id);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at,
            (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.message_id) AS attachment_count
       FROM messages m ${whereSql}
      ORDER BY m.date DESC, m.id DESC
      LIMIT ?`;
  // Fetch one extra row to know whether another page exists.
  binds.push(limit + 1);

  const res = await env.DB.prepare(sql).bind(...binds).all<SummaryRow>();
  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = page.map(rowToSummary);
  const last = page[page.length - 1];
  const cursor = hasMore && last ? encodeCursor(last.date, last.id) : null;
  return { items, cursor };
}

/**
 * Search messages (CONTRACT section 4). Three modes:
 *   - fts (default): SQLite FTS5 over subject + body, newest-first, keyset-paged.
 *   - semantic (M4): query the Vectorize index that ingest already populates --
 *     embed the query with the same model, find the nearest chunk vectors,
 *     collapse to unique messages (best chunk score wins), hydrate from D1.
 *   - hybrid (M4): run both and merge by message_id on a normalized score.
 * Returns SearchHit (the #24 summary, no body) so the read shape is uniform.
 *
 * fts is date-ordered and cursor-paged. semantic/hybrid are SCORE-ranked, so a
 * date keyset cursor does not apply: they return a single ranked page (cursor
 * always null) of up to `limit` hits. Paging a re-ranked semantic set is a
 * post-v1 nicety, noted not built.
 */
export async function search(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const mode = q.mode ?? "fts";
  switch (mode) {
    case "fts":
      return ftsSearch(env, q);
    case "semantic":
      return semanticSearch(env, q);
    case "hybrid":
      return hybridSearch(env, q);
    default:
      throw new SearchModeUnsupported(mode);
  }
}

async function ftsSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  const ftsExpr = toFtsQuery(q.q ?? "");
  if (!ftsExpr) return { items: [], cursor: null };

  const binds: unknown[] = [ftsExpr];
  const where: string[] = ["m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"];

  const cur = decodeCursor(q.cursor);
  if (cur) {
    where.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
    binds.push(cur.date, cur.date, cur.id);
  }

  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at,
            (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.message_id) AS attachment_count
       FROM messages m WHERE ${where.join(" AND ")}
      ORDER BY m.date DESC, m.id DESC
      LIMIT ?`;
  binds.push(limit + 1);

  const res = await env.DB.prepare(sql).bind(...binds).all<SummaryRow>();
  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items: SearchHit[] = page.map((row) => ({ message: rowToSummary(row) }));
  const last = page[page.length - 1];
  const cursor = hasMore && last ? encodeCursor(last.date, last.id) : null;
  return { items, cursor };
}

// Embed a query string with the same model + binding ingest uses, so the query
// vector lives in the same space as the indexed chunk vectors.
async function embedQuery(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  const embed = (await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [text] })) as { data: number[][] };
  const vec = embed?.data?.[0];
  return Array.isArray(vec) && vec.length > 0 ? vec : null;
}

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: { message_id?: string } | null;
}

// Nearest message ids for a query, best chunk-score per message. Vectorize is
// chunk-granular (ingest upserts one vector per body window), so we collapse to
// unique message_id keeping the max score, then take the top `limit` messages.
async function nearestMessageIds(
  env: Env,
  queryVec: number[],
  limit: number,
): Promise<{ messageId: string; score: number }[]> {
  if (!env.VECTORIZE) return [];
  // Over-fetch chunks so collapsing to messages still yields ~limit of them.
  const topK = Math.min(50, Math.max(limit * 3, limit));
  const res = (await env.VECTORIZE.query(queryVec, {
    topK,
    returnMetadata: "all",
  })) as { matches?: VectorizeMatch[] };
  const best = new Map<string, number>();
  for (const m of res.matches ?? []) {
    const id = m.metadata?.message_id;
    if (!id) continue;
    const prev = best.get(id);
    if (prev === undefined || m.score > prev) best.set(id, m.score);
  }
  return [...best.entries()]
    .map(([messageId, score]) => ({ messageId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Hydrate summaries for a set of message ids in one query, returned as a map so
// callers can preserve their own (score) ordering. Ids are bound params.
async function summariesByIds(env: Env, ids: string[]): Promise<Map<string, StoredMessageSummary>> {
  const out = new Map<string, StoredMessageSummary>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(", ");
  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at,
            (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.message_id) AS attachment_count
       FROM messages m WHERE m.message_id IN (${placeholders})`;
  const res = await env.DB.prepare(sql).bind(...ids).all<SummaryRow>();
  for (const row of res.results ?? []) out.set(row.message_id, rowToSummary(row));
  return out;
}

async function semanticSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  const text = (q.q ?? "").trim();
  if (!text) return { items: [], cursor: null };

  const queryVec = await embedQuery(env, text);
  if (!queryVec) return { items: [], cursor: null }; // AI binding unavailable

  const ranked = await nearestMessageIds(env, queryVec, limit);
  const summaries = await summariesByIds(env, ranked.map((r) => r.messageId));
  const items: SearchHit[] = [];
  for (const r of ranked) {
    const message = summaries.get(r.messageId);
    if (message) items.push({ message, score: r.score });
  }
  // Score-ranked: single page, no date cursor.
  return { items, cursor: null };
}

async function hybridSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  // Pull each side, then merge by message_id on a normalized 0..1 score and sum.
  const [ftsPage, semPage] = await Promise.all([
    ftsSearch(env, { q: q.q, mode: "fts", limit }),
    semanticSearch(env, { q: q.q, mode: "semantic", limit }),
  ]);

  const merged = new Map<string, SearchHit & { score: number }>();
  // FTS hits are date-ranked, not scored; give them a uniform rank-decayed score
  // so order is preserved within the FTS contribution.
  ftsPage.items.forEach((hit, i) => {
    const score = (ftsPage.items.length - i) / ftsPage.items.length; // 1..~0
    merged.set(hit.message.messageId, { message: hit.message, score });
  });
  // Vectorize cosine scores are already ~0..1; add into the blend.
  for (const hit of semPage.items) {
    const id = hit.message.messageId;
    const add = hit.score ?? 0;
    const existing = merged.get(id);
    if (existing) existing.score += add;
    else merged.set(id, { message: hit.message, score: add });
  }

  const items: SearchHit[] = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => ({ message: h.message, score: h.score }));
  return { items, cursor: null };
}

/** Thrown when a search mode is requested before it ships (semantic/hybrid = M4). */
export class SearchModeUnsupported extends Error {
  readonly code = "E_VALIDATION_ERROR";
  readonly status = 400;
  constructor(mode: string) {
    super(`search mode '${mode}' is not supported yet (fts only until M4)`);
    this.name = "SearchModeUnsupported";
  }
}

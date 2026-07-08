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
  /** Read state (#seen): has this message been read? Inbound mail arrives unseen
   *  (false); the mailbox's own outbound sent copies are stored seen (true). Flipped
   *  by POST /api/messages/seen (the IMAP \Seen flag / a webmail "mark read"). The
   *  human doors surface it as unread; agents can ignore it. */
  seen: boolean;
  // --- M8 envelope fidelity v2 (#189). All nullable: absent = a pre-v2 row that
  //     renders exactly as before. Header-fidelity fields are the raw RFC 5322
  //     headers as they arrived (display names and all); deliveredTo is the
  //     normalized envelope-recipient set the mailbox views filter on. ---
  cc: string | null; // raw Cc header
  bcc: string | null; // raw Bcc header, outbound only (inbound Bcc is not on our wire)
  sender: string | null; // raw Sender header
  replyTo: string | null; // raw Reply-To header
  deliveredTo: string[]; // bare lower-cased delivered recipients; pre-v2 fallback [to_addr]
  wireSize: number | null; // raw RFC822 byte size at intake
  attachments: AttachmentMeta[];
}

export interface AttachmentMeta {
  filename: string | null;
  mime: string | null;
  size: number;
}

/** List view: a message without its body or attachment bytes; carries a count. */
export interface StoredMessageSummary {
  /**
   * Monotonic insertion key (#103): the store's AUTOINCREMENT rowid, assigned
   * strictly ascending at ARRIVAL and never reused. This is the durable IMAP UID
   * the proxy maps each message to (RFC 3501): order the mailbox by this value
   * (arrival order) and surface it as the message UID under a constant
   * UIDVALIDITY. Unlike the `date` field, it does not move when a backdated
   * message arrives -- that message simply gets the next-highest uid and appears
   * last, so a client's cached uid -> message mapping never points at the wrong
   * body. Always present and > 0.
   */
  uid: number;
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
  /** Read state (#seen): false = unread. Mirrors StoredMessage.seen so a list/search
   *  summary drives the unread view without a per-message body fetch. */
  seen: boolean;
  // M8 (#189): same envelope-fidelity fields as StoredMessage, so a list/search
  // summary can render Cc/Reply-To and answer "mail for X" on the delivered set.
  cc: string | null;
  bcc: string | null;
  sender: string | null;
  replyTo: string | null;
  deliveredTo: string[];
  wireSize: number | null;
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

export type SearchField = "subject" | "body" | "text";

export interface SearchQuery {
  q: string;
  mode?: "fts" | "substr" | "semantic" | "hybrid"; // substr = #212; semantic/hybrid = M4
  // substr only (#212): which column(s) the substring matches; default "text".
  field?: SearchField;
  // Restrict to one direction (#128); undefined = both. Validated at the API edge.
  direction?: "inbound" | "outbound";
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
  // --- M8 envelope fidelity v2 (#189) ---
  /** Bare lower-cased recipients this message was DELIVERED to. Inbound: the one
   *  envelope recipient per delivery (merged into the existing row on a dedup hit,
   *  #178). Outbound: the full to+cc+bcc set, complete at insert. When omitted the
   *  store derives it from `to` (back-compat), so delivered_to is never null. */
  deliveredTo?: string[];
  /** Raw header-fidelity strings (as they arrived / were sent); null = absent. */
  cc?: string | null;
  bcc?: string | null;
  sender?: string | null;
  replyTo?: string | null;
  /** Raw RFC822 wire byte size at intake; null/omitted for outbound. */
  wireSize?: number | null;
}

export interface PutResult {
  messageId: string;
  // stored: a NEW row was inserted (first delivery). merged: an existing row's
  // delivered_to gained a new envelope recipient (#178). Both false = a true
  // dedup no-op (a retry/loop of an already-recorded delivery). Attachments, FTS,
  // and Vectorize run ONLY when stored is true.
  stored: boolean;
  merged: boolean;
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
 * Insert a message (either direction) and resolve its thread. message_id stays the
 * UNIQUE identity: a same-Message-ID redelivery to a NEW recipient MERGES into the
 * existing row's delivered_to (#178) instead of forking identity or dropping the
 * copy; a redelivery to an already-recorded recipient is a true no-op. The FTS5
 * triggers stay in sync automatically. Attachments (R2) and opt-in Vectorize run
 * via ctx.waitUntil (best-effort) ONLY on a first insert (PutResult.stored).
 */
export async function put(env: Env, input: StoreInput, ctx: ExecutionContext): Promise<PutResult> {
  const receivedAt = new Date().toISOString();
  const threadId = await resolveThreadId(env.DB, input.messageId, input.inReplyTo, input.references);

  // Envelope semantics (#178): the deduped, bare lower-cased set this delivery is
  // FOR, wrapped ",a,b," so membership is one delimiter-safe LIKE. Derived from
  // `to` when a caller omits deliveredTo, so the column is never null.
  const deliveredList = normalizeDelivered(input.deliveredTo, input.to);
  const deliveredSet = `,${deliveredList.join(",")},`;
  // The single recipient the merge appends on a dedup hit. Inbound delivers one
  // envelope recipient per invocation, so this is that address; outbound writes
  // its full set complete at insert and never conflicts (we mint unique ids).
  const mergeRcpt = deliveredList[0];

  // ONE atomic upsert, safe under CF's concurrent per-recipient invocations of the
  // SAME Message-ID (#178). On conflict we MERGE the new recipient into the row's
  // delivered_to rather than fork the message identity (which would duplicate body
  // storage, search hits, and embeddings). The DO UPDATE ... WHERE makes an
  // already-present recipient a true no-op (RETURNING then emits no row). We
  // distinguish the three outcomes from this single statement via RETURNING
  // is_fresh = (delivered_to == the value we tried to INSERT): 1 only on a real
  // insert, since a merge rebuilds delivered_to from the EXISTING row and differs.
  const res = await env.DB.prepare(
    `INSERT INTO messages
       (message_id, from_addr, to_addr, subject, date, in_reply_to,
        body_text, body_html, spf, dkim, dmarc, trusted, received_at, direction, thread_id,
        delivered_to, cc_addr, bcc_addr, sender_addr, reply_to_addr, wire_size, seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       delivered_to = COALESCE(messages.delivered_to, ',' || messages.to_addr || ',') || ? || ','
       WHERE COALESCE(messages.delivered_to, ',' || messages.to_addr || ',') NOT LIKE '%,' || ? || ',%'
     RETURNING thread_id, (delivered_to = ?) AS is_fresh`,
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
      deliveredSet,
      input.cc ?? null,
      input.bcc ?? null,
      input.sender ?? null,
      input.replyTo ?? null,
      input.wireSize ?? null,
      // Inbound mail arrives UNREAD; the mailbox's own sent copies are stored read
      // (a human never wants their own Sent items flagged unread). Flipped later via
      // setSeen() (the IMAP \Seen flag). The ON CONFLICT merge below never touches
      // seen, so a redelivery to a new recipient keeps the row's current read state.
      input.direction === "outbound" ? 1 : 0,
      mergeRcpt,
      mergeRcpt,
      deliveredSet,
    )
    .all<{ thread_id: string | null; is_fresh: number }>();

  const returned = (res.results ?? [])[0];
  if (!returned) {
    // DO UPDATE WHERE was false: this exact recipient is already on the row (a
    // retry / delivery loop). True dedup, no-op; resolve the thread for a
    // consistent return.
    const existing = await env.DB.prepare("SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1")
      .bind(input.messageId)
      .first<{ thread_id: string | null }>();
    return { messageId: input.messageId, stored: false, merged: false, threadId: existing?.thread_id ?? threadId };
  }

  const rowThreadId = returned.thread_id ?? threadId;
  if (returned.is_fresh !== 1) {
    // Conflict + a NEW recipient appended: a merge, not a new message. The one-time
    // side effects already ran on the first insert; a merge touches one column.
    return { messageId: input.messageId, stored: false, merged: true, threadId: rowThreadId };
  }

  // A brand-new row: run the one-time side effects.
  const attachments = input.attachments ?? [];
  if (attachments.length > 0) {
    ctx.waitUntil(storeAttachments(env, input.messageId, attachments, receivedAt));
  }

  if (input.vectorize && input.bodyText.length > 0) {
    ctx.waitUntil(indexVectors(env, input));
  }

  return { messageId: input.messageId, stored: true, merged: false, threadId: rowThreadId };
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

// Chunking parameters: ONE place so the live index path and the backfill (#116
// ws4) chunk identically, which (with the deterministic vector id) makes a
// backfilled vector byte-identical to the live one for the same message.
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS = 24; // bound embed cost on huge mail

/** The fields embedAndUpsert needs from a message (a subset of StoreInput, also
 *  reconstructable from a stored row for the backfill). */
export interface VectorizeFields {
  messageId: string;
  bodyText: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  date: string;
  subject: string;
}

/** plannedChunks is how many chunk-vectors a body WOULD produce, without
 *  embedding -- used by the reindex dry run to total the cost up front. */
export function plannedChunks(bodyText: string): number {
  if (bodyText.length === 0) return 0;
  return chunkText(bodyText, CHUNK_SIZE, CHUNK_OVERLAP).slice(0, MAX_CHUNKS).length;
}

/**
 * embedAndUpsert chunks the body, embeds each chunk (bge-base), and upserts the
 * vectors keyed by a DETERMINISTIC id (sha256(messageId).slice + chunk), so a
 * re-run OVERWRITES rather than duplicates -- the backfill is idempotent. Returns
 * the number of vectors written. The SINGLE source of vector construction: both
 * the live store.put path (via indexVectors) and the #116 ws4 backfill call it, so
 * their vectors are identical. Unlike indexVectors this THROWS on failure, so a
 * backfill page fails loud instead of silently skipping a message.
 */
export async function embedAndUpsert(env: Env, f: VectorizeFields): Promise<number> {
  if (!env.AI || !env.VECTORIZE) return 0;
  if (f.bodyText.length === 0) return 0;
  const chunks = chunkText(f.bodyText, CHUNK_SIZE, CHUNK_OVERLAP).slice(0, MAX_CHUNKS);
  if (chunks.length === 0) return 0;
  const base = (await sha256hex(f.messageId)).slice(0, 56);
  const embed = (await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: chunks })) as { data: number[][] };
  const vectors = embed.data.map((values, i) => ({
    id: `${base}.${i}`,
    values,
    metadata: {
      message_id: f.messageId,
      chunk: i,
      // direction (#116 ws2) lets a query attribute / filter "what WE said"
      // (outbound) vs "what was asked" (inbound) -- e.g. a status question wants
      // the outbound reply. inbound | outbound.
      direction: f.direction,
      from: f.from,
      to: f.to.toLowerCase(),
      date: f.date,
      subject: f.subject,
    },
  }));
  if (vectors.length) await env.VECTORIZE.upsert(vectors);
  return vectors.length;
}

async function indexVectors(env: Env, input: StoreInput): Promise<void> {
  // Best-effort on the live path: never throw out of store.put. The backfill calls
  // embedAndUpsert directly so it CAN see failures.
  try {
    await embedAndUpsert(env, {
      messageId: input.messageId,
      bodyText: input.bodyText,
      direction: input.direction,
      from: input.from,
      to: input.to,
      date: input.date,
      subject: input.subject,
    });
  } catch (e) {
    console.error("vectorize upsert failed", e);
  }
}

// --- Vectorize gating (single source for the live path AND the backfill, #116) ---

/** Parse VECTORIZE_FOR into a normalized allowlist (empty = index everything). */
export function vectorizeAllowlist(env: Env): string[] {
  return (env.VECTORIZE_FOR ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * shouldVectorize is the opt-in RAG gate, identical for live ingest and backfill:
 * outbound mail is ALWAYS indexed (it is our own); inbound only when the allowlist
 * is empty (index-all, the current default) or one of the recipients opted in.
 */
export function shouldVectorize(allowlist: string[], direction: "inbound" | "outbound", recipients: string[]): boolean {
  if (direction === "outbound") return true;
  if (allowlist.length === 0) return true;
  return recipients.some((r) => allowlist.includes(r));
}

/** Extract bare lower-cased addresses from a stored to_addr (which may be a
 *  comma-list and/or carry display names), for the backfill gate. */
export function parseRecipients(toAddr: string): string[] {
  return toAddr
    .split(",")
    .map((part) => {
      // [^<>] (not [^>]) so failed attempts cannot rescan overlapping spans;
      // with [^>]+ a sender-controlled to_addr full of "<" is quadratic (ReDoS, alert #26).
      const angle = part.match(/<([^<>]+)>/);
      return (angle ? angle[1] : part).trim().toLowerCase();
    })
    .filter(Boolean);
}

/** Build the deduped, bare, lower-cased delivered-recipient list for delivered_to
 *  (#178). Prefer an explicit deliveredTo; else derive from the to_addr string (a
 *  back-compat caller). Never empty (to_addr is always present), so delivered_to
 *  is never null and the merge / is_fresh discriminator in put() always applies. */
export function normalizeDelivered(deliveredTo: string[] | undefined, toAddr: string): string[] {
  const raw = deliveredTo && deliveredTo.length > 0 ? deliveredTo : parseRecipients(toAddr);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of raw) {
    const bare = a.trim().toLowerCase();
    if (bare && !seen.has(bare)) {
      seen.add(bare);
      out.push(bare);
    }
  }
  if (out.length === 0) {
    const fallback = toAddr.trim().toLowerCase();
    if (fallback) out.push(fallback);
  }
  return out;
}

/** Parse a stored delivered_to (",a,b,") into its member list. NULL/empty falls
 *  back to [toAddr] (a pre-0006 row's single envelope address), so old rows carry
 *  a sensible deliveredTo without a backfill. */
function parseDeliveredTo(deliveredTo: string | null, toAddr: string): string[] {
  if (!deliveredTo) return [toAddr];
  const members = deliveredTo.split(",").map((s) => s.trim()).filter(Boolean);
  return members.length > 0 ? members : [toAddr];
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
  seen: number;
  delivered_to: string | null;
  cc_addr: string | null;
  bcc_addr: string | null;
  sender_addr: string | null;
  reply_to_addr: string | null;
  wire_size: number | null;
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
    seen: row.seen === 1,
    cc: row.cc_addr ?? null,
    bcc: row.bcc_addr ?? null,
    sender: row.sender_addr ?? null,
    replyTo: row.reply_to_addr ?? null,
    deliveredTo: parseDeliveredTo(row.delivered_to, row.to_addr),
    wireSize: row.wire_size ?? null,
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

/**
 * Set the read state (#seen) on a set of messages by message_id, returning how many
 * rows changed. The single writer for the seen flag: the IMAP \Seen store, a webmail
 * "mark (un)read", or any API client. Idempotent -- setting a row to its current state
 * is a no-op (SQLite reports 0 changes). Unknown ids are silently skipped (they simply
 * match no row). An empty id list is a no-op that never touches D1.
 */
export async function setSeen(env: Env, messageIds: string[], seen: boolean): Promise<number> {
  if (messageIds.length === 0) return 0;
  const placeholders = messageIds.map(() => "?").join(", ");
  const res = await env.DB.prepare(
    `UPDATE messages SET seen = ? WHERE message_id IN (${placeholders})`,
  )
    .bind(seen ? 1 : 0, ...messageIds)
    .run();
  return res.meta?.changes ?? 0;
}

/** Full message + attachment metadata, or null if not found. */
export async function get(env: Env, messageId: string): Promise<StoredMessage | null> {
  const row = await env.DB.prepare(
    `SELECT message_id, direction, thread_id, from_addr, to_addr, subject, date,
            in_reply_to, body_text, body_html, spf, dkim, dmarc, trusted, received_at, seen,
            delivered_to, cc_addr, bcc_addr, sender_addr, reply_to_addr, wire_size
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
            in_reply_to, body_text, body_html, spf, dkim, dmarc, trusted, received_at, seen,
            delivered_to, cc_addr, bcc_addr, sender_addr, reply_to_addr, wire_size
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
  seen: number;
  delivered_to: string | null;
  cc_addr: string | null;
  bcc_addr: string | null;
  sender_addr: string | null;
  reply_to_addr: string | null;
  wire_size: number | null;
  attachment_count: number;
}

function rowToSummary(row: SummaryRow): StoredMessageSummary {
  return {
    uid: row.id,
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
    seen: row.seen === 1,
    cc: row.cc_addr ?? null,
    bcc: row.bcc_addr ?? null,
    sender: row.sender_addr ?? null,
    replyTo: row.reply_to_addr ?? null,
    deliveredTo: parseDeliveredTo(row.delivered_to, row.to_addr),
    wireSize: row.wire_size ?? null,
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
    // Envelope-membership filter (#178/#189): "mail for X" matches the delivered
    // set, falling back to a pre-v2 row's to_addr via COALESCE, so a message to
    // support@ AND security@ shows in BOTH views. Bind the bare lower-cased
    // address; the leading/trailing commas make it a delimiter-safe membership
    // test (no substring false-positives, no string surgery).
    where.push("COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE '%,' || ? || ',%'");
    binds.push(q.to.trim().toLowerCase());
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
            m.date, m.in_reply_to, m.trusted, m.received_at, m.seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
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
 *   - substr (#212): exact case-insensitive substring over subject/body or the
 *     served header columns (field-selectable), for IMAP SEARCH parity.
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
    case "substr":
      return substrSearch(env, q);
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

  // Optional direction restriction (#128). Bound after the FTS expr, before the
  // cursor tuple, so the keyset order the fake interprets stays consistent.
  if (q.direction === "inbound" || q.direction === "outbound") {
    where.push("m.direction = ?");
    binds.push(q.direction);
  }

  const cur = decodeCursor(q.cursor);
  if (cur) {
    where.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
    binds.push(cur.date, cur.date, cur.id);
  }

  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at, m.seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
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

// --- mode=substr: exact case-insensitive substring for IMAP SEARCH parity (#212) ---
//
// IMAP SEARCH SUBJECT/BODY/TEXT are case-insensitive SUBSTRING matches (RFC 3501),
// which mode=fts (FTS5 word-token OR) cannot express. substr is the exact-substring
// predicate the imap door (#148) pushes to. See CONTRACT.md 10.8.

// The header columns TEXT covers: every header the store SERVES in the rendered
// projection, UNION body_text. Post-M8 from_addr/to_addr hold RAW header fidelity
// (display names included), so a display-name substring matches. Headers we never
// store (Received, X-*) are not searchable, and that is the spec-true posture.
const SUBSTR_TEXT_COLUMNS = [
  "subject",
  "from_addr",
  "to_addr",
  "cc_addr",
  "bcc_addr",
  "sender_addr",
  "reply_to_addr",
  "message_id",
  "in_reply_to",
  "body_text",
] as const;

function substrColumns(field: SearchField): readonly string[] {
  switch (field) {
    case "subject":
      return ["subject"];
    case "body":
      return ["body_text"];
    case "text":
    default:
      return SUBSTR_TEXT_COLUMNS;
  }
}

// Escape LIKE metacharacters, BACKSLASH FIRST (CONTRACT 10.8): the ESCAPE char
// itself must be escaped before the wildcards, or a literal backslash in q would
// corrupt the following escape. Order: \ -> \\, then % -> \%, then _ -> \_.
function escapeLikePattern(raw: string): string {
  const esc = raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `%${esc}%`;
}

async function substrSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  const raw = q.q ?? "";
  if (!raw) return { items: [], cursor: null };

  const cols = substrColumns(q.field ?? "text");
  const pattern = escapeLikePattern(raw);

  // Case-insensitivity is SQLite LIKE's native ASCII folding (CONTRACT 10.8);
  // COALESCE(col,'') keeps a NULL header column from nulling the OR. One bind of
  // the same pattern per column, bound BEFORE direction/cursor so the fake's
  // in-order bind walk stays consistent with the live query.
  const binds: unknown[] = [];
  const orClause = cols.map((c) => `COALESCE(m.${c},'') LIKE ? ESCAPE '\\'`).join(" OR ");
  for (let k = 0; k < cols.length; k++) binds.push(pattern);
  const where: string[] = [`(${orClause})`];

  if (q.direction === "inbound" || q.direction === "outbound") {
    where.push("m.direction = ?");
    binds.push(q.direction);
  }

  const cur = decodeCursor(q.cursor);
  if (cur) {
    where.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
    binds.push(cur.date, cur.date, cur.id);
  }

  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at, m.seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
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
            m.date, m.in_reply_to, m.trusted, m.received_at, m.seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
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
    if (!message) continue;
    // Direction restriction (#128): the vector index is not direction-keyed, so
    // filter the hydrated summaries (cheap: at most `limit` of them).
    if (q.direction && message.direction !== q.direction) continue;
    items.push({ message, score: r.score });
  }
  // Score-ranked: single page, no date cursor.
  return { items, cursor: null };
}

async function hybridSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  // Pull each side, then merge by message_id on a normalized 0..1 score and sum.
  const [ftsPage, semPage] = await Promise.all([
    ftsSearch(env, { q: q.q, mode: "fts", limit, direction: q.direction }),
    semanticSearch(env, { q: q.q, mode: "semantic", limit, direction: q.direction }),
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

// --- Backfill / re-embed the existing mailbox (#116 ws4) ---

const DEFAULT_REINDEX_LIMIT = 25;
const MAX_REINDEX_LIMIT = 50;

function clampReindexLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_REINDEX_LIMIT;
  return Math.min(Math.floor(limit), MAX_REINDEX_LIMIT);
}

/** One message's fields needed to (re)embed it, fetched in a single paged query. */
interface ReindexRow {
  id: number;
  message_id: string;
  direction: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  date: string;
  body_text: string;
}

export interface ReindexResult {
  /** Total messages in the store; present ONLY on the first call (no cursor) so a
   *  runner can show progress without an extra round-trip. */
  total?: number;
  processed: number; // messages examined this page
  indexed: number; // messages actually embedded this page (0 on a dry run)
  vectors: number; // chunk-vectors written this page (or that WOULD be, on a dry run)
  skippedByGate: number; // inbound messages excluded by the VECTORIZE_FOR allowlist
  nextCursor: string | null;
  done: boolean;
  dryRun: boolean;
}

/** countMessages totals the store, for the runner's progress denominator. */
export async function countMessages(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
  return row?.n ?? 0;
}

/** pageForReindex keyset-pages the messages table by the SAME (date DESC, id DESC)
 *  order + opaque cursor the read API uses, pulling body_text + the metadata fields
 *  in one query (no N+1). */
async function pageForReindex(
  env: Env,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: ReindexRow[]; nextCursor: string | null }> {
  const cur = decodeCursor(cursor);
  const binds: unknown[] = [];
  let where = "";
  if (cur) {
    where = " WHERE (date < ? OR (date = ? AND id < ?))";
    binds.push(cur.date, cur.date, cur.id);
  }
  const sql =
    "SELECT id, message_id, direction, from_addr, to_addr, subject, date, body_text" +
    ` FROM messages${where} ORDER BY date DESC, id DESC LIMIT ?`;
  binds.push(limit + 1); // fetch one extra to detect a next page
  const res = await env.DB.prepare(sql).bind(...binds).all<ReindexRow>();
  const all = res.results ?? [];
  const hasMore = all.length > limit;
  const rows = hasMore ? all.slice(0, limit) : all;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.date, last.id) : null;
  return { rows, nextCursor };
}

/**
 * reindexPage processes ONE page of the backfill (#116 ws4): for each message it
 * applies the SAME VECTORIZE_FOR gate as live ingest, then (unless dryRun) embeds
 * and upserts via the shared embedAndUpsert, so backfilled vectors are identical
 * to live ones and re-runs overwrite (idempotent). A dry run does everything except
 * the embed/upsert, summing the chunk count so the exact cost is known up front. It
 * returns the next cursor; a thin runner loops until done.
 */
export async function reindexPage(
  env: Env,
  opts: { cursor?: string; limit?: number; dryRun?: boolean },
): Promise<ReindexResult> {
  const dryRun = opts.dryRun === true;
  const allowlist = vectorizeAllowlist(env);
  const { rows, nextCursor } = await pageForReindex(env, opts.cursor, clampReindexLimit(opts.limit));

  let indexed = 0;
  let vectors = 0;
  let skippedByGate = 0;

  for (const r of rows) {
    const direction = r.direction === "outbound" ? "outbound" : "inbound";
    if (!shouldVectorize(allowlist, direction, parseRecipients(r.to_addr))) {
      skippedByGate++;
      continue;
    }
    const chunks = plannedChunks(r.body_text);
    if (chunks === 0) continue; // empty body: nothing to embed (not an allowlist skip)
    if (dryRun) {
      vectors += chunks;
      continue;
    }
    vectors += await embedAndUpsert(env, {
      messageId: r.message_id,
      bodyText: r.body_text,
      direction,
      from: r.from_addr,
      to: r.to_addr,
      date: r.date,
      subject: r.subject,
    });
    indexed++;
  }

  const result: ReindexResult = {
    processed: rows.length,
    indexed,
    vectors,
    skippedByGate,
    nextCursor,
    done: nextCursor === null,
    dryRun,
  };
  if (!opts.cursor) result.total = await countMessages(env);
  return result;
}

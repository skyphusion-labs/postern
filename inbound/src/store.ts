// The store (docs/CONTRACT.md section 1): the ONLY code that touches D1, R2, and
// Vectorize. Both directions go through store.put() -- ingest() for received mail
// (#22) and mailbox.send()/reply() for the sent copy (#27) -- so threads are
// complete and the data model has a single owner.

import { sha256hex, chunkText } from "./ingest";
import { PROJECTION_VERSION, projectRfc822Size } from "./rfc822Project";

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
  flagged: boolean;
  answered: boolean;
  mailbox: MailboxPlacement;
  trashedAt: string | null;
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
  /** Cached IMAP projection length (#342). Null on pre-0012 rows. */
  projectedSize: number | null;
  /** Renderer version that produced projectedSize; bump with UIDVALIDITY. */
  projectionVersion: number | null;
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
  flagged: boolean;
  answered: boolean;
  mailbox: MailboxPlacement;
  trashedAt: string | null;
  folderUid: number | null;
  // M8 (#189): same envelope-fidelity fields as StoredMessage, so a list/search
  // summary can render Cc/Reply-To and answer "mail for X" on the delivered set.
  cc: string | null;
  bcc: string | null;
  sender: string | null;
  replyTo: string | null;
  deliveredTo: string[];
  wireSize: number | null;
  /** Cached IMAP projection length (#342). Prefer for RFC822.SIZE. */
  projectedSize: number | null;
  projectionVersion: number | null;
  attachmentCount: number;
  /** True when the store holds a non-empty HTML body (#220). List/search summaries
   *  carry this body-free so the IMAP door can project multipart/alternative (plain
   *  + html) and serve Content-Type without a per-message body fetch. */
  hasHtml: boolean;
}

export interface ListQuery {
  to?: string;
  from?: string;
  thread?: string;
  direction?: "inbound" | "outbound";
  mailbox?: MailboxFilter;
  /** Internal account boundary for a bound webmail session. Unlike public `to`,
   * this includes the viewer's authored Sent rows in All while keeping Inbox
   * recipient-relative. Never accepted directly from a query parameter. */
  viewer?: string;
  q?: string; // FTS over subject + body
  limit?: number; // default 50, max 200
  cursor?: string; // opaque; encodes (date, id) of the last row
}

export type MailboxPlacement = "archive" | "trash" | "junk" | null;
export type MailboxFilter = MailboxPlacement | "all";

export type SearchField = "subject" | "body" | "text";

export interface SearchQuery {
  q: string;
  mode?: "fts" | "substr" | "semantic" | "hybrid"; // substr = #212; semantic/hybrid = M4
  // substr only (#212): which column(s) the substring matches; default "text".
  field?: SearchField;
  // Restrict to one direction (#128); undefined = both. Validated at the API edge.
  direction?: "inbound" | "outbound";
  // Viewer address for recipient-scoped search (#350): delivered-set membership +
  // viewer-relative INBOX + effective (per-recipient) seen, same as ListQuery.to.
  to?: string;
  // Sender filter (#366): same lower(from_addr) LIKE semantics as ListQuery.from,
  // so the IMAP Sent lens can push from=V server-side.
  from?: string;
  // Durable-folder scope (#352/#354): same semantics as ListQuery.mailbox across
  // EVERY search mode (fts/substr/semantic/hybrid). "all" = every placement,
  // archive|trash|junk = that placement only, undefined = mailbox IS NULL.
  mailbox?: string;
  /** Inclusive ISO date lower bound on messages.date (#354). */
  after?: string;
  /** Inclusive ISO date upper bound on messages.date (#354). */
  before?: string;
  /** true = has >=1 attachment; false = none (#354). */
  hasAttachment?: boolean;
  /** Filter on effective seen (viewer-aware when to/viewer set) (#354). */
  seen?: boolean;
  /** Internal bound-session account boundary; never caller-controlled. */
  viewer?: string;
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
/** Seed per-recipient unread overrides for a same-domain outbound send (#350).
 *  A message from a@ALLOWED to b@ALLOWED is stored once, direction=outbound,
 *  messages.seen=1 (the sender Sent view). Without this, b every new-mail lens
 *  misses it. We write a seen=0 override for each delivered recipient on
 *  ALLOWED_FROM_DOMAIN except the sender, so b viewer-scoped lens (to=b) shows it
 *  unread while a Sent view stays seen. External recipients never read through our
 *  lenses, so they get no override (keeps the table small). Runs only on a fresh
 *  outbound insert; ON CONFLICT DO NOTHING keeps it idempotent. */
async function seedSameDomainSeen(
  env: Env,
  messageId: string,
  from: string,
  deliveredList: string[],
): Promise<void> {
  const domain = (env.ALLOWED_FROM_DOMAIN || "skyphusion.org").toLowerCase();
  const sender = (parseRecipients(from)[0] || "").toLowerCase();
  const targets = deliveredList.filter(
    (r) => r.includes("@") && r !== sender && r.slice(r.lastIndexOf("@") + 1) === domain,
  );
  for (const r of targets) {
    await env.DB.prepare(
      "INSERT INTO message_seen_by (message_id, recipient, seen) VALUES (?, ?, 0) " +
        "ON CONFLICT(message_id, recipient) DO NOTHING",
    )
      .bind(messageId, r)
      .run();
  }
}

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
  // #342: project SIZE from D1-known fields only (attachment sizes known before
  // the waitUntil R2 write). storeAttachments refreshes if any part is skipped.
  const attMeta: AttachmentMeta[] = (input.attachments ?? [])
    .filter((a) => a.content && a.content.byteLength > 0)
    .map((a) => ({
      filename: a.filename ?? null,
      mime: a.mimeType ?? null,
      size: a.content.byteLength,
    }));
  const projectedSize = await projectRfc822Size({
    messageId: input.messageId,
    from: input.from,
    to: input.to,
    subject: input.subject,
    date: input.date,
    inReplyTo: input.inReplyTo ?? null,
    cc: input.cc ?? null,
    bcc: input.bcc ?? null,
    sender: input.sender ?? null,
    replyTo: input.replyTo ?? null,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml ?? null,
    attachments: attMeta,
  });

  const res = await env.DB.prepare(
    `INSERT INTO messages
       (message_id, from_addr, to_addr, subject, date, in_reply_to,
        body_text, body_html, spf, dkim, dmarc, trusted, received_at, direction, thread_id,
        delivered_to, cc_addr, bcc_addr, sender_addr, reply_to_addr, wire_size,
        projected_size, projection_version, seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      projectedSize,
      PROJECTION_VERSION,
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

  // Same-domain outbound (#350): seed per-recipient unread overrides so the
  // recipient new-mail lens surfaces it while the sender Sent view stays seen.
  if (input.direction === "outbound") {
    await seedSameDomainSeen(env, input.messageId, input.from, deliveredList);
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
  // Refresh from the attachment rows that actually landed (skips/errors may differ
  // from the pre-insert projection that assumed every non-empty part would store).
  await refreshProjectedSize(env, messageId);
}

/** Recompute projected_size from D1 body + attachment metadata (no R2 reads). */
export async function refreshProjectedSize(env: Env, messageId: string): Promise<void> {
  const msg = await get(env, messageId);
  if (!msg) return;
  const size = await projectRfc822Size({
    messageId: msg.messageId,
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    date: msg.date,
    inReplyTo: msg.inReplyTo,
    cc: msg.cc,
    bcc: msg.bcc,
    sender: msg.sender,
    replyTo: msg.replyTo,
    bodyText: msg.bodyText,
    bodyHtml: msg.bodyHtml,
    attachments: msg.attachments,
  });
  await env.DB.prepare(
    "UPDATE messages SET projected_size = ?, projection_version = ? WHERE message_id = ?",
  )
    .bind(size, PROJECTION_VERSION, messageId)
    .run();
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

/** Deterministic Vectorize ids for a message (sha256hex(messageId)[:56].chunk). */
export async function vectorIdsForMessage(messageId: string, chunkCount: number): Promise<string[]> {
  if (chunkCount <= 0) return [];
  const base = (await sha256hex(messageId)).slice(0, 56);
  return Array.from({ length: chunkCount }, (_, i) => `${base}.${i}`);
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
  const ids = await vectorIdsForMessage(f.messageId, chunks.length);
  const embed = (await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: chunks })) as { data: number[][] };
  const vectors = embed.data.map((values, i) => ({
    id: ids[i],
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
  if (vectors.length) await syncVectorLedger(env, f.messageId, ids);
  return vectors.length;
}

/** Record the chunk-vector ids upserted for a message (#279 id-ledger). */
async function syncVectorLedger(env: Env, messageId: string, vectorIds: string[]): Promise<void> {
  if (!env.DB || vectorIds.length === 0) return;
  await env.DB.prepare("DELETE FROM vector_ledger WHERE message_id = ?").bind(messageId).run();
  for (let i = 0; i < vectorIds.length; i++) {
    await env.DB.prepare(
      "INSERT INTO vector_ledger (vector_id, message_id, chunk, indexed_at) VALUES (?, ?, ?, datetime('now'))",
    )
      .bind(vectorIds[i], messageId, i)
      .run();
  }
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
  projected_size: number | null;
  projection_version: number | null;
  flagged: number;
  answered: number;
  mailbox: string | null;
  trashed_at: string | null;
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
    flagged: row.flagged === 1,
    answered: row.answered === 1,
    mailbox: normalizeMailbox(row.mailbox),
    trashedAt: row.trashed_at ?? null,
    cc: row.cc_addr ?? null,
    bcc: row.bcc_addr ?? null,
    sender: row.sender_addr ?? null,
    replyTo: row.reply_to_addr ?? null,
    deliveredTo: parseDeliveredTo(row.delivered_to, row.to_addr),
    wireSize: row.wire_size ?? null,
    projectedSize: row.projected_size ?? null,
    projectionVersion: row.projection_version ?? null,
    attachments,
  };
}

function normalizeMailbox(value: string | null): MailboxPlacement {
  return value === "archive" || value === "trash" || value === "junk" ? value : null;
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
export async function setSeen(
  env: Env,
  messageIds: string[],
  seen: boolean,
  forRecipient?: string,
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const placeholders = messageIds.map(() => "?").join(", ");

  // Scoped (#350): mark read/unread for ONE recipient -- upsert a sparse override
  // in message_seen_by, never touching messages.seen (the estate/legacy flag).
  // Only existing messages get an override (unknown ids are skipped, as legacy
  // does), so a scoped mark never seeds junk for a message that is not stored.
  if (forRecipient) {
    const recipient = forRecipient.trim().toLowerCase();
    const existing = await env.DB.prepare(
      `SELECT message_id FROM messages WHERE message_id IN (${placeholders})`,
    )
      .bind(...messageIds)
      .all<{ message_id: string }>();
    const ids = (existing.results ?? []).map((r) => r.message_id);
    for (const id of ids) {
      await env.DB.prepare(
        "INSERT INTO message_seen_by (message_id, recipient, seen) VALUES (?, ?, ?) " +
          "ON CONFLICT(message_id, recipient) DO UPDATE SET seen = excluded.seen",
      )
        .bind(id, recipient, seen ? 1 : 0)
        .run();
    }
    return ids.length;
  }

  // Legacy/estate (no recipient): set the row-level flag AND realign any EXISTING
  // per-recipient overrides for those ids, so the estate lens stays authoritative
  // when a caller uses it (#350). RETURNING (not meta.changes): the AFTER UPDATE FTS
  // trigger fires per row and its shadow-table writes inflate meta.changes, so it is
  // not a reliable count of message rows touched. RETURNING yields exactly one row
  // per matched message row (trigger rows never appear), so results.length is the
  // true count of existing ids updated.
  const res = await env.DB.prepare(
    `UPDATE messages SET seen = ? WHERE message_id IN (${placeholders}) RETURNING message_id`,
  )
    .bind(seen ? 1 : 0, ...messageIds)
    .all<{ message_id: string }>();
  await env.DB.prepare(
    `UPDATE message_seen_by SET seen = ? WHERE message_id IN (${placeholders})`,
  )
    .bind(seen ? 1 : 0, ...messageIds)
    .run();
  return (res.results ?? []).length;
}

/** Persist \Flagged / \Answered beside the existing durable \Seen flag. */
export async function setFlags(
  env: Env,
  messageIds: string[],
  set: { flagged?: boolean; answered?: boolean },
  viewer?: string,
): Promise<number> {
  if (messageIds.length === 0 || (set.flagged === undefined && set.answered === undefined)) return 0;
  const assignments: string[] = [];
  const binds: unknown[] = [];
  if (set.flagged !== undefined) {
    assignments.push("flagged = ?");
    binds.push(set.flagged ? 1 : 0);
  }
  if (set.answered !== undefined) {
    assignments.push("answered = ?");
    binds.push(set.answered ? 1 : 0);
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  let access = "";
  if (viewer) {
    access =
      " AND (COALESCE(delivered_to, ',' || to_addr || ',') LIKE '%,' || ? || ',%' OR lower(from_addr) = ?)";
  }
  const res = await env.DB.prepare(
    `UPDATE messages SET ${assignments.join(", ")} WHERE message_id IN (${placeholders})${access} RETURNING message_id`,
  )
    .bind(...binds, ...messageIds, ...(viewer ? [viewer.toLowerCase(), viewer.toLowerCase()] : []))
    .all<{ message_id: string }>();
  return (res.results ?? []).length;
}

async function ensureFolderCounter(env: Env, folder: string): Promise<{ nextUid: number; uidvalidity: number }> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO mailbox_uid_counter (folder, next_uid, uidvalidity) VALUES (?, 1, ?)",
  )
    .bind(folder, Math.floor(Date.now() / 1000))
    .run();
  const current = await env.DB.prepare(
    "SELECT next_uid, uidvalidity FROM mailbox_uid_counter WHERE folder = ?",
  )
    .bind(folder)
    .first<{ next_uid: number; uidvalidity: number }>();
  if (!current) throw new Error(`failed to initialize UID counter for ${folder}`);
  return { nextUid: current.next_uid, uidvalidity: current.uidvalidity };
}

async function allocateFolderUid(env: Env, folder: string): Promise<{ uid: number; uidvalidity: number }> {
  await ensureFolderCounter(env, folder);
  const row = await env.DB.prepare(
    "UPDATE mailbox_uid_counter SET next_uid = next_uid + 1 WHERE folder = ? " +
      "RETURNING next_uid - 1 AS uid, uidvalidity",
  )
    .bind(folder)
    .first<{ uid: number; uidvalidity: number }>();
  if (!row) throw new Error(`failed to allocate UID for ${folder}`);
  return row;
}

/** Move messages between the mutually-exclusive durable system boxes. */
export async function moveMessages(
  env: Env,
  messageIds: string[],
  mailbox: MailboxPlacement,
  viewer?: string,
): Promise<number> {
  let updated = 0;
  for (const id of messageIds) {
    const row = await env.DB.prepare(
      "SELECT mailbox FROM messages WHERE message_id = ? " +
        (viewer
          ? "AND (COALESCE(delivered_to, ',' || to_addr || ',') LIKE '%,' || ? || ',%' OR lower(from_addr) = ?)"
          : ""),
    )
      .bind(id, ...(viewer ? [viewer.toLowerCase(), viewer.toLowerCase()] : []))
      .first<{ mailbox: string | null }>();
    if (!row || normalizeMailbox(row.mailbox) === mailbox) continue;

    const placement = mailbox ? await allocateFolderUid(env, mailbox) : null;
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare(
        "UPDATE messages SET mailbox = ?, trashed_at = ? WHERE message_id = ?",
      ).bind(mailbox, mailbox === "trash" ? now : null, id),
      env.DB.prepare("DELETE FROM mailbox_placement WHERE message_id = ?").bind(id),
    ];
    if (mailbox && placement) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO mailbox_placement (message_id, folder, folder_uid, added_at) VALUES (?, ?, ?, ?)",
        ).bind(id, mailbox, placement.uid, now),
      );
    }
    await env.DB.batch(statements);
    updated++;
  }
  return updated;
}

export interface Draft {
  id: string;
  identity: string;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  inReplyTo: string | null;
  threadId: string | null;
  composeMode: DraftComposeMode;
  sourceMessageId: string | null;
  uid: number;
  createdAt: string;
  updatedAt: string;
}

interface DraftRow {
  id: string;
  identity: string;
  to_addr: string | null;
  cc_addr: string | null;
  bcc_addr: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  compose_mode: string;
  source_message_id: string | null;
  uid: number;
  created_at: string;
  updated_at: string;
}

function rowToDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    identity: row.identity,
    to: row.to_addr,
    cc: row.cc_addr,
    bcc: row.bcc_addr,
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    inReplyTo: row.in_reply_to,
    threadId: row.thread_id,
    composeMode: normalizeDraftMode(row.compose_mode),
    sourceMessageId: row.source_message_id,
    uid: row.uid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type DraftComposeMode = "new" | "reply" | "replyAll" | "forward";

function normalizeDraftMode(value: string | null | undefined): DraftComposeMode {
  return value === "reply" || value === "replyAll" || value === "forward" ? value : "new";
}

export interface DraftInput {
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  inReplyTo: string | null;
  threadId: string | null;
  composeMode?: DraftComposeMode;
  sourceMessageId?: string | null;
}

const DRAFT_COLUMNS =
  "id, identity, to_addr, cc_addr, bcc_addr, subject, body_text, body_html, in_reply_to, thread_id, " +
  "compose_mode, source_message_id, uid, created_at, updated_at";

export async function listDrafts(env: Env, identity: string): Promise<Draft[]> {
  const res = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE identity = ? ORDER BY updated_at DESC`,
  )
    .bind(identity.toLowerCase())
    .all<DraftRow>();
  return (res.results ?? []).map(rowToDraft);
}

export async function getDraft(env: Env, id: string, identity: string): Promise<Draft | null> {
  const row = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ? AND identity = ? LIMIT 1`,
  )
    .bind(id, identity.toLowerCase())
    .first<DraftRow>();
  return row ? rowToDraft(row) : null;
}

/** Owning identity of a draft id, regardless of caller identity, or null if it doesn't exist. */
export async function getDraftOwner(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT identity FROM drafts WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ identity: string }>();
  return row ? row.identity : null;
}

export async function putDraft(
  env: Env,
  id: string,
  identity: string,
  input: DraftInput,
  expectedUpdatedAt?: string,
): Promise<{ draft: Draft; conflict: boolean }> {
  const owner = identity.toLowerCase();
  const current = await getDraft(env, id, owner);
  if (current && expectedUpdatedAt !== current.updatedAt) return { draft: current, conflict: true };
  const { uid } = await allocateFolderUid(env, "drafts");
  const nowDate = new Date();
  if (current && nowDate.toISOString() <= current.updatedAt) nowDate.setTime(Date.parse(current.updatedAt) + 1);
  const now = nowDate.toISOString();
  if (current) {
    await env.DB.prepare(
      "UPDATE drafts SET to_addr=?, cc_addr=?, bcc_addr=?, subject=?, body_text=?, body_html=?, " +
        "in_reply_to=?, thread_id=?, compose_mode=?, source_message_id=?, uid=?, updated_at=? WHERE id=? AND identity=?",
    )
      .bind(input.to, input.cc, input.bcc, input.subject, input.bodyText, input.bodyHtml,
        input.inReplyTo, input.threadId, normalizeDraftMode(input.composeMode), input.sourceMessageId ?? null,
        uid, now, id, owner)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO drafts (id, identity, to_addr, cc_addr, bcc_addr, subject, body_text, body_html, " +
        "in_reply_to, thread_id, compose_mode, source_message_id, uid, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, owner, input.to, input.cc, input.bcc, input.subject, input.bodyText, input.bodyHtml,
        input.inReplyTo, input.threadId, normalizeDraftMode(input.composeMode), input.sourceMessageId ?? null,
        uid, now, now)
      .run();
  }
  return { draft: (await getDraft(env, id, owner))!, conflict: false };
}

export async function deleteDraft(env: Env, id: string, identity: string): Promise<boolean> {
  await deleteAllDraftAttachments(env, id, identity);
  const res = await env.DB.prepare("DELETE FROM drafts WHERE id = ? AND identity = ?")
    .bind(id, identity.toLowerCase())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export interface DraftAttachment {
  id: string;
  draftId: string;
  filename: string | null;
  mime: string | null;
  size: number;
  createdAt: string;
}

interface DraftAttachmentRow {
  id: string;
  draft_id: string;
  filename: string | null;
  mime: string | null;
  size: number;
  r2_key: string;
  created_at: string;
}

function draftAttachmentMeta(row: DraftAttachmentRow): DraftAttachment {
  return {
    id: row.id,
    draftId: row.draft_id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    createdAt: row.created_at,
  };
}

export async function listDraftAttachments(
  env: Env,
  draftId: string,
  identity: string,
): Promise<DraftAttachment[]> {
  const res = await env.DB.prepare(
    "SELECT id, draft_id, filename, mime, size, r2_key, created_at FROM draft_attachments " +
      "WHERE draft_id = ? AND identity = ? ORDER BY created_at, id",
  )
    .bind(draftId, identity.toLowerCase())
    .all<DraftAttachmentRow>();
  return (res.results ?? []).map(draftAttachmentMeta);
}

export async function draftAttachmentUsage(
  env: Env,
  draftId: string,
  identity: string,
): Promise<{ count: number; bytes: number }> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM draft_attachments " +
      "WHERE draft_id = ? AND identity = ?",
  )
    .bind(draftId, identity.toLowerCase())
    .first<{ count: number; bytes: number }>();
  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export async function putDraftAttachment(
  env: Env,
  draftId: string,
  identity: string,
  input: { filename?: string; mime?: string; content: ArrayBuffer },
): Promise<DraftAttachment> {
  const owner = identity.toLowerCase();
  if (!(await getDraft(env, draftId, owner))) throw new Error("draft not found");
  const id = crypto.randomUUID();
  const safeName = (input.filename || "attachment").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  const key = `drafts/${draftId}/${id}-${safeName}`;
  const now = new Date().toISOString();
  await env.ATTACHMENTS.put(key, input.content, {
    httpMetadata: { contentType: input.mime || "application/octet-stream" },
  });
  try {
    await env.DB.prepare(
      "INSERT INTO draft_attachments (id, draft_id, identity, filename, mime, size, r2_key, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, draftId, owner, input.filename ?? null, input.mime ?? null, input.content.byteLength, key, now)
      .run();
  } catch (error) {
    await env.ATTACHMENTS.delete(key);
    throw error;
  }
  return { id, draftId, filename: input.filename ?? null, mime: input.mime ?? null, size: input.content.byteLength, createdAt: now };
}

export async function loadDraftAttachments(
  env: Env,
  draftId: string,
  identity: string,
): Promise<Array<{ id: string; filename?: string; mimeType?: string; content: ArrayBuffer }>> {
  const res = await env.DB.prepare(
    "SELECT id, draft_id, filename, mime, size, r2_key, created_at FROM draft_attachments " +
      "WHERE draft_id = ? AND identity = ? ORDER BY created_at, id",
  )
    .bind(draftId, identity.toLowerCase())
    .all<DraftAttachmentRow>();
  const out: Array<{ id: string; filename?: string; mimeType?: string; content: ArrayBuffer }> = [];
  for (const row of res.results ?? []) {
    const object = await env.ATTACHMENTS.get(row.r2_key);
    if (!object) throw new Error(`draft attachment ${row.id} bytes are missing`);
    out.push({
      id: row.id,
      ...(row.filename ? { filename: row.filename } : {}),
      ...(row.mime ? { mimeType: row.mime } : {}),
      content: await object.arrayBuffer(),
    });
  }
  return out;
}

export async function deleteDraftAttachment(
  env: Env,
  draftId: string,
  identity: string,
  attachmentId: string,
): Promise<boolean> {
  const owner = identity.toLowerCase();
  const row = await env.DB.prepare(
    "SELECT r2_key FROM draft_attachments WHERE id = ? AND draft_id = ? AND identity = ? LIMIT 1",
  )
    .bind(attachmentId, draftId, owner)
    .first<{ r2_key: string }>();
  if (!row) return false;
  await env.ATTACHMENTS.delete(row.r2_key);
  const result = await env.DB.prepare(
    "DELETE FROM draft_attachments WHERE id = ? AND draft_id = ? AND identity = ?",
  )
    .bind(attachmentId, draftId, owner)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function deleteAllDraftAttachments(env: Env, draftId: string, identity: string): Promise<void> {
  const owner = identity.toLowerCase();
  const rows = await env.DB.prepare(
    "SELECT r2_key FROM draft_attachments WHERE draft_id = ? AND identity = ?",
  )
    .bind(draftId, owner)
    .all<{ r2_key: string }>();
  for (const row of rows.results ?? []) await env.ATTACHMENTS.delete(row.r2_key);
  await env.DB.prepare("DELETE FROM draft_attachments WHERE draft_id = ? AND identity = ?")
    .bind(draftId, owner)
    .run();
}

export async function messageAccessible(
  env: Env,
  id: string,
  identity: string,
  requireTrash = false,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT message_id FROM messages WHERE message_id = ? " +
      "AND (COALESCE(delivered_to, ',' || to_addr || ',') LIKE '%,' || ? || ',%' OR lower(from_addr) = ?) " +
      (requireTrash ? "AND mailbox = 'trash' " : "") +
      "LIMIT 1",
  )
    .bind(id, identity.toLowerCase(), identity.toLowerCase())
    .first<{ message_id: string }>();
  return !!row;
}

/** Batch-delete Vectorize ids (20/call cap matches getByIds). */
async function deleteVectorIds(env: Env, ids: string[]): Promise<void> {
  if (!env.VECTORIZE || ids.length === 0) return;
  const batch = 20; // Vectorize getByIds/deleteByIds payload cap
  for (let i = 0; i < ids.length; i += batch) {
    await env.VECTORIZE.deleteByIds(ids.slice(i, i + batch));
  }
}

/** Vector ids to tombstone on delete: ledger first, else computed from body (#279). */
async function vectorIdsForDelete(env: Env, messageId: string, bodyText: string): Promise<string[]> {
  if (env.DB) {
    const res = await env.DB.prepare(
      "SELECT vector_id FROM vector_ledger WHERE message_id = ? ORDER BY chunk",
    )
      .bind(messageId)
      .all<{ vector_id: string }>();
    const rows = res.results ?? [];
    if (rows.length > 0) return rows.map((r) => r.vector_id);
  }
  const chunks = plannedChunks(bodyText);
  return vectorIdsForMessage(messageId, chunks);
}

/**
 * Hard-delete a message from the store, bundled with Vectorize tombstone (#278).
 * Removes D1 rows (messages + attachments + vector_ledger), deletes Vectorize
 * chunk-vectors, and purges attachment bytes from R2 (waitUntil). Returns false
 * when the message_id is unknown. Irreversible; admin-scoped at the API layer.
 */
export async function deleteMessage(
  env: Env,
  messageId: string,
  ctx?: ExecutionContext,
): Promise<boolean> {
  if (!env.DB) return false;
  const row = await env.DB.prepare("SELECT body_text FROM messages WHERE message_id = ? LIMIT 1")
    .bind(messageId)
    .first<{ body_text: string }>();
  if (!row) return false;

  const vectorIds = await vectorIdsForDelete(env, messageId, row.body_text);
  await deleteVectorIds(env, vectorIds);
  await env.DB.prepare("DELETE FROM vector_ledger WHERE message_id = ?").bind(messageId).run();
  await env.DB.prepare("DELETE FROM message_seen_by WHERE message_id = ?").bind(messageId).run();
  await env.DB.prepare("DELETE FROM mailbox_placement WHERE message_id = ?").bind(messageId).run();

  const attRes = await env.DB.prepare("SELECT r2_key FROM attachments WHERE message_id = ?")
    .bind(messageId)
    .all<{ r2_key: string }>();
  const r2Keys = (attRes.results ?? []).map((r) => r.r2_key);

  await env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(messageId).run();
  const del = await env.DB.prepare("DELETE FROM messages WHERE message_id = ?").bind(messageId).run();
  if ((del.meta?.changes ?? 0) === 0) return false;

  if (ctx && r2Keys.length > 0) {
    ctx.waitUntil(
      Promise.all(r2Keys.map((key) => env.ATTACHMENTS.delete(key))).then(() => undefined),
    );
  }
  return true;
}

/** Full message + attachment metadata, or null if not found. */
export async function get(env: Env, messageId: string): Promise<StoredMessage | null> {
  const row = await env.DB.prepare(
    `SELECT message_id, direction, thread_id, from_addr, to_addr, subject, date,
            in_reply_to, body_text, body_html, spf, dkim, dmarc, trusted, received_at, seen,
            delivered_to, cc_addr, bcc_addr, sender_addr, reply_to_addr, wire_size,
            projected_size, projection_version,
            flagged, answered, mailbox, trashed_at
       FROM messages WHERE message_id = ? LIMIT 1`,
  )
    .bind(messageId)
    .first<MessageRow>();
  if (!row) return null;
  return rowToMessage(row, await attachmentsFor(env.DB, messageId));
}

/** All messages in a thread, oldest first. */
export async function thread(env: Env, threadId: string, viewer?: string): Promise<StoredMessage[]> {
  const owner = viewer?.trim().toLowerCase();
  const res = await env.DB.prepare(
    `SELECT message_id, direction, thread_id, from_addr, to_addr, subject, date,
            in_reply_to, body_text, body_html, spf, dkim, dmarc, trusted, received_at, seen,
            delivered_to, cc_addr, bcc_addr, sender_addr, reply_to_addr, wire_size,
            projected_size, projection_version,
            flagged, answered, mailbox, trashed_at
       FROM messages WHERE thread_id = ? ${
         owner
           ? "AND (COALESCE(delivered_to, ',' || to_addr || ',') LIKE '%,' || ? || ',%' OR lower(from_addr) = ?)"
           : ""
       } ORDER BY date, id`,
  )
    .bind(threadId, ...(owner ? [owner, owner] : []))
    .all<MessageRow>();
  const rows = res.results ?? [];
  const out: StoredMessage[] = [];
  for (const row of rows) {
    out.push(rowToMessage(row, await attachmentsFor(env.DB, row.message_id)));
  }
  return out;
}

// --- Recipient-relative views (#350) --------------------------------------
//
// Two things that used to be row-global become viewer-relative when a query
// carries a viewer address (to=V): which direction-default view a message appears
// in, and whether it has been read. Both are additive: a query with no `to` keeps
// the estate lens (stored direction, messages.seen) exactly as before.

/** The `seen` projection for a read. With a viewer, effective seen is the sparse
 *  per-recipient override (message_seen_by) COALESCEd over the row-level
 *  messages.seen; without a viewer, the row-level flag as today. The bound `?`
 *  lives in the SELECT column list, so its bind MUST precede the WHERE binds. */
function seenProjection(viewer: string | undefined): { expr: string; binds: unknown[] } {
  if (!viewer) return { expr: "m.seen", binds: [] };
  return {
    expr:
      "COALESCE((SELECT sb.seen FROM message_seen_by sb " +
      "WHERE sb.message_id = m.message_id AND sb.recipient = ?), m.seen)",
    binds: [viewer],
  };
}

/** The (to + direction) WHERE fragments shared by list, fts, and substr search.
 *  - to=V: delivered-set membership (#178), COALESCE fallback to a v1 to_addr.
 *  - direction=inbound WITH to=V: viewer-relative INBOX (#350) -- inbound mail for
 *    V PLUS same-store outbound NOT authored by V, so a same-domain send lands in
 *    the recipient INBOX, not only the sender Sent. A true self-send (from=V)
 *    stays Sent-only (correct: you wrote it).
 *  - direction=outbound, or no viewer: the stored direction fact, unchanged.
 *  Outbound from_addr is a bare address by construction (mailbox.send), so the
 *  lower() compare is exact; the branch only inspects outbound rows anyway. */
function recipientWhere(
  viewer: string | undefined,
  direction: "inbound" | "outbound" | undefined,
): { membership: string | null; membershipBinds: unknown[]; direction: string | null; directionBinds: unknown[] } {
  const out = {
    membership: null as string | null,
    membershipBinds: [] as unknown[],
    direction: null as string | null,
    directionBinds: [] as unknown[],
  };
  if (viewer) {
    out.membership = "COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE '%,' || ? || ',%'";
    out.membershipBinds = [viewer];
  }
  if (direction === "inbound" || direction === "outbound") {
    if (viewer && direction === "inbound") {
      out.direction = "(m.direction = 'inbound' OR (m.direction = 'outbound' AND lower(m.from_addr) <> ?))";
      out.directionBinds = [viewer];
    } else {
      out.direction = "m.direction = ?";
      out.directionBinds = [direction];
    }
  }
  return out;
}

/** Account-owned view for a bound webmail session. */
function accountWhere(
  viewer: string,
  direction: "inbound" | "outbound" | undefined,
): { membership: string | null; membershipBinds: unknown[]; direction: string | null; directionBinds: unknown[] } {
  const delivered = "COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE '%,' || ? || ',%'";
  if (direction === "inbound") {
    return {
      membership: delivered,
      membershipBinds: [viewer],
      direction: "(m.direction = 'inbound' OR (m.direction = 'outbound' AND lower(m.from_addr) <> ?))",
      directionBinds: [viewer],
    };
  }
  if (direction === "outbound") {
    return {
      membership: null,
      membershipBinds: [],
      direction: "lower(m.from_addr) = ?",
      directionBinds: [viewer],
    };
  }
  return {
    membership: `(${delivered} OR lower(m.from_addr) = ?)`,
    membershipBinds: [viewer, viewer],
    direction: null,
    directionBinds: [],
  };
}

// --- List / search (CONTRACT section 1 / section 4) ---

// Summary rows carry the rowid for keyset pagination + attachment/hasHtml flags, but
// not the body. Ordering is (date DESC, id DESC); the cursor encodes the last
// (date, id) so the next page is a strict keyset seek, stable under inserts.
const SUMMARY_HAS_HTML_SQL =
  `(CASE WHEN m.body_html IS NOT NULL AND TRIM(m.body_html) <> '' THEN 1 ELSE 0 END) AS has_html`;

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
  projected_size: number | null;
  projection_version: number | null;
  has_html: number;
  attachment_count: number;
  flagged: number;
  answered: number;
  mailbox: string | null;
  trashed_at: string | null;
  folder_uid: number | null;
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
    projectedSize: row.projected_size ?? null,
    projectionVersion: row.projection_version ?? null,
    attachmentCount: row.attachment_count,
    hasHtml: row.has_html === 1,
    flagged: row.flagged === 1,
    answered: row.answered === 1,
    mailbox: normalizeMailbox(row.mailbox),
    trashedAt: row.trashed_at ?? null,
    folderUid: row.folder_uid ?? null,
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
  const accountViewer = q.viewer?.trim().toLowerCase() || undefined;
  const recipientViewer = q.to?.trim().toLowerCase() || undefined;
  const sp = seenProjection(accountViewer ?? recipientViewer);
  const seenExpr = sp.expr;
  const where: string[] = [];
  const binds: unknown[] = [...sp.binds];

  const useFts = typeof q.q === "string" && q.q.trim().length > 0;
  const ftsExpr = useFts ? toFtsQuery(q.q as string) : "";

  if (useFts && ftsExpr) {
    where.push("m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
    binds.push(ftsExpr);
  } else if (useFts && !ftsExpr) {
    // q was all punctuation/whitespace: matches nothing.
    return { items: [], cursor: null };
  }

  // Recipient view (#178 delivered-set membership) at the `to` slot; the direction
  // predicate (viewer-relative INBOX for #350) is appended AFTER from/thread so the
  // bind order stays stable. ONE builder for list, fts, and substr search.
  const rv = accountViewer
    ? accountWhere(accountViewer, q.direction)
    : recipientWhere(recipientViewer, q.direction);
  if (rv.membership) {
    where.push(rv.membership);
    binds.push(...rv.membershipBinds);
  }
  if (q.from) {
    where.push("lower(m.from_addr) LIKE ?");
    binds.push(`%${q.from.toLowerCase()}%`);
  }
  if (q.thread) {
    where.push("m.thread_id = ?");
    binds.push(q.thread);
  }
  if (rv.direction) {
    where.push(rv.direction);
    binds.push(...rv.directionBinds);
  }
  if (q.mailbox !== "all") {
    if (q.mailbox) {
      where.push("m.mailbox = ?");
      binds.push(q.mailbox);
    } else {
      where.push("m.mailbox IS NULL");
    }
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
            m.date, m.in_reply_to, m.trusted, m.received_at, ${seenExpr} AS seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
            m.projected_size, m.projection_version,
            m.flagged, m.answered, m.mailbox, m.trashed_at,
            (SELECT mp.folder_uid FROM mailbox_placement mp WHERE mp.message_id=m.message_id AND mp.folder=m.mailbox) AS folder_uid,
            ${SUMMARY_HAS_HTML_SQL},
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

export interface FolderSummary {
  id: "inbox" | "sent" | "all" | "drafts" | "trash" | "junk" | "archive";
  label: string;
  count: number;
  unread: number;
  /** Authoritative durable-folder UIDVALIDITY; absent on arrival views. */
  uidValidity?: number;
}

/** Server-authoritative folder counts using the same placement predicates as list. */
export async function folders(env: Env, viewer?: string): Promise<FolderSummary[]> {
  const identity = viewer?.trim().toLowerCase() || undefined;
  const access = identity
    ? "(COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE '%,' || ? || ',%' OR lower(m.from_addr) = ?)"
    : "1=1";
  const definitions: Array<[FolderSummary["id"], string, string]> = [
    ["inbox", "Inbox", identity
      ? "m.mailbox IS NULL AND " + access +
        " AND (m.direction='inbound' OR (m.direction='outbound' AND lower(m.from_addr) <> ?))"
      : "m.mailbox IS NULL AND m.direction='inbound'"],
    ["sent", "Sent", identity
      ? "m.mailbox IS NULL AND lower(m.from_addr) = ?"
      : "m.mailbox IS NULL AND m.direction='outbound'"],
    ["all", "All", access],
    ["trash", "Trash", `m.mailbox='trash' AND ${access}`],
    ["junk", "Junk", `m.mailbox='junk' AND ${access}`],
    ["archive", "Archive", `m.mailbox='archive' AND ${access}`],
  ];
  const result: FolderSummary[] = [];
  for (const [id, label, predicate] of definitions) {
    const binds: unknown[] = [];
    if (identity) {
      if (id === "sent") binds.push(identity);
      else if (id === "inbox") binds.push(identity, identity, identity);
      else binds.push(identity, identity);
    }
    const seen = seenProjection(identity);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count, SUM(CASE WHEN ${seen.expr}=0 THEN 1 ELSE 0 END) AS unread ` +
        `FROM messages m WHERE ${predicate}`,
    )
      .bind(...seen.binds, ...binds)
      .first<{ count: number; unread: number | null }>();
    const durable = id === "trash" || id === "junk" || id === "archive"
      ? await ensureFolderCounter(env, id)
      : null;
    result.push({
      id,
      label,
      count: Number(row?.count ?? 0),
      unread: Number(row?.unread ?? 0),
      ...(durable ? { uidValidity: durable.uidvalidity } : {}),
    });
  }
  const draftCounter = await ensureFolderCounter(env, "drafts");
  const draftRow = identity
    ? await env.DB.prepare("SELECT COUNT(*) AS count FROM drafts WHERE identity = ?")
        .bind(identity)
        .first<{ count: number }>()
    : { count: 0 };
  result.splice(3, 0, {
    id: "drafts",
    label: "Drafts",
    count: Number(draftRow?.count ?? 0),
    unread: 0,
    uidValidity: draftCounter.uidvalidity,
  });
  return result;
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

/** Shared SQL predicates for mailbox/date/attachment/seen across search modes (#354). */
function pushCommonSearchFilters(
  where: string[],
  binds: unknown[],
  q: SearchQuery,
  opts: { seenExpr: string; seenBinds: unknown[] },
): void {
  const seenExpr = opts.seenExpr;
  if (q.mailbox !== "all") {
    if (q.mailbox) {
      where.push("m.mailbox = ?");
      binds.push(q.mailbox);
    } else {
      where.push("m.mailbox IS NULL");
    }
  }
  if (q.after) {
    where.push("m.date >= ?");
    binds.push(q.after);
  }
  if (q.before) {
    where.push("m.date <= ?");
    binds.push(q.before);
  }
  if (q.hasAttachment === true) {
    where.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.message_id)");
  } else if (q.hasAttachment === false) {
    where.push("NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.message_id)");
  }
  if (q.seen === true) {
    where.push(`(${seenExpr}) = 1`);
    binds.push(...opts.seenBinds);
  } else if (q.seen === false) {
    where.push(`(${seenExpr}) = 0`);
    binds.push(...opts.seenBinds);
  }
}

function passesCommonSearchFilters(m: StoredMessageSummary, q: SearchQuery): boolean {
  if (q.mailbox !== "all") {
    if (q.mailbox) {
      if (m.mailbox !== q.mailbox) return false;
    } else if (m.mailbox !== null) {
      return false;
    }
  }
  if (q.after && m.date < q.after) return false;
  if (q.before && m.date > q.before) return false;
  if (q.hasAttachment === true && m.attachmentCount < 1) return false;
  if (q.hasAttachment === false && m.attachmentCount > 0) return false;
  if (q.seen === true && !m.seen) return false;
  if (q.seen === false && m.seen) return false;
  return true;
}

async function ftsSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  const ftsExpr = toFtsQuery(q.q ?? "");
  if (!ftsExpr) return { items: [], cursor: null };

  const accountViewer = q.viewer?.trim().toLowerCase() || undefined;
  const recipientViewer = q.to?.trim().toLowerCase() || undefined;
  const sp = seenProjection(accountViewer ?? recipientViewer);
  const seenExpr = sp.expr;
  // Seen bind (SELECT column) first, then the FTS match bind, then recipient/cursor.
  const binds: unknown[] = [...sp.binds, ftsExpr];
  const where: string[] = ["m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"];

  // Recipient view + viewer-relative INBOX (#350/#178); membership then direction,
  // the same order list/substr use, so fts shares the one "INBOX for V" builder.
  const rv = accountViewer
    ? accountWhere(accountViewer, q.direction)
    : recipientWhere(recipientViewer, q.direction);
  if (rv.membership) {
    where.push(rv.membership);
    binds.push(...rv.membershipBinds);
  }
  if (q.from) {
    where.push("lower(m.from_addr) LIKE ?");
    binds.push(`%${q.from.toLowerCase()}%`);
  }
  if (rv.direction) {
    where.push(rv.direction);
    binds.push(...rv.directionBinds);
  }
  // seenExpr also appears in WHERE when seen= is requested. Its viewer
  // placeholder is therefore bound a second time, after the preceding WHERE
  // predicates, in addition to the SELECT projection bind at the head.
  pushCommonSearchFilters(where, binds, q, { seenExpr, seenBinds: sp.binds });

  const cur = decodeCursor(q.cursor);
  if (cur) {
    where.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
    binds.push(cur.date, cur.date, cur.id);
  }

  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at, ${seenExpr} AS seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
            m.projected_size, m.projection_version,
            m.flagged, m.answered, m.mailbox, m.trashed_at, NULL AS folder_uid,
            ${SUMMARY_HAS_HTML_SQL},
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

  const accountViewer = q.viewer?.trim().toLowerCase() || undefined;
  const recipientViewer = q.to?.trim().toLowerCase() || undefined;
  const sp = seenProjection(accountViewer ?? recipientViewer);
  const seenExpr = sp.expr;

  // Case-insensitivity is SQLite LIKE's native ASCII folding (CONTRACT 10.8);
  // COALESCE(col,'') keeps a NULL header column from nulling the OR. Seen bind
  // (SELECT column) first, then one pattern bind per column, then recipient/cursor.
  const binds: unknown[] = [...sp.binds];
  const orClause = cols.map((c) => `COALESCE(m.${c},'') LIKE ? ESCAPE '\\'`).join(" OR ");
  for (let k = 0; k < cols.length; k++) binds.push(pattern);
  const where: string[] = [`(${orClause})`];

  // Recipient view + viewer-relative INBOX (#350/#178).
  const rv = accountViewer
    ? accountWhere(accountViewer, q.direction)
    : recipientWhere(recipientViewer, q.direction);
  if (rv.membership) {
    where.push(rv.membership);
    binds.push(...rv.membershipBinds);
  }
  if (q.from) {
    where.push("lower(m.from_addr) LIKE ?");
    binds.push(`%${q.from.toLowerCase()}%`);
  }
  if (rv.direction) {
    where.push(rv.direction);
    binds.push(...rv.directionBinds);
  }
  // Durable-folder + date/attachment/seen (#352/#354): shared across modes.
  pushCommonSearchFilters(where, binds, q, { seenExpr, seenBinds: sp.binds });

  const cur = decodeCursor(q.cursor);
  if (cur) {
    where.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
    binds.push(cur.date, cur.date, cur.id);
  }

  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at, ${seenExpr} AS seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
            m.projected_size, m.projection_version,
            m.flagged, m.answered, m.mailbox, m.trashed_at,
            (SELECT mp.folder_uid FROM mailbox_placement mp WHERE mp.message_id=m.message_id AND mp.folder=m.mailbox) AS folder_uid,
            ${SUMMARY_HAS_HTML_SQL},
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
async function summariesByIds(env: Env, ids: string[], viewer?: string): Promise<Map<string, StoredMessageSummary>> {
  const out = new Map<string, StoredMessageSummary>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(", ");
  // #350: render effective seen for the viewer (semantic/hybrid to=V). The seen
  // subquery bind lives in the SELECT column list, so it precedes the id binds.
  const sp = seenProjection(viewer);
  const seenExpr = sp.expr;
  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at, ${seenExpr} AS seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
            m.projected_size, m.projection_version,
            m.flagged, m.answered, m.mailbox, m.trashed_at, NULL AS folder_uid,
            ${SUMMARY_HAS_HTML_SQL},
            (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.message_id) AS attachment_count
       FROM messages m WHERE m.message_id IN (${placeholders})`;
  const res = await env.DB.prepare(sql).bind(...sp.binds, ...ids).all<SummaryRow>();
  for (const row of res.results ?? []) out.set(row.message_id, rowToSummary(row));
  return out;
}

/**
 * Post-hydrate viewer scope for the score-ranked modes (#350), which cannot push a
 * WHERE to Vectorize. Mirrors /api/messages semantics on a hydrated summary:
 *  - no viewer: the optional direction filter only (#128), as before.
 *  - to=V: delivered-set membership (drop anything NOT delivered to V -- the leak the
 *    lead caught), then the same viewer-relative INBOX rule list/fts use when
 *    direction=inbound (inbound OR outbound-not-authored-by-V), else the plain
 *    direction filter.
 *  - from= (#366): same lower(from_addr) substring match as list/fts/substr.
 */
function passesViewerScope(
  m: StoredMessageSummary,
  viewer: string | undefined,
  direction: "inbound" | "outbound" | undefined,
  fromFilter?: string,
  accountViewer?: string,
): boolean {
  if (fromFilter) {
    const needle = fromFilter.toLowerCase();
    if (!m.from.toLowerCase().includes(needle)) return false;
  }
  if (accountViewer) {
    const from = (parseRecipients(m.from)[0] ?? "").toLowerCase();
    const delivered = m.deliveredTo.map((a) => a.toLowerCase());
    if (direction === "outbound") return from === accountViewer;
    if (direction === "inbound") {
      return delivered.includes(accountViewer) &&
        (m.direction === "inbound" || (m.direction === "outbound" && from !== accountViewer));
    }
    return delivered.includes(accountViewer) || from === accountViewer;
  }
  if (!viewer) return !direction || m.direction === direction;
  const delivered = m.deliveredTo.map((a) => a.toLowerCase());
  if (!delivered.includes(viewer)) return false;
  if (direction === "inbound") {
    const bareFrom = (parseRecipients(m.from)[0] ?? "").toLowerCase();
    return m.direction === "inbound" || (m.direction === "outbound" && bareFrom !== viewer);
  }
  if (direction === "outbound") return m.direction === "outbound";
  return true;
}

async function semanticSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  const text = (q.q ?? "").trim();
  if (!text) return { items: [], cursor: null };

  const viewer = q.to?.trim().toLowerCase() || undefined;
  const fromFilter = q.from?.trim() || undefined;
  const accountViewer = q.viewer?.trim().toLowerCase() || undefined;
  const queryVec = await embedQuery(env, text);
  if (!queryVec) return { items: [], cursor: null }; // AI binding unavailable

  const ranked = await nearestMessageIds(env, queryVec, limit);
  const summaries = await summariesByIds(env, ranked.map((r) => r.messageId), accountViewer ?? viewer);
  const items: SearchHit[] = [];
  for (const r of ranked) {
    const message = summaries.get(r.messageId);
    if (!message) continue;
    // Viewer scope + direction + from= (#350/#128/#366): the vector index is neither
    // recipient-, sender-, nor direction-keyed, so scope the hydrated summaries.
    if (!passesViewerScope(message, viewer, q.direction, fromFilter, accountViewer)) continue;
    // Folder/date/attachment/seen (#354): same post-hydrate gate as the SQL modes.
    if (!passesCommonSearchFilters(message, q)) continue;
    items.push({ message, score: r.score });
  }
  // Score-ranked: single page, no date cursor.
  return { items, cursor: null };
}

async function hybridSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  // Pull each side, then merge by message_id on a normalized 0..1 score and sum.
  const shared = {
    q: q.q,
    direction: q.direction,
    to: q.to,
    from: q.from,
    mailbox: q.mailbox,
    after: q.after,
    before: q.before,
    hasAttachment: q.hasAttachment,
    seen: q.seen,
    viewer: q.viewer,
    limit,
  };
  const [ftsPage, semPage] = await Promise.all([
    ftsSearch(env, { ...shared, mode: "fts" }),
    semanticSearch(env, { ...shared, mode: "semantic" }),
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

export interface RecentRecipient {
  address: string;
  lastUsedAt: string;
}

/**
 * D-CONTACTS-1 (#354): recent recipients for ONE bound identity, derived from
 * that identity's outbound to/cc/bcc. Never estate-wide -- caller MUST pass the
 * owning From address (session identity or explicit viewer).
 */
export async function recentRecipients(
  env: Env,
  identity: string,
  limit = 25,
): Promise<RecentRecipient[]> {
  const owner = identity.trim().toLowerCase();
  if (!owner) return [];
  const cap = Math.min(Math.max(1, Math.floor(limit)), 50);
  // Over-fetch outbound rows; dedupe addresses in memory by most-recent use.
  const res = await env.DB.prepare(
    `SELECT to_addr, cc_addr, bcc_addr, date FROM messages
      WHERE direction = 'outbound' AND lower(from_addr) = ?
      ORDER BY date DESC, id DESC
      LIMIT 200`,
  )
    .bind(owner)
    .all<{ to_addr: string | null; cc_addr: string | null; bcc_addr: string | null; date: string }>();

  const seen = new Map<string, string>();
  for (const row of res.results ?? []) {
    const fields = [row.to_addr, row.cc_addr, row.bcc_addr];
    for (const field of fields) {
      if (!field) continue;
      for (const addr of parseRecipients(field)) {
        const key = addr.toLowerCase();
        if (!key || key === owner || seen.has(key)) continue;
        seen.set(key, row.date);
        if (seen.size >= cap) {
          return [...seen.entries()].map(([address, lastUsedAt]) => ({ address, lastUsedAt }));
        }
      }
    }
  }
  return [...seen.entries()].map(([address, lastUsedAt]) => ({ address, lastUsedAt }));
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

// --- Reconcile / orphan-vector audit (#134, read-only) ---
//
// The #130 backfill proved current-mail coverage but the live index settled ABOVE
// it: vectors with no live message behind them ("orphans"). Two roots are possible:
//   (a) a message deleted from the store with no Vectorize delete propagated, and/or
//   (b) a pre-#116 id scheme the unified `embedAndUpsert` id does not overwrite.
//
// HARD CONSTRAINT (investigated first): Vectorize exposes NO "list all vectors" API
// (describe / query / insert / upsert / getByIds / deleteByIds only). So the orphan
// COUNT is exact (describe.vectorsCount minus the verified-present expected set), but
// the orphan SET is NOT cleanly enumerable by id-listing. We therefore:
//   1. enumerate the EXPECTED id set from D1 via the SAME id scheme embedAndUpsert
//      uses (sha256hex(message_id)[:56] + "." + chunk), applying the same gate;
//   2. read describe() for the live count and getByIds() to verify the expected set
//      is actually present (catches under-coverage too);
//   3. SAMPLE the index by querying with stored vector values as probes (no new
//      embeddings, so zero Workers-AI spend) and classify every surfaced orphan id
//      as cause (a) vs (b) by EVERY linkage it exposes (metadata.message_id, the
//      vector id itself as a message_id, or its (date,subject) metadata) vs live D1.
// The sample yields a PARTIAL, honestly-labelled orphan id set (enumerable: false)
// plus a cause determination. THIS PATH NEVER DELETES (no deleteByIds call exists
// here): the prune is a separate, Conrad-supervised, gated step.

/** Vectorize getByIds caps at 20 ids per call (VECTOR_GET_ERROR 40007 above that). */
const RECONCILE_GETBYIDS_BATCH = 20;
/** Default number of live vectors used as similarity probes when sampling for cause. */
const RECONCILE_DEFAULT_SAMPLE = 32;
/** topK per sampling probe. Vectorize caps topK at 20 when returnMetadata="all". */
const RECONCILE_SAMPLE_TOPK = 20;
/** Cap on concrete orphan ids returned, so the report stays bounded. */
const RECONCILE_MAX_ORPHAN_IDS = 200;

export interface ReconcileSample {
  probes: number; // live vectors used as query probes
  matchesInspected: number; // total match ids inspected across all probes
  distinctOrphans: number; // distinct orphan ids surfaced by sampling
  causeA: number; // orphans pointing at a message (by id or metadata) NOT in D1 (deleted)
  causeB: number; // orphans tied to a STILL-LIVE message (pre-#116 id scheme)
  unknown: number; // orphans with no usable linkage signal to attribute
  orphanIds: string[]; // concrete orphan ids found (PARTIAL set), present iff requested
}

export interface ReconcileResult {
  // --- D1 side: the authoritative EXPECTED state ---
  messages: number; // total messages in the store
  gatedMessages: number; // messages that pass the vectorize gate AND have a non-empty body
  expectedVectors: number; // expected chunk-vectors (from ledger when populated, else computed)
  expectedSource: "ledger" | "computed"; // where expectedVectors came from (#279)
  ledgerVectors: number; // rows in vector_ledger (0 when never backfilled)
  computedVectors: number; // D1-derived expected count (always computed for drift)
  ledgerDrift: number; // computedVectors - ledgerVectors when ledger is in use
  // --- Vectorize side: what is actually in the index ---
  liveVectorCount: number; // describe(): vectors actually present (may lag, eventually-consistent)
  verified: boolean; // whether the getByIds presence check ran
  presentExpected: number; // expected ids confirmed present via getByIds (verified runs only)
  missingExpected: number; // expected ids NOT found -- coverage gaps (verified runs only)
  missingExpectedSample: string[]; // up to a few missing ids, for diagnosis
  // --- The headline ---
  orphanCount: number; // liveVectorCount - (verified ? presentExpected : expectedVectors)
  enumerable: false; // CONSTANT: Vectorize has no list API; the orphan SET is not fully enumerable
  // --- Cause attribution (probabilistic, via sampling) ---
  sample: ReconcileSample;
  causeDetermination: "a" | "b" | "mixed" | "indeterminate";
  note: string;
}

interface ReconcileOpts {
  /** Skip the getByIds presence check (cheaper; orphanCount falls back to expectedVectors). */
  verify?: boolean;
  /** Number of live vectors to use as similarity probes for cause sampling (0 disables). */
  sampleSize?: number;
  /** Include the concrete (partial) orphan id set in the report. */
  includeOrphanIds?: boolean;
}

/** Compute the expected vector id SET from D1 using the SAME scheme + gate as the
 *  live/backfill path. Pages internally so one request covers the whole store. */
async function expectedVectorIds(env: Env): Promise<{
  messages: number;
  gatedMessages: number;
  ids: Set<string>;
  liveMessageIds: Set<string>;
  liveMetaKeys: Set<string>;
}> {
  const allowlist = vectorizeAllowlist(env);
  const ids = new Set<string>();
  const liveMessageIds = new Set<string>();
  const liveMetaKeys = new Set<string>();
  let messages = 0;
  let gatedMessages = 0;
  let cursor: string | undefined;
  for (;;) {
    const { rows, nextCursor } = await pageForReindex(env, cursor, 200);
    for (const r of rows) {
      messages++;
      liveMessageIds.add(r.message_id);
      liveMetaKeys.add(metaKey(r.date, r.subject));
      const direction = r.direction === "outbound" ? "outbound" : "inbound";
      if (!shouldVectorize(allowlist, direction, parseRecipients(r.to_addr))) continue;
      const chunks = plannedChunks(r.body_text);
      if (chunks === 0) continue;
      gatedMessages++;
      const vids = await vectorIdsForMessage(r.message_id, chunks);
      for (const id of vids) ids.add(id);
    }
    if (nextCursor === null) break;
    cursor = nextCursor;
  }
  return { messages, gatedMessages, ids, liveMessageIds, liveMetaKeys };
}

/** Load every vector_id recorded by embedAndUpsert (#279). Pages by vector_id. */
async function loadVectorLedgerIds(env: Env): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!env.DB) return ids;
  let after: string | undefined;
  for (;;) {
    const stmt = after
      ? env.DB.prepare("SELECT vector_id FROM vector_ledger WHERE vector_id > ? ORDER BY vector_id LIMIT 500")
      : env.DB.prepare("SELECT vector_id FROM vector_ledger ORDER BY vector_id LIMIT 500");
    const page = after ? await stmt.bind(after).all<{ vector_id: string }>() : await stmt.all<{ vector_id: string }>();
    const rows = page.results ?? [];
    if (rows.length === 0) break;
    for (const r of rows) ids.add(r.vector_id);
    if (rows.length < 500) break;
    after = rows[rows.length - 1].vector_id;
  }
  return ids;
}

/** Stable key linking an old-scheme orphan (which lacks a message_id) back to a live
 *  message by its (date, subject) metadata. */
function metaKey(date: unknown, subject: unknown): string {
  return `${typeof date === "string" ? date : ""}\u0000${typeof subject === "string" ? subject : ""}`;
}

/** describe() spans two binding generations: legacy VectorizeIndex reports
 *  `vectorsCount`, post-beta Vectorize reports `vectorCount`. Read whichever is set. */
async function liveVectorCount(env: Env): Promise<number> {
  const vi = env.VECTORIZE as unknown as {
    describe?: () => Promise<{ vectorsCount?: number; vectorCount?: number }>;
  };
  if (!vi?.describe) return 0;
  const d = await vi.describe();
  return d.vectorsCount ?? d.vectorCount ?? 0;
}

/** Bounded concurrency for the audit's independent Vectorize reads: enough to beat
 *  the per-request wall-clock on a real mailbox, low enough to stay polite. */
const RECONCILE_CONCURRENCY = 8;

interface ByIdVector {
  id: string;
  values?: number[];
  metadata?: Record<string, unknown> | null;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. The
 *  audit's getByIds/query calls are independent reads, so this just trades a long
 *  sequential chain for a bounded-parallel one (the 60s/subrequest wall otherwise
 *  trips on a full-size index). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function getByIdsBatched(env: Env, ids: string[]): Promise<ByIdVector[]> {
  const vi = env.VECTORIZE as unknown as { getByIds?: (ids: string[]) => Promise<ByIdVector[]> };
  if (!vi?.getByIds) return [];
  const getByIds = vi.getByIds.bind(vi);
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += RECONCILE_GETBYIDS_BATCH) {
    batches.push(ids.slice(i, i + RECONCILE_GETBYIDS_BATCH));
  }
  const results = await mapWithConcurrency(batches, RECONCILE_CONCURRENCY, (b) => getByIds(b));
  return results.flat();
}

/**
 * classifyOrphan attributes a sampled orphan vector to cause (a) deleted-message or
 * (b) pre-#116 id scheme, using EVERY linkage the orphan exposes -- because the older
 * schemes carry NEITHER the unified vector id NOR a message_id metadata field:
 *   - unified scheme: metadata.message_id present -> live? b : a;
 *   - raw-message-id scheme: the vector id IS the message_id -> live id => b;
 *   - early metadata scheme: only {date, subject, from} -> (date,subject) live => b.
 * Any live linkage => (b) (the message still exists, the vector id is just stale). A
 * present-but-dead message_id, or dead (date,subject), => (a). No usable signal at all
 * => unknown (honest: we cannot attribute it from the sample).
 */
function classifyOrphan(
  id: string,
  metadata: Record<string, unknown> | null,
  liveMessageIds: Set<string>,
  liveMetaKeys: Set<string>,
): "a" | "b" | "unknown" {
  const mid = typeof metadata?.message_id === "string" ? (metadata.message_id as string) : "";
  const date = metadata?.date;
  const subject = metadata?.subject;
  const hasMetaPair = typeof date === "string" && typeof subject === "string";
  // (b): any signal ties the orphan to a still-live message.
  if (mid && liveMessageIds.has(mid)) return "b";
  if (liveMessageIds.has(id)) return "b"; // raw-message-id-as-vector-id scheme
  if (hasMetaPair && liveMetaKeys.has(metaKey(date, subject))) return "b"; // early metadata scheme
  // (a): the orphan points at a message (by id or by metadata) that is NOT in D1.
  if (mid) return "a";
  if (hasMetaPair) return "a";
  return "unknown";
}

/**
 * reconcile audits the live Vectorize index against the expected id set derived from
 * D1, returning the orphan count, an honest enumerability verdict, and a sampled
 * cause (a vs b) determination. READ-ONLY: it never deletes. See the block comment
 * above for the constraint that makes the orphan SET non-enumerable.
 */
export async function reconcile(env: Env, opts: ReconcileOpts = {}): Promise<ReconcileResult> {
  const verify = opts.verify !== false;
  const sampleSize = opts.sampleSize ?? RECONCILE_DEFAULT_SAMPLE;
  const includeOrphanIds = opts.includeOrphanIds === true;

  const computed = await expectedVectorIds(env);
  const ledgerIds = await loadVectorLedgerIds(env);
  const ledgerVectors = ledgerIds.size;
  const computedVectors = computed.ids.size;
  const useLedger = ledgerVectors > 0;
  const expectedIds = useLedger ? ledgerIds : computed.ids;
  const expectedSource = useLedger ? "ledger" : "computed";
  const expectedVectors = expectedIds.size;
  const ledgerDrift = useLedger ? computedVectors - ledgerVectors : 0;

  const expected = { ...computed, ids: expectedIds };
  const live = await liveVectorCount(env);

  // Presence check: confirm the expected set is actually in the index (and surface
  // under-coverage, a distinct bug from over-coverage/orphans).
  let presentExpected = expectedVectors;
  let missingExpected = 0;
  const missingExpectedSample: string[] = [];
  if (verify && expectedVectors > 0) {
    const expectedList = [...expected.ids];
    const found = await getByIdsBatched(env, expectedList);
    const foundIds = new Set(found.map((v) => v.id));
    presentExpected = foundIds.size;
    for (const id of expectedList) {
      if (!foundIds.has(id)) {
        missingExpected++;
        if (missingExpectedSample.length < 10) missingExpectedSample.push(id);
      }
    }
  }

  const baseline = verify ? presentExpected : expectedVectors;
  const orphanCount = Math.max(0, live - baseline);

  // Cause sampling: probe with stored vector VALUES (no new embeddings -> zero
  // Workers-AI spend), classify every surfaced non-expected id by whether its
  // message_id is still in D1.
  const sample: ReconcileSample = {
    probes: 0,
    matchesInspected: 0,
    distinctOrphans: 0,
    causeA: 0,
    causeB: 0,
    unknown: 0,
    orphanIds: [],
  };
  const seenOrphans = new Set<string>();
  if (sampleSize > 0 && expectedVectors > 0) {
    const probeIds = [...expected.ids].slice(0, sampleSize);
    const probes = (await getByIdsBatched(env, probeIds)).filter(
      (v): v is ByIdVector & { values: number[] } => Array.isArray(v.values) && v.values.length > 0,
    );
    const vi = env.VECTORIZE as unknown as {
      query?: (
        v: number[],
        o: { topK: number; returnMetadata: string },
      ) => Promise<{ matches?: { id: string; metadata?: Record<string, unknown> | null }[] }>;
    };
    for (const p of probes) {
      if (!vi.query) break;
      sample.probes++;
      const res = await vi.query(p.values, { topK: RECONCILE_SAMPLE_TOPK, returnMetadata: "all" });
      for (const m of res.matches ?? []) {
        sample.matchesInspected++;
        if (expected.ids.has(m.id) || seenOrphans.has(m.id)) continue;
        seenOrphans.add(m.id);
        const cause = classifyOrphan(m.id, m.metadata ?? null, expected.liveMessageIds, expected.liveMetaKeys);
        if (cause === "a") sample.causeA++;
        else if (cause === "b") sample.causeB++;
        else sample.unknown++;
        if (includeOrphanIds && sample.orphanIds.length < RECONCILE_MAX_ORPHAN_IDS) {
          sample.orphanIds.push(m.id);
        }
      }
    }
    sample.distinctOrphans = seenOrphans.size;
  }

  let causeDetermination: ReconcileResult["causeDetermination"] = "indeterminate";
  if (sample.causeA > 0 && sample.causeB > 0) causeDetermination = "mixed";
  else if (sample.causeA > 0) causeDetermination = "a";
  else if (sample.causeB > 0) causeDetermination = "b";

  const note =
    (useLedger
      ? "Expected ids from vector_ledger (#279); run reindex once to backfill a pre-ledger store. "
      : "vector_ledger empty: expected ids computed from D1 (run reindex to populate the ledger). ") +
    "Vectorize has no list API: orphanCount is exact, but the orphan SET is sampled, " +
    "not fully enumerable (enumerable=false). causeDetermination is from the sample only. " +
    "READ-ONLY: no vectors were deleted.";

  return {
    messages: expected.messages,
    gatedMessages: expected.gatedMessages,
    expectedVectors,
    expectedSource,
    ledgerVectors,
    computedVectors,
    ledgerDrift,
    liveVectorCount: live,
    verified: verify && expectedVectors > 0,
    presentExpected,
    missingExpected,
    missingExpectedSample,
    orphanCount,
    enumerable: false,
    sample,
    causeDetermination,
    note,
  };
}

// The store (docs/CONTRACT.md section 1): the ONLY code that touches D1, R2, and
// Vectorize. Both directions go through store.put() -- ingest() for received mail
// (#22) and mailbox.send()/reply() for the sent copy (#27) -- so threads are
// complete and the data model has a single owner.

import { sha256hex, chunkText, representableId } from "./ingest";
import { PROJECTION_VERSION, projectRfc822Size } from "./rfc822Project";
import { allowedFromDomain } from "./fromdomain";

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

/**
 * Every key a list/search summary row carries, and the ONLY names `fields=` accepts
 * (#646).
 *
 * A projection may select only what the store already produces. Accepting a name that
 * is not a key of StoredMessageSummary would hand the caller a column nothing fills --
 * which is exactly what #652 was: `snippet` declared on the search hit with zero
 * producers. #652 resolved it by DELETING that declaration, because this projection was
 * the one caller that could have forced a producer and it turned out not to need one.
 * `fields=snippet` therefore stays a 400, now simply because no such key exists.
 * searchhit-producers.test.ts is what keeps a producerless field from coming back.
 *
 * The two assertions below make this list UNABLE to drift from the type: adding a field
 * to StoredMessageSummary without adding it here fails `npm run typecheck`, and so does
 * a name here the type does not have. That gate is why this is a tuple and not a comment.
 */
export const SUMMARY_FIELDS = [
  "uid", "messageId", "direction", "threadId", "from", "to", "subject", "date",
  "inReplyTo", "trusted", "receivedAt", "seen", "flagged", "answered", "mailbox",
  "trashedAt", "folderUid", "cc", "bcc", "sender", "replyTo", "deliveredTo",
  "wireSize", "projectedSize", "projectionVersion", "attachmentCount", "hasHtml",
] as const;

/** One of the names `fields=` accepts. */
export type SummaryField = (typeof SUMMARY_FIELDS)[number];

// Exhaustiveness, both directions, at COMPILE time. `never` is the only type that
// satisfies the constraint, so a key the tuple is missing and a name the type does not
// have are both typecheck failures rather than a runtime surprise on a live read.
type ExactlyNever<T extends never> = T;
type _NoSummaryFieldMissing = ExactlyNever<Exclude<keyof StoredMessageSummary, SummaryField>>;
type _NoSummaryFieldInvented = ExactlyNever<Exclude<SummaryField, keyof StoredMessageSummary>>;

/**
 * Narrow a summary row to the requested keys (#646).
 *
 * Key order is the TYPE's, never the caller's, so two callers asking for the same set
 * get byte-identical rows and a response can never depend on argument order.
 *
 * This runs at the API EDGE, after the query: what it saves is RESPONSE SIZE, which is
 * the constraint #631 hit (a 15-day window refused outright as one tool result). It does
 * NOT narrow the SELECT, so the D1 column and row cost is unchanged; a SQL-level
 * projection is a separate, separately-measurable change and is not claimed here.
 */
export function projectSummary(
  row: StoredMessageSummary,
  fields: readonly SummaryField[],
): Partial<StoredMessageSummary> {
  const want = new Set<string>(fields);
  const out: Record<string, unknown> = {};
  for (const key of SUMMARY_FIELDS) {
    if (want.has(key)) out[key] = row[key];
  }
  return out as Partial<StoredMessageSummary>;
}

export interface ListQuery {
  to?: string;
  from?: string;
  thread?: string;
  /** The STORED wire fact, filtered exactly (#403). Never re-interpreted into a
   *  view: a row returned under direction=inbound always reports inbound. The
   *  viewer-relative views live on `lens`. */
  direction?: "inbound" | "outbound";
  /** Named viewer-relative view (#403; the semantics #350 used to overload onto
   *  `direction`). Requires a viewer (`to` or `viewer`); mutually exclusive with
   *  `direction`. Validated at the API edge. */
  lens?: ViewLens;
  /** WHOSE seen state this read renders (#404). Overrides the seen-projection key
   *  ONLY; the row predicate stays keyed on `to` / `viewer`. Absent = today's
   *  behavior exactly. Validated at the API edge (bare address; a bound session may
   *  only name itself). */
  seenFor?: string;
  mailbox?: MailboxFilter;
  /** Internal account boundary for a bound webmail session. Unlike public `to`,
   * this includes the viewer's authored Sent rows in All while keeping Inbox
   * recipient-relative. Never accepted directly from a query parameter. */
  viewer?: string;
  q?: string; // FTS over subject + body
  /** Inclusive lower bound on messages.date (#647). CANONICAL: the API edge has already
   *  normalized it to the exact form this column stores, which is what lets a plain string
   *  comparison be correct. Never take a raw caller value here. */
  after?: string;
  /** Inclusive upper bound on messages.date (#647). CANONICAL, as `after`. */
  before?: string;
  limit?: number; // default 50, max 200
  cursor?: string; // opaque; encodes (date, id) of the last row
}

/** Viewer-relative views (CONTRACT 10.9):
 *  - inbox: mail delivered to V that V did not author (an INBOX, not a direction).
 *  - sent: mail V authored (sender-based, never delivered-set based). */
export type ViewLens = "inbox" | "sent";

export type MailboxPlacement = "archive" | "trash" | "junk" | null;
export type MailboxFilter = MailboxPlacement | "all";

export type SearchField = "subject" | "body" | "text";

export interface SearchQuery {
  q: string;
  mode?: "fts" | "substr" | "semantic" | "hybrid"; // substr = #212; semantic/hybrid = M4
  // substr only (#212): which column(s) the substring matches; default "text".
  field?: SearchField;
  // Restrict to one STORED direction (#128); undefined = both. Exact, never
  // re-interpreted into a view (#403). Validated at the API edge.
  direction?: "inbound" | "outbound";
  // Named viewer-relative view (#403); requires a viewer (to/viewer), mutually
  // exclusive with direction. Same semantics as ListQuery.lens in every mode.
  lens?: ViewLens;
  // Whose seen state to render (#404); same semantics as ListQuery.seenFor, in
  // every mode (the SQL modes project it, semantic/hybrid hydrate it).
  seenFor?: string;
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

/**
 * One page of results.
 *
 * `cursor === null` means THERE ARE NO MORE: it is a positive claim of exhaustion, and the
 * keyset surfaces (list, fts, substr) can make it honestly because they page a SQL ordering.
 *
 * `cursor` ABSENT means something different and is never the same thing: this page is
 * incomplete AND no continuation exists. The score-ranked modes are in that position, because
 * a vector index has no offset to resume from and its topK has a platform ceiling. They used
 * to answer null there, which asserted exhaustion they could not deliver; that is the defect
 * #631 was filed for, in the field a careful caller trusts most.
 *
 * So: read `complete`. Never read an absent cursor as exhaustion.
 */
export interface Page<T> {
  items: T[];
  cursor?: string | null;
  /**
   * Whether `items` plus the cursor chain is the WHOLE answer set. Absent means true, which
   * keeps every existing keyset response byte-identical. `false` appears only when a
   * score-ranked retrieval hit its ceiling, or when a mode could not run at all.
   */
  complete?: boolean;
  /** The retrieval ceiling that applied, present only alongside `complete: false`. */
  retrievalCap?: number;
  /**
   * Why this answer is not complete, in words, when the reason is not simply the ceiling:
   * a mode that could not run (no AI or no Vectorize binding) answers zero rows, and zero
   * rows with no explanation is indistinguishable from "no matching mail". A degrade may
   * happen; it may not be silent.
   */
  degraded?: string;
}

export interface SearchHit {
  message: StoredMessageSummary;
  score?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Normalized input to store.put(). messageId is already normalized (<>-stripped,
 * trimmed, and kept VERBATIM unless it is absurdly long, #486) by the caller --
 * ingest.normalizeMessageId. references is the parsed References list
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
 *
 * Each candidate is tried BOTH as the sender wrote it and as `representableId` would
 * have stored it (#500). A parent whose header could not be represented lives under its
 * sha256 (#486, #494, #500), so a reply quoting the sender's own raw id would match no
 * row and fork, which is the exact bug the collapse exists to prevent, moved one seam
 * over. The raw form is tried FIRST, so this is purely additive: no lookup that
 * succeeded before can start failing, and for a representable id the two forms are the
 * same string and only one query runs.
 */
async function resolveThreadId(
  db: D1Database,
  messageId: string,
  inReplyTo: string | null | undefined,
  references: string[] | undefined,
): Promise<string> {
  const quoted: string[] = [];
  if (inReplyTo) quoted.push(stripAngle(inReplyTo));
  // References: check most-recent first (closest parent wins).
  for (const r of (references ?? []).slice().reverse()) {
    const id = stripAngle(r);
    if (id && !quoted.includes(id)) quoted.push(id);
  }
  const candidates: string[] = [];
  for (const id of quoted) {
    if (!id || candidates.includes(id)) continue;
    candidates.push(id);
    const stored = await representableId(id);
    if (stored !== id && !candidates.includes(stored)) candidates.push(stored);
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
  // Unset domain: no recipient is "same-domain", so seed nothing. Skip, never throw:
  // this runs after the message is already sent and stored, and the override is a
  // best-effort unread hint, not a gate (#615).
  const domain = allowedFromDomain(env);
  if (!domain) return;
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

/**
 * Does a row already exist under this exact message_id? The store owns every D1 read,
 * so ingest.normalizeMessageId asks through here rather than reaching for the binding
 * itself (#486: a redelivery of a message stored under the pre-fix sha256 must merge
 * into that row instead of forking a second copy under the raw header).
 */
export async function messageExists(env: Env, messageId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT message_id FROM messages WHERE message_id = ? LIMIT 1")
    .bind(messageId)
    .first<{ message_id: string }>();
  return !!row;
}

/** The content two deliveries of ONE message necessarily agree on.
 *
 *  INVARIANT: a merge widens `delivered_to` only between deliveries of the SAME message.
 *  `message_id` is UNIQUE and it is supplied with the message rather than derived here,
 *  so on its own it identifies a row, not a message; `delivered_to` is the column every
 *  access check reads (accessClause), so the merge asks this question too and only
 *  widens on a yes. Refs GHSA-pjv6-4xmx-29cw.
 *
 *  FROM + SUBJECT + BODY, and deliberately NOT date: a message arriving with no Date
 *  header is stamped `new Date()` at ingest, so two per-recipient invocations of ONE
 *  delivery would disagree on it and a legitimate second recipient would be forked off
 *  into its own row. The body carries the comparison regardless: it is a pure function
 *  of the MIME bytes and therefore identical across per-recipient invocations of one
 *  delivery.
 *
 *  `sameMessageSql` is the SQL half of this same predicate and the two must agree;
 *  both COALESCE to '' so a legacy NULL column is not read as a mismatch. Kept adjacent
 *  for that reason, and message-identity.test.ts pins the pair against a real engine. */
function sameMessageAs(
  row: { from_addr: string | null; subject: string | null; body_text: string | null },
  input: StoreInput,
): boolean {
  return (
    (row.from_addr ?? "") === input.from &&
    (row.subject ?? "") === input.subject &&
    (row.body_text ?? "") === input.bodyText
  );
}

/** The SQL half of `sameMessageAs`, for the alias the surrounding statement uses.
 *  Binds, in order: from, subject, bodyText. */
function sameMessageSql(alias: string): string {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(${p}from_addr,'') = ? AND COALESCE(${p}subject,'') = ? AND COALESCE(${p}body_text,'') = ?`;
}

/** The id a colliding DIFFERENT message is stored under. Derived, so it is
 *  DETERMINISTIC: a retry of that same delivery resolves to the same row instead of
 *  minting a new one on every attempt. */
async function forkedMessageId(input: StoreInput): Promise<string> {
  return await sha256hex(
    `${input.messageId}\u0000${input.from}\u0000${input.subject}\u0000${input.bodyText}`,
  );
}

export async function put(env: Env, input: StoreInput, ctx: ExecutionContext): Promise<PutResult> {
  return await putRow(env, input, ctx, false);
}

/** `forked` marks the one retry `put` allows itself: the stored id was already taken by
 *  a different message, so this call is storing the delivery under its derived id. */
async function putRow(
  env: Env,
  input: StoreInput,
  ctx: ExecutionContext,
  forked: boolean,
): Promise<PutResult> {
  const receivedAt = new Date().toISOString();
  const threadId = await resolveThreadId(env.DB, input.messageId, input.inReplyTo, input.references);

  // Envelope semantics (#178): the deduped, bare lower-cased set this delivery is
  // FOR, wrapped ",a,b," so membership is one delimiter-safe LIKE. Derived from
  // `to` when a caller omits deliveredTo, so the column is never null.
  const deliveredList = normalizeDelivered(input.deliveredTo, input.to);
  const deliveredSet = `,${deliveredList.join(",")},`;
  // The recipient the ATOMIC merge appends on a dedup hit: the envelope address this
  // invocation delivered to, which is why it must stay first in deliveredList.
  //
  // It is no longer the ONLY address inbound can carry. Role-address filing
  // (FILE_ALSO_UNDER) hands ingest [recipient, ...owners], and the upsert below appends
  // exactly one. On a FRESH insert that is harmless (the whole set is written at once),
  // but on a MERGE -- a second delivery of the same Message-ID, i.e. mail addressed to a
  // role address AND something else, where the other recipient happened to land first --
  // the owners would be silently dropped and the role mail would go back to being
  // invisible. `extraRcpts` closes that, right below the upsert.
  const mergeRcpt = deliveredList[0];
  const extraRcpts = deliveredList.slice(1);
  // Already-a-member is a no-op, and the address is matched LITERALLY -- the same
  // membershipClause the read paths use, so the write guard and the access check agree
  // on what "is on the delivered set" means. Refs GHSA-pjv6-4xmx-29cw.
  const mergeGuard = membershipClause(mergeRcpt, { alias: "messages", negated: true });

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
       WHERE ${mergeGuard.sql}
         AND ${sameMessageSql("messages")}
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
      ...mergeGuard.binds,
      input.from,
      input.subject,
      input.bodyText,
      deliveredSet,
    )
    .all<{ thread_id: string | null; is_fresh: number }>();

  // EVERY OTHER address this delivery is for, appended idempotently. The NOT LIKE guard
  // makes each statement a no-op when the address is already on the row, so this is safe
  // on the fresh-insert path (where the full set was just written), on the merge path
  // (where the upsert appended only the envelope recipient), and on a retry.
  //
  // Deliberately separate statements rather than a cleverer single upsert: the atomic
  // insert-or-merge above is the concurrency-critical one (#178, concurrent per-recipient
  // invocations of the SAME Message-ID) and it stays exactly as it was. These run only
  // when a delivery actually carries extra addresses, which today means only mail to a
  // configured role address.
  //
  // It carries BOTH of the upsert's guards, for the same reasons: it is keyed on
  // message_id alone, so the same-message condition is what keeps it on a row holding
  // this delivery, and the membership guard is the escaped one.
  for (const extra of extraRcpts) {
    const guard = membershipClause(extra, { negated: true });
    await env.DB.prepare(
      `UPDATE messages
          SET delivered_to = COALESCE(delivered_to, ',' || to_addr || ',') || ? || ','
        WHERE message_id = ?
          AND ${guard.sql}
          AND ${sameMessageSql("")}`,
    )
      .bind(extra, input.messageId, ...guard.binds, input.from, input.subject, input.bodyText)
      .run();
  }

  const returned = (res.results ?? [])[0];
  if (!returned) {
    // DO UPDATE WHERE was false, which is TWO situations that must not be conflated
    // (refs GHSA-pjv6-4xmx-29cw):
    //
    //   1. This exact recipient is already on the row -- a retry / delivery loop of a
    //      message we hold. True dedup, a no-op, and the pre-existing behavior.
    //   2. The row holds a DIFFERENT message under this Message-ID, so the merge
    //      correctly declined to widen its delivered_to (sameMessageAs). What is left is
    //      to store THIS delivery, under its own identity. Never merged, and never
    //      dropped: dropping it would be lost mail.
    //
    // This read runs only on a conflict, never on the fresh-insert path.
    const existing = await env.DB.prepare(
      "SELECT thread_id, from_addr, subject, body_text FROM messages WHERE message_id = ? LIMIT 1",
    )
      .bind(input.messageId)
      .first<{
        thread_id: string | null;
        from_addr: string | null;
        subject: string | null;
        body_text: string | null;
      }>();
    if (existing && !sameMessageAs(existing, input)) {
      if (forked) {
        // The DERIVED id collided too, and again with different content. That id is a
        // sha256 over the message identifier plus the content, so there is no ordinary
        // route to this state. Fail loudly -- the transport retries and an operator sees
        // it -- rather than drop the message or widen a delivered_to to place it.
        throw new Error("store: message identity could not be resolved without a collision");
      }
      return await putRow(env, { ...input, messageId: await forkedMessageId(input) }, ctx, true);
    }
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

/**
 * The projected size of ONE stored message, from D1 body + attachment metadata
 * (no R2 reads). Returns null when the row is gone.
 *
 * This is the single projection entry point on the worker side: live ingest
 * (refreshProjectedSize) and the #507 reproject sweep both go through it, so a
 * backfilled size is computed by the same code that computes a live one and the two
 * cannot drift. Duplicating the projection for the sweep would have re-created the
 * exact class of bug #507 is about, one number produced by two serializers.
 */
export async function projectedSizeFor(env: Env, messageId: string): Promise<number | null> {
  // No caller and no member: an internal projection of a row we already hold.
  const msg = await getUnscoped(env, messageId);
  if (!msg) return null;
  return await projectRfc822Size({
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
}

/** Recompute projected_size from D1 body + attachment metadata (no R2 reads). */
export async function refreshProjectedSize(env: Env, messageId: string): Promise<void> {
  const size = await projectedSizeFor(env, messageId);
  if (size === null) return;
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

/** Normalize one viewer address, or a viewer SET, to lower-cased unique addresses.
 *
 *  A bound webmail session is ONE person, but since #425 it can also read the role
 *  queues that person is a member of, so every READ-side access check takes a set. The
 *  single-address form stays exactly what it was. */
function viewerList(viewer: string | readonly string[] | undefined): string[] {
  if (!viewer) return [];
  const raw = Array.isArray(viewer) ? viewer : [viewer as string];
  const out: string[] = [];
  for (const entry of raw) {
    const value = entry?.trim().toLowerCase();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

// --- LIKE plumbing: ONE escaper, ONE membership predicate -------------------
//
// INVARIANT: an address is matched LITERALLY everywhere the store asks whether a viewer
// is on the delivered set. That set is a ",a,b," string and membership is a SQL LIKE
// over it, so every pattern this file binds is built by the helpers below and by nothing
// else. An address is DATA, never a pattern.
//
// ONE helper rather than a rule each call site remembers: the predicate had nine call
// sites, and a convention applied nine times independently is a convention the tenth
// site can miss. membership-literal.test.ts fails if a LIKE appears in this file without
// its ESCAPE. Refs GHSA-pjv6-4xmx-29cw.

/** Escape LIKE metacharacters, BACKSLASH FIRST (CONTRACT 10.8): the ESCAPE character
 *  itself must be escaped before the wildcards, or a literal backslash in the input
 *  would corrupt the escape that follows it. Order: \ -> \\, then % -> \%, then _ -> \_.
 *  Pairs with `ESCAPE '\'` on every LIKE that consumes its output; one without the
 *  other does nothing. */
function escapeLikeMeta(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** A CONTAINS pattern for free text (substring search): escaped, then wrapped in the
 *  wildcards the caller actually asked for. */
function escapeLikePattern(raw: string): string {
  return `%${escapeLikeMeta(raw)}%`;
}

/** The bound value for `membershipClause`: ",addr," as a LIKE pattern. The delimiters
 *  and the surrounding wildcards are OURS -- they are what makes the match
 *  delimiter-safe -- and everything the ADDRESS contributes is escaped to a literal. */
function membershipPattern(address: string): string {
  return `%,${escapeLikeMeta(address)},%`;
}

/** "this address is on the delivered set": the one membership predicate.
 *
 *  `alias` is the table alias the surrounding statement uses ("m", "messages", or none);
 *  `negated` gives the NOT LIKE form the delivered-set write guards need. SQL and binds
 *  come back TOGETHER, which is the point: a call site never writes the pattern, so it
 *  cannot write one the escaper did not produce. */
function membershipClause(
  address: string,
  opts: { alias?: string; negated?: boolean } = {},
): { sql: string; binds: string[] } {
  const p = opts.alias ? `${opts.alias}.` : "";
  const set = `COALESCE(${p}delivered_to, ',' || ${p}to_addr || ',')`;
  return {
    sql: `${set} ${opts.negated ? "NOT LIKE" : "LIKE"} ? ESCAPE '\\'`,
    binds: [membershipPattern(address)],
  };
}

/** WHOSE mail a scoped store call may touch.
 *
 *  The estate case is the LITERAL `"estate"`, never an absent argument and never an empty
 *  array, so it cannot be reached by omission: a bare address is not assignable to this
 *  type, and a member scope must be written as an array. An EMPTY array is a real answer
 *  and it means NOTHING is reachable; "I resolved this caller and it came out with no
 *  addresses" is the fail-closed case, not a licence to touch the estate.
 *
 *  Same discipline as `MessageReadScope` (GHSA-49mc-vh6w-95h4), applied to the paths that
 *  WRITE. It is what stops the next state-changing call site from acquiring estate reach by
 *  forgetting an argument: there is no argument to forget, and the two meanings that used
 *  to share one representation (`undefined`) no longer have one. */
export type AccessScope = readonly string[] | "estate";

/** "delivered to V, or authored by V" for ANY address in the scope (#425).
 *
 *  One address produces one fragment; a set produces a parenthesised OR of the same
 *  fragment, so a role member reaches ROLE mail and nothing else widens. `"estate"`
 *  produces no SQL at all, deliberately unconstrained: the static operator token, the IMAP
 *  door and the same-account RPC entrypoint are estate-wide by construction and each says
 *  so with the literal. An EMPTY member set produces `1=0`, which matches nothing, and that
 *  is the answer the old shape could not give: an absent viewer produced no SQL, so "no
 *  identity for this caller" and "this caller may see everything" were the same string.
 *  `alias` matches the surrounding statement, so list/search/folders share this definition
 *  instead of keeping aliased copies of it. */
function accessClause(scope: AccessScope, alias?: string): { sql: string; binds: string[] } {
  if (scope === "estate") return { sql: "", binds: [] };
  const viewers = viewerList(scope);
  // Matches nothing rather than throwing: every call site already treats an id it cannot
  // reach as skipped, so a refusal reads exactly like an unknown id.
  if (viewers.length === 0) return { sql: "1=0", binds: [] };
  const p = alias ? `${alias}.` : "";
  const parts: string[] = [];
  const binds: string[] = [];
  for (const viewer of viewers) {
    const member = membershipClause(viewer, { alias });
    parts.push(`(${member.sql} OR lower(${p}from_addr) = ?)`);
    binds.push(...member.binds, viewer);
  }
  return { sql: parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`, binds };
}

/** The READ paths' documented default: a read with no bound viewer is an ESTATE read.
 *
 *  The static operator token, the IMAP door and the shared public demo mailbox all rely on
 *  it, so it stays. It lives HERE, once, as a deliberate and greppable mapping rather than
 *  inside accessClause, where the state-changing paths would inherit it too. Only the read
 *  projections may use it. */
function readScopeOf(viewer: string | readonly string[] | undefined): AccessScope {
  // ONLY an absent viewer is estate. An argument that was PASSED and resolved to no
  // addresses stays empty, and the shared predicate then matches nothing: a caller that
  // tried to state a scope and came up empty is exactly the fail-closed case, and reading
  // it as estate is the defect this type exists to remove, on the read paths as much as on
  // the write ones.
  if (viewer === undefined) return "estate";
  return viewerList(viewer);
}

/**
 * Set the read state (#seen) on a set of messages by message_id, returning how many
 * rows changed. The single writer for the seen flag: the IMAP \Seen store, a webmail
 * "mark (un)read", or any API client. Idempotent -- setting a row to its current state
 * is a no-op (SQLite reports 0 changes). Unknown ids are silently skipped (they simply
 * match no row). An empty id list is a no-op that never touches D1.
 *
 * `scope` (#410) restricts every write to messages that scope can actually SEE -- the same
 * delivered-to / from-addr predicate setFlags and moveMessages apply, and the same one
 * messageAccessible uses for the single-message routes. It is REQUIRED and there is no
 * estate default: a bound caller passes its member set, and an estate-wide caller (the
 * static operator token, the IMAP door) passes the literal `"estate"` out loud. An id the
 * scope cannot reach is skipped, not refused, exactly as an unknown id is.
 *
 * A member scope may be a SET since #425 (the session identity PLUS the role queues that
 * identity belongs to), so a member can mark role mail read. `forRecipient` is unaffected
 * and stays the ONE person the override belongs to: the widened set decides which messages
 * are REACHABLE, never whose read state is written.
 */
export async function setSeen(
  env: Env,
  messageIds: string[],
  seen: boolean,
  scope: AccessScope,
  forRecipient?: string,
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const placeholders = messageIds.map(() => "?").join(", ");
  // The accessibility predicate, identical to setFlags/moveMessages and to
  // messageAccessible: the message was delivered to the scope, or the scope sent it.
  const clause = accessClause(scope);
  const access = clause.sql ? ` AND ${clause.sql}` : "";
  const accessBinds = clause.binds;

  // Scoped (#350): mark read/unread for ONE recipient -- upsert a sparse override
  // in message_seen_by, never touching messages.seen (the estate/legacy flag).
  // Only existing messages get an override (unknown ids are skipped, as legacy
  // does), so a scoped mark never seeds junk for a message that is not stored.
  if (forRecipient) {
    const recipient = forRecipient.trim().toLowerCase();
    const existing = await env.DB.prepare(
      `SELECT message_id FROM messages WHERE message_id IN (${placeholders})${access}`,
    )
      .bind(...messageIds, ...accessBinds)
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
    `UPDATE messages SET seen = ? WHERE message_id IN (${placeholders})${access} RETURNING message_id`,
  )
    .bind(seen ? 1 : 0, ...messageIds, ...accessBinds)
    .all<{ message_id: string }>();
  const touched = (res.results ?? []).map((r) => r.message_id);
  // Realign the per-recipient overrides. Under `"estate"` this stays byte-identical to
  // before #410 (every requested id, unknown ones matching nothing); under a MEMBER scope
  // only the rows that scope was actually allowed to touch are realigned, so the gate
  // cannot be sidestepped through the override table. An empty member scope therefore
  // realigns nothing, which is the same nothing it was allowed to update.
  const realignIds = scope === "estate" ? messageIds : touched;
  if (realignIds.length > 0) {
    const realign = realignIds.map(() => "?").join(", ");
    await env.DB.prepare(
      `UPDATE message_seen_by SET seen = ? WHERE message_id IN (${realign})`,
    )
      .bind(seen ? 1 : 0, ...realignIds)
      .run();
  }
  return touched.length;
}

/** Persist \Flagged / \Answered beside the existing durable \Seen flag. */
export async function setFlags(
  env: Env,
  messageIds: string[],
  set: { flagged?: boolean; answered?: boolean },
  scope: AccessScope,
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
  // The same accessClause every other scoped path uses, so a flag write cannot drift
  // from the read it mirrors.
  const clause = accessClause(scope);
  const access = clause.sql ? ` AND ${clause.sql}` : "";
  const res = await env.DB.prepare(
    `UPDATE messages SET ${assignments.join(", ")} WHERE message_id IN (${placeholders})${access} RETURNING message_id`,
  )
    .bind(...binds, ...messageIds, ...clause.binds)
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

/** Move messages between the mutually-exclusive durable system boxes.
 *
 *  `scope` is REQUIRED, exactly as on setSeen: a member set, or the literal `"estate"`
 *  named out loud.
 *
 *  It gates BOTH statements that can decide the outcome, the placement read AND the
 *  UPDATE. The UPDATE used to carry no predicate of its own and inherited its only guard
 *  from the SELECT above it, which is one refactor away from having none: a write states
 *  its own constraint, or it is not constrained. */
export async function moveMessages(
  env: Env,
  messageIds: string[],
  mailbox: MailboxPlacement,
  scope: AccessScope,
): Promise<number> {
  let updated = 0;
  const clause = accessClause(scope);
  const access = clause.sql ? ` AND ${clause.sql}` : "";
  for (const id of messageIds) {
    const row = await env.DB.prepare(
      `SELECT mailbox FROM messages WHERE message_id = ?${access}`,
    )
      .bind(id, ...clause.binds)
      .first<{ mailbox: string | null }>();
    if (!row || normalizeMailbox(row.mailbox) === mailbox) continue;

    const placement = mailbox ? await allocateFolderUid(env, mailbox) : null;
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare(
        `UPDATE messages SET mailbox = ?, trashed_at = ? WHERE message_id = ?${access}`,
      ).bind(mailbox, mailbox === "trash" ? now : null, id, ...clause.binds),
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
  // Defense in depth for the IDOR boundary (#355 / contract §2.4): never INSERT
  // under a new identity when the draft id already belongs to someone else.
  // Callers (session + IMAP PUT) also 403 before this; without the check a
  // colliding INSERT would either throw a PK error or (in loose fakes) dual-own.
  const existingOwner = await getDraftOwner(env, id);
  if (existingOwner !== null && existingOwner !== owner) {
    throw new Error("draft belongs to another identity");
  }
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

/** Can this viewer SEE this message at all?
 *
 *  `identity` may be ONE address or a SET (#425: a session identity plus the role
 *  queues it belongs to), so a message opened from a role view resolves instead of
 *  404ing. Write paths deliberately keep passing the single identity. */
export async function messageAccessible(
  env: Env,
  id: string,
  identity: string | readonly string[],
  requireTrash = false,
): Promise<boolean> {
  // An EMPTY set is refused rather than read as estate, and that refusal now comes from
  // accessClause itself (`1=0`) instead of a guard kept here: this runs only to SCOPE a
  // caller, so "no addresses" can only mean the scope is unanswerable, and the fail-closed
  // answer to that is no. A bare `readonly string[]` is passed, never `"estate"`, so the
  // type makes an unscoped accessibility check unwritable.
  const clause = accessClause(viewerList(identity));
  const row = await env.DB.prepare(
    "SELECT message_id FROM messages WHERE message_id = ? " +
      `AND ${clause.sql} ` +
      (requireTrash ? "AND mailbox = 'trash' " : "") +
      "LIMIT 1",
  )
    .bind(id, ...clause.binds)
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

/**
 * Full message + attachment metadata for a caller SCOPED to `readScope`. Null when the
 * row does not exist, AND null when it exists but is not this caller's to read: the two
 * are deliberately indistinguishable, so this is never an existence oracle.
 *
 * `readScope` is REQUIRED and there is no estate default. Reading the whole estate is a
 * real need (the static operator/IMAP token, the same-account RPC entrypoint, the internal
 * size projection) and it has its OWN function, `getUnscoped`, which a call site must name
 * out loud. That asymmetry is the whole point of the shape: a reader added later cannot
 * obtain an unscoped read by forgetting an argument, only by asking for one. The read
 * ROUTE is not the only path that reads a stored message, and a per-call-site check is
 * exactly the kind of thing the next call site does not repeat. Refs GHSA-49mc-vh6w-95h4.
 *
 * The predicate is `messageAccessible`, so "may this caller see this message" keeps ONE
 * definition (`accessClause`) rather than gaining a second copy here that could drift from
 * the one the read route already enforces. An EMPTY viewer set is refused rather than read
 * as estate, for the reason stated on messageAccessible: this runs only to SCOPE a caller,
 * so no addresses can only mean the scope is unanswerable.
 */
export async function get(
  env: Env,
  messageId: string,
  readScope: string | readonly string[],
): Promise<StoredMessage | null> {
  if (!(await messageAccessible(env, messageId, readScope))) return null;
  return await getUnscoped(env, messageId);
}

/**
 * Full message + attachment metadata with NO access scoping: any stored message, whoever
 * is asking. Named so that an unscoped read is a deliberate, greppable act at the call
 * site instead of the default (see `get`). Legitimate callers today: the read route when
 * the bearer is a static estate token, `MailboxService` (a same-account service binding
 * with no bearer and therefore no member to scope to), and `projectedSizeFor` (an internal
 * projection with no caller at all).
 */
export async function getUnscoped(env: Env, messageId: string): Promise<StoredMessage | null> {
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

/** The default bound on a thread read (#649).
 *
 *  Deliberately SMALLER than DEFAULT_LIMIT, which is the SUMMARY default. A thread row is a
 *  full StoredMessage, `body_text` and `body_html` included, plus its attachment metadata,
 *  so it is an order of magnitude heavier than a summary row: fifty of them is the payload
 *  problem rather than a bound on it.
 *
 *  Twenty is a REAL ceiling and not a large number standing in for one. It covers the
 *  overwhelming majority of real threads in a single call, so the common case still reads
 *  whole, and the worst case is bounded at twenty bodies instead of at however long the
 *  conversation happened to get. A caller that genuinely needs more asks for it, up to
 *  MAX_LIMIT, which is itself a bound.
 */
const THREAD_DEFAULT_LIMIT = 20;

function clampThreadLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return THREAD_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** One page of a thread, oldest first, keyset-paginated (#649).
 *
 *  This used to select EVERY message in the thread with no LIMIT and no cursor, each row a
 *  full StoredMessage. So the size of the answer was the size of the conversation, and one
 *  long thread returned whole into a single response. That is the same failure #631 hit on
 *  the list route, on a surface nobody had looked at.
 *
 *  TRUNCATION IS VISIBLE AS THE CURSOR, and deliberately not as a second field. `Page`
 *  already defines `cursor === null` as a POSITIVE claim of exhaustion, so a non-null cursor
 *  is the statement "this is a first page, not a thread". Adding a separate truncation flag
 *  would be two names for one fact, which is how two names drift apart. `complete` stays
 *  absent, meaning true, exactly as `list` leaves it: items plus the cursor chain IS the
 *  whole thread, because this is a keyset ordering and not a score-ranked retrieval.
 *
 *  The keyset is the SAME tuple the other read routes use, read FORWARD rather than
 *  backward: a thread reads oldest first, so the seek takes rows strictly AFTER the cursor
 *  in the (date, id) ordering this query already imposed.
 *
 *  `viewer` may be ONE address or a SET (#425), matching messageAccessible: a thread
 *  reached from a role view is scoped to the member PLUS its role queues. Absent =
 *  estate, exactly as before. */
export async function thread(
  env: Env,
  threadId: string,
  viewer?: string | readonly string[],
  opts: { limit?: number; cursor?: string } = {},
): Promise<Page<StoredMessage>> {
  const limit = clampThreadLimit(opts.limit);
  const clause = accessClause(readScopeOf(viewer));
  const where: string[] = ["thread_id = ?"];
  const binds: unknown[] = [threadId];
  if (clause.sql) {
    where.push(clause.sql);
    binds.push(...clause.binds);
  }
  const cur = decodeCursor(opts.cursor);
  if (cur) {
    where.push("(date > ? OR (date = ? AND id > ?))");
    binds.push(cur.date, cur.date, cur.id);
  }
  // `id` joins the projection because the cursor tuple needs it; it is not part of
  // MessageRow, which the unpaged single-message reads still use unchanged.
  const res = await env.DB.prepare(
    `SELECT id, message_id, direction, thread_id, from_addr, to_addr, subject, date,
            in_reply_to, body_text, body_html, spf, dkim, dmarc, trusted, received_at, seen,
            delivered_to, cc_addr, bcc_addr, sender_addr, reply_to_addr, wire_size,
            projected_size, projection_version,
            flagged, answered, mailbox, trashed_at
       FROM messages WHERE ${where.join(" AND ")} ORDER BY date, id LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<MessageRow & { id: number }>();
  const rows = res.results ?? [];
  // One extra row fetched, so "is there another page" is observed rather than guessed.
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: StoredMessage[] = [];
  for (const row of pageRows) {
    items.push(rowToMessage(row, await attachmentsFor(env.DB, row.message_id)));
  }
  const last = pageRows[pageRows.length - 1];
  return { items, cursor: hasMore && last ? encodeCursor(last.date, last.id) : null };
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
/** WHOSE per-recipient seen state a read RENDERS (#404).
 *
 *  Independent of WHICH ROWS a read returns: `to` / `viewer` select the rows,
 *  `seenFor` only picks the `message_seen_by` row the COALESCE reads. A folder view
 *  keyed to a role address (`to=R`) can therefore render the human reader's seen
 *  state without the predicate pretending R is the reader. Absent, the key is the
 *  viewer as before (session identity, else `to`), so every existing read is
 *  byte-identical.
 *
 *  It also keys the `seen=` FILTER, which shares this expression: "R's mail that I
 *  have not read" is one query, not a client-side subtraction. */
function seenKey(q: { seenFor?: string; viewer?: string; to?: string }): string | undefined {
  return (
    q.seenFor?.trim().toLowerCase() ||
    q.viewer?.trim().toLowerCase() ||
    q.to?.trim().toLowerCase() ||
    undefined
  );
}

function seenProjection(viewer: string | undefined): { expr: string; binds: unknown[] } {
  if (!viewer) return { expr: "m.seen", binds: [] };
  return {
    expr:
      "COALESCE((SELECT sb.seen FROM message_seen_by sb " +
      "WHERE sb.message_id = m.message_id AND sb.recipient = ?), m.seen)",
    binds: [viewer],
  };
}

/** The (to + direction/lens) WHERE fragments shared by list, fts, and substr search.
 *  - to=V: delivered-set membership (#178), COALESCE fallback to a v1 to_addr.
 *  - direction=D: the STORED wire fact, exactly, viewer or not (#403). Before #403 a
 *    viewer-scoped direction=inbound was silently rewritten into the INBOX lens, so
 *    an explicit filter could not be expressed and rows contradicted the filter they
 *    came back under (an outbound sent copy answering "did anything arrive").
 *  - lens=inbox (needs V): viewer-relative INBOX (#350) -- inbound mail for V PLUS
 *    same-store outbound NOT authored by V, so a same-domain send lands in the
 *    recipient INBOX, not only the sender Sent. A true self-send (from=V) stays
 *    Sent-only (correct: you wrote it). This is exactly the predicate that used to
 *    hide behind direction=inbound; it now has its own name.
 *  - lens=sent (needs V): sender-based (from_addr = V), never delivered-set based,
 *    so the membership fragment is dropped.
 *  Outbound from_addr is a bare address by construction (mailbox.send), so the
 *  lower() compare is exact; the lens branch only inspects outbound rows anyway. */
function recipientWhere(
  viewer: string | undefined,
  direction: "inbound" | "outbound" | undefined,
  lens?: ViewLens,
): { membership: string | null; membershipBinds: unknown[]; direction: string | null; directionBinds: unknown[] } {
  // A lens is a view OF someone. Without a viewer there is nothing to be relative
  // to, and quietly dropping it would hand back an estate answer under a
  // viewer-scoped question -- the failure this issue exists to remove. The API edge
  // refuses this with a 400 first; this is the last-line guard for internal callers.
  if (lens && !viewer) throw new Error("store: lens requires a viewer");
  const out = {
    membership: null as string | null,
    membershipBinds: [] as unknown[],
    direction: null as string | null,
    directionBinds: [] as unknown[],
  };
  if (viewer && lens === "sent") {
    out.direction = "lower(m.from_addr) = ?";
    out.directionBinds = [viewer];
    return out;
  }
  if (viewer) {
    const member = membershipClause(viewer, { alias: "m" });
    out.membership = member.sql;
    out.membershipBinds = member.binds;
  }
  if (viewer && lens === "inbox") {
    out.direction = "(m.direction = 'inbound' OR (m.direction = 'outbound' AND lower(m.from_addr) <> ?))";
    out.directionBinds = [viewer];
    return out;
  }
  if (direction === "inbound" || direction === "outbound") {
    out.direction = "m.direction = ?";
    out.directionBinds = [direction];
  }
  return out;
}

/** Account-owned view for a bound webmail session. Same #403 split as
 *  recipientWhere: `lens` names the Inbox/Sent folder views, and `direction`
 *  filters the stored wire fact inside the account boundary.
 *
 *  `recipient` is the caller's `to=` (#422). Under a session the ACCOUNT is the
 *  viewer, so `to=` is no longer "whose mailbox is this"; it is an ordinary
 *  recipient FILTER, and it is ANDed INSIDE the boundary, never widening it. It
 *  used to be accepted and then dropped on the floor: a session asking for one
 *  correspondent got the unfiltered page back with no way to tell (the #403
 *  defect-2 family, a filter the answer was not filtered by).
 *
 *  It composes with the role branch (#425): a session `to=R` for a role R the
 *  session is a member of is rewritten upstream into the ROLE boundary (to=R,
 *  lens=inbox, seenFor=session) and reaches recipientWhere with no accountViewer,
 *  so it never gets here. Everything else falls through to this rule. */
function accountWhere(
  viewer: string,
  direction: "inbound" | "outbound" | undefined,
  lens?: ViewLens,
  recipient?: string,
): { membership: string | null; membershipBinds: unknown[]; direction: string | null; directionBinds: unknown[] } {
  // ONE membership predicate, and the bound value comes back WITH it, so the viewer
  // and the recipient filter are both matched literally.
  const viewerMember = membershipClause(viewer, { alias: "m" });
  const delivered = viewerMember.sql;
  // The recipient filter is delivered-set membership, exactly the predicate `to=`
  // means on every other auth path (recipientWhere), so one address filters the
  // same way whether the caller holds a session or a token.
  const recipientMember = recipient ? membershipClause(recipient, { alias: "m" }) : null;
  const filtered = (base: string | null, binds: unknown[]) => {
    if (!recipientMember) return { membership: base, membershipBinds: binds };
    return base
      ? {
          membership: `(${base}) AND ${recipientMember.sql}`,
          membershipBinds: [...binds, ...recipientMember.binds],
        }
      : { membership: recipientMember.sql, membershipBinds: [...recipientMember.binds] };
  };
  if (lens === "inbox") {
    return {
      ...filtered(delivered, [...viewerMember.binds]),
      direction: "(m.direction = 'inbound' OR (m.direction = 'outbound' AND lower(m.from_addr) <> ?))",
      directionBinds: [viewer],
    };
  }
  if (lens === "sent") {
    // Sent is sender-based, so membership is free for the recipient filter to
    // use: to=X under lens=sent is "my sent mail that went to X".
    return {
      ...filtered(null, []),
      direction: "lower(m.from_addr) = ?",
      directionBinds: [viewer],
    };
  }
  // Account boundary (delivered to V or authored by V), plus the exact stored
  // direction when one was asked for.
  return {
    ...filtered(`(${delivered} OR lower(m.from_addr) = ?)`, [...viewerMember.binds, viewer]),
    direction: direction ? "m.direction = ?" : null,
    directionBinds: direction ? [direction] : [],
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

/** Sanitize caller text into an FTS5 MATCH expression. FTS5 query syntax would
 *  otherwise throw on quotes/operators (and could be abused), so the text is
 *  reduced to word tokens. Empty input -> no MATCH.
 *
 *  Word tokens are quoted (so caller input can never inject an FTS operator or
 *  break the query) and joined with AND: EVERY token must appear in a matching
 *  message. The pre-#403 join was OR, which made ABSENCE unrepresentable -- a
 *  multi-token marker that exists nowhere still matched any message carrying any
 *  one of its tokens, so "search for the marker, assert a hit" went green on
 *  garbage (#403 defect 1). An all-punctuation query still matches nothing.
 *
 *  Cap: only the first FTS_MAX_TOKENS tokens are required. Under AND that cap can
 *  only WIDEN a match (fewer required terms), so it is documented in CONTRACT
 *  section 1 rather than left silent; read-back markers are far below it. */
const FTS_MAX_TOKENS = 16;

function toFtsQuery(q: string): string {
  const tokens = (q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, FTS_MAX_TOKENS);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" AND ");
}

/**
 * List / filter messages, newest first, keyset-paginated. q (when present) is an
 * FTS match over subject + body. All filter values are bound params; the FTS
 * query is sanitized to a phrase expression (no injection, no syntax errors).
 */
/**
 * The row predicate for a list read, as ONE builder (#648).
 *
 * Extracted so a COUNT and the ROWS it counts cannot be filtered differently. A count
 * computed from a SECOND predicate is a number the caller cannot reach by paging, and it
 * is worse than no count at all: it reads as authoritative and nothing contradicts it.
 * `folders` already shares one set of predicates between its counts and the rows those
 * counts describe, for exactly this reason; this is that discipline applied to the
 * enumeration route.
 *
 * It deliberately EXCLUDES the seen projection's bind. That bind belongs to the SELECT
 * column list rather than to the predicate (see seenProjection), so it stays at the call
 * site, which is the only place that can put it BEFORE these binds. A COUNT has no such
 * column and must not carry it.
 *
 * `matchesNothing` is the q-was-all-punctuation case. It is a property of the QUERY, not
 * of the SQL, so it is returned rather than encoded as a `WHERE 0`: both callers have to
 * answer it, and they have to answer it the same way.
 *
 * `cursor: false` omits the keyset seek. A count is of the WHOLE match set; counting the
 * remainder after a cursor would answer a question nobody asked, which is why the API
 * edge refuses `countOnly` together with `cursor` instead of quietly picking one.
 */
function listPredicate(
  q: ListQuery,
  opts: { cursor: boolean },
): { sql: string; binds: unknown[]; matchesNothing: boolean } {
  const accountViewer = q.viewer?.trim().toLowerCase() || undefined;
  const recipientViewer = q.to?.trim().toLowerCase() || undefined;
  const where: string[] = [];
  const binds: unknown[] = [];

  const useFts = typeof q.q === "string" && q.q.trim().length > 0;
  const ftsExpr = useFts ? toFtsQuery(q.q as string) : "";

  if (useFts && ftsExpr) {
    where.push("m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
    binds.push(ftsExpr);
  } else if (useFts && !ftsExpr) {
    // q was all punctuation/whitespace: matches nothing.
    return { sql: "", binds: [], matchesNothing: true };
  }

  // Recipient view (#178 delivered-set membership) at the `to` slot; the
  // direction/lens predicate (#350 INBOX view, #403 exact direction) is appended
  // AFTER from/thread so the bind order stays stable. ONE builder for list, fts,
  // and substr search.
  const rv = accountViewer
    ? accountWhere(accountViewer, q.direction, q.lens, recipientViewer)
    : recipientWhere(recipientViewer, q.direction, q.lens);
  if (rv.membership) {
    where.push(rv.membership);
    binds.push(...rv.membershipBinds);
  }
  if (q.from) {
    where.push("lower(m.from_addr) LIKE ? ESCAPE '\\'");
    binds.push(escapeLikePattern(q.from.toLowerCase()));
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
  // The date window (#647), the SAME predicate the search modes use, placed here so the
  // pre-existing bind order (seen, fts, membership, from, thread, direction, mailbox, then
  // the cursor seek) is unchanged for every caller that sends no bounds.
  pushDateRange(where, binds, q);

  if (opts.cursor) {
    const cur = decodeCursor(q.cursor);
    if (cur) {
      // Keyset seek: rows strictly older than the cursor tuple (date, id).
      where.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
      binds.push(cur.date, cur.date, cur.id);
    }
  }

  return {
    sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    binds,
    matchesNothing: false,
  };
}

export async function list(env: Env, q: ListQuery): Promise<Page<StoredMessageSummary>> {
  const limit = clampLimit(q.limit);
  const sp = seenProjection(seenKey(q));
  const pred = listPredicate(q, { cursor: true });
  if (pred.matchesNothing) return { items: [], cursor: null };

  const sql =
    `SELECT m.id, m.message_id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
            m.date, m.in_reply_to, m.trusted, m.received_at, ${sp.expr} AS seen,
            m.delivered_to, m.cc_addr, m.bcc_addr, m.sender_addr, m.reply_to_addr, m.wire_size,
            m.projected_size, m.projection_version,
            m.flagged, m.answered, m.mailbox, m.trashed_at,
            (SELECT mp.folder_uid FROM mailbox_placement mp WHERE mp.message_id=m.message_id AND mp.folder=m.mailbox) AS folder_uid,
            ${SUMMARY_HAS_HTML_SQL},
            (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.message_id) AS attachment_count
       FROM messages m ${pred.sql}
      ORDER BY m.date DESC, m.id DESC
      LIMIT ?`;
  // The seen bind lives in the SELECT column list, so it MUST precede the WHERE binds.
  // Fetch one extra row to know whether another page exists.
  const binds = [...sp.binds, ...pred.binds, limit + 1];

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
 * How many messages match a list query (#648), under the SAME predicate `list` uses.
 *
 * "How many match this" was only answerable by paging the whole result and counting,
 * which is the payload problem that made #631 unanswerable. It is also the cheapest way
 * for a caller to decide whether to spend a real query, and the only way to tell "nothing
 * matches" from "the page was truncated".
 *
 * The count carries NO limit and NO cursor: both describe a page, and this describes the
 * match set. It shares `listPredicate` with the rows rather than re-deriving the filters,
 * so the number is always reachable by paging the same query.
 *
 * COUNT(*) over `messages m` is exact for this predicate: the row SELECT's extra columns
 * (folder_uid, hasHtml, attachment_count) are correlated subqueries in the projection and
 * join nothing, so they cannot change which rows the WHERE admits.
 */
export async function countList(env: Env, q: ListQuery): Promise<number> {
  const pred = listPredicate(q, { cursor: false });
  if (pred.matchesNothing) return 0;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM messages m ${pred.sql}`)
    .bind(...pred.binds)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export type SystemFolderId = "inbox" | "sent" | "all" | "drafts" | "trash" | "junk" | "archive";

export interface FolderSummary {
  /** A fixed personal folder, or `role:<address>` for a role queue (#425). */
  id: SystemFolderId | `role:${string}`;
  label: string;
  count: number;
  unread: number;
  /** Authoritative durable-folder UIDVALIDITY; absent on arrival views. */
  uidValidity?: number;
  /** The role ADDRESS this entry is the queue for (#425); absent on personal folders.
   *  Its presence is what tells a client the view is a shared queue, so the client
   *  never has to parse the id or carry its own list of role addresses. */
  role?: string;
}

/** The four folders that carry their own UIDVALIDITY (#352): re-populated boxes whose
 *  members arrive out of arrival order, so they cannot use messages.id as the IMAP UID. */
const DURABLE_UID_FOLDERS = ["trash", "junk", "archive", "drafts"] as const;

/** Server-authoritative folder counts using the same placement predicates as list.
 *
 *  `roles` (#425) appends one entry per role queue the VIEWER may read, after the fixed
 *  personal set and never merged into Inbox. Membership is decided by the caller
 *  (api.ts), the only layer that knows the request is a bound session; this function
 *  counts what it is handed and asserts nothing about who may see it.
 *
 *  ONE statement (#477). This used to issue fifteen statements for a bare viewer and one
 *  more per role queue: six aggregate scans of `messages`, a drafts count, and an
 *  INSERT-then-SELECT UID-counter init for each of the four durable folders, every one of
 *  them awaited in series. Against a local SQLite that whole sequence is ~50ms at 50k
 *  rows, so the scanning was never the cost; against D1 each statement is a network round
 *  trip, which is what the measured ~2.2s p50 in production actually was (#477: 80
 *  samples, max/p50 = 1.21, the signature of a fixed hop count rather than jitter).
 *
 *  So: the counts are conditional aggregates over ONE pass of `messages`, the per-viewer
 *  read override is a join instead of a per-folder correlated subquery, and the drafts
 *  count plus the four UIDVALIDITY values ride the same statement as uncorrelated scalar
 *  subqueries. No index is added because none can help -- every folder count here is an
 *  aggregate over the whole estate, which is a scan by definition. The answer is
 *  unchanged: the predicates are the same strings in the same order, and
 *  folders-one-statement.test.ts re-derives every number with the old per-folder SQL over
 *  a seeded store and asserts the two agree.
 *
 *  The lazy UID-counter mint is preserved, but it now runs only for a folder that has no
 *  counter row yet (once in the life of an estate) instead of on every read. */
export async function folders(
  env: Env,
  viewer?: string,
  roles: readonly string[] = [],
): Promise<FolderSummary[]> {
  const identity = viewer?.trim().toLowerCase() || undefined;
  // The shared accessClause, aliased to this statement, so the rail counts exactly what
  // the list and read paths would show.
  const accessPredicate = accessClause(identity ? [identity] : "estate", "m");
  const access = accessPredicate.sql || "1=1";
  // The per-recipient read override as a JOIN rather than the seenProjection()
  // correlated subquery: message_seen_by is PRIMARY KEY (message_id, recipient), so with
  // the recipient pinned the join matches at most one row per message and cannot inflate
  // a count, and the effective flag becomes a plain column that every unread sum below
  // shares instead of a lookup re-run per folder.
  const seenExpr = identity ? "COALESCE(sb.seen, m.seen)" : "m.seen";

  interface FolderSpec {
    id: FolderSummary["id"];
    label: string;
    predicate: string;
    binds: unknown[];
    role?: string;
  }
  const identityBinds = [...accessPredicate.binds];
  const specs: FolderSpec[] = [
    {
      id: "inbox",
      label: "Inbox",
      predicate: identity
        ? "m.mailbox IS NULL AND " + access +
          " AND (m.direction='inbound' OR (m.direction='outbound' AND lower(m.from_addr) <> ?))"
        : "m.mailbox IS NULL AND m.direction='inbound'",
      binds: identity ? [...accessPredicate.binds, identity] : [],
    },
    {
      id: "sent",
      label: "Sent",
      predicate: identity
        ? "m.mailbox IS NULL AND lower(m.from_addr) = ?"
        : "m.mailbox IS NULL AND m.direction='outbound'",
      binds: identity ? [identity] : [],
    },
    { id: "all", label: "All", predicate: access, binds: [...identityBinds] },
    { id: "trash", label: "Trash", predicate: `m.mailbox='trash' AND ${access}`, binds: [...identityBinds] },
    { id: "junk", label: "Junk", predicate: `m.mailbox='junk' AND ${access}`, binds: [...identityBinds] },
    { id: "archive", label: "Archive", predicate: `m.mailbox='archive' AND ${access}`, binds: [...identityBinds] },
  ];
  // Role queues (#425). The count is the role ARRIVAL view -- delivered to R, with the
  // inbox lens taken relative to R (so a same-domain send TO the queue counts, and the
  // queue own outbound does not) -- which is byte for byte the predicate the IMAP door
  // role folder reads with. Read state is keyed on the MEMBER, so two members of one
  // queue never inherit each other unread counts, and the rail agrees with the list.
  //
  // These are extra aggregate COLUMNS, not extra statements. The bound is the size of the
  // operator config map (POSTERN_VIEWER_ROLES), never anything a caller sends, so the rail
  // polling this endpoint cannot inflate the work either way.
  for (const raw of identity ? roles : []) {
    const role = raw.trim().toLowerCase();
    if (!role) continue;
    const at = role.indexOf("@");
    const roleMember = membershipClause(role, { alias: "m" });
    specs.push({
      id: `role:${role}`,
      label: at > 0 ? role.slice(0, at) : role,
      role,
      predicate:
        "m.mailbox IS NULL" +
        ` AND ${roleMember.sql}` +
        " AND (m.direction='inbound' OR (m.direction='outbound' AND lower(m.from_addr) <> ?))",
      binds: [...roleMember.binds, role],
    });
  }

  // Binds are pushed in the order their placeholders appear in the finished SQL text:
  // every spec column pair first (each predicate is written twice, so its binds go in
  // twice), then the drafts subquery, then the counter subqueries, then the join.
  const columns: string[] = [];
  const binds: unknown[] = [];
  specs.forEach((spec, i) => {
    columns.push(`SUM(CASE WHEN (${spec.predicate}) THEN 1 ELSE 0 END) AS c${i}`);
    binds.push(...spec.binds);
    columns.push(`SUM(CASE WHEN (${spec.predicate}) AND ${seenExpr}=0 THEN 1 ELSE 0 END) AS u${i}`);
    binds.push(...spec.binds);
  });
  // Uncorrelated scalar subqueries: SQLite evaluates each once for the whole statement,
  // so folding them in costs one lookup, not a per-row cost. Without an identity there
  // are no drafts to count (a draft is owned by a bound From), exactly as before.
  if (identity) {
    columns.push("(SELECT COUNT(*) FROM drafts WHERE identity = ?) AS drafts_count");
    binds.push(identity);
  } else {
    columns.push("0 AS drafts_count");
  }
  for (const folder of DURABLE_UID_FOLDERS) {
    columns.push(`(SELECT uidvalidity FROM mailbox_uid_counter WHERE folder = ?) AS uv_${folder}`);
    binds.push(folder);
  }
  const from = identity
    ? "FROM messages m LEFT JOIN message_seen_by sb" +
      " ON sb.message_id = m.message_id AND sb.recipient = ?"
    : "FROM messages m";
  if (identity) binds.push(identity);

  // A bare aggregate returns exactly one row, empty estate included, so the scalar
  // subqueries still answer when there is not a single message stored.
  const row = await env.DB.prepare(`SELECT ${columns.join(", ")} ${from}`)
    .bind(...binds)
    .first<Record<string, number | null>>();

  const uidValidity: Record<string, number> = {};
  for (const folder of DURABLE_UID_FOLDERS) {
    const stored = row?.[`uv_${folder}`];
    uidValidity[folder] = stored == null
      ? (await ensureFolderCounter(env, folder)).uidvalidity
      : Number(stored);
  }

  const result: FolderSummary[] = specs.map((spec, i) => ({
    id: spec.id,
    label: spec.label,
    ...(spec.role ? { role: spec.role } : {}),
    count: Number(row?.[`c${i}`] ?? 0),
    unread: Number(row?.[`u${i}`] ?? 0),
    ...(spec.id === "trash" || spec.id === "junk" || spec.id === "archive"
      ? { uidValidity: uidValidity[spec.id] }
      : {}),
  }));
  result.splice(3, 0, {
    id: "drafts",
    label: "Drafts",
    count: Number(row?.drafts_count ?? 0),
    unread: 0,
    uidValidity: uidValidity.drafts,
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

/**
 * The ONE date-range predicate, shared by list() and every search mode (#647).
 *
 * It used to live only inside pushCommonSearchFilters, so /api/messages had no date filter
 * at all and adding one meant either a second copy of this or this function. #647 asked for
 * one definition explicitly, so the predicate moved out here and both callers use it.
 *
 * Both bounds are INCLUSIVE, and they can only BE inclusive because the API edge
 * canonicalizes every accepted value to the exact form this column stores
 * (Date.toISOString()), which is what makes a plain string comparison correct. Three
 * boundary defects lived in the gap between those two facts before #647; parseDateBound in
 * api.ts and docs/CONTRACT.md 10.9 carry the measurements.
 *
 * Pushes `after` then `before`, matching the order the WHERE fragments go in, which is all
 * D1 positional binds require of a caller.
 */
function pushDateRange(where: string[], binds: unknown[], q: { after?: string; before?: string }): void {
  if (q.after) {
    where.push("m.date >= ?");
    binds.push(q.after);
  }
  if (q.before) {
    where.push("m.date <= ?");
    binds.push(q.before);
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
  pushDateRange(where, binds, q);
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
  const sp = seenProjection(seenKey(q));
  const seenExpr = sp.expr;
  // Seen bind (SELECT column) first, then the FTS match bind, then recipient/cursor.
  const binds: unknown[] = [...sp.binds, ftsExpr];
  const where: string[] = ["m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"];

  // Recipient view + named lens (#350/#178/#403); membership then direction, the
  // same order list/substr use, so fts shares the one view builder.
  const rv = accountViewer
    ? accountWhere(accountViewer, q.direction, q.lens, recipientViewer)
    : recipientWhere(recipientViewer, q.direction, q.lens);
  if (rv.membership) {
    where.push(rv.membership);
    binds.push(...rv.membershipBinds);
  }
  if (q.from) {
    where.push("lower(m.from_addr) LIKE ? ESCAPE '\\'");
    binds.push(escapeLikePattern(q.from.toLowerCase()));
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

async function substrSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  const raw = q.q ?? "";
  if (!raw) return { items: [], cursor: null };

  const cols = substrColumns(q.field ?? "text");
  const pattern = escapeLikePattern(raw);

  const accountViewer = q.viewer?.trim().toLowerCase() || undefined;
  const recipientViewer = q.to?.trim().toLowerCase() || undefined;
  const sp = seenProjection(seenKey(q));
  const seenExpr = sp.expr;

  // Case-insensitivity is SQLite LIKE's native ASCII folding (CONTRACT 10.8);
  // COALESCE(col,'') keeps a NULL header column from nulling the OR. Seen bind
  // (SELECT column) first, then one pattern bind per column, then recipient/cursor.
  const binds: unknown[] = [...sp.binds];
  const orClause = cols.map((c) => `COALESCE(m.${c},'') LIKE ? ESCAPE '\\'`).join(" OR ");
  for (let k = 0; k < cols.length; k++) binds.push(pattern);
  const where: string[] = [`(${orClause})`];

  // Recipient view + named lens (#350/#178/#403), the same builder as list/fts.
  const rv = accountViewer
    ? accountWhere(accountViewer, q.direction, q.lens, recipientViewer)
    : recipientWhere(recipientViewer, q.direction, q.lens);
  if (rv.membership) {
    where.push(rv.membership);
    binds.push(...rv.membershipBinds);
  }
  if (q.from) {
    where.push("lower(m.from_addr) LIKE ? ESCAPE '\\'");
    binds.push(escapeLikePattern(q.from.toLowerCase()));
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

/**
 * Vectorize's OWN ceiling on topK for the way we query it.
 *
 * 50 with `returnValues: true` or `returnMetadata: "all"`; 100 only with neither; 20 on a
 * LEGACY V1 index, where returnMetadata is a boolean. We pass `returnMetadata: "all"` to read
 * `message_id` back, so 50 is our ceiling and there is no knob that raises it.
 *
 * This is a HARD wall, not a tuning parameter, and it is the honest reason a score-ranked
 * answer can be incomplete: there is no "fetch more" to loop on. Widening it for real means
 * pushing the date/recipient predicate INTO the query with Vectorize metadata filtering, so
 * the top N is the top N INSIDE the window rather than whatever survives the global top N.
 * That needs metadata indexes on the index plus a corpus re-upsert, so it is a deliberate
 * migration, not a code change here. Until then this module DECLARES the truncation.
 *
 * Cross-check when touching this: RECONCILE_SAMPLE_TOPK below cites 20, which was the V1
 * number and is now only the legacy ceiling.
 */
const VECTOR_TOPK_MAX = 50;

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
  wide: boolean,
): Promise<{ ranked: { messageId: string; score: number }[]; exhausted: boolean; topK: number }> {
  // `wide` = a filter will be applied AFTER hydration, so every row the filter drops is a
  // row the retrieval should have replaced and did not. limit*3 was always a guess at how
  // many chunks collapse into `limit` messages; under a filter it is the WRONG guess, and
  // quietly so: a limit-5 query asked for 15 chunks store-wide and then threw most of them
  // away against a date window, which is how a month of mail answered with two hits. When a
  // filter is active we ask for the ceiling outright. That does not make the answer complete
  // (see VECTOR_TOPK_MAX), it just stops us discarding headroom we already had.
  const topK = wide ? VECTOR_TOPK_MAX : Math.min(VECTOR_TOPK_MAX, Math.max(limit * 3, limit));
  if (!env.VECTORIZE) return { ranked: [], exhausted: false, topK };
  const res = (await env.VECTORIZE.query(queryVec, {
    topK,
    returnMetadata: "all",
  })) as { matches?: VectorizeMatch[] };
  const matches = res.matches ?? [];
  const best = new Map<string, number>();
  for (const m of matches) {
    const id = m.metadata?.message_id;
    if (!id) continue;
    const prev = best.get(id);
    if (prev === undefined || m.score > prev) best.set(id, m.score);
  }
  const collapsed = [...best.entries()]
    .map(([messageId, score]) => ({ messageId, score }))
    .sort((a, b) => b.score - a.score);
  // THE ORDERING IS THE WHOLE FIX. Slicing to `limit` here, before hydration, is what made a
  // filtered query answer with almost nothing: a message that matched the window but ranked
  // below `limit` GLOBALLY was discarded before the window was ever consulted, so raising the
  // retrieval ceiling on its own changed nothing. When a post-retrieval filter is active we
  // hand back every candidate and let the caller slice AFTER filtering. Unfiltered queries
  // keep the cheap path: there is nothing to thin, so the old slice is still exactly right and
  // still bounds the hydration query.
  const ranked = wide ? collapsed : collapsed.slice(0, limit);
  // Fewer matches than we asked for means the index had nothing else to give, so the
  // CANDIDATE set really was exhausted and an exhaustion claim is honest. Hitting the
  // ceiling proves only that we stopped asking.
  return { ranked, exhausted: matches.length < topK, topK };
}

/**
 * Does this query carry a predicate the score-ranked modes can only apply AFTER retrieval?
 *
 * Every one of these is pushed into SQL by the keyset modes and cannot be pushed into a
 * vector query at all, so for semantic/hybrid they are all post-hydration thinning. If any is
 * present, retrieval must not also be narrowed by a limit-derived guess.
 */
function hasPostRetrievalFilter(q: SearchQuery): boolean {
  return Boolean(
    q.after ||
      q.before ||
      q.mailbox !== undefined ||
      q.hasAttachment !== undefined ||
      q.seen !== undefined ||
      q.to ||
      q.from ||
      q.viewer ||
      q.lens ||
      q.direction,
  );
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
 * WHERE to Vectorize. Mirrors /api/messages semantics on a hydrated summary, and
 * must stay predicate-for-predicate identical to recipientWhere / accountWhere:
 *  - no viewer: the optional stored-direction filter only (#128), as before.
 *  - to=V: delivered-set membership (drop anything NOT delivered to V -- the leak the
 *    lead caught), then lens=inbox (inbound OR outbound-not-authored-by-V) or the
 *    EXACT stored direction (#403), never one silently standing in for the other.
 *  - lens=sent: sender-based (from == V), membership not required.
 *  - from= (#366): same lower(from_addr) substring match as list/fts/substr.
 *  - accountViewer + to= (#422): the account boundary decides WHAT the caller may
 *    see; `to=` is then an ordinary recipient filter ANDed inside it, matching the
 *    accountWhere(recipient) predicate the SQL modes push down. This mirror is the
 *    reason the filter is applied before the lens branches: semantic/hybrid must
 *    not answer a filtered question with an unfiltered page either.
 */
function passesViewerScope(
  m: StoredMessageSummary,
  viewer: string | undefined,
  direction: "inbound" | "outbound" | undefined,
  fromFilter?: string,
  accountViewer?: string,
  lens?: ViewLens,
): boolean {
  if (fromFilter) {
    const needle = fromFilter.toLowerCase();
    if (!m.from.toLowerCase().includes(needle)) return false;
  }
  const bareFrom = (parseRecipients(m.from)[0] ?? "").toLowerCase();
  const scope = accountViewer ?? viewer;
  // #422: under an account boundary, `viewer` here is the caller's to= RECIPIENT
  // FILTER, not the viewer, so it applies on top of every branch below (including
  // lens=sent, whose early return would otherwise swallow it).
  if (accountViewer && viewer && !m.deliveredTo.some((a) => a.toLowerCase() === viewer)) return false;
  if (scope && lens === "sent") return bareFrom === scope;
  if (accountViewer) {
    const delivered = m.deliveredTo.map((a) => a.toLowerCase());
    if (lens === "inbox") {
      return delivered.includes(accountViewer) &&
        (m.direction === "inbound" || (m.direction === "outbound" && bareFrom !== accountViewer));
    }
    if (!delivered.includes(accountViewer) && bareFrom !== accountViewer) return false;
    return !direction || m.direction === direction;
  }
  if (!viewer) return !direction || m.direction === direction;
  const delivered = m.deliveredTo.map((a) => a.toLowerCase());
  if (!delivered.includes(viewer)) return false;
  if (lens === "inbox") {
    return m.direction === "inbound" || (m.direction === "outbound" && bareFrom !== viewer);
  }
  return !direction || m.direction === direction;
}

async function semanticSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  const text = (q.q ?? "").trim();
  if (!text) return { items: [], cursor: null };

  const viewer = q.to?.trim().toLowerCase() || undefined;
  const fromFilter = q.from?.trim() || undefined;
  const accountViewer = q.viewer?.trim().toLowerCase() || undefined;
  const queryVec = await embedQuery(env, text);
  // An absent AI binding is not "no matching mail": the query never ran. Answering an
  // unexplained empty page here is the purest form of the completeness lie, because zero rows
  // plus a null cursor reads as a searched-and-found-nothing result.
  if (!queryVec) {
    return {
      items: [],
      complete: false,
      degraded: "semantic search unavailable: no AI binding is configured, so no query was run",
    };
  }
  if (!env.VECTORIZE) {
    return {
      items: [],
      complete: false,
      degraded: "semantic search unavailable: no Vectorize binding is configured, so no query was run",
    };
  }

  const wide = hasPostRetrievalFilter(q);
  const { ranked, exhausted, topK } = await nearestMessageIds(env, queryVec, limit, wide);
  const summaries = await summariesByIds(env, ranked.map((r) => r.messageId), seenKey(q));
  const items: SearchHit[] = [];
  for (const r of ranked) {
    const message = summaries.get(r.messageId);
    if (!message) continue;
    // Viewer scope + direction/lens + from= (#350/#128/#366/#403): the vector index
    // is neither recipient-, sender-, nor direction-keyed, so scope the hydrated
    // summaries with the same predicates the SQL modes push down.
    if (!passesViewerScope(message, viewer, q.direction, fromFilter, accountViewer, q.lens)) continue;
    // Folder/date/attachment/seen (#354): same post-hydrate gate as the SQL modes.
    if (!passesCommonSearchFilters(message, q)) continue;
    items.push({ message, score: r.score });
  }
  // Slice AFTER filtering, so `limit` bounds the ANSWER rather than the candidate pool.
  const page = items.slice(0, limit);
  // A vector index has no offset, so there is no continuation to hand back either way. What
  // differs is the CLAIM: null asserts exhaustion, and we may only assert it on two conditions
  // together -- the index ran out of candidates before our ceiling did, AND filtering did not
  // leave more matches than this page carries. Either one alone would be a claim we cannot
  // support, so the cursor is OMITTED and the truncation is stated, and a caller cannot read
  // exhaustion out of this response at all.
  const more = items.length > page.length;
  if (exhausted && !more) return { items: page, cursor: null, complete: true };
  const out: Page<SearchHit> = { items: page, complete: false, retrievalCap: topK };
  if (more) {
    out.degraded =
      "more matching messages were retrieved than `limit` allows, and a score-ranked mode has no cursor to resume from: raise limit or narrow the query";
  }
  return out;
}

async function hybridSearch(env: Env, q: SearchQuery): Promise<Page<SearchHit>> {
  const limit = clampLimit(q.limit);
  // Pull each side, then merge by message_id on a normalized 0..1 score and sum.
  const shared = {
    q: q.q,
    direction: q.direction,
    lens: q.lens,
    seenFor: q.seenFor,
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
  // A blend is complete only if BOTH halves were. The FTS half is keyset-paginated, so it is
  // complete exactly when it handed back no continuation; the semantic half reports for
  // itself. This is the DEFAULT mode for the MCP door, which is why it mattered most that it
  // stopped claiming exhaustion it had not earned.
  const ftsComplete = ftsPage.complete ?? ftsPage.cursor === null;
  const semComplete = semPage.complete ?? semPage.cursor === null;
  if (ftsComplete && semComplete) return { items, cursor: null, complete: true };
  const out: Page<SearchHit> = { items, complete: false };
  if (semPage.retrievalCap !== undefined) out.retrievalCap = semPage.retrievalCap;
  const reasons = [semPage.degraded, ftsComplete ? undefined : "more keyword matches remain beyond this page"]
    .filter(Boolean)
    .join("; ");
  if (reasons) out.degraded = reasons;
  return out;
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

/**
 * Authoritative projection-version census for the whole estate (#520).
 *
 * Answers the question the reproject runner and operators actually need after a
 * PROJECTION_VERSION bump: how many rows are NOT at the current version, right
 * now -- without paging the mailbox and without privileged D1 access.
 *
 * Single aggregate query. `atCurrent + notCurrent === total` is an invariant of
 * the same result (the positive control against a broken WHERE that would read
 * as a clean sweep). `notCurrent` is NULL version OR any version other than
 * PROJECTION_VERSION.
 */
export interface ProjectionCountResult {
  total: number;
  atCurrent: number;
  notCurrent: number;
  /** The PROJECTION_VERSION constant the counts were evaluated against. */
  projectionVersion: number;
}

export async function countProjectionStatus(env: Env): Promise<ProjectionCountResult> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total, " +
      "COALESCE(SUM(CASE WHEN projection_version = ? THEN 1 ELSE 0 END), 0) AS at_current, " +
      "COALESCE(SUM(CASE WHEN projection_version IS NULL OR projection_version != ? THEN 1 ELSE 0 END), 0) AS not_current " +
      "FROM messages",
  )
    .bind(PROJECTION_VERSION, PROJECTION_VERSION)
    .first<{ total: number; at_current: number; not_current: number }>();
  const total = Number(row?.total ?? 0);
  const atCurrent = Number(row?.at_current ?? 0);
  const notCurrent = Number(row?.not_current ?? 0);
  // Invariant of the same result: a broken CASE would drop rows from both
  // buckets and still look "clean" if the caller only checked notCurrent === 0.
  if (atCurrent + notCurrent !== total) {
    throw new Error(
      `projection count invariant broken: atCurrent(${atCurrent}) + notCurrent(${notCurrent}) !== total(${total})`,
    );
  }
  return {
    total,
    atCurrent,
    notCurrent,
    projectionVersion: PROJECTION_VERSION,
  };
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

// --- Reproject sweep (#507): refill projected_size after a PROJECTION_VERSION bump ---
//
// A PROJECTION_VERSION bump invalidates every cached projected_size at once: the IMAP
// door only trusts a cached size whose stored projection_version matches the renderer
// it is running (imap/posternimap/message.py getSize). Nothing refills them on its own,
// because refreshProjectedSize is only ever called at store time. Without this sweep
// every pre-existing row is a permanent cache MISS, and each RFC822.SIZE on old mail
// costs the door a full message hydration, which is exactly the cost #342 exists to
// remove. Measured scale at the time of #507: 10634 rows.
//
// Shape is deliberately the reindexPage shape (#116 ws4): one keyset page per call, a
// cursor back to the runner, and a dryRun that computes everything and writes nothing.
// Idempotent: re-running over a row already at the current version rewrites the same
// number.

export interface ReprojectResult {
  /** Total messages in the store; first call only (no cursor), for a progress bar. */
  total?: number;
  processed: number; // rows examined this page
  updated: number; // rows whose stored size or version CHANGED (0 on a dry run)
  unchanged: number; // rows already correct at the current PROJECTION_VERSION
  missing: number; // rows that vanished between the page read and the projection
  failed: number; // rows whose post-write read-back did NOT match what we wrote
  nextCursor: string | null;
  done: boolean;
  dryRun: boolean;
}

interface ReprojectRow {
  id: number;
  message_id: string;
  date: string;
  projected_size: number | null;
  projection_version: number | null;
}

/** Same keyset order and opaque cursor as pageForReindex and the read API. */
async function pageForReproject(
  env: Env,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: ReprojectRow[]; nextCursor: string | null }> {
  const cur = decodeCursor(cursor);
  const binds: unknown[] = [];
  let where = "";
  if (cur) {
    where = " WHERE (date < ? OR (date = ? AND id < ?))";
    binds.push(cur.date, cur.date, cur.id);
  }
  const sql =
    "SELECT id, message_id, date, projected_size, projection_version" +
    ` FROM messages${where} ORDER BY date DESC, id DESC LIMIT ?`;
  binds.push(limit + 1);
  const res = await env.DB.prepare(sql).bind(...binds).all<ReprojectRow>();
  const all = res.results ?? [];
  const hasMore = all.length > limit;
  const rows = hasMore ? all.slice(0, limit) : all;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.date, last.id) : null;
  return { rows, nextCursor };
}

/**
 * reprojectPage recomputes projected_size for ONE page and verifies each write.
 *
 * Every row goes through projectedSizeFor, the same entry point live ingest uses, so a
 * backfilled size is byte-identical to the size the same message would get if it were
 * stored today. After each write the row is READ BACK and compared; a row whose
 * read-back does not match what was written counts as `failed` and is reported rather
 * than being silently folded into `updated`. A write nobody read back is not evidence
 * the write landed.
 */
export async function reprojectPage(
  env: Env,
  opts: { cursor?: string; limit?: number; dryRun?: boolean },
): Promise<ReprojectResult> {
  const dryRun = opts.dryRun === true;
  // Sample the store total BEFORE reading this page's rows, on the first call only
  // (no cursor). Ordering matters (#515): the previous code read it AFTER the first
  // page's rows were already fetched and processed, which left a window where a
  // message inserted between the two reads counted in `total` but had already been
  // passed by the very first page's SELECT, so it could never be walked by a later
  // page either. The runner's completion guard then compared `processed` to that
  // `total` and FATAL'd on a sweep that genuinely covered everything it needed to.
  // Reading total FIRST makes it a true lower bound instead: any row that exists at
  // the moment `total` is sampled is guaranteed to still be reachable by this page
  // or a later one, so a live mailbox can only ever grow `processed` past `total`,
  // never fall short of it through no fault of the sweep.
  const total = opts.cursor ? undefined : await countMessages(env);
  const { rows, nextCursor } = await pageForReproject(
    env,
    opts.cursor,
    clampReindexLimit(opts.limit),
  );

  let updated = 0;
  let unchanged = 0;
  let missing = 0;
  let failed = 0;

  for (const r of rows) {
    const size = await projectedSizeFor(env, r.message_id);
    if (size === null) {
      missing++;
      continue;
    }
    const current = r.projected_size;
    const version = r.projection_version;
    if (current === size && version === PROJECTION_VERSION) {
      unchanged++;
      continue;
    }
    if (dryRun) {
      updated++;
      continue;
    }
    await env.DB.prepare(
      "UPDATE messages SET projected_size = ?, projection_version = ? WHERE message_id = ?",
    )
      .bind(size, PROJECTION_VERSION, r.message_id)
      .run();
    const back = await env.DB.prepare(
      "SELECT projected_size, projection_version FROM messages WHERE message_id = ?",
    )
      .bind(r.message_id)
      .first<{ projected_size: number | null; projection_version: number | null }>();
    if (
      !back ||
      back.projected_size !== size ||
      back.projection_version !== PROJECTION_VERSION
    ) {
      failed++;
      continue;
    }
    updated++;
  }

  const result: ReprojectResult = {
    processed: rows.length,
    updated,
    unchanged,
    missing,
    failed,
    nextCursor,
    done: nextCursor === null,
    dryRun,
  };
  if (total !== undefined) result.total = total;
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
/** topK per sampling probe.
 *
 *  20 was the ceiling on a LEGACY V1 index. The current limit with `returnMetadata: "all"` is
 *  50 (100 applies only with no values and no metadata), so this constant is now a
 *  deliberately conservative sample size rather than a platform maximum, and the comment that
 *  called it one was wrong. Raising it would widen orphan-cause coverage per probe at
 *  proportional cost on a Conrad-supervised audit path, so the VALUE is left alone here and
 *  only the false claim is corrected. See VECTOR_TOPK_MAX. */
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

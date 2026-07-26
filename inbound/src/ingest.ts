// The inbound transport seam (issue #22). ingest() is a pure function of a
// normalized ParsedInbound: it owns the inbound-specific concerns (dedup key,
// body cleaning, the trust verdict, the Vectorize opt-in) and hands the
// normalized record to the store (store.ts), which is the only code that touches
// D1/R2/Vectorize. ingest() does NOT know about ForwardableEmailMessage,
// postal-mime, or forwarding -- those belong to a transport driver (the CF
// email() handler, or an out-of-Worker POST /ingest). See CONTRACT.md section 2.

import * as store from "./store";

/**
 * Normalized inbound message. Every inbound transport (CF Email Routing today,
 * postern-relay SMTP later) builds this shape and hands it to ingest().
 */
export interface ParsedInbound {
  /** Raw Message-ID without <>; ingest() stores it VERBATIM (see normalizeMessageId). */
  messageId?: string;
  from: string;
  /** The delivered-to recipient. */
  to: string;
  subject?: string;
  /** ISO date; defaults to now. */
  date?: string;
  inReplyTo?: string;
  references?: string[];
  text?: string;
  html?: string;
  attachments?: { filename?: string; mimeType?: string; content: ArrayBuffer }[];
  /** SPF/DKIM/DMARC verdicts; an SMTP transport may omit them. */
  auth?: { spf?: string; dkim?: string; dmarc?: string };
  // --- M8 envelope fidelity v2 (#189). All optional and wire-compatible: an older
  //     transport omits them and the store falls back to `to` / NULLs. `to` KEEPS
  //     its v1 meaning (THE delivered-to envelope recipient), so every existing
  //     driver stays correct with no change. ---
  /** Raw decoded To header; stored as to_addr when present (else falls back to `to`). */
  toHeader?: string;
  /** Raw decoded Cc header. */
  cc?: string;
  /** Raw decoded Sender header. */
  sender?: string;
  /** Raw decoded Reply-To header. */
  replyTo?: string;
  /** RFC822 wire byte size as received. */
  rawSize?: number;
}

export interface IngestResult {
  messageId: string;
  stored: boolean;
  /** A delivery of an already-stored Message-ID whose new envelope recipient was
   *  merged into delivered_to (#178), rather than a new row. */
  merged: boolean;
  threadId: string;
}

/**
 * Store one inbound message. Pure of transport: callers normalize whatever they
 * received into ParsedInbound first. ingest() owns the inbound-specific concerns
 * (body cleaning, the trust verdict, messageId normalization, the Vectorize
 * opt-in) and then hands the normalized record to the store, which is the only
 * code that touches D1/R2/Vectorize. Returns the normalized messageId, whether a
 * new row was written (false on a dedup hit), and the resolved thread id.
 */
export async function ingest(
  env: Env,
  parsed: ParsedInbound,
  ctx: ExecutionContext,
): Promise<IngestResult> {
  const fromAddr = parsed.from;
  const toAddr = parsed.to.toLowerCase();

  const spf = (parsed.auth?.spf ?? "none").toLowerCase();
  const dkim = (parsed.auth?.dkim ?? "none").toLowerCase();
  const dmarc = (parsed.auth?.dmarc ?? "none").toLowerCase();
  // CF Email Routing strips transport-level auth headers; fall back to
  // allowlist-only trust when neither verdict is available.
  const trusted = isTrusted(fromAddr, spf, dkim, env.TRUSTED_SENDER_DOMAINS);

  // Clean body: prefer plain text, strip quoted lines and sig block.
  const rawBody = parsed.text ?? htmlToText(parsed.html ?? "");
  const bodyText = cleanBody(rawBody).slice(0, 32_000);

  // Keep the original HTML body so the webmail can render it in a sandboxed
  // iframe (#57); bodyText stays the FTS source + plain-text fallback. Stored
  // raw (the iframe sandbox is the isolation boundary, not sanitization) and
  // size-capped to bound storage / render cost on very large messages.
  const bodyHtml = parsed.html ? parsed.html.slice(0, 512_000) : null;

  // Dedup key -- the sender's Message-ID kept VERBATIM (#486), or a stable
  // fallback when the message carries none. ONE normalizer, shared with the IMAP
  // APPEND path in api.ts.
  const messageId = await normalizeMessageId(env, parsed.messageId);
  const date = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();

  // Only index mail for addresses that opted in to crew RAG (VECTORIZE_FOR). The
  // SAME gate the #116 ws4 backfill applies (store.shouldVectorize), so live and
  // backfilled coverage match.
  const vectorize = store.shouldVectorize(store.vectorizeAllowlist(env), "inbound", [toAddr]);

  // Envelope fidelity v2 (#189): to_addr becomes the raw To HEADER (display names
  // and all) when the transport provides it, falling back to the envelope
  // recipient; delivered_to owns the envelope role via the bare recipient (toAddr).
  const toHeader = parsed.toHeader && parsed.toHeader.trim() ? parsed.toHeader : parsed.to;

  const result = await store.put(
    env,
    {
      messageId,
      direction: "inbound",
      from: fromAddr,
      to: toHeader,
      subject: parsed.subject ?? "",
      date,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references,
      bodyText,
      bodyHtml,
      auth: { spf, dkim, dmarc },
      trusted,
      attachments: parsed.attachments,
      vectorize,
      // The one bare lower-cased envelope recipient this invocation delivered to;
      // merged into an existing row's delivered_to on a same-Message-ID dedup (#178).
      deliveredTo: [toAddr, ...fileAlsoUnder(toAddr, env.FILE_ALSO_UNDER)],
      cc: parsed.cc ?? null,
      sender: parsed.sender ?? null,
      replyTo: parsed.replyTo ?? null,
      // Inbound bcc_addr is structurally NULL (a Bcc that reached us was the
      // sender's secret and is not in our headers) -- never populate it here.
      wireSize: parsed.rawSize ?? null,
    },
    ctx,
  );

  return { messageId: result.messageId, stored: result.stored, merged: result.merged, threadId: result.threadId };
}

// --- Helpers ---

/**
 * Role addresses belong to a FUNCTION, not a person: nothing about `abuse@` says
 * which human reads it. Per-account mailbox views scope every folder to the viewer
 * address, so a role address with no owner lands in the store and appears in NO view
 * at all -- delivered, stored, searchable through the API, and invisible in every mail
 * client. For an abuse or security intake address, that is the whole point of
 * publishing it, missed.
 *
 * FILE_ALSO_UNDER fixes the FILING rather than the transport: a matching message is
 * recorded as delivered to the extra address TOO, so it appears in that mailbox view
 * of the SAME stored message. Nothing is copied, nothing is re-transmitted, and no
 * mail leaves the estate.
 *
 * FORMAT: `role@example.com=person@example.com,role2@example.com=person@example.com`
 *
 * DELIBERATE PROPERTIES:
 * - SINGLE HOP. The map is consulted once, against the address the message was
 *   actually delivered to; a target is never expanded again. A config saying a=b and
 *   b=c files an a-message under b only, so no chain or cycle is expressible.
 * - A SELF-MAP IS A NO-OP and duplicate targets collapse, so the delivered set can
 *   never carry the same address twice.
 * - A MALFORMED ENTRY IS SKIPPED AND LOGGED, and the valid entries still apply. This
 *   is parsed on the DELIVERY path, so throwing would turn one typo into refused mail
 *   for every recipient, which is strictly worse than the typo. The warning names the
 *   offending entry (config text, never a credential).
 * - UNSET OR EMPTY CHANGES NOTHING. An address that is not the left side of an entry
 *   files exactly as before, which is what the suite asserts as its control.
 */
export function fileAlsoUnder(recipient: string, raw: string | undefined | null): string[] {
  const bare = recipient.trim().toLowerCase();
  if (!bare || !raw) return [];
  const out: string[] = [];
  for (const chunk of raw.split(",")) {
    const entry = chunk.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const from = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : "";
    const target = eq > 0 ? entry.slice(eq + 1).trim().toLowerCase() : "";
    if (!from.includes("@") || !target.includes("@")) {
      console.warn("FILE_ALSO_UNDER: ignoring malformed entry", entry);
      continue;
    }
    if (from !== bare || target === bare) continue;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * The longest Message-ID stored verbatim, measured in UTF-8 BYTES; past it the id
 * collapses to its sha256.
 *
 * The cap is NOT a Vectorize constraint. Vector ids are
 * `sha256hex(messageId).slice(0, 56) + ".<chunk>"` (store.vectorIdsForMessage), a fixed
 * 58 chars for an id of ANY length, and the raw id rides only in vector METADATA, which
 * is never an id and is never filtered on. D1's `message_id` is TEXT with no length
 * bound. Nothing downstream of the store needed the old 64-char cutoff.
 *
 * What DOES bound the id is the R2 attachment key, `att/<messageId>/<n>-<name>`, against
 * R2's 1024-byte key limit, and R2 counts that limit in BYTES.
 *
 * NEITHER count can actually cross it, and the honest arithmetic is worth writing down:
 * 255 UTF-16 units is at most 765 UTF-8 bytes (3-byte BMP characters are one unit each;
 * astral characters are two units and four bytes, so they top out lower), which with the
 * prefix, index, and sanitized 100-char filename reaches about 873 bytes. So a
 * char-counted cap would ALSO have held. The budget is counted in bytes anyway for two
 * reasons: the guarantee becomes exact instead of resting on a 150-byte slack factor
 * that a later change to the filename cap could quietly eat, and the stored id gets a
 * hard byte bound for the D1 index. Message-IDs are ASCII by RFC 5322, so for every real
 * id the two counts are identical; the distinction only decides what happens to a
 * malformed header.
 *
 * 255 also sits far above any Message-ID observed in production -- the longest GitHub
 * thread root measured is under 100 chars, and RFC 5322 folds the whole header line at
 * 998. Past the budget we still hash, so identity and dedup survive even an absurd
 * header; that path is a documented, tested refusal rather than the invisible cliff #486
 * filed.
 */
export const MAX_STORED_MESSAGE_ID_BYTES = 255;

/** The pre-#486 cutoff, in JS string length, because that is exactly what the old code
 *  compared. Ids longer than this MAY already be stored under their sha256. */
const LEGACY_COLLAPSE_ABOVE = 64;

const TE = new TextEncoder();

/**
 * The ONE place a Message-ID header becomes a stored id (#486). Both ingest paths (the
 * inbound transport seam here, and the IMAP APPEND import in api.ts) call it, so the two
 * cannot drift.
 *
 * WHY VERBATIM: the Message-ID is the only machine-parseable handle a sender gives us.
 * GitHub encodes `owner/repo/{issues,pull}/N@github.com` in it, and the old 64-char
 * collapse destroyed that structure for long ids with no error anywhere -- a consumer
 * keying on the structured id worked until a repo name or issue number crossed a length
 * it could not see, then silently stopped seeing new items. Keeping the header also fixes
 * THREADING for those ids: `in_reply_to` is stored raw, so a reply to a collapsed parent
 * never matched the parent row and started its own thread.
 *
 * LEGACY MERGE: a message ingested BEFORE this change already lives under its sha256. A
 * redelivery of that exact header must merge into that row (delivered_to, #178), not fork
 * a second copy under the raw id, so ids in the legacy range get one indexed existence
 * check against the hash first. A miss -- every id first seen from here on -- stores the
 * raw header. The check is scoped to ids over the old cutoff and disappears from practice
 * as those rows age out.
 */
export async function normalizeMessageId(env: Env, raw: string | undefined | null): Promise<string> {
  // `bare` is EXACTLY the string the pre-#486 code keyed on: <>-stripped, NOT trimmed.
  // The legacy lookup below must hash that string, or for a header that arrived with
  // surrounding whitespace it hashes something the old code never stored and misses the
  // very row it exists to find. What we STORE is the trimmed form, which is what
  // in_reply_to / references are compared as at thread resolution.
  const bare = (raw ?? "").replace(/[<>]/g, "");
  const stripped = bare.trim();
  if (!stripped) return crypto.randomUUID();
  if (TE.encode(stripped).length > MAX_STORED_MESSAGE_ID_BYTES) return await sha256hex(stripped);
  if (bare.length > LEGACY_COLLAPSE_ABOVE) {
    const legacy = await sha256hex(bare);
    if (await store.messageExists(env, legacy)) return legacy;
  }
  return stripped;
}

export async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Split text into overlapping windows (~chunk chars, overlap chars carried over)
// on whitespace boundaries where possible. bge-base handles ~512 tokens, so a
// 1200-char window stays comfortably under the limit.
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

/**
 * Extract the bare address from a From value that may carry a display name
 * (`"Cloudflare" <noreply@notify.cloudflare.com>` -> `noreply@notify.cloudflare.com`),
 * so allowlist/DMARC-style matching sees the address, not the label. `from` is now the
 * raw From HEADER (see index.ts), so trust MUST parse it; a bare address passes through
 * unchanged. `[^<>]+` (not `[^>]+`) keeps the match linear (no ReDoS on a "<"-heavy label).
 */
export function bareAddress(from: string): string {
  const angle = from.match(/<([^<>]+)>/);
  return (angle ? angle[1] : from).trim().toLowerCase();
}

/**
 * Allowlist trust decision. `allowlistEnv` is `env.TRUSTED_SENDER_DOMAINS`, read on the
 * INGEST path, so an ABSENT value must not throw (#473): a clean-install operator who
 * prunes a var whose shipped value is empty anyway would otherwise fail EVERY inbound
 * message, and as a TRANSIENT INFRA FAULT rather than a config message (the in-Worker
 * email() handler lets the throw escape and CF retries; /ingest answers 500, which the
 * relay maps to SMTP 451, so the sending MTA retries forever).
 *
 * Absent therefore reads exactly like the shipped "": an empty allowlist, so nothing is
 * trusted, which is the fail-closed direction. Same guard as store.vectorizeAllowlist()
 * (VECTORIZE_FOR) and the FORWARD_FOR read in index.ts; Env still declares the var
 * REQUIRED, as it does for every sibling comma-list var, and every read guards.
 */
export function isTrusted(from: string, spf: string, dkim: string, allowlistEnv: string | undefined): boolean {
  const domains = (allowlistEnv ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const fromLower = bareAddress(from);
  const onAllowlist = domains.some((d) => fromLower === d || fromLower.endsWith("@" + d));
  if (!onAllowlist) return false;
  // Auth verdicts available: require at least SPF pass/neutral OR DKIM pass.
  // If CF stripped both headers (spf=none AND dkim=none), allowlist alone is
  // sufficient -- CF's own MX infrastructure already handles inbound filtering.
  const spfOk = spf === "pass" || spf === "neutral";
  const dkimOk = dkim === "pass";
  const noAuthData = spf === "none" && dkim === "none";
  return spfOk || dkimOk || noAuthData;
}

// --- Body cleaning ---

/** RFC 5322 quoted previous text, not MCP JSON-RPC log markers (>>> / <<<). */
function isQuotedReplyLine(line: string): boolean {
  const t = line.trimStart();
  if (!t.startsWith(">")) return false;
  // MCP tools log >>> request / <<< response JSON-RPC lines; keep in stored body.
  if (/^>{3}\s*\{/.test(t) || /^<{3}\s*\{/.test(t)) return false;
  return /^>+(\s|$)/.test(t);
}

export function cleanBody(raw: string): string {
  // Strip sig block (RFC 3676 "-- \n" delimiter)
  const sigIdx = raw.indexOf("\n-- \n");
  const stripped = sigIdx !== -1 ? raw.slice(0, sigIdx) : raw;
  return stripped
    .split("\n")
    .filter((l) => !isQuotedReplyLine(l))
    .join("\n")
    .trim();
}

export function htmlToText(html: string): string {
  // Drop <script>/<style> blocks and their contents. Loop until the string is
  // stable so nested or reordered tags can't survive a single pass (a one-shot
  // .replace is defeated by e.g. "<scr<script>ipt>"); the end-tag patterns allow
  // whitespace before ">" so "</script >" is matched too. Body is stored for FTS
  // and embeddings, not rendered, but we strip thoroughly regardless.
  let out = html;
  const blockTag = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let prev: string;
  do {
    prev = out;
    out = out.replace(blockTag, "");
  } while (out !== prev);

  out = out
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n");

  // Strip any remaining tags, looping so overlapping "<<>>" forms can't leave a
  // partial tag behind after one pass.
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, "");
  } while (out !== prev);

  // Decode named entities. Decode &amp; LAST so an entity revealed by an earlier
  // pass (e.g. "&amp;lt;" -> "&lt;") is not then itself re-decoded.
  out = out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  return out.trim();
}

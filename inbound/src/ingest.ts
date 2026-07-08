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
  /** Raw Message-ID without <>; ingest() normalizes (>64 chars -> sha256). */
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

  // Dedup key -- use Message-ID or generate a stable fallback. D1 stores the
  // full raw ID; Vectorize requires max 64 chars so we SHA-256 hash anything
  // longer (32 bytes = 64 hex chars exactly).
  const rawMessageId = (parsed.messageId ?? "").replace(/[<>]/g, "") || crypto.randomUUID();
  const messageId = rawMessageId.length > 64 ? await sha256hex(rawMessageId) : rawMessageId;
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
      deliveredTo: [toAddr],
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

export function isTrusted(from: string, spf: string, dkim: string, allowlistEnv: string): boolean {
  const domains = allowlistEnv
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

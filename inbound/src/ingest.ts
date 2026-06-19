// The inbound transport seam (issue #22). ingest() is a pure function of a
// normalized ParsedInbound: it owns dedup, body cleaning, the trust verdict,
// the D1 insert, R2 attachments, and opt-in Vectorize. It does NOT know about
// ForwardableEmailMessage, postal-mime, or forwarding -- those belong to a
// transport driver (the CF email() handler, or an out-of-Worker POST /ingest).
// See docs/CONTRACT.md section 2.

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
}

export interface IngestResult {
  messageId: string;
  stored: boolean;
}

/**
 * Store one inbound message. Pure of transport: callers normalize whatever they
 * received into ParsedInbound first. Returns the normalized messageId and
 * whether a new row was written (false on a dedup hit).
 *
 * Attachments and Vectorize are best-effort and run via ctx.waitUntil so the
 * caller can return promptly; pass the ExecutionContext through.
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

  // Dedup key -- use Message-ID or generate a stable fallback. D1 stores the
  // full raw ID; Vectorize requires max 64 chars so we SHA-256 hash anything
  // longer (32 bytes = 64 hex chars exactly).
  const rawMessageId = (parsed.messageId ?? "").replace(/[<>]/g, "") || crypto.randomUUID();
  const messageId = rawMessageId.length > 64 ? await sha256hex(rawMessageId) : rawMessageId;
  const receivedAt = new Date().toISOString();
  const date = parsed.date ? new Date(parsed.date).toISOString() : receivedAt;

  // D1 insert -- INSERT OR IGNORE handles duplicates cleanly. The messages_fts
  // FTS5 index is kept in sync by triggers (see schema.sql), so no extra work here.
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages
       (message_id, from_addr, to_addr, subject, date, in_reply_to,
        body_text, spf, dkim, dmarc, trusted, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      fromAddr,
      parsed.to,
      parsed.subject ?? "",
      date,
      parsed.inReplyTo ?? null,
      bodyText,
      spf,
      dkim,
      dmarc,
      trusted ? 1 : 0,
      receivedAt,
    )
    .run();

  if (result.meta.changes === 0) return { messageId, stored: false }; // duplicate

  // Attachments -> R2 (bytes) + D1 (metadata + key). Best-effort, non-blocking.
  const attachments = parsed.attachments ?? [];
  if (attachments.length > 0) {
    ctx.waitUntil(
      (async () => {
        for (let i = 0; i < attachments.length; i++) {
          const att = attachments[i];
          try {
            const bytes = att.content;
            if (!bytes || bytes.byteLength === 0) continue;
            const safeName = (att.filename || `attachment-${i}`)
              .replace(/[^A-Za-z0-9._-]/g, "_")
              .slice(0, 100);
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
      })(),
    );
  }

  // Vectorize: chunk the body and embed each window so long mail keeps full
  // recall (a single 8k embedding lost the tail). Non-blocking, best-effort.
  // Only index mail for addresses that opted in to crew RAG (VECTORIZE_FOR).
  const vectorizeFor = (env.VECTORIZE_FOR ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowedForVectorize = vectorizeFor.length === 0 || vectorizeFor.includes(toAddr);

  if (bodyText.length > 0 && allowedForVectorize) {
    ctx.waitUntil(
      (async () => {
        try {
          const chunks = chunkText(bodyText, 1200, 150).slice(0, 24); // bound cost on huge mail
          // 56-hex base keeps chunk ids (`<base>.<i>`) within Vectorize's 64-char id limit.
          const base = (await sha256hex(messageId)).slice(0, 56);
          const embed = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
            text: chunks,
          })) as { data: number[][] };
          const vectors = embed.data.map((values, i) => ({
            id: `${base}.${i}`,
            values,
            metadata: {
              message_id: messageId,
              chunk: i,
              from: fromAddr,
              to: toAddr,
              date,
              subject: parsed.subject ?? "",
            },
          }));
          if (vectors.length) await env.VECTORIZE.upsert(vectors);
        } catch (e) {
          console.error("vectorize upsert failed", e);
        }
      })(),
    );
  }

  return { messageId, stored: true };
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

export function isTrusted(from: string, spf: string, dkim: string, allowlistEnv: string): boolean {
  const domains = allowlistEnv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const fromLower = from.toLowerCase();
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

export function cleanBody(raw: string): string {
  // Strip sig block (RFC 3676 "-- \n" delimiter)
  const sigIdx = raw.indexOf("\n-- \n");
  const stripped = sigIdx !== -1 ? raw.slice(0, sigIdx) : raw;
  // Remove quoted-reply lines ("> ...")
  return stripped
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

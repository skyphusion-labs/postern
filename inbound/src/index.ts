import PostalMime from "postal-mime";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // 1. Forward immediately, before consuming message.raw. CF Email Workers
    //    require the stream to be unconsumed when forward() is called; parsing
    //    first exhausts the stream and silently breaks delivery.
    //    Only forward when message.to is in FORWARD_FOR (crew keep their own mail).
    const forwardFor = (env.FORWARD_FOR ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const toAddr = message.to.toLowerCase();
    if (env.FORWARD_TO && (forwardFor.length === 0 || forwardFor.includes(toAddr))) {
      try {
        await message.forward(env.FORWARD_TO);
      } catch (e) {
        console.error("forward to", env.FORWARD_TO, "failed:", e);
      }
    }

    // 2. Parse MIME for ingestion (D1 + R2 + Vectorize). message.raw is a teed
    //    copy that CF keeps available after forward() completes.
    const parsed = await new PostalMime().parse(message.raw);

    // Helper: search both message.headers and postal-mime's parsed header list.
    const getHeader = (name: string): string => {
      const fromMsg = message.headers.get(name) ?? "";
      if (fromMsg) return fromMsg;
      return parsed.headers.find((h) => h.key.toLowerCase() === name)?.value ?? "";
    };

    const fromAddr = message.from;
    const authResults = getHeader("authentication-results");
    const spf = extractSpfResult(getHeader("received-spf"));
    const dkim = extractDkimResult(authResults);
    const dmarc = extractDmarcResult(authResults);
    // CF Email Routing strips transport-level auth headers; fall back to
    // allowlist-only trust when neither verdict is available.
    const trusted = isTrusted(fromAddr, spf, dkim, env.TRUSTED_SENDER_DOMAINS);

    // 3. Clean body: prefer plain text, strip quoted lines and sig block
    const rawBody = parsed.text ?? htmlToText(parsed.html ?? "");
    const bodyText = cleanBody(rawBody).slice(0, 32_000);

    // 4. Dedup key -- use Message-ID or generate stable fallback.
    //    D1 stores the full raw ID; Vectorize requires max 64 chars so we
    //    SHA-256 hash anything longer (32 bytes = 64 hex chars exactly).
    const rawMessageId = (parsed.messageId ?? "").replace(/[<>]/g, "") || crypto.randomUUID();
    const messageId = rawMessageId.length > 64 ? await sha256hex(rawMessageId) : rawMessageId;
    const receivedAt = new Date().toISOString();
    const date = parsed.date ? new Date(parsed.date).toISOString() : receivedAt;

    // 5. D1 insert -- INSERT OR IGNORE handles duplicates cleanly. The messages_fts
    //    FTS5 index is kept in sync by triggers (see schema.sql), so no extra work here.
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO messages
         (message_id, from_addr, to_addr, subject, date, in_reply_to,
          body_text, spf, dkim, dmarc, trusted, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        messageId,
        fromAddr,
        message.to,
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

    if (result.meta.changes === 0) return; // already stored (duplicate)

    // 6. Attachments -> R2 (bytes) + D1 (metadata + key). Best-effort, non-blocking.
    const attachments = parsed.attachments ?? [];
    if (attachments.length > 0) {
      ctx.waitUntil(
        (async () => {
          for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            try {
              const bytes = toArrayBuffer(att.content);
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

    // 7. Vectorize: chunk the body and embed each window so long mail keeps full
    //    recall (a single 8k embedding lost the tail). Non-blocking, best-effort.
    //    Only index mail for addresses that opted in to crew RAG (VECTORIZE_FOR).
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
  },
};

// --- Helpers ---

function toArrayBuffer(content: unknown): ArrayBuffer | null {
  if (content instanceof ArrayBuffer) return content;
  // Copy into a fresh ArrayBuffer so the type is unambiguously ArrayBuffer
  // (Uint8Array.buffer / TextEncoder().buffer are typed as ArrayBufferLike).
  let view: Uint8Array | null = null;
  if (content instanceof Uint8Array) view = content;
  else if (typeof content === "string") view = new TextEncoder().encode(content);
  if (!view) return null;
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

// Split text into overlapping windows (~chunk chars, overlap chars carried over)
// on whitespace boundaries where possible. bge-base handles ~512 tokens, so a
// 1200-char window stays comfortably under the limit.
function chunkText(text: string, chunk: number, overlap: number): string[] {
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

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Auth verdict helpers ---

function extractSpfResult(header: string): string {
  const m = header.match(/^(pass|fail|softfail|neutral|none|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

function extractDkimResult(authResults: string): string {
  const m = authResults.match(/dkim=(pass|fail|neutral|none|policy|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

function extractDmarcResult(authResults: string): string {
  const m = authResults.match(/dmarc=(pass|fail|none|bestguesspass|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

function isTrusted(from: string, spf: string, dkim: string, allowlistEnv: string): boolean {
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

function cleanBody(raw: string): string {
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

function htmlToText(html: string): string {
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

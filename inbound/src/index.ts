import PostalMime from "postal-mime";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // 1. Parse MIME first so we have access to all raw headers (including any
    //    Authentication-Results CF may have injected into the raw stream).
    const parsed = await new PostalMime().parse(message.raw);

    // Helper: search both message.headers and postal-mime's parsed header list.
    const getHeader = (name: string): string => {
      const fromMsg = message.headers.get(name) ?? "";
      if (fromMsg) return fromMsg;
      return parsed.headers.find((h) => h.key.toLowerCase() === name)?.value ?? "";
    };

    const fromAddr = message.from;
    const spf = extractSpfResult(getHeader("received-spf"));
    const dkim = extractDkimResult(getHeader("authentication-results"));
    // CF Email Routing strips transport-level auth headers; fall back to
    // allowlist-only trust when neither verdict is available.
    const trusted = isTrusted(fromAddr, spf, dkim, env.TRUSTED_SENDER_DOMAINS);

    // 3. Clean body: prefer plain text, strip quoted lines and sig block
    const rawBody = parsed.text ?? htmlToText(parsed.html ?? "");
    const bodyText = cleanBody(rawBody).slice(0, 32_000);

    // 4. Dedup key -- use Message-ID or generate stable fallback
    const messageId = (parsed.messageId ?? "").replace(/[<>]/g, "") || crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const date = parsed.date ? new Date(parsed.date).toISOString() : receivedAt;

    // 5. D1 insert -- INSERT OR IGNORE handles duplicates cleanly
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO messages
         (message_id, from_addr, to_addr, subject, date, in_reply_to,
          body_text, spf, dkim, trusted, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        trusted ? 1 : 0,
        receivedAt,
      )
      .run();

    if (result.meta.changes === 0) return; // already stored (duplicate)

    // 6. Vectorize embed + upsert (non-blocking, best-effort)
    if (bodyText.length > 0) {
      ctx.waitUntil(
        (async () => {
          try {
            const embed = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
              text: [bodyText.slice(0, 8_000)],
            });
            await env.VECTORIZE.upsert([
              {
                id: messageId,
                values: (embed as { data: number[][] }).data[0],
                metadata: { from: fromAddr, date, subject: parsed.subject ?? "" },
              },
            ]);
          } catch (e) {
            console.error("vectorize upsert failed", e);
          }
        })(),
      );
    }
  },
};

// --- Auth verdict helpers ---

function extractSpfResult(header: string): string {
  const m = header.match(/^(pass|fail|softfail|neutral|none|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

function extractDkimResult(authResults: string): string {
  const m = authResults.match(/dkim=(pass|fail|neutral|none|policy|temperror|permerror)/i);
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

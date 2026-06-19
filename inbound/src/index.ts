import PostalMime from "postal-mime";
import { ingest, type ParsedInbound } from "./ingest";

// The in-Worker inbound transport driver (issue #21): the one surviving email()
// handler. It forwards, parses the MIME via postal-mime, extracts the CF auth
// verdicts, builds a ParsedInbound, and hands off to ingest(). All storage logic
// lives in ingest.ts; this file only adapts CF's ForwardableEmailMessage to the
// transport contract. See docs/CONTRACT.md section 2.
export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // 1. Forward immediately, before consuming message.raw. CF Email Workers
    //    require the stream to be unconsumed when forward() is called; parsing
    //    first exhausts the stream and silently breaks delivery. Forwarding is a
    //    CF-transport concern, so it stays in the driver, not in ingest().
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

    // 2. Parse MIME for ingestion. message.raw is a teed copy that CF keeps
    //    available after forward() completes.
    const parsed = await new PostalMime().parse(message.raw);

    // Helper: search both message.headers and postal-mime's parsed header list.
    const getHeader = (name: string): string => {
      const fromMsg = message.headers.get(name) ?? "";
      if (fromMsg) return fromMsg;
      return parsed.headers.find((h) => h.key.toLowerCase() === name)?.value ?? "";
    };

    const authResults = getHeader("authentication-results");

    // Coerce postal-mime attachments to the contract shape, dropping any whose
    // content can't be read into an ArrayBuffer.
    type InboundAttachment = NonNullable<ParsedInbound["attachments"]>[number];
    const attachments: InboundAttachment[] = [];
    for (const att of parsed.attachments ?? []) {
      const content = toArrayBuffer(att.content);
      if (!content) continue;
      attachments.push({
        filename: att.filename ?? undefined,
        mimeType: att.mimeType ?? undefined,
        content,
      });
    }

    // 3. Normalize to the transport contract and hand off to ingest().
    const normalized: ParsedInbound = {
      messageId: parsed.messageId ?? undefined,
      from: message.from,
      to: message.to,
      subject: parsed.subject ?? undefined,
      date: parsed.date ?? undefined,
      inReplyTo: parsed.inReplyTo ?? undefined,
      text: parsed.text ?? undefined,
      html: parsed.html ?? undefined,
      attachments,
      auth: {
        spf: extractSpfResult(getHeader("received-spf")),
        dkim: extractDkimResult(authResults),
        dmarc: extractDmarcResult(authResults),
      },
    };

    await ingest(env, normalized, ctx);
  },
};

// --- Helpers (CF transport: header extraction + content coercion) ---
// Exported so the unit suite (smoke.test.ts) can exercise the transport-side
// helpers directly without a live Email Routing event. The storage-side pure
// helpers (cleanBody, htmlToText, chunkText, sha256hex, isTrusted) now live in
// ingest.ts and are exported from there.

export function toArrayBuffer(content: unknown): ArrayBuffer | null {
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

// --- Auth verdict helpers (parse the CF/MTA headers into a verdict) ---

export function extractSpfResult(header: string): string {
  const m = header.match(/^(pass|fail|softfail|neutral|none|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

export function extractDkimResult(authResults: string): string {
  const m = authResults.match(/dkim=(pass|fail|neutral|none|policy|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

export function extractDmarcResult(authResults: string): string {
  const m = authResults.match(/dmarc=(pass|fail|none|bestguesspass|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

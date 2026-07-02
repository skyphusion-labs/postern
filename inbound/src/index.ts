import PostalMime from "postal-mime";
import { WorkerEntrypoint } from "cloudflare:workers";
import { ingest, type ParsedInbound } from "./ingest";
import { handleApi } from "./api";
import { send, reply, type SendRequest, type ReplyRequest, type SendResult } from "./mailbox";
import * as store from "./store";
import type { StoredMessage, StoredMessageSummary, ListQuery, SearchQuery, Page, SearchHit } from "./store";
import { toArrayBuffer, extractSpfResult, extractDkimResult, extractDmarcResult } from "./headers";

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

    // 3. Normalize to the transport contract and hand off to ingest(). `to` stays
    //    the envelope recipient (message.to) that CF delivered this invocation to;
    //    the M8 fidelity fields carry the raw decoded RFC 5322 headers (#189).
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
      // Envelope fidelity v2 (#189): raw decoded headers + the wire byte size CF
      // reports. Absent headers stay undefined so the store keeps to_addr/NULLs.
      toHeader: getHeader("to") || undefined,
      cc: getHeader("cc") || undefined,
      sender: getHeader("sender") || undefined,
      replyTo: getHeader("reply-to") || undefined,
      rawSize: message.rawSize,
    };

    await ingest(env, normalized, ctx);
  },

  // The mailbox HTTP API: send/reply (#26) + read (get/thread) + health. Lives
  // in the same isolate as the store and the send_email binding so a sent copy
  // is written without a cross-worker hop (CONTRACT section 6).
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleApi(request, env, ctx);
  },
};

/**
 * RPC surface for same-account Workers (e.g. skyphusion-llm-public) bound via a
 * service binding -- the structured mailbox channel without a network hop or a
 * shared secret (CONTRACT sections 4-5). Mirrors the HTTP write + read ops.
 *
 *   // consumer wrangler.jsonc
 *   "services": [
 *     { "binding": "MAILBOX", "service": "skyphusion-email-inbound", "entrypoint": "MailboxService" }
 *   ]
 */
export class MailboxService extends WorkerEntrypoint<Env> {
  send(req: SendRequest): Promise<SendResult> {
    return send(this.env, req, this.ctx);
  }
  reply(req: ReplyRequest): Promise<SendResult> {
    return reply(this.env, req, this.ctx);
  }
  get(messageId: string): Promise<StoredMessage | null> {
    return store.get(this.env, messageId);
  }
  thread(threadId: string): Promise<StoredMessage[]> {
    return store.thread(this.env, threadId);
  }
  list(query: ListQuery): Promise<Page<StoredMessageSummary>> {
    return store.list(this.env, query);
  }
  search(query: SearchQuery): Promise<Page<SearchHit>> {
    return store.search(this.env, query);
  }
}

// Re-export the CF-transport helpers for any existing importer of this module.
export { toArrayBuffer, extractSpfResult, extractDkimResult, extractDmarcResult } from "./headers";

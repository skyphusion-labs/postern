// CfEmailTransport (docs/CONTRACT.md section 3): the default outbound transport.
// Wraps the Cloudflare Email Sending binding (send_email -> env.EMAIL), byte for
// byte the prior send behavior, now behind the Transport interface so a
// deployment can swap in the relay or another provider without touching the
// mailbox or the store.

import type { Transport, OutboundMessage, DispatchResult } from "./index";

// Decode standard base64 (the JSON wire form of an attachment) to raw bytes for
// the binding, which accepts an ArrayBufferView and builds the MIME itself. atob
// throws on non-base64 input; attachments are validated before they reach here.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class CfEmailTransport implements Transport {
  constructor(private readonly env: Env) {}

  async dispatch(msg: OutboundMessage): Promise<DispatchResult> {
    // BCC is envelope-only: include it as a recipient, never as a header (the
    // mailbox builds headers without bcc). cc IS a visible header on CF send.
    const message: SendEmailMessage = {
      to: msg.to,
      from: msg.from.name ? { email: msg.from.email, name: msg.from.name } : msg.from.email,
      subject: msg.subject,
    };
    if (msg.html) message.html = msg.html;
    if (msg.text) message.text = msg.text;
    if (msg.cc && msg.cc.length) message.cc = msg.cc;
    if (msg.bcc && msg.bcc.length) message.bcc = msg.bcc;
    if (msg.replyTo) {
      message.replyTo = msg.replyTo.name
        ? { email: msg.replyTo.email, name: msg.replyTo.name }
        : msg.replyTo.email;
    }
    // Attachments (#70): the binding takes them as a field and builds the MIME
    // (multipart/mixed) itself, so we never hand-roll a raw RFC 5322 message. The
    // wire/JSON value is base64; decode to bytes here. All parts are sent as
    // disposition "attachment" for v1 (inline-cid fidelity is a tracked
    // follow-up). When there are none, the field-based path is unchanged.
    if (msg.attachments && msg.attachments.length) {
      message.attachments = msg.attachments.map((a, i) => ({
        filename: a.filename && a.filename.trim() ? a.filename : `attachment-${i + 1}`,
        type: a.mimeType && a.mimeType.trim() ? a.mimeType : "application/octet-stream",
        disposition: "attachment" as const,
        content: base64ToBytes(a.content),
      }));
    }
    // Cloudflare Email Sending generates its own Message-ID and REJECTS a custom
    // one (only whitelisted + X-* headers are accepted). The mailbox stamps a
    // core-generated Message-ID for the store + threading; that lives in our
    // store, not on the CF wire. Strip it (and any other non-whitelisted header)
    // here, the transport-specific seam, so a default CF deploy can send. CF
    // accepts In-Reply-To / References, so reply threading on the wire survives.
    if (msg.headers) {
      const allowed: Record<string, string> = {};
      for (const [k, v] of Object.entries(msg.headers)) {
        const key = k.toLowerCase();
        if (key === "message-id") continue; // CF sets its own
        if (key === "in-reply-to" || key === "references" || key.startsWith("x-")) {
          allowed[k] = v;
        }
      }
      if (Object.keys(allowed).length) message.headers = allowed;
    }

    // env.EMAIL throws an Error carrying a .code (E_* string) on failure; the
    // caller maps that to the {ok:false,error} response shape.
    const binding = this.env.EMAIL;
    if (!binding) {
      throw new Error("send_email binding (EMAIL) is not configured");
    }
    const response = await binding.send(message);
    return { providerMessageId: response?.messageId };
  }
}

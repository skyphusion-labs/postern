// CfEmailTransport (docs/CONTRACT.md section 3): the default outbound transport.
// Wraps the Cloudflare Email Sending binding (send_email -> env.EMAIL), byte for
// byte the prior send behavior, now behind the Transport interface so a
// deployment can swap in the relay or another provider without touching the
// mailbox or the store.

import type { Transport, OutboundMessage, DispatchResult } from "./index";

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

// The outbound transport seam (docs/CONTRACT.md section 3). mailbox.send()/reply()
// build an OutboundMessage and call dispatch(); the selected Transport is the
// only thing that actually puts bytes on the wire. Cloudflare Email Sending is
// the default; an alternate (the postern-relay SMTP bridge, another provider)
// implements the same interface and is selected by OUTBOUND_TRANSPORT.

import type { EmailAddress } from "../mailbox";
import { CfEmailTransport } from "./cf";
import { RelayTransport } from "./relay";

/** Normalized, post-validation message ready to hand to a Transport. */
export interface OutboundMessage {
  messageId: string; // core-generated, so we can thread + store the sent copy
  to: string[];
  cc?: string[];
  bcc?: string[];
  from: EmailAddress; // already domain-checked by resolveFrom()
  replyTo?: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>; // carries In-Reply-To / References on replies
}

/** providerMessageId is best-effort: present only if the provider returns one. */
export interface DispatchResult {
  providerMessageId?: string;
}

export interface Transport {
  dispatch(msg: OutboundMessage): Promise<DispatchResult>;
}

/**
 * Select the outbound transport. Default (unset or "cf") is Cloudflare Email
 * Sending. "relay" is the bring-your-own-SMTP escape hatch (#28): it POSTs to the
 * postern-relay /dispatch bridge instead of env.EMAIL.send(). An unknown value
 * fails loudly rather than silently falling back to CF.
 */
export function selectTransport(env: Env): Transport {
  const choice = (env.OUTBOUND_TRANSPORT || "cf").toLowerCase();
  switch (choice) {
    case "cf":
    case "":
      return new CfEmailTransport(env);
    case "relay":
      return new RelayTransport(env);
    default:
      throw new Error(`unsupported OUTBOUND_TRANSPORT: ${choice}`);
  }
}

// RelayTransport (docs/CONTRACT.md section 3, issue #28): the bring-your-own-SMTP
// outbound transport. Instead of env.EMAIL.send(), it POSTs the OutboundMessage
// to the postern-relay /dispatch bridge, which relays it over a configured SMTP
// server. This is what makes sending not CF-locked. Selected by
// OUTBOUND_TRANSPORT=relay. The wire shape is pinned against relay/http.go.

import type { Transport, OutboundMessage, DispatchResult } from "./index";

// Failure codes the mailbox/api layer maps to HTTP status (E_DELIVERY_FAILED is
// retryable -> 502). Kept aligned with the standalone worker's E_* vocabulary.
class RelayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

export class RelayTransport implements Transport {
  private readonly url: string;
  private readonly token: string;

  constructor(env: Env) {
    const url = (env.RELAY_DISPATCH_URL || "").trim();
    const token = (env.POSTERN_TRANSPORT_TOKEN || "").trim();
    if (!url) {
      throw new RelayError("E_INTERNAL_SERVER_ERROR", "RELAY_DISPATCH_URL is not configured");
    }
    if (!token) {
      throw new RelayError("E_INTERNAL_SERVER_ERROR", "POSTERN_TRANSPORT_TOKEN is not configured");
    }
    this.url = url;
    this.token = token;
  }

  async dispatch(msg: OutboundMessage): Promise<DispatchResult> {
    // The body is the OutboundMessage verbatim (the relay decodes with
    // unknown-field rejection, so we send exactly the contract keys). bcc rides
    // in msg.bcc and is never written into headers -- the mailbox builds headers
    // without bcc, so passing msg through keeps bcc envelope-only.
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(msg),
      });
    } catch (e) {
      // Network/connection failure reaching the relay: transient, retryable.
      throw new RelayError("E_DELIVERY_FAILED", `relay dispatch request failed: ${stringifyError(e)}`);
    }

    if (res.ok) {
      const body = (await safeJson(res)) as { providerMessageId?: string } | null;
      return { providerMessageId: body?.providerMessageId || undefined };
    }

    // Map the relay's status to our E_* vocabulary (CONTRACT section 3):
    //   401 -> our transport token is wrong (config problem, not the caller's)
    //   400/413 -> we built a bad/oversized OutboundMessage
    //   502 (or 5xx) -> upstream SMTP send failed; retryable
    const detail = await relayErrorDetail(res);
    if (res.status === 401) {
      throw new RelayError("E_INTERNAL_SERVER_ERROR", `relay rejected the transport token (401): ${detail}`);
    }
    if (res.status === 413) {
      throw new RelayError("E_PAYLOAD_TOO_LARGE", `relay rejected an oversized message (413): ${detail}`);
    }
    if (res.status >= 500) {
      throw new RelayError("E_DELIVERY_FAILED", `relay upstream send failed (${res.status}): ${detail}`);
    }
    throw new RelayError("E_VALIDATION_ERROR", `relay rejected the message (${res.status}): ${detail}`);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function relayErrorDetail(res: Response): Promise<string> {
  const body = (await safeJson(res)) as { error?: unknown } | null;
  if (body && typeof body.error === "string") return body.error;
  return res.statusText || "no detail";
}

function stringifyError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

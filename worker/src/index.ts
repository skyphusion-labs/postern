import { WorkerEntrypoint } from "cloudflare:workers";
import { sendEmail, EmailError, type EmailRequest, type SendResult } from "./email";

export type { EmailRequest, SendResult, EmailAddress } from "./email";

// Failure codes that represent a transient upstream condition rather than a
// bad request; the public endpoint maps these to 502 so callers can retry.
const RETRYABLE = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DELIVERY_FAILED",
  "E_INTERNAL_SERVER_ERROR",
]);

/**
 * RPC surface for same-account Workers (e.g. skyphusion-llm-public) bound via a
 * service binding. No network hop, no shared secret.
 *
 *   // consumer wrangler.jsonc
 *   "services": [
 *     { "binding": "EMAIL", "service": "skyphusion-email", "entrypoint": "EmailService" }
 *   ]
 *
 *   const { messageId } = await env.EMAIL.send({ to, subject, html, text });
 */
export class EmailService extends WorkerEntrypoint<Env> {
  send(req: EmailRequest): Promise<SendResult> {
    return sendEmail(this.env, req);
  }
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await message.forward(env.FORWARD_TO);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "skyphusion-email" });
    }

    if (request.method !== "POST" || url.pathname !== "/send") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    // Bearer-token gate for the public endpoint (used by the mindcrime SMTP
    // relay and any external caller that can't use a service binding).
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.RELAY_TOKEN || !timingSafeEqual(token, env.RELAY_TOKEN)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    let body: EmailRequest;
    try {
      body = (await request.json()) as EmailRequest;
    } catch {
      return json({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
    }

    try {
      const result = await sendEmail(env, body);
      return json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof EmailError) {
        return json({ ok: false, error: err.code, message: err.message }, err.status);
      }
      // Errors thrown by the EMAIL binding carry a `.code` (E_* string).
      const code = errorCode(err);
      const message = err instanceof Error ? err.message : "send failed";
      const status = RETRYABLE.has(code) ? 502 : 400;
      return json({ ok: false, error: code, message }, status);
    }
  },
} satisfies ExportedHandler<Env>;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return "E_INTERNAL_SERVER_ERROR";
}

// Constant-time comparison so the auth check doesn't leak the token byte by byte
// via timing. Length is allowed to leak; tokens are high-entropy.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// The mailbox HTTP API (docs/CONTRACT.md section 4). The write half (send/reply,
// #26) and just enough of the read half to make M2 verifiable end to end
// (get one message, get a thread). The full M1 read surface (list/search/
// pagination, #24/#25) attaches to the same store next. Token-gated with the
// mailbox API token (POSTERN_API_TOKEN), constant-time compared.

import * as store from "./store";
import { send, reply, MailboxError, type SendRequest, type ReplyRequest } from "./mailbox";

// Failure codes that represent a transient upstream condition (the transport /
// provider) rather than a bad request; mapped to 502 so callers can retry.
const RETRYABLE = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR"]);

// Cap the JSON body so a single request cannot exhaust worker memory. CF Email
// Sending caps a message near 25 MiB; bound a little above so a max-size message
// still passes.
const MAX_BODY_BYTES = 30 * 1024 * 1024;

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && (path === "/" || path === "/health")) {
    return json({ ok: true, service: "postern" });
  }

  // Everything under /api (and the back-compat /send alias) requires the token.
  const isApi = path === "/send" || path.startsWith("/api/");
  if (!isApi) return json({ ok: false, error: "not_found" }, 404);

  if (!authorized(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  try {
    // --- write: send ---
    if (request.method === "POST" && (path === "/api/send" || path === "/send")) {
      const body = await readJson<SendRequest>(request);
      const result = await send(env, body, ctx);
      return json({ ok: true, ...result });
    }

    // --- write: reply ---
    if (request.method === "POST" && path === "/api/reply") {
      const body = await readJson<ReplyRequest>(request);
      const result = await reply(env, body, ctx);
      return json({ ok: true, ...result });
    }

    // --- read: one message ---
    if (request.method === "GET" && path.startsWith("/api/messages/")) {
      const id = decodeURIComponent(path.slice("/api/messages/".length));
      if (!id) return json({ ok: false, error: "E_FIELD_MISSING", message: "message id required" }, 400);
      const msg = await store.get(env, id);
      if (!msg) return json({ ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
      return json({ ok: true, message: msg });
    }

    // --- read: a thread ---
    if (request.method === "GET" && path.startsWith("/api/threads/")) {
      const id = decodeURIComponent(path.slice("/api/threads/".length));
      if (!id) return json({ ok: false, error: "E_FIELD_MISSING", message: "thread id required" }, 400);
      const messages = await store.thread(env, id);
      return json({ ok: true, threadId: id, messages });
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

function authorized(request: Request, env: Env): boolean {
  const apiToken = env.POSTERN_API_TOKEN || env.RELAY_TOKEN || "";
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return apiToken.length > 0 && timingSafeEqual(token, apiToken);
}

async function readJson<T>(request: Request): Promise<T> {
  const declaredLen = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    throw new MailboxError("E_PAYLOAD_TOO_LARGE", "request body too large", 413);
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new MailboxError("E_VALIDATION_ERROR", "invalid JSON body");
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof MailboxError) {
    return json({ ok: false, error: err.code, message: err.message }, err.status);
  }
  // Errors thrown by the EMAIL binding / transport carry a .code (E_* string).
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : "send failed";
  const status = RETRYABLE.has(code) ? 502 : 400;
  return json({ ok: false, error: code, message }, status);
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return "E_INTERNAL_SERVER_ERROR";
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Constant-time compare so the auth check does not leak the token byte by byte
// via timing. Length may leak (tokens are high-entropy); the bytes must not.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

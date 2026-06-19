import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://postern.example${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("handleApi", () => {
  it("serves health without a token", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "postern" });
  });

  it("401s an API call with no/with a wrong token", async () => {
    const { env, ctx } = makeFakeEnv();
    expect((await handleApi(req("POST", "/api/send", { body: {} }), env, ctx)).status).toBe(401);
    expect((await handleApi(req("POST", "/api/send", { token: "wrong", body: {} }), env, ctx)).status).toBe(401);
  });

  it("sends via POST /api/send with the API token", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    const res = await handleApi(
      req("POST", "/api/send", { token: "test-token", body: { to: "d@example.com", subject: "hi", text: "yo" } }),
      env,
      ctx,
    );
    await settle();
    const payload = (await res.json()) as { ok: boolean; messageId: string };
    expect(res.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("keeps /send as a back-compat alias of /api/send", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    const res = await handleApi(
      req("POST", "/send", { token: "test-token", body: { to: "d@example.com", subject: "hi", text: "yo" } }),
      env,
      ctx,
    );
    await settle();
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("reads a stored message and its thread over the API", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    const sendRes = await handleApi(
      req("POST", "/api/send", { token: "test-token", body: { to: "d@example.com", subject: "hi", text: "yo" } }),
      env,
      ctx,
    );
    await settle();
    const { messageId, threadId } = (await sendRes.json()) as { messageId: string; threadId: string };

    const getRes = await handleApi(req("GET", `/api/messages/${encodeURIComponent(messageId)}`, { token: "test-token" }), env, ctx);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()) as { message: { messageId: string } }).toMatchObject({ message: { messageId } });

    const threadRes = await handleApi(req("GET", `/api/threads/${encodeURIComponent(threadId)}`, { token: "test-token" }), env, ctx);
    const tp = (await threadRes.json()) as { messages: unknown[] };
    expect(threadRes.status).toBe(200);
    expect(tp.messages).toHaveLength(1);
  });

  it("404s an unknown message id", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("GET", "/api/messages/nope@example.com", { token: "test-token" }), env, ctx);
    expect(res.status).toBe(404);
  });
});

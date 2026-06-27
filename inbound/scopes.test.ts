// Per-function token scopes (#85). Proves the read/send/both scope matrix the
// worker enforces in api.ts: a read-only token cannot send, a send-only token
// cannot read, neither can touch the credential-admin routes, the unscoped
// `both` token reaches everything (back-compat), and an unknown token is 401.

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// A fake env carrying all three tokens at once: the egalitarian `both` token plus
// the two optional scoped tokens an operator may provision.
function scopedEnv() {
  return makeFakeEnv({
    POSTERN_API_TOKEN: "both-token",
    POSTERN_API_TOKEN_READ: "read-token",
    POSTERN_API_TOKEN_SEND: "send-token",
  });
}

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

const SEND_BODY = { to: "d@example.com", subject: "hi", text: "yo" };
const ADMIN_BODY = { username: "alice@skyphusion.org" };

describe("per-function token scopes (#85)", () => {
  it("unknown token is 401 on every door", async () => {
    const { env, ctx } = scopedEnv();
    expect((await handleApi(req("GET", "/api/messages", { token: "nope" }), env, ctx)).status).toBe(401);
    expect((await handleApi(req("POST", "/api/send", { token: "nope", body: SEND_BODY }), env, ctx)).status).toBe(401);
  });

  it("absent token is 401", async () => {
    const { env, ctx } = scopedEnv();
    expect((await handleApi(req("GET", "/api/messages"), env, ctx)).status).toBe(401);
  });

  describe("read-scoped token", () => {
    it("reaches the read door (messages / search / threads / attachments)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("GET", "/api/messages", { token: "read-token" }), env, ctx)).status).toBe(200);
      expect((await handleApi(req("GET", "/api/search?q=hello", { token: "read-token" }), env, ctx)).status).toBe(200);
      // A specific message id that does not exist resolves PAST the gate to 404,
      // proving the read scope was accepted (a scope reject would be 403).
      expect((await handleApi(req("GET", "/api/messages/nope@example.com", { token: "read-token" }), env, ctx)).status).toBe(404);
      expect((await handleApi(req("GET", "/api/messages/nope@example.com/attachments/0", { token: "read-token" }), env, ctx)).status).toBe(404);
      expect((await handleApi(req("GET", "/api/threads/t1", { token: "read-token" }), env, ctx)).status).toBe(200);
    });

    it("cannot send (POST /api/send and /api/reply -> 403)", async () => {
      const { env, ctx, sent } = scopedEnv();
      expect((await handleApi(req("POST", "/api/send", { token: "read-token", body: SEND_BODY }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("POST", "/send", { token: "read-token", body: SEND_BODY }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("POST", "/api/reply", { token: "read-token", body: SEND_BODY }), env, ctx)).status).toBe(403);
      // Nothing left the worker.
      expect(sent).toHaveLength(0);
    });

    it("cannot touch credential-admin routes (-> 403)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("POST", "/api/admin/smtp-credentials", { token: "read-token", body: ADMIN_BODY }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("DELETE", "/api/admin/smtp-credentials/alice%40skyphusion.org", { token: "read-token" }), env, ctx)).status).toBe(403);
    });

    it("cannot trigger the reindex backfill (-> 403, #116 ws4)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("POST", "/api/admin/reindex", { token: "read-token", body: {} }), env, ctx)).status).toBe(403);
    });
  });

  describe("send-scoped token", () => {
    it("reaches the write door (send / reply)", async () => {
      const { env, ctx, settle, sent } = scopedEnv();
      const res = await handleApi(req("POST", "/api/send", { token: "send-token", body: SEND_BODY }), env, ctx);
      await settle();
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
    });

    it("cannot read the store (GET messages / search / threads -> 403)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("GET", "/api/messages", { token: "send-token" }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("GET", "/api/search?q=hello", { token: "send-token" }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("GET", "/api/messages/anything@example.com", { token: "send-token" }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("GET", "/api/threads/t1", { token: "send-token" }), env, ctx)).status).toBe(403);
    });

    it("cannot touch credential-admin routes (-> 403)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("POST", "/api/admin/smtp-credentials", { token: "send-token", body: ADMIN_BODY }), env, ctx)).status).toBe(403);
    });

    it("cannot trigger the reindex backfill (-> 403, #116 ws4)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("POST", "/api/admin/reindex", { token: "send-token", body: {} }), env, ctx)).status).toBe(403);
    });
  });

  describe("both-scoped token (back-compat / egalitarian default)", () => {
    it("reads, sends, and reaches admin", async () => {
      const { env, ctx, settle, sent } = scopedEnv();
      expect((await handleApi(req("GET", "/api/messages", { token: "both-token" }), env, ctx)).status).toBe(200);

      const sendRes = await handleApi(req("POST", "/api/send", { token: "both-token", body: SEND_BODY }), env, ctx);
      await settle();
      expect(sendRes.status).toBe(200);
      expect(sent).toHaveLength(1);

      const adminRes = await handleApi(req("POST", "/api/admin/smtp-credentials", { token: "both-token", body: ADMIN_BODY }), env, ctx);
      expect(adminRes.status).toBe(200);
      expect((await adminRes.json()) as { ok: boolean }).toMatchObject({ ok: true });
    });

    it("reaches the reindex backfill route (#116 ws4)", async () => {
      const { env, ctx } = scopedEnv();
      const res = await handleApi(req("POST", "/api/admin/reindex", { token: "both-token", body: { dryRun: true } }), env, ctx);
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    });
  });

  describe("single-token deployment (only POSTERN_API_TOKEN set)", () => {
    it("that lone token is `both` and gates the whole surface as before", async () => {
      // The live default: no scoped tokens provisioned, just the one mailbox token
      // (makeFakeEnv's POSTERN_API_TOKEN = "test-token"). It must read AND send.
      const { env, ctx, settle, sent } = makeFakeEnv();
      expect((await handleApi(req("GET", "/api/messages", { token: "test-token" }), env, ctx)).status).toBe(200);
      const sendRes = await handleApi(req("POST", "/api/send", { token: "test-token", body: SEND_BODY }), env, ctx);
      await settle();
      expect(sendRes.status).toBe(200);
      expect(sent).toHaveLength(1);
      // A read-scope value is NOT configured here, so it is just an unknown token.
      expect((await handleApi(req("GET", "/api/messages", { token: "read-token" }), env, ctx)).status).toBe(401);
    });
  });
});

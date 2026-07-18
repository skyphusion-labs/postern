// Per-function token scopes (#85). Proves the read/send/both scope matrix the
// worker enforces in api.ts: a read-only token cannot send, a send-only token
// cannot read, neither can touch the credential-admin routes, the unscoped
// `both` token reaches everything (back-compat), and an unknown token is 401.

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// A fake env carrying all four static tokens at once: the egalitarian `both`
// token plus the optional read/send/delete scoped slots (#85/#352).
function scopedEnv() {
  return makeFakeEnv({
    POSTERN_API_TOKEN: "both-token",
    POSTERN_API_TOKEN_READ: "read-token",
    POSTERN_API_TOKEN_SEND: "send-token",
    POSTERN_API_TOKEN_DELETE: "delete-token",
    POSTERN_API_TOKEN_IMAP: "imap-token",
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

    it("can mark messages (un)read (POST /api/messages/seen is read-scoped, #seen)", async () => {
      const { env, ctx } = scopedEnv();
      const res = await handleApi(req("POST", "/api/messages/seen", { token: "read-token", body: { ids: [], seen: true } }), env, ctx);
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    });

    it("can organize (flags / move / folders are read-scoped, #352)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("POST", "/api/messages/flags", {
        token: "read-token", body: { ids: [], set: { flagged: true } },
      }), env, ctx)).status).toBe(200);
      expect((await handleApi(req("POST", "/api/messages/move", {
        token: "read-token", body: { ids: [], mailbox: "trash" },
      }), env, ctx)).status).toBe(200);
      expect((await handleApi(req("GET", "/api/folders", { token: "read-token" }), env, ctx)).status).toBe(200);
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

    it("cannot hard-delete messages (-> 403; delete is its own scope, #352)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("DELETE", "/api/messages/a@example.com", { token: "read-token" }), env, ctx)).status).toBe(403);
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

    it("cannot mark messages read (POST /api/messages/seen is read-scoped -> 403, #seen)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("POST", "/api/messages/seen", { token: "send-token", body: { ids: [], seen: true } }), env, ctx)).status).toBe(403);
    });

    it("cannot touch credential-admin routes (-> 403)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("POST", "/api/admin/smtp-credentials", { token: "send-token", body: ADMIN_BODY }), env, ctx)).status).toBe(403);
    });

    it("cannot trigger the reindex backfill (-> 403, #116 ws4)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("POST", "/api/admin/reindex", { token: "send-token", body: {} }), env, ctx)).status).toBe(403);
    });

    it("cannot delete messages (-> 403, #278)", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("DELETE", "/api/messages/a@example.com", { token: "send-token" }), env, ctx)).status).toBe(403);
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

    it("can hard-delete a message (DELETE /api/messages/{id} is delete-scoped; both includes delete, #352)", async () => {
      const { env, ctx } = scopedEnv();
      // Scope gate only: message absent -> 404 proves delete scope was accepted.
      expect((await handleApi(req("DELETE", "/api/messages/nope@example.com", { token: "both-token" }), env, ctx)).status).toBe(404);
    });
  });

  describe("delete-scoped token (#352 / C4)", () => {
    it("reaches only irreversible DELETE /api/messages/{id}", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("DELETE", "/api/messages/nope@example.com", { token: "delete-token" }), env, ctx)).status).toBe(404);
      expect((await handleApi(req("GET", "/api/messages", { token: "delete-token" }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("POST", "/api/send", { token: "delete-token", body: SEND_BODY }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("POST", "/api/messages/flags", {
        token: "delete-token", body: { ids: [], set: { flagged: true } },
      }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("POST", "/api/admin/reindex", { token: "delete-token", body: {} }), env, ctx)).status).toBe(403);
    });
  });

  describe("imap-service token (#352)", () => {
    it("reaches only identity-asserted Drafts/import service routes", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("GET", "/api/messages", { token: "imap-token" }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("POST", "/api/send", {
        token: "imap-token", body: SEND_BODY,
      }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("DELETE", "/api/messages/x", { token: "imap-token" }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("GET", "/api/imap/drafts?identity=user%40skyphusion.org", {
        token: "imap-token",
      }), env, ctx)).status).toBe(200);
      expect((await handleApi(req("POST", "/api/admin/reindex", {
        token: "imap-token", body: {},
      }), env, ctx)).status).toBe(403);
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

  describe("token SETS in a slot (#154)", () => {
    // Each static slot holds a comma-separated SET of tokens: per-consumer values
    // within one function, so one member can rotate without stranding the rest.
    // Deliberately messy config: interior whitespace and a trailing comma must be
    // tolerated (trimmed / dropped), never become matchable values.
    function setEnv() {
      return makeFakeEnv({
        POSTERN_API_TOKEN: "both-token",
        POSTERN_API_TOKEN_READ: "imap-read-token, mcp-read-token ,webmail-read-token,",
        POSTERN_API_TOKEN_SEND: "relay-send-token,cli-send-token",
      });
    }

    it("every member of the read set resolves to read", async () => {
      const { env, ctx } = setEnv();
      for (const token of ["imap-read-token", "mcp-read-token", "webmail-read-token"]) {
        expect((await handleApi(req("GET", "/api/messages", { token }), env, ctx)).status).toBe(200);
      }
    });

    it("a read-set member is still 403 on send and admin (scope semantics unchanged)", async () => {
      const { env, ctx, sent } = setEnv();
      expect((await handleApi(req("POST", "/api/send", { token: "mcp-read-token", body: SEND_BODY }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("POST", "/api/admin/reindex", { token: "mcp-read-token", body: {} }), env, ctx)).status).toBe(403);
      expect(sent).toHaveLength(0);
    });

    it("every member of the send set reaches the write door and none the read door", async () => {
      const { env, ctx, settle, sent } = setEnv();
      for (const token of ["relay-send-token", "cli-send-token"]) {
        expect((await handleApi(req("POST", "/api/send", { token, body: SEND_BODY }), env, ctx)).status).toBe(200);
        expect((await handleApi(req("GET", "/api/messages", { token }), env, ctx)).status).toBe(403);
      }
      await settle();
      expect(sent).toHaveLength(2);
    });

    it("a value in NO set is 401: unknown, member-prefix, and the raw list string itself", async () => {
      const { env, ctx } = setEnv();
      expect((await handleApi(req("GET", "/api/messages", { token: "nope" }), env, ctx)).status).toBe(401);
      // A prefix of a member must not match (per-member compare, not substring).
      expect((await handleApi(req("GET", "/api/messages", { token: "imap-read" }), env, ctx)).status).toBe(401);
      // The whole configured list is NOT itself a token.
      expect((await handleApi(req("GET", "/api/messages", { token: "imap-read-token, mcp-read-token ,webmail-read-token," }), env, ctx)).status).toBe(401);
    });

    it("config whitespace is trimmed but presented whitespace is not", async () => {
      const { env, ctx } = setEnv();
      // " mcp-read-token " is configured with padding yet matches bare (config trimmed)...
      expect((await handleApi(req("GET", "/api/messages", { token: "mcp-read-token" }), env, ctx)).status).toBe(200);
      // ...while a padded PRESENTED bearer is a different byte string: 401.
      expect((await handleApi(req("GET", "/api/messages", { token: " mcp-read-token " }), env, ctx)).status).toBe(401);
    });

    it("a slot of only commas/whitespace configures NOTHING (empty string never matches)", async () => {
      const { env, ctx } = makeFakeEnv({
        POSTERN_API_TOKEN: "both-token",
        POSTERN_API_TOKEN_READ: " , ,",
      });
      expect((await handleApi(req("GET", "/api/messages", { token: "," }), env, ctx)).status).toBe(401);
      expect((await handleApi(req("GET", "/api/messages", { token: " " }), env, ctx)).status).toBe(401);
      // The both token is unaffected.
      expect((await handleApi(req("GET", "/api/messages", { token: "both-token" }), env, ctx)).status).toBe(200);
    });

    it("single bare value (no comma) keeps working exactly as before (back-compat)", async () => {
      // The scopedEnv suite above IS the single-value coverage; this pins the
      // equivalence explicitly on one env.
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("GET", "/api/messages", { token: "read-token" }), env, ctx)).status).toBe(200);
      expect((await handleApi(req("GET", "/api/messages", { token: "read-token,other" }), env, ctx)).status).toBe(401);
    });
  });
});

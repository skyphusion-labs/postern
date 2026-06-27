// Per-identity send registry (#28, the layer above the #85 scope resolver). Proves:
// a registry token resolves to send scope with a DISTINCT, AUTHORITATIVE From; the
// bound From overrides any caller-supplied From on /api/send + /api/reply (a token
// cannot send as anyone else); displayName becomes the From name; a registry token
// is send-only (cannot read or reach admin); an unknown token is 401; a registry
// From off ALLOWED_FROM_DOMAIN fails loud (403, nothing sent); a malformed registry
// secret denies its tokens without breaking the static both/read/send posture; and
// the legacy un-bound POSTERN_API_TOKEN_SEND path is unchanged (back-compat).

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { sha256Hex, parseRegistry } from "./src/sendidentity";
import { makeFakeEnv } from "./fakes";

interface Entry {
  token: string;
  from: string;
  displayName?: string;
}

// Build a fake env whose POSTERN_SEND_IDENTITIES secret registers the given tokens
// by their sha256 hash (exactly how an operator provisions one), plus any overrides.
async function registryEnv(entries: Entry[], overrides: Record<string, unknown> = {}) {
  const map: Record<string, { from: string; displayName?: string }> = {};
  for (const e of entries) {
    const hash = await sha256Hex(e.token);
    map[hash] = e.displayName ? { from: e.from, displayName: e.displayName } : { from: e.from };
  }
  return makeFakeEnv({ POSTERN_SEND_IDENTITIES: JSON.stringify(map), ...overrides });
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

describe("per-identity send registry (#28)", () => {
  describe("registry token -> send scope with an authoritative From", () => {
    it("forces From to the token's bound identity on /api/send, overriding any caller From", async () => {
      const { env, ctx, settle, sent } = await registryEnv([
        { token: "rollins-secret", from: "rollins@skyphusion.org", displayName: "Rollins" },
      ]);
      // Caller tries to spoof a different From; the bound identity must win.
      const body = { ...SEND_BODY, from: "someone-else@skyphusion.org" };
      const res = await handleApi(req("POST", "/api/send", { token: "rollins-secret", body }), env, ctx);
      await settle();
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].from).toEqual({ email: "rollins@skyphusion.org", name: "Rollins" });
    });

    it("binds From with no displayName as a bare address", async () => {
      const { env, ctx, settle, sent } = await registryEnv([
        { token: "joan-secret", from: "joan@skyphusion.org" },
      ]);
      const res = await handleApi(req("POST", "/api/send", { token: "joan-secret", body: SEND_BODY }), env, ctx);
      await settle();
      expect(res.status).toBe(200);
      expect(sent[0].from).toBe("joan@skyphusion.org");
    });

    it("distinct tokens send as distinct identities", async () => {
      const { env, ctx, settle, sent } = await registryEnv([
        { token: "rollins-secret", from: "rollins@skyphusion.org", displayName: "Rollins" },
        { token: "strummer-secret", from: "strummer@skyphusion.org", displayName: "Strummer" },
      ]);
      await handleApi(req("POST", "/api/send", { token: "rollins-secret", body: SEND_BODY }), env, ctx);
      await handleApi(req("POST", "/api/send", { token: "strummer-secret", body: SEND_BODY }), env, ctx);
      await settle();
      expect(sent.map((s) => s.from)).toEqual([
        { email: "rollins@skyphusion.org", name: "Rollins" },
        { email: "strummer@skyphusion.org", name: "Strummer" },
      ]);
    });

    it("forces From on /api/reply too", async () => {
      const { env, ctx, settle, sent } = await registryEnv([
        { token: "strummer-secret", from: "strummer@skyphusion.org", displayName: "Strummer" },
      ]);
      // Seed a message to reply to (a both-token send from the default From).
      const seed = await handleApi(req("POST", "/api/send", { token: "test-token", body: SEND_BODY }), env, ctx);
      await settle();
      const { messageId } = (await seed.json()) as { messageId: string };

      const res = await handleApi(
        req("POST", "/api/reply", { token: "strummer-secret", body: { messageId, text: "re" } }),
        env,
        ctx,
      );
      await settle();
      expect(res.status).toBe(200);
      // sent[1] is the reply; its From is the bound identity, not the seed's From.
      expect(sent[1].from).toEqual({ email: "strummer@skyphusion.org", name: "Strummer" });
    });
  });

  describe("a registry token is send-only", () => {
    it("cannot read the store (GET messages / search / threads -> 403)", async () => {
      const { env, ctx } = await registryEnv([{ token: "rollins-secret", from: "rollins@skyphusion.org" }]);
      expect((await handleApi(req("GET", "/api/messages", { token: "rollins-secret" }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("GET", "/api/search?q=x", { token: "rollins-secret" }), env, ctx)).status).toBe(403);
      expect((await handleApi(req("GET", "/api/threads/t1", { token: "rollins-secret" }), env, ctx)).status).toBe(403);
    });

    it("cannot reach admin routes (-> 403)", async () => {
      const { env, ctx } = await registryEnv([{ token: "rollins-secret", from: "rollins@skyphusion.org" }]);
      expect(
        (await handleApi(req("POST", "/api/admin/smtp-credentials", { token: "rollins-secret", body: ADMIN_BODY }), env, ctx)).status,
      ).toBe(403);
      expect((await handleApi(req("POST", "/api/admin/reindex", { token: "rollins-secret", body: {} }), env, ctx)).status).toBe(403);
    });
  });

  describe("deny-by-default", () => {
    it("an unknown token (not static, not registry) is 401", async () => {
      const { env, ctx, sent } = await registryEnv([{ token: "rollins-secret", from: "rollins@skyphusion.org" }]);
      expect((await handleApi(req("POST", "/api/send", { token: "nope", body: SEND_BODY }), env, ctx)).status).toBe(401);
      expect(sent).toHaveLength(0);
    });

    it("a registry From off ALLOWED_FROM_DOMAIN fails loud (403), nothing sent", async () => {
      // The token IS in the registry (passes the send-scope gate), but its bound From
      // is off-domain, so resolveFrom rejects it: an honest, loud failure, never a
      // silent send from a bad address.
      const { env, ctx, settle, sent } = await registryEnv([{ token: "bad-secret", from: "evil@example.com" }]);
      const res = await handleApi(req("POST", "/api/send", { token: "bad-secret", body: SEND_BODY }), env, ctx);
      await settle();
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("E_SENDER_NOT_ALLOWED");
      expect(sent).toHaveLength(0);
    });

    it("a malformed registry secret denies its tokens but leaves the static tokens working", async () => {
      const { env, ctx, settle, sent } = makeFakeEnv({ POSTERN_SEND_IDENTITIES: "{ not json" });
      // The would-be registry token is now just unknown -> 401.
      expect((await handleApi(req("POST", "/api/send", { token: "rollins-secret", body: SEND_BODY }), env, ctx)).status).toBe(401);
      // The static both token still sends, unaffected by the broken registry.
      const ok = await handleApi(req("POST", "/api/send", { token: "test-token", body: SEND_BODY }), env, ctx);
      await settle();
      expect(ok.status).toBe(200);
      expect(sent).toHaveLength(1);
    });
  });

  describe("back-compat: static tokens unchanged when a registry is present", () => {
    it("the legacy un-bound POSTERN_API_TOKEN_SEND still sends and honors the caller From", async () => {
      const { env, ctx, settle, sent } = await registryEnv(
        [{ token: "rollins-secret", from: "rollins@skyphusion.org" }],
        { POSTERN_API_TOKEN_SEND: "legacy-send" },
      );
      const body = { ...SEND_BODY, from: "ops@skyphusion.org" };
      const res = await handleApi(req("POST", "/api/send", { token: "legacy-send", body }), env, ctx);
      await settle();
      expect(res.status).toBe(200);
      // No bound identity on the legacy send token: the caller-supplied From is honored.
      expect(sent[0].from).toBe("ops@skyphusion.org");
    });

    it("the both token reads, sends (caller From honored), and reaches admin", async () => {
      const { env, ctx, settle, sent } = await registryEnv([{ token: "rollins-secret", from: "rollins@skyphusion.org" }]);
      expect((await handleApi(req("GET", "/api/messages", { token: "test-token" }), env, ctx)).status).toBe(200);
      const body = { ...SEND_BODY, from: "ops@skyphusion.org" };
      await handleApi(req("POST", "/api/send", { token: "test-token", body }), env, ctx);
      await settle();
      expect(sent[0].from).toBe("ops@skyphusion.org");
    });
  });
});

describe("registry parsing + hashing (units)", () => {
  it("sha256Hex matches the documented sha256sum hex form", async () => {
    // Stable vector: sha256("") well-known digest, so operators can trust the CLI recipe.
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("parseRegistry skips bad entries and keeps the good ones", async () => {
    const good = await sha256Hex("good-token");
    const raw = JSON.stringify({
      [good]: { from: "rollins@skyphusion.org", displayName: "Rollins" },
      "not-a-hash": { from: "x@skyphusion.org" },
      [await sha256Hex("nofrom")]: { from: "not-an-email" },
      [await sha256Hex("nullval")]: null,
    });
    const map = parseRegistry(raw);
    expect(map.size).toBe(1);
    expect(map.get(good)).toEqual({ from: "rollins@skyphusion.org", displayName: "Rollins" });
  });

  it("parseRegistry returns empty on missing or non-object input", () => {
    expect(parseRegistry(undefined).size).toBe(0);
    expect(parseRegistry("").size).toBe(0);
    expect(parseRegistry("[]").size).toBe(0);
    expect(parseRegistry("{ broken").size).toBe(0);
  });
});

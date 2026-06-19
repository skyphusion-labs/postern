import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { ingest } from "./src/ingest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// Seed N inbound messages with increasing dates (so ordering is deterministic).
async function seed(env: Env, ctx: ExecutionContext, msgs: Array<Partial<{ id: string; from: string; to: string; subject: string; text: string; date: string }>>) {
  for (const m of msgs) {
    await ingest(
      env,
      {
        messageId: m.id ?? crypto.randomUUID() + "@example.com",
        from: m.from ?? "alice@example.com",
        to: m.to ?? "conrad@skyphusion.org",
        subject: m.subject ?? "subject",
        text: m.text ?? "body",
        date: m.date,
      },
      ctx,
    );
  }
}

describe("store.list", () => {
  it("returns newest first and paginates with a cursor", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx, [
      { id: "m1@example.com", date: "2026-01-01T00:00:00.000Z", subject: "one" },
      { id: "m2@example.com", date: "2026-01-02T00:00:00.000Z", subject: "two" },
      { id: "m3@example.com", date: "2026-01-03T00:00:00.000Z", subject: "three" },
    ]);
    await settle();

    const p1 = await store.list(env, { limit: 2 });
    expect(p1.items.map((m) => m.messageId)).toEqual(["m3@example.com", "m2@example.com"]);
    expect(p1.cursor).not.toBeNull();
    // Summaries carry no body.
    expect((p1.items[0] as unknown as { bodyText?: string }).bodyText).toBeUndefined();

    const p2 = await store.list(env, { limit: 2, cursor: p1.cursor! });
    expect(p2.items.map((m) => m.messageId)).toEqual(["m1@example.com"]);
    expect(p2.cursor).toBeNull(); // no more
  });

  it("filters by direction, to/from, and thread", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx, [
      { id: "in1@example.com", from: "bob@example.com", to: "conrad@skyphusion.org", date: "2026-01-01T00:00:00.000Z" },
    ]);
    await settle();
    await store.put(
      env,
      { messageId: "out1@example.com", direction: "outbound", from: "noreply@skyphusion.org", to: "bob@example.com", subject: "hi", date: "2026-01-02T00:00:00.000Z", bodyText: "yo", auth: { spf: "none", dkim: "none", dmarc: "none" }, trusted: true },
      ctx,
    );

    expect((await store.list(env, { direction: "outbound" })).items.map((m) => m.messageId)).toEqual(["out1@example.com"]);
    expect((await store.list(env, { direction: "inbound" })).items.map((m) => m.messageId)).toEqual(["in1@example.com"]);
    expect((await store.list(env, { from: "bob@example.com" })).items.map((m) => m.messageId)).toEqual(["in1@example.com"]);
    expect((await store.list(env, { to: "bob" })).items.map((m) => m.messageId)).toEqual(["out1@example.com"]);
  });

  it("filters by FTS q over subject + body", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx, [
      { id: "a@example.com", subject: "invoice attached", text: "please pay", date: "2026-01-01T00:00:00.000Z" },
      { id: "b@example.com", subject: "lunch", text: "tacos friday", date: "2026-01-02T00:00:00.000Z" },
    ]);
    await settle();
    const res = await store.list(env, { q: "invoice" });
    expect(res.items.map((m) => m.messageId)).toEqual(["a@example.com"]);
    const res2 = await store.list(env, { q: "tacos" });
    expect(res2.items.map((m) => m.messageId)).toEqual(["b@example.com"]);
  });

  it("clamps limit to the 1..200 range", async () => {
    const { env } = makeFakeEnv();
    // Indirect: a huge limit must not throw; an empty store returns [].
    const res = await store.list(env, { limit: 10_000 });
    expect(res.items).toEqual([]);
    expect(res.cursor).toBeNull();
  });
});

describe("store.search", () => {
  it("FTS-searches subject + body and returns hits", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx, [
      { id: "s1@example.com", subject: "deploy is green", text: "main passed", date: "2026-01-01T00:00:00.000Z" },
      { id: "s2@example.com", subject: "random", text: "nothing here", date: "2026-01-02T00:00:00.000Z" },
    ]);
    await settle();
    const res = await store.search(env, { q: "deploy" });
    expect(res.items.map((h) => h.message.messageId)).toEqual(["s1@example.com"]);
  });

  it("does not choke or inject on FTS-special characters (sanitized)", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx, [{ id: "x@example.com", subject: "report", text: "quarterly", date: "2026-01-01T00:00:00.000Z" }]);
    await settle();
    // Quotes / operators / a SQL-ish payload must be reduced to safe tokens.
    await expect(store.search(env, { q: '" OR 1=1 --' })).resolves.toBeTruthy();
    const res = await store.search(env, { q: "report)) AND (" });
    expect(res.items.map((h) => h.message.messageId)).toEqual(["x@example.com"]);
  });

  it("returns an empty page for an all-punctuation query", async () => {
    const { env } = makeFakeEnv();
    const res = await store.search(env, { q: "!@#$%" });
    expect(res.items).toEqual([]);
    expect(res.cursor).toBeNull();
  });

  it("rejects an unknown search mode", async () => {
    const { env } = makeFakeEnv();
    // semantic/hybrid are supported as of M4; only a bogus mode is rejected.
    await expect(store.search(env, { q: "x", mode: "telepathy" as unknown as "fts" })).rejects.toMatchObject({
      code: "E_VALIDATION_ERROR",
    });
  });
});

describe("read API routes", () => {
  function req(path: string, token = "test-token"): Request {
    return new Request(`https://postern.example${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it("GET /api/messages lists with filters + paginates", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx, [
      { id: "p1@example.com", date: "2026-01-01T00:00:00.000Z" },
      { id: "p2@example.com", date: "2026-01-02T00:00:00.000Z" },
    ]);
    await settle();
    const res = await handleApi(req("/api/messages?limit=1"), env, ctx);
    const body = (await res.json()) as { ok: boolean; items: { messageId: string }[]; cursor: string | null };
    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].messageId).toBe("p2@example.com");
    expect(body.cursor).not.toBeNull();
  });

  it("GET /api/search requires q and returns hits", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx, [{ id: "q1@example.com", subject: "widget", text: "x", date: "2026-01-01T00:00:00.000Z" }]);
    await settle();
    expect((await handleApi(req("/api/search"), env, ctx)).status).toBe(400);
    const res = await handleApi(req("/api/search?q=widget"), env, ctx);
    const body = (await res.json()) as { items: { message: { messageId: string } }[] };
    expect(res.status).toBe(200);
    expect(body.items[0].message.messageId).toBe("q1@example.com");
  });

  it("401s list/search without the API token", async () => {
    const { env, ctx } = makeFakeEnv();
    expect((await handleApi(new Request("https://postern.example/api/messages"), env, ctx)).status).toBe(401);
    expect((await handleApi(new Request("https://postern.example/api/search?q=a"), env, ctx)).status).toBe(401);
  });
});

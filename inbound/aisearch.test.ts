import { describe, it, expect, vi } from "vitest";
import * as store from "./src/store";
import { ingest } from "./src/ingest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// Seed inbound messages; VECTORIZE_FOR="" so ingest indexes all of them into the
// fake Vectorize (the deterministic embedder + cosine query make ranking real).
async function seed(env: Env, ctx: ExecutionContext, msgs: Array<{ id: string; subject: string; text: string; date: string; from?: string }>) {
  for (const m of msgs) {
    await ingest(
      env,
      { messageId: m.id, from: m.from ?? "alice@example.com", to: "conrad@skyphusion.org", subject: m.subject, text: m.text, date: m.date },
      ctx,
    );
  }
}

const CORPUS = [
  { id: "inv@example.com", subject: "invoice", text: "invoice payment billing money due", date: "2026-01-01T00:00:00.000Z" },
  { id: "lunch@example.com", subject: "lunch", text: "lunch tacos food friday", date: "2026-01-02T00:00:00.000Z" },
  { id: "deploy@example.com", subject: "deploy", text: "deploy release build green", date: "2026-01-03T00:00:00.000Z" },
];

describe("store.search semantic (#31)", () => {
  it("ranks the semantically closest message first", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, CORPUS);
    await settle();

    const res = await store.search(env, { q: "payment for the invoice", mode: "semantic" });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0].message.messageId).toBe("inv@example.com");
    expect(typeof res.items[0].score).toBe("number");
    // Score-ranked single page: no date cursor.
    expect(res.cursor).toBeNull();
  });

  it("collapses multiple chunk-hits to one message (best score)", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    // A long body produces several chunks/vectors for the same message_id.
    const long = ("deploy release build green ").repeat(400);
    await ingest(env, { messageId: "big@example.com", from: "a@example.com", to: "conrad@skyphusion.org", subject: "ci", text: long, date: "2026-01-04T00:00:00.000Z" }, ctx);
    await settle();
    const res = await store.search(env, { q: "release deploy", mode: "semantic" });
    const ids = res.items.map((h) => h.message.messageId);
    // big@ appears at most once despite many chunk vectors.
    expect(ids.filter((id) => id === "big@example.com")).toHaveLength(1);
  });

  it("returns empty when the AI binding is unavailable (graceful)", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "", AI: undefined });
    await seed(env, ctx, CORPUS);
    await settle();
    const res = await store.search(env, { q: "anything", mode: "semantic" });
    expect(res.items).toEqual([]);
    expect(res.cursor).toBeNull();
  });

  it("returns empty for a blank query", async () => {
    const { env } = makeFakeEnv({ VECTORIZE_FOR: "" });
    expect((await store.search(env, { q: "   ", mode: "semantic" })).items).toEqual([]);
  });
});

describe("store.search hybrid (#31)", () => {
  it("merges fts + semantic and ranks the on-topic message top", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, CORPUS);
    await settle();
    const res = await store.search(env, { q: "invoice", mode: "hybrid" });
    expect(res.items[0].message.messageId).toBe("inv@example.com");
    expect(res.cursor).toBeNull();
  });

  it("surfaces a semantic-only hit that exact FTS would miss", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, CORPUS);
    await settle();
    // "money" is in the invoice body but not the query word "billing"; semantic
    // closeness still pulls the invoice in under hybrid.
    const res = await store.search(env, { q: "billing money", mode: "hybrid" });
    expect(res.items.map((h) => h.message.messageId)).toContain("inv@example.com");
  });
});

describe("unknown search mode still rejects", () => {
  it("throws E_VALIDATION_ERROR for a bogus mode", async () => {
    const { env } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await expect(store.search(env, { q: "x", mode: "telepathy" as unknown as "fts" })).rejects.toMatchObject({
      code: "E_VALIDATION_ERROR",
    });
  });
});

describe("outbound vectorization (#116 ws2)", () => {
  type Vec = { metadata?: { message_id?: string; direction?: string } };

  function sendReq(body: unknown): Request {
    return new Request("https://postern.example/api/send", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("indexes an outbound send and finds it by semantic search, tagged direction=outbound", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    const res = await handleApi(
      sendReq({ to: "alice@example.com", subject: "status update", text: "deploy release build green gpu render" }),
      env,
      ctx,
    );
    await settle();
    const { messageId } = (await res.json()) as { messageId: string };

    // It was indexed (outbound used to be vectorize:false).
    const mine = (vectors as Vec[]).filter((v) => v.metadata?.message_id === messageId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((v) => v.metadata?.direction === "outbound")).toBe(true);

    // And it is recoverable by semantic search -- the point of the change.
    const sr = await store.search(env, { q: "release deploy", mode: "semantic" });
    expect(sr.items.map((h) => h.message.messageId)).toContain(messageId);
  });

  it("indexes outbound unconditionally -- even with a VECTORIZE_FOR allowlist set (outbound is not gated)", async () => {
    // The allowlist narrows INBOUND only; outbound is always our own mail.
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "someone-else@skyphusion.org" });
    const res = await handleApi(
      sendReq({ to: "bob@example.com", subject: "reply", text: "invoice payment money billing" }),
      env,
      ctx,
    );
    await settle();
    const { messageId } = (await res.json()) as { messageId: string };
    const mine = (vectors as Vec[]).filter((v) => v.metadata?.message_id === messageId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((v) => v.metadata?.direction === "outbound")).toBe(true);
  });

  it("tags inbound mail direction=inbound in the vector metadata", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await ingest(
      env,
      { messageId: "in@example.com", from: "x@example.com", to: "conrad@skyphusion.org", subject: "q", text: "invoice payment money", date: "2026-01-01T00:00:00.000Z" },
      ctx,
    );
    await settle();
    const mine = (vectors as Vec[]).filter((v) => v.metadata?.message_id === "in@example.com");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((v) => v.metadata?.direction === "inbound")).toBe(true);
  });
});

describe("search API mode passthrough (#31)", () => {
  function req(path: string): Request {
    return new Request(`https://postern.example${path}`, { headers: { authorization: "Bearer test-token" } });
  }
  it("GET /api/search?mode=semantic returns ranked hits", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, CORPUS);
    await settle();
    const res = await handleApi(req("/api/search?q=invoice%20payment&mode=semantic"), env, ctx);
    const body = (await res.json()) as { ok: boolean; items: { message: { messageId: string } }[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.items[0].message.messageId).toBe("inv@example.com");
  });
  it("GET /api/search?mode=hybrid works", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, CORPUS);
    await settle();
    const res = await handleApi(req("/api/search?q=deploy&mode=hybrid"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { message: { messageId: string } }[] };
    expect(body.items[0].message.messageId).toBe("deploy@example.com");
  });
  it("GET /api/search?mode=bogus returns 400", async () => {
    const { env, ctx } = makeFakeEnv({ VECTORIZE_FOR: "" });
    const res = await handleApi(req("/api/search?q=x&mode=bogus"), env, ctx);
    expect(res.status).toBe(400);
  });
});

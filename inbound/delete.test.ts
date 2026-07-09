import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// #278: hard delete bundled with Vectorize tombstone + vector_ledger purge.

async function seed(
  env: Env,
  ctx: ExecutionContext,
  settle: () => Promise<unknown[]>,
  id: string,
  text: string,
) {
  await store.put(
    env,
    {
      messageId: id,
      direction: "inbound",
      from: "sender@example.com",
      to: "conrad@skyphusion.org",
      subject: "subject",
      date: "2026-01-01T00:00:00.000Z",
      bodyText: text,
      auth: { spf: "none", dkim: "none", dmarc: "none" },
      trusted: true,
      vectorize: true,
    },
    ctx,
  );
  await settle();
}

describe("store.deleteMessage (#278)", () => {
  it("removes the message, vectors, and ledger rows", async () => {
    const { env, ctx, settle, vectors, vectorLedger } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, "gone@x", "deploy release invoice");
    expect(vectors.length).toBeGreaterThan(0);
    expect(vectorLedger.some((r) => r.message_id === "gone@x")).toBe(true);

    expect(await store.deleteMessage(env, "gone@x", ctx)).toBe(true);
    await settle();

    expect(await store.get(env, "gone@x")).toBeNull();
    expect(vectors.length).toBe(0);
    expect(vectorLedger.some((r) => r.message_id === "gone@x")).toBe(false);

    const r = await store.reconcile(env, { verify: true });
    expect(r.orphanCount).toBe(0);
  });

  it("returns false for an unknown message_id", async () => {
    const { env } = makeFakeEnv();
    expect(await store.deleteMessage(env, "nope@x")).toBe(false);
  });

  it("drops the message from list and search", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, "findme@x", "deploy release invoice");
    expect(await store.deleteMessage(env, "findme@x", ctx)).toBe(true);
    await settle();

    const list = await store.list(env, {});
    expect(list.items.some((m) => m.messageId === "findme@x")).toBe(false);
    const hits = await store.search(env, { q: "deploy", mode: "fts" });
    expect(hits.items.some((h) => h.message.messageId === "findme@x")).toBe(false);
  });
});

describe("DELETE /api/messages/{id}", () => {
  function del(id: string, token = "test-token"): Request {
    return new Request(`https://postern.example/api/messages/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("deletes with the both-scoped token", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, "api@x", "deploy release");
    const res = await handleApi(del("api@x"), env, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: "api@x" });
    expect(await store.get(env, "api@x")).toBeNull();
  });

  it("returns 404 when the message is absent", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(del("missing@x"), env, ctx);
    expect(res.status).toBe(404);
  });
});

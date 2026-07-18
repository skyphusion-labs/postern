/**
 * #366: /api/search accepts from= with the same lower(from_addr) LIKE semantics
 * as /api/messages, across fts/substr and passesViewerScope for semantic/hybrid.
 */
import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { makeFakeEnv } from "./fakes";

let clock = 0;
async function put(
  env: Env,
  ctx: ExecutionContext,
  m: Partial<{
    id: string;
    direction: "inbound" | "outbound";
    from: string;
    to: string;
    subject: string;
    body: string;
    date: string;
    vectorize: boolean;
  }>,
) {
  clock += 1;
  await store.put(
    env,
    {
      messageId: m.id ?? `m${clock}@example.com`,
      direction: m.direction ?? "outbound",
      from: m.from ?? "alice@example.com",
      to: m.to ?? "bob@example.com",
      subject: m.subject ?? "widget subject",
      date: m.date ?? `2026-07-${String(clock).padStart(2, "0")}T00:00:00.000Z`,
      bodyText: m.body ?? "widget body",
      auth: { spf: "none", dkim: "none", dmarc: "none" },
      trusted: true,
      vectorize: m.vectorize ?? false,
    } as unknown as Parameters<typeof store.put>[1],
    ctx,
  );
}

async function seedTwoSenders(
  env: Env,
  ctx: ExecutionContext,
  settle: () => Promise<unknown[]>,
) {
  await put(env, ctx, {
    id: "alice-out@example.com",
    from: "alice@skyphusion.org",
    subject: "widget alpha",
    body: "widget alpha body",
    vectorize: true,
  });
  await put(env, ctx, {
    id: "carol-out@example.com",
    from: "carol@skyphusion.org",
    subject: "widget beta",
    body: "widget beta body",
    vectorize: true,
  });
  await settle();
}

function ids(page: { items: { message: { messageId: string } }[] }): string[] {
  return page.items.map((h) => h.message.messageId);
}

function req(path: string, token = "test-token"): Request {
  return new Request(`https://postern.example${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("search from= (#366)", () => {
  it("fts from= mirrors list from= substring match", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seedTwoSenders(env, ctx, settle);
    const all = await store.search(env, { q: "widget", mode: "fts", direction: "outbound" });
    expect(ids(all).sort()).toEqual(["alice-out@example.com", "carol-out@example.com"]);
    const alice = await store.search(env, {
      q: "widget",
      mode: "fts",
      direction: "outbound",
      from: "alice@skyphusion.org",
    });
    expect(ids(alice)).toEqual(["alice-out@example.com"]);
    const listAlice = await store.list(env, { from: "alice@skyphusion.org", direction: "outbound" });
    expect(listAlice.items.map((m) => m.messageId)).toEqual(["alice-out@example.com"]);
  });

  it("substr from= filters the sender the same way", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seedTwoSenders(env, ctx, settle);
    const hits = await store.search(env, {
      q: "widget",
      mode: "substr",
      field: "subject",
      direction: "outbound",
      from: "carol@skyphusion.org",
    });
    expect(ids(hits)).toEqual(["carol-out@example.com"]);
  });

  it("semantic/hybrid from= goes through passesViewerScope", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seedTwoSenders(env, ctx, settle);
    const sem = await store.search(env, {
      q: "widget",
      mode: "semantic",
      direction: "outbound",
      from: "alice@skyphusion.org",
    });
    expect(ids(sem)).toEqual(["alice-out@example.com"]);
    const hyb = await store.search(env, {
      q: "widget",
      mode: "hybrid",
      direction: "outbound",
      from: "alice@skyphusion.org",
    });
    expect(ids(hyb)).toEqual(["alice-out@example.com"]);
  });

  it("GET /api/search forwards from=", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seedTwoSenders(env, ctx, settle);
    const res = await handleApi(
      req("/api/search?q=widget&mode=fts&direction=outbound&from=alice%40skyphusion.org"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { message: { messageId: string } }[] };
    expect(body.items.map((h) => h.message.messageId)).toEqual(["alice-out@example.com"]);
  });
});

// A search answer must never claim to be more complete, or less bounded, than it is.
// Refs #631 (the report), #632 F2/F3/F4/F7 (the traced causes), #544 (the scoping this
// declares).
//
// Three separate lies lived in this response shape, and each gets a test here plus a control
// that produces the OPPOSITE reading, because "incomplete" asserted unconditionally would be
// just as useless as "complete" asserted unconditionally:
//
//   1. `cursor: null` from the score-ranked modes. The contract defines null as "there are no
//      more", and hybrid is the DEFAULT mode, so the most-used search path asserted exhaustion
//      it could not deliver.
//   2. The candidate set was collapsed and sliced to `limit` BEFORE the caller's filters ran,
//      so a message that matched a date window but ranked below `limit` globally was discarded
//      before the window was consulted. This is the one that cost a real search: a month of
//      mail answered with two hits.
//   3. A scoped view that never named its scope, so a zero result read as "not in the estate"
//      when it meant "not in your slice".

import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { ingest } from "./src/ingest";
import { handleApi } from "./src/api";
import { sha256Hex } from "./src/sendidentity";
import { makeFakeEnv } from "./fakes";

const VIEWER = "conrad@skyphusion.org";

async function seed(
  env: Env,
  ctx: ExecutionContext,
  msgs: Array<{ id: string; text: string; date: string; to?: string }>,
) {
  for (const m of msgs) {
    await ingest(
      env,
      {
        messageId: m.id,
        from: "alice@example.com",
        to: m.to ?? VIEWER,
        subject: "s",
        text: m.text,
        date: m.date,
      },
      ctx,
    );
  }
}

/** n topically-identical messages, so they all outrank anything off-topic. */
function onTopic(n: number, date: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `hit${i}@example.com`,
    text: "invoice payment billing money",
    date,
  }));
}

describe("a filtered score-ranked search is not thinned by a pre-filter slice (#632 F3)", () => {
  it("finds an in-window message that ranks below `limit` GLOBALLY", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    // 20 strong matches, every one OUTSIDE the window, plus one weak match INSIDE it. The
    // target ranks 21st on score alone, so any pre-filter slice at limit=5 destroys it. This
    // is the shape of the real failure: the filter was not wrong, it was applied too late to
    // a set that had already been cut.
    await seed(env, ctx, [
      ...onTopic(20, "2026-03-01T00:00:00.000Z"),
      { id: "target@example.com", text: "lunch tacos food", date: "2026-01-15T00:00:00.000Z" },
    ]);
    await settle();

    const res = await store.search(env, {
      q: "invoice payment billing money",
      mode: "semantic",
      limit: 5,
      after: "2026-01-01T00:00:00.000Z",
      before: "2026-01-31T23:59:59.000Z",
    });

    expect(res.items.map((h) => h.message.messageId)).toEqual(["target@example.com"]);
  });

  it("CONTROL: the same corpus and query with NO window returns the strong matches, not the weak one", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, [
      ...onTopic(20, "2026-03-01T00:00:00.000Z"),
      { id: "target@example.com", text: "lunch tacos food", date: "2026-01-15T00:00:00.000Z" },
    ]);
    await settle();

    const res = await store.search(env, { q: "invoice payment billing money", mode: "semantic", limit: 5 });

    // Ranking is untouched: without a filter the top of the list is still the top of the list,
    // so the fix above widened retrieval without turning relevance into a lottery.
    expect(res.items).toHaveLength(5);
    expect(res.items.map((h) => h.message.messageId)).not.toContain("target@example.com");
  });

  it("`limit` bounds the ANSWER, not the candidate pool", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    // 12 in-window messages, limit 4: the page is 4 and the response must admit there is more
    // rather than imply those 4 were all that matched.
    await seed(env, ctx, onTopic(12, "2026-01-10T00:00:00.000Z"));
    await settle();

    const res = await store.search(env, {
      q: "invoice payment billing money",
      mode: "semantic",
      limit: 4,
      after: "2026-01-01T00:00:00.000Z",
      before: "2026-01-31T23:59:59.000Z",
    });

    expect(res.items).toHaveLength(4);
    expect(res.complete).toBe(false);
    expect(res.cursor, "an absent cursor, never a null one: null is a claim of exhaustion").toBeUndefined();
    expect(res.degraded).toMatch(/more matching messages/i);
  });
});

describe("the score-ranked modes stop claiming exhaustion they cannot deliver (#632 F2)", () => {
  it("semantic omits the cursor and reports complete:false when retrieval hit its ceiling", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    // limit 10 with no filter asks for topK 30; 60 messages means the index had more to give.
    await seed(env, ctx, onTopic(60, "2026-01-10T00:00:00.000Z"));
    await settle();

    const res = await store.search(env, { q: "invoice payment billing money", mode: "semantic", limit: 10 });

    expect(res.complete).toBe(false);
    expect(res.retrievalCap).toBe(30);
    expect(res.cursor).toBeUndefined();
  });

  it("CONTROL: an exhausted candidate set still reports complete:true with cursor:null", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, onTopic(3, "2026-01-10T00:00:00.000Z"));
    await settle();

    const res = await store.search(env, { q: "invoice payment billing money", mode: "semantic", limit: 10 });

    // The point of the control: "incomplete" is a measurement, not a blanket disclaimer. When
    // the index genuinely ran out before the ceiling did, exhaustion is honest and is claimed.
    expect(res.complete).toBe(true);
    expect(res.cursor).toBeNull();
    expect(res.items).toHaveLength(3);
  });

  it("hybrid, the DEFAULT mode, inherits the same honesty", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, onTopic(60, "2026-01-10T00:00:00.000Z"));
    await settle();

    const res = await store.search(env, { q: "invoice payment billing money", mode: "hybrid", limit: 10 });

    expect(res.complete).toBe(false);
    expect(res.cursor).toBeUndefined();
  });

  it("the HTTP envelope omits the cursor KEY entirely when the answer is incomplete", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, onTopic(60, "2026-01-10T00:00:00.000Z"));
    await settle();

    const res = await handleApi(
      new Request(
        "https://postern.example/api/search?q=invoice%20payment&mode=semantic&limit=10",
        { headers: { authorization: "Bearer test-token" } },
      ),
      env,
      ctx,
    );
    const body = (await res.json()) as Record<string, unknown>;

    // A client doing `body.cursor ?? null` would coerce an absent key back into the old lie,
    // so the key must be ABSENT rather than null and the client must read `complete`.
    expect(Object.keys(body)).not.toContain("cursor");
    expect(body.complete).toBe(false);
  });
});

describe("a mode that could not run says so instead of answering zero (#632 F4)", () => {
  it("reports a degraded reason when there is no AI binding", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "", AI: undefined });
    await seed(env, ctx, onTopic(3, "2026-01-10T00:00:00.000Z"));
    await settle();

    const res = await store.search(env, { q: "invoice", mode: "semantic" });

    expect(res.items).toEqual([]);
    expect(res.complete).toBe(false);
    expect(res.degraded).toMatch(/no AI binding/i);
    expect(res.cursor, "zero rows plus a null cursor is exactly the false completeness").toBeUndefined();
  });

  it("reports a degraded reason when there is no Vectorize binding", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "", VECTORIZE: undefined });
    await seed(env, ctx, onTopic(3, "2026-01-10T00:00:00.000Z"));
    await settle();

    const res = await store.search(env, { q: "invoice", mode: "semantic" });

    expect(res.items).toEqual([]);
    expect(res.degraded).toMatch(/no Vectorize binding/i);
  });

  it("CONTROL: with both bindings present the same query is complete and undegraded", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, onTopic(3, "2026-01-10T00:00:00.000Z"));
    await settle();

    const res = await store.search(env, { q: "invoice payment billing money", mode: "semantic" });

    expect(res.degraded).toBeUndefined();
    expect(res.complete).toBe(true);
  });
});

describe("every read declares the scope it was answered under (#632 F7 / #544)", () => {
  async function boundEnv() {
    const token = "reader-registry-token";
    const registry = { [await sha256Hex(token)]: { from: VIEWER, scopes: ["read"] } };
    const { env, ctx, settle } = makeFakeEnv({
      VECTORIZE_FOR: "",
      POSTERN_SEND_IDENTITIES: JSON.stringify(registry),
    });
    return { env, ctx, settle, token };
  }

  const get = (path: string, token: string) =>
    new Request(`https://postern.example${path}`, { headers: { authorization: `Bearer ${token}` } });

  it("a bound read token is told it is scoped to itself, on list AND search", async () => {
    const { env, ctx, settle, token } = await boundEnv();
    await seed(env, ctx, onTopic(2, "2026-01-10T00:00:00.000Z"));
    await settle();

    const list = (await (await handleApi(get("/api/messages", token), env, ctx)).json()) as Record<string, unknown>;
    expect(list.identityScope).toEqual({ kind: "member", addresses: [VIEWER] });

    const search = (await (
      await handleApi(get("/api/search?q=invoice&mode=fts", token), env, ctx)
    ).json()) as Record<string, unknown>;
    expect(search.identityScope).toEqual({ kind: "member", addresses: [VIEWER] });
  });

  it("CONTROL: a static estate token is told it is NOT scoped, so the field discriminates", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, onTopic(2, "2026-01-10T00:00:00.000Z"));
    await settle();

    const list = (await (
      await handleApi(get("/api/messages", "test-token"), env, ctx)
    ).json()) as Record<string, unknown>;
    expect(list.identityScope).toEqual({ kind: "estate" });

    const search = (await (
      await handleApi(get("/api/search?q=invoice&mode=fts", "test-token"), env, ctx)
    ).json()) as Record<string, unknown>;
    expect(search.identityScope).toEqual({ kind: "estate" });
  });
});

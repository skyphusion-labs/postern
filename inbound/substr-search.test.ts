// mode=substr: exact case-insensitive substring search for IMAP SEARCH parity
// (#212, backend for #148). Proves field scoping (subject/body/text), header-column
// coverage that fts does not have (a from-header display-name match), LIKE
// metacharacter escaping (% and _ are literal), direction restriction, cursor
// paging, and the api.ts route wiring (mode + field validation).

import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

let clock = 0;
async function put(
  env: Env,
  ctx: ExecutionContext,
  m: Partial<{ id: string; direction: "inbound" | "outbound"; from: string; to: string; subject: string; body: string; date: string }>,
) {
  clock += 1;
  await store.put(
    env,
    {
      messageId: m.id ?? `m${clock}@example.com`,
      direction: m.direction ?? "inbound",
      from: m.from ?? "alice@example.com",
      to: m.to ?? "conrad@skyphusion.org",
      subject: m.subject ?? "subject",
      date: m.date ?? `2026-01-${String(clock).padStart(2, "0")}T00:00:00.000Z`,
      bodyText: m.body ?? "body",
      auth: { spf: "none", dkim: "none", dmarc: "none" },
      trusted: true,
    } as unknown as Parameters<typeof store.put>[1],
    ctx,
  );
}

function ids(page: { items: { message: { messageId: string } }[] }): string[] {
  return page.items.map((h) => h.message.messageId).sort();
}

function req(path: string, token = "test-token", method = "GET"): Request {
  return new Request(`https://postern.example${path}`, { method, headers: { authorization: `Bearer ${token}` } });
}

describe("store.search mode=substr (#212)", () => {
  it("matches a substring inside a word (not token-bounded like fts)", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "a@example.com", subject: "quarterly-report" });
    const res = await store.search(env, { q: "terly-rep", mode: "substr", field: "subject" });
    expect(ids(res)).toEqual(["a@example.com"]);
  });

  it("is case-insensitive (ASCII)", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "a@example.com", subject: "Quarterly Report" });
    const res = await store.search(env, { q: "QUARTERLY", mode: "substr", field: "subject" });
    expect(ids(res)).toEqual(["a@example.com"]);
  });

  it("field=subject and field=body scope to their column; field=text spans both", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "sub@example.com", subject: "quarterly", body: "zzz" });
    await put(env, ctx, { id: "bod@example.com", subject: "zzz", body: "quarterly numbers" });

    expect(ids(await store.search(env, { q: "quarterly", mode: "substr", field: "subject" }))).toEqual(["sub@example.com"]);
    expect(ids(await store.search(env, { q: "quarterly", mode: "substr", field: "body" }))).toEqual(["bod@example.com"]);
    expect(ids(await store.search(env, { q: "quarterly", mode: "substr", field: "text" }))).toEqual(["bod@example.com", "sub@example.com"]);
  });

  it("field=text covers header columns fts does not (a from-header display name)", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "c@example.com", from: "Alice Wonderland <alice@example.com>", subject: "hi", body: "hi" });
    // text (default column set) reaches from_addr, which holds the raw header
    // incl. the display name (post-M8 fidelity).
    expect(ids(await store.search(env, { q: "Wonderland", mode: "substr", field: "text" }))).toEqual(["c@example.com"]);
    // subject-only scope does NOT see the From header.
    expect(ids(await store.search(env, { q: "Wonderland", mode: "substr", field: "subject" }))).toEqual([]);
    // fts searches subject + body only, so it cannot find a From-header-only term
    // -- the exact coverage gap substr text closes.
    expect((await store.search(env, { q: "Wonderland", mode: "fts" })).items).toEqual([]);
  });

  it("escapes LIKE wildcards: % is a literal percent, not an any-run", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "pct@example.com", subject: "50% off deal" });
    await put(env, ctx, { id: "num@example.com", subject: "5000 off deal" });
    const res = await store.search(env, { q: "50%", mode: "substr", field: "subject" });
    expect(ids(res)).toEqual(["pct@example.com"]);
  });

  it("escapes LIKE wildcards: _ is a literal underscore, not any-single-char", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "us@example.com", subject: "a_b marker" });
    await put(env, ctx, { id: "ax@example.com", subject: "axb marker" });
    const res = await store.search(env, { q: "a_b", mode: "substr", field: "subject" });
    expect(ids(res)).toEqual(["us@example.com"]);
  });

  it("restricts by direction", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "in@example.com", direction: "inbound", subject: "shared term" });
    await put(env, ctx, { id: "out@example.com", direction: "outbound", subject: "shared term" });
    expect(ids(await store.search(env, { q: "shared", mode: "substr", field: "subject", direction: "inbound" }))).toEqual(["in@example.com"]);
    expect(ids(await store.search(env, { q: "shared", mode: "substr", field: "subject", direction: "outbound" }))).toEqual(["out@example.com"]);
  });

  it("paginates with a keyset cursor", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "p1@example.com", subject: "match one", date: "2026-02-01T00:00:00.000Z" });
    await put(env, ctx, { id: "p2@example.com", subject: "match two", date: "2026-02-02T00:00:00.000Z" });
    await put(env, ctx, { id: "p3@example.com", subject: "match three", date: "2026-02-03T00:00:00.000Z" });
    const p1 = await store.search(env, { q: "match", mode: "substr", field: "subject", limit: 2 });
    expect(p1.items.map((h) => h.message.messageId)).toEqual(["p3@example.com", "p2@example.com"]);
    expect(p1.cursor).not.toBeNull();
    const p2 = await store.search(env, { q: "match", mode: "substr", field: "subject", limit: 2, cursor: p1.cursor! });
    expect(p2.items.map((h) => h.message.messageId)).toEqual(["p1@example.com"]);
    expect(p2.cursor).toBeNull();
  });

  it("empty q returns no rows", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "a@example.com", subject: "anything" });
    expect((await store.search(env, { q: "", mode: "substr" })).items).toEqual([]);
  });
});

describe("GET /api/search?mode=substr route (#212)", () => {
  it("returns matches for mode=substr", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "h@example.com", subject: "hello world" });
    const res = await handleApi(req("/api/search?mode=substr&q=ello&field=subject"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; items: { message: { messageId: string } }[] };
    expect(body.items.map((h) => h.message.messageId)).toEqual(["h@example.com"]);
  });

  it("defaults field to text (finds a from-header match with no field param)", async () => {
    const { env, ctx } = makeFakeEnv();
    await put(env, ctx, { id: "z@example.com", from: "Zed Zephyr <z@example.com>", subject: "hi", body: "hi" });
    const res = await handleApi(req("/api/search?mode=substr&q=Zephyr"), env, ctx);
    const body = (await res.json()) as { items: { message: { messageId: string } }[] };
    expect(body.items.map((h) => h.message.messageId)).toEqual(["z@example.com"]);
  });

  it("400 E_VALIDATION_ERROR for an unknown field", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("/api/search?mode=substr&q=x&field=bogus"), env, ctx);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("E_VALIDATION_ERROR");
  });
});

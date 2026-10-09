// #648: countOnly on GET /api/messages.
//
// "How many messages match this" was only answerable by paging the whole result and
// counting. For any window worth asking about that is the exact payload problem that made
// #631 unanswerable, and it is also the cheapest way for a caller to decide whether to
// spend a real query, and the only way to tell "nothing matches" from "the page was
// truncated".
//
// TWO properties carry this, and the second is the security-relevant one:
//
//   1. AGREEMENT. The total must be the number of rows the same query would page. A count
//      from a second predicate is a number the caller cannot reach, and it is worse than
//      no count because it reads as authoritative and nothing contradicts it. So the arms
//      below compare the total against the ROWS rather than against a literal.
//   2. SCOPE. The count must run under the SAME access predicate as the rows. A count that
//      ignored scope would be a disclosure channel: it would tell an identity-scoped caller
//      how much mail exists OUTSIDE its own slice, which is a fact no read of that slice
//      can reveal.
//
// Real SQLite via ./realdb, because both properties are claims about real predicates.

import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import { realEnv, putInbound } from "./realdb";
import { sha256Hex } from "./src/sendidentity";

const ESTATE_TOKEN = "test-token";
const ME = "me@skyphusion.org";
const OTHER = "other@skyphusion.org";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";

const get = (path: string, token = ESTATE_TOKEN) =>
  new Request(`https://postern.example${path}`, { headers: { authorization: `Bearer ${token}` } });

/** Three messages for ME, two for OTHER, across two senders and two months. */
async function seed(env: Env, ctx: ExecutionContext) {
  await putInbound(env, ctx, { id: "m1@x", from: ALICE, to: ME, subject: "one", body: "alpha", date: "2026-01-05T00:00:00.000Z" });
  await putInbound(env, ctx, { id: "m2@x", from: BOB, to: ME, subject: "two", body: "alpha", date: "2026-01-20T00:00:00.000Z" });
  await putInbound(env, ctx, { id: "m3@x", from: ALICE, to: ME, subject: "three", body: "beta", date: "2026-02-10T00:00:00.000Z" });
  await putInbound(env, ctx, { id: "m4@x", from: BOB, to: OTHER, subject: "four", body: "alpha", date: "2026-01-11T00:00:00.000Z" });
  await putInbound(env, ctx, { id: "m5@x", from: BOB, to: OTHER, subject: "five", body: "beta", date: "2026-02-11T00:00:00.000Z" });
}

async function total(env: Env, ctx: ExecutionContext, query: string, token = ESTATE_TOKEN): Promise<number> {
  const res = await handleApi(get(`/api/messages?countOnly=1${query}`, token), env, ctx);
  expect(res.status, `countOnly${query} should be 200`).toBe(200);
  const body = (await res.json()) as { total?: number };
  expect(typeof body.total, "total must be a number").toBe("number");
  return body.total as number;
}

/** Every id the same query returns, paged to exhaustion, so AGREEMENT is against rows. */
async function pagedIds(env: Env, ctx: ExecutionContext, query: string, token = ESTATE_TOKEN): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let hop = 0; hop < 20; hop++) {
    const suffix = cursor ? `&limit=2&cursor=${encodeURIComponent(cursor)}` : "&limit=2";
    const res = await handleApi(get(`/api/messages?x=1${query}${suffix}`.replace("?x=1&", "?"), token), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ messageId: string }>; cursor: string | null };
    out.push(...body.items.map((i) => i.messageId));
    cursor = body.cursor;
    if (!cursor) return out;
  }
  throw new Error("pagination did not terminate");
}

describe("#648 the total AGREES with the rows the same query pages", () => {
  for (const [label, query] of [
    ["no filter", ""],
    ["a sender filter", `&from=${ALICE}`],
    ["a recipient filter", `&to=${ME}`],
    ["a date window", "&after=2026-01-01&before=2026-01-31"],
    ["an FTS filter", "&q=alpha"],
    ["filters combined", `&from=${BOB}&after=2026-02-01`],
  ] as const) {
    it(`agrees under ${label}`, async () => {
      const { env, ctx } = realEnv();
      await seed(env, ctx);

      const rows = await pagedIds(env, ctx, query);
      const counted = await total(env, ctx, query);

      expect(counted).toBe(rows.length);
    });
  }

  it("CONTROL: the totals DIFFER across those queries, so agreement is not a constant", async () => {
    // Without this, every arm above would pass against a count that always returned the
    // table size, as long as the row paging happened to return the same number.
    const { env, ctx } = realEnv();
    await seed(env, ctx);

    const all = await total(env, ctx, "");
    const narrowed = await total(env, ctx, `&from=${ALICE}`);
    const windowed = await total(env, ctx, "&after=2026-01-01&before=2026-01-31");

    expect(all).toBe(5);
    expect(narrowed).toBe(2);
    expect(windowed).toBe(3);
    expect(new Set([all, narrowed, windowed]).size).toBe(3);
  });

  it("counts zero for a query that matches nothing, and says so as a number", async () => {
    const { env, ctx } = realEnv();
    await seed(env, ctx);

    // A real zero, distinguishable from a truncated page, which is the whole point.
    expect(await total(env, ctx, "&from=nobody@nowhere.example")).toBe(0);
    // The all-punctuation FTS query, which the store short-circuits before any SQL.
    expect(await total(env, ctx, "&q=" + encodeURIComponent("!!!"))).toBe(0);
    // AGREEMENT holds on the short-circuit too, not just on the SQL path.
    expect(await pagedIds(env, ctx, "&q=" + encodeURIComponent("!!!"))).toEqual([]);
  });
});

describe("#648 the count runs under the SAME access scope as the rows", () => {
  async function boundEnv() {
    const token = "bound-read-token";
    const registry = { [await sha256Hex(token)]: { from: ME, scopes: ["read"] } };
    const { env, ctx } = realEnv({ POSTERN_SEND_IDENTITIES: JSON.stringify(registry) });
    return { env, ctx, token };
  }

  it("an identity-scoped token is counted its OWN slice, not the estate", async () => {
    const { env, ctx, token } = await boundEnv();
    await seed(env, ctx);

    const rows = await pagedIds(env, ctx, "", token);
    const counted = await total(env, ctx, "", token);

    // Agreement under the bound token: the number is reachable by paging as that token.
    expect(counted).toBe(rows.length);
    // And it is the SLICE, not the table. Three of the five seeded rows are ME's.
    expect(counted).toBe(3);
  });

  it("DISCRIMINATOR: the estate token counts MORE than the scoped token, on one store", async () => {
    // This is the arm that proves scope is applied rather than merely declared. If the
    // count ignored scope, both numbers would be 5 and every assertion above would still
    // pass, because 5 would also be the estate row count.
    const { env, ctx, token } = await boundEnv();
    await seed(env, ctx);

    const scoped = await total(env, ctx, "", token);
    const estate = await total(env, ctx, "", ESTATE_TOKEN);

    expect(estate).toBe(5);
    expect(scoped).toBe(3);
    expect(scoped).toBeLessThan(estate);
  });

  it("a scoped caller cannot widen the count with to=, any more than it can widen a read", async () => {
    const { env, ctx, token } = await boundEnv();
    await seed(env, ctx);

    // Naming someone else's address must not count their mail. The row predicate forces
    // the viewer to the bound identity (#544), and the count shares that predicate.
    const counted = await total(env, ctx, `&to=${OTHER}`, token);
    const rows = await pagedIds(env, ctx, `&to=${OTHER}`, token);

    expect(counted).toBe(rows.length);
    expect(counted).toBe(0);
  });

  it("the count response states the scope it was answered under", async () => {
    const { env, ctx, token } = await boundEnv();
    await seed(env, ctx);

    const bound = (await (
      await handleApi(get("/api/messages?countOnly=1", token), env, ctx)
    ).json()) as Record<string, unknown>;
    const estate = (await (
      await handleApi(get("/api/messages?countOnly=1"), env, ctx)
    ).json()) as Record<string, unknown>;

    // A bare "0" means a different thing under each, so the number alone is not an answer.
    expect(bound.identityScope).toEqual({ kind: "member", addresses: [ME] });
    expect(estate.identityScope).toEqual({ kind: "estate" });
  });
});

describe("#648 the count response is a count, and the row path is untouched", () => {
  it("carries no items and no cursor, because both describe a page", async () => {
    const { env, ctx } = realEnv();
    await seed(env, ctx);

    const body = (await (
      await handleApi(get("/api/messages?countOnly=1"), env, ctx)
    ).json()) as Record<string, unknown>;

    expect(body.ok).toBe(true);
    expect(body.total).toBe(5);
    expect(body).not.toHaveProperty("items");
    expect(body).not.toHaveProperty("cursor");
  });

  it("CONTROL: countOnly=0 and an absent countOnly return the ordinary page, byte for byte", async () => {
    // The refactor behind this change put the row predicate and the count predicate in one
    // builder, so the ordinary read is the thing most at risk. Compared as whole bodies,
    // not just as id sets.
    const { env, ctx } = realEnv();
    await seed(env, ctx);

    const plain = await (await handleApi(get("/api/messages"), env, ctx)).text();
    const explicitlyOff = await (await handleApi(get("/api/messages?countOnly=0"), env, ctx)).text();
    const falseOff = await (await handleApi(get("/api/messages?countOnly=false"), env, ctx)).text();

    expect(JSON.parse(plain).items.length).toBe(5);
    expect(explicitlyOff).toBe(plain);
    expect(falseOff).toBe(plain);
  });

  it("refuses a bogus value rather than reading it as off", async () => {
    const { env, ctx } = realEnv();
    await seed(env, ctx);

    for (const bad of ["maybe", "yes", "2", ""]) {
      const res = await handleApi(get(`/api/messages?countOnly=${encodeURIComponent(bad)}`), env, ctx);
      expect(res.status, `countOnly=${bad} should be refused`).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });
    }
  });

  it("refuses limit, cursor and fields alongside it, naming the one that clashed", async () => {
    const { env, ctx } = realEnv();
    await seed(env, ctx);

    for (const clash of ["limit=10", "cursor=abc", "fields=uid"]) {
      const res = await handleApi(get(`/api/messages?countOnly=1&${clash}`), env, ctx);
      expect(res.status, `countOnly with ${clash} should be refused`).toBe(400);
      const body = (await res.json()) as { message?: string };
      // Named, so the caller can fix the request without guessing which half was wrong.
      expect(body.message).toContain(clash.split("=")[0]);
    }
  });

  it("CONTROL: each of those three is still accepted on its own", async () => {
    // Otherwise the refusals above could be passing because the parameter is broken
    // generally, rather than because it clashes with countOnly.
    const { env, ctx } = realEnv();
    await seed(env, ctx);

    for (const solo of ["limit=2", "fields=uid"]) {
      const res = await handleApi(get(`/api/messages?${solo}`), env, ctx);
      expect(res.status, `${solo} alone should still be 200`).toBe(200);
    }
  });
});

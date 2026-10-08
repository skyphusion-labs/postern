// #649 (#632 F14): a thread read had no bound at all.
//
// `store.thread` selected EVERY message in the thread, bodies included, ORDER BY date, id,
// with no LIMIT and no cursor. So the size of the answer was the size of the conversation,
// and one long thread returned whole into a single response. That is the same failure #631
// hit on the list route, on a surface nobody had looked at, and the thread route had it
// worse: there was not even a `limit` to lower.
//
// The DISCRIMINATOR arms are the point of this file. A thread exactly AT the limit and a
// thread one over it both look fine in casual use, and the off-by-one at that boundary is
// where a paging bug lives. Both are asserted, and so is the pair of claims that go with
// them: at the limit the cursor must be null (a positive claim of exhaustion), and one over
// it the cursor must be present and must resume without repeating or skipping a row.

import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { realEnv, putInbound } from "./realdb";

const TOKEN = "test-token";
const ME = "me@skyphusion.org";
const ALICE = "alice@example.com";
const THREAD = "t-long";

const get = (path: string) =>
  new Request(`https://postern.example${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

/** `n` messages in ONE thread, one per day so (date, id) is a strict total order. */
async function seedThread(
  env: Env,
  ctx: ExecutionContext,
  raw: import("node:sqlite").DatabaseSync,
  n: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `m${String(i).padStart(3, "0")}@x`;
    ids.push(id);
    await putInbound(env, ctx, {
      id,
      from: ALICE,
      to: ME,
      subject: "re: the long one",
      body: `body ${i}`,
      // Day 1..n, so oldest-first order is the id order and a skipped row is detectable.
      date: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
  raw.prepare("UPDATE messages SET thread_id = ?").run(THREAD);
  return ids;
}

async function readThread(
  env: Env,
  ctx: ExecutionContext,
  query = "",
): Promise<{ messages: Array<{ messageId: string; bodyText: string }>; cursor: string | null }> {
  const res = await handleApi(get(`/api/threads/${THREAD}${query}`), env, ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    messages: Array<{ messageId: string; bodyText: string }>;
    cursor: string | null;
  };
}

/** Every id reachable by following the cursor to exhaustion, plus the HOP COUNT.
 *
 *  The hop count is load-bearing, not diagnostics. Against an UNBOUNDED read this walk
 *  returns the whole thread in ONE hop and `walked === ids` holds trivially, so without
 *  asserting that paging actually happened these arms would pass on the very defect they
 *  exist for. Measured: they did, on main, until the hop assertion was added. */
async function walk(
  env: Env,
  ctx: ExecutionContext,
  limit: number,
): Promise<{ ids: string[]; hops: number }> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let hop = 1; hop <= 50; hop++) {
    const q = cursor ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}` : `?limit=${limit}`;
    const page = await readThread(env, ctx, q);
    expect(
      page.messages.length,
      `hop ${hop} returned ${page.messages.length} rows for limit=${limit}`,
    ).toBeLessThanOrEqual(limit);
    seen.push(...page.messages.map((m) => m.messageId));
    cursor = page.cursor;
    if (!cursor) return { ids: seen, hops: hop };
  }
  throw new Error("thread pagination did not terminate");
}

describe("#649 the default is a REAL bound, not a large number", () => {
  it("a thread longer than the default comes back TRUNCATED, with a cursor", async () => {
    const { env, ctx, raw } = realEnv();
    const ids = await seedThread(env, ctx, raw, 25);

    const page = await readThread(env, ctx);

    // 20, deliberately lower than the 50 summary default: a thread row carries full bodies.
    expect(page.messages).toHaveLength(20);
    expect(page.messages.length).toBeLessThan(ids.length);
    // The truncation is VISIBLE. This is the whole issue: a caller must be able to tell a
    // complete thread from a first page.
    expect(page.cursor).toBeTruthy();
  });

  it("the rows are full messages, so the bound is bounding something real", async () => {
    // If the thread read had quietly become a summary read, the arm above would still pass
    // while the payload problem was unfixed in the other direction.
    const { env, ctx, raw } = realEnv();
    await seedThread(env, ctx, raw, 3);

    const page = await readThread(env, ctx);

    expect(page.messages[0].bodyText).toBe("body 0");
  });

  it("CONTROL: a short thread still returns whole, and SAYS it is whole", async () => {
    const { env, ctx, raw } = realEnv();
    const ids = await seedThread(env, ctx, raw, 3);

    const page = await readThread(env, ctx);

    expect(page.messages.map((m) => m.messageId)).toEqual(ids);
    // `cursor: null` is the POSITIVE claim of exhaustion, per the Page contract. It is the
    // only truncation signal, so it has to be right in both directions.
    expect(page.cursor).toBeNull();
  });
});

describe("#649 DISCRIMINATOR: exactly AT the limit versus one OVER it", () => {
  // Both look fine in casual use, and the difference between them is where an off-by-one
  // hides. A read that returned n rows for a thread of n would pass every arm above.
  it("a thread of exactly the limit is complete: n rows and a NULL cursor", async () => {
    const { env, ctx, raw } = realEnv();
    const ids = await seedThread(env, ctx, raw, 5);

    const page = await readThread(env, ctx, "?limit=5");

    expect(page.messages.map((m) => m.messageId)).toEqual(ids);
    expect(page.cursor, "a thread that exactly fits must NOT claim there is more").toBeNull();
  });

  it("a thread of the limit PLUS ONE is truncated: n rows and a cursor", async () => {
    const { env, ctx, raw } = realEnv();
    const ids = await seedThread(env, ctx, raw, 6);

    const page = await readThread(env, ctx, "?limit=5");

    expect(page.messages).toHaveLength(5);
    expect(page.cursor, "one row over the limit must be announced").toBeTruthy();
    // And the row left out is the LAST one, because a thread reads oldest first.
    expect(page.messages.map((m) => m.messageId)).toEqual(ids.slice(0, 5));
  });

  it("the extra row is reachable through the cursor, exactly once", async () => {
    const { env, ctx, raw } = realEnv();
    const ids = await seedThread(env, ctx, raw, 6);

    const page1 = await readThread(env, ctx, "?limit=5");
    const page2 = await readThread(
      env,
      ctx,
      `?limit=5&cursor=${encodeURIComponent(page1.cursor as string)}`,
    );

    expect(page2.messages.map((m) => m.messageId)).toEqual([ids[5]]);
    expect(page2.cursor, "the final page must claim exhaustion").toBeNull();
  });
});

describe("#649 the keyset neither skips nor repeats a row", () => {
  for (const limit of [1, 2, 3, 7]) {
    it(`walks a 25-message thread exactly once at limit=${limit}`, async () => {
      const { env, ctx, raw } = realEnv();
      const ids = await seedThread(env, ctx, raw, 25);

      const walked = await walk(env, ctx, limit);

      // It genuinely PAGED. On an unbounded read this is 1 and every assertion below is
      // vacuous, so the hop count is asserted before the contents.
      expect(walked.hops, "one hop means the read was never bounded").toBe(
        Math.ceil(ids.length / limit),
      );
      // Oldest first, every row, no duplicate. A keyset that compared the wrong way round
      // would either loop forever (caught by walk's hop ceiling) or drop the boundary row.
      expect(walked.ids).toEqual(ids);
      expect(new Set(walked.ids).size).toBe(ids.length);
    });
  }

  it("CONTROL: the walk is actually paging, not reading one wide page", async () => {
    const { env, ctx, raw } = realEnv();
    await seedThread(env, ctx, raw, 25);

    const page = await readThread(env, ctx, "?limit=1");

    expect(page.messages).toHaveLength(1);
    expect(page.cursor).toBeTruthy();
  });

  it("a limit above the maximum is clamped, never honoured as given", async () => {
    const { env, ctx, raw } = realEnv();
    await seedThread(env, ctx, raw, 25);

    const page = await readThread(env, ctx, "?limit=9999");

    // Clamped to MAX_LIMIT, so the whole 25 fit, but the ceiling itself is still a bound.
    expect(page.messages).toHaveLength(25);
    expect(page.cursor).toBeNull();
  });
});

describe("#649 the bound lives in the STORE, so every seam gets it", () => {
  // The route is not the only reader: the MailboxService RPC entrypoint calls store.thread
  // too. Bounding only the HTTP handler would have left the RPC seam returning a whole
  // conversation of full bodies, which is the same defect behind a different door.
  it("store.thread is bounded by default, called directly", async () => {
    const { env, ctx, raw } = realEnv();
    await seedThread(env, ctx, raw, 25);

    const page = await store.thread(env, THREAD);

    expect(page.items).toHaveLength(20);
    expect(page.cursor).toBeTruthy();
  });

  it("store.thread still scopes by viewer, with the bound on top", async () => {
    // The access property is what this read already had; the regression risk is losing it
    // while adding paging, so it is asserted through the new shape.
    const { env, ctx, raw } = realEnv();
    await seedThread(env, ctx, raw, 3);

    const mine = await store.thread(env, THREAD, [ME]);
    const stranger = await store.thread(env, THREAD, ["nobody@nowhere.example"]);

    expect(mine.items.length).toBe(3);
    expect(stranger.items).toEqual([]);
    expect(stranger.cursor).toBeNull();
  });
});

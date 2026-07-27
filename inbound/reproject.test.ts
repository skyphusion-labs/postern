import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { PROJECTION_VERSION } from "./src/rfc822Project";
import { makeFakeEnv } from "./fakes";

// #507: after a PROJECTION_VERSION bump every cached projected_size is stale, and the
// IMAP door only trusts a cached size whose stored version matches its renderer. These
// tests pin the sweep that refills them: the STALE row is the case that matters, so
// each one first forces a row into the pre-bump state and proves the sweep notices.

async function put(
  env: Env,
  ctx: ExecutionContext,
  settle: () => Promise<unknown[]>,
  m: { id: string; date: string; text?: string },
) {
  await store.put(
    env,
    {
      messageId: m.id,
      direction: "inbound",
      from: "sender@example.com",
      to: "conrad@skyphusion.org",
      subject: "subject",
      date: m.date,
      bodyText: m.text ?? "line one\nline two",
      auth: { spf: "none", dkim: "none", dmarc: "none" },
      trusted: true,
    },
    ctx,
  );
  await settle();
}

/** Force a row back to the pre-#507 state: an old version and a wrong size. */
async function makeStale(env: Env, messageId: string, size = 1) {
  await env.DB.prepare(
    "UPDATE messages SET projected_size = ?, projection_version = ? WHERE message_id = ?",
  )
    .bind(size, PROJECTION_VERSION - 1, messageId)
    .run();
}

async function readRow(env: Env, messageId: string) {
  return await env.DB.prepare(
    "SELECT projected_size, projection_version FROM messages WHERE message_id = ?",
  )
    .bind(messageId)
    .first<{ projected_size: number | null; projection_version: number | null }>();
}

describe("reproject sweep (#507)", () => {
  it("refills a stale row and reports it as updated", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await put(env, ctx, settle, { id: "r1@x", date: "2026-01-01T00:00:00.000Z" });
    await makeStale(env, "r1@x");

    // CONTROL: the row really is stale before the sweep, so "updated" below cannot be
    // a sweep that rewrote a row which was already correct.
    const before = await readRow(env, "r1@x");
    expect(before?.projection_version).toBe(PROJECTION_VERSION - 1);
    expect(before?.projected_size).toBe(1);

    const res = await store.reprojectPage(env, {});
    expect(res.updated).toBe(1);
    expect(res.unchanged).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.missing).toBe(0);
    expect(res.done).toBe(true);
    expect(res.total).toBe(1);

    const after = await readRow(env, "r1@x");
    expect(after?.projection_version).toBe(PROJECTION_VERSION);
    expect(after?.projected_size).toBe(await store.projectedSizeFor(env, "r1@x"));
    expect(after?.projected_size).not.toBe(1);
  });

  it("dry run reports exactly what would change and writes NOTHING", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await put(env, ctx, settle, { id: "d1@x", date: "2026-02-01T00:00:00.000Z" });
    await makeStale(env, "d1@x");

    const res = await store.reprojectPage(env, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.updated).toBe(1);

    // The store is untouched: same stale size, same stale version.
    const after = await readRow(env, "d1@x");
    expect(after?.projected_size).toBe(1);
    expect(after?.projection_version).toBe(PROJECTION_VERSION - 1);
  });

  it("is idempotent: a second pass finds nothing left to do", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await put(env, ctx, settle, { id: "i1@x", date: "2026-03-01T00:00:00.000Z" });
    await makeStale(env, "i1@x");

    const first = await store.reprojectPage(env, {});
    expect(first.updated).toBe(1);

    const second = await store.reprojectPage(env, {});
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.failed).toBe(0);
  });

  it("a freshly stored row needs no work (live ingest already projects at the current version)", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await put(env, ctx, settle, { id: "f1@x", date: "2026-04-01T00:00:00.000Z" });
    const res = await store.reprojectPage(env, {});
    expect(res.unchanged).toBe(1);
    expect(res.updated).toBe(0);
  });

  it("pages with a cursor and covers every row exactly once", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    for (let i = 0; i < 5; i++) {
      await put(env, ctx, settle, { id: `p${i}@x`, date: `2026-05-0${i + 1}T00:00:00.000Z` });
      await makeStale(env, `p${i}@x`);
    }

    let cursor: string | undefined;
    let pages = 0;
    let updated = 0;
    let processed = 0;
    for (;;) {
      const res: store.ReprojectResult = await store.reprojectPage(env, { cursor, limit: 2 });
      pages++;
      updated += res.updated;
      processed += res.processed;
      if (res.done) break;
      // The runner MUST follow nextCursor. A runner that read a differently named
      // field would silently stop after the first page (the trap #483 hit), so the
      // page count below is asserted, not just the total.
      expect(res.nextCursor).toBeTruthy();
      cursor = res.nextCursor as string;
      expect(pages).toBeLessThan(10); // no runaway
    }
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(processed).toBe(5);
    expect(updated).toBe(5);

    for (let i = 0; i < 5; i++) {
      const row = await readRow(env, `p${i}@x`);
      expect(row?.projection_version).toBe(PROJECTION_VERSION);
    }
  });

  it("only the first call carries the total, so a runner cannot double-count", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    for (let i = 0; i < 3; i++) {
      await put(env, ctx, settle, { id: `t${i}@x`, date: `2026-06-0${i + 1}T00:00:00.000Z` });
    }
    const first = await store.reprojectPage(env, { limit: 2 });
    expect(first.total).toBe(3);
    const second = await store.reprojectPage(env, { limit: 2, cursor: first.nextCursor as string });
    expect(second.total).toBeUndefined();
  });

  it("rewrites a row whose SIZE is already right but whose VERSION is stale", async () => {
    // The door trusts a cached size only when the stored projection_version matches its
    // renderer, so a row carrying the correct number under an old version is still a
    // permanent cache MISS and still has to be rewritten. Without this case the sweep
    // could drop its version check entirely and every other gate would stay green
    // (verified by mutation: it did).
    const { env, ctx, settle } = makeFakeEnv();
    await put(env, ctx, settle, { id: "v1@x", date: "2026-08-01T00:00:00.000Z" });
    const correct = await store.projectedSizeFor(env, "v1@x");
    await makeStale(env, "v1@x", correct as number);

    // CONTROL: the size really is already correct, so an "updated" below can only be
    // about the version.
    const before = await readRow(env, "v1@x");
    expect(before?.projected_size).toBe(correct);
    expect(before?.projection_version).toBe(PROJECTION_VERSION - 1);

    const res = await store.reprojectPage(env, {});
    expect(res.updated).toBe(1);
    expect(res.unchanged).toBe(0);

    const after = await readRow(env, "v1@x");
    expect(after?.projection_version).toBe(PROJECTION_VERSION);
    expect(after?.projected_size).toBe(correct);
  });

  it("reports a row as FAILED when the write does not survive the read-back", async () => {
    // The read-back exists so a write that silently did not land is reported instead of
    // counted as success. Without a case where the write is dropped, the verification
    // could be deleted and every other gate would stay green (verified by mutation: it
    // did). Here the UPDATE for one message is swallowed at the D1 seam.
    const { env, ctx, settle } = makeFakeEnv();
    await put(env, ctx, settle, { id: "x1@x", date: "2026-09-01T00:00:00.000Z" });
    await makeStale(env, "x1@x");

    const realPrepare = env.DB.prepare.bind(env.DB);
    let swallowed = 0;
    (env.DB as { prepare: typeof realPrepare }).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (/UPDATE messages SET projected_size/i.test(sql)) {
        return {
          ...stmt,
          bind: (...a: unknown[]) => {
            void stmt.bind(...a);
            return { run: async () => { swallowed++; return { meta: { changes: 0 } }; } };
          },
        } as typeof stmt;
      }
      return stmt;
    };

    const res = await store.reprojectPage(env, {});
    // CONTROL: the write really was attempted and really was dropped.
    expect(swallowed).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.updated).toBe(0);
    const after = await readRow(env, "x1@x");
    expect(after?.projection_version).toBe(PROJECTION_VERSION - 1);
  });

  it("the written size is the one the SAME projector computes for live ingest", async () => {
    // The whole point of routing the sweep through projectedSizeFor: a backfilled row
    // must be byte-identical to a row stored today. A second projection path here
    // would re-create the #507 class of bug (one number, two producers).
    const { env, ctx, settle } = makeFakeEnv();
    await put(env, ctx, settle, { id: "s1@x", date: "2026-07-01T00:00:00.000Z", text: "a\nb\nc" });
    const live = await readRow(env, "s1@x");
    await makeStale(env, "s1@x");
    await store.reprojectPage(env, {});
    const swept = await readRow(env, "s1@x");
    expect(swept?.projected_size).toBe(live?.projected_size);
    // CONTROL: that agreement is not vacuous -- the live value exists and is real.
    expect(live?.projected_size).toBeGreaterThan(100);
  });
});

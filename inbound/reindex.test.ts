import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { makeFakeEnv } from "./fakes";

// #116 ws4: backfill / re-embed the existing mailbox. These tests pin the page
// orchestration -- gate mirroring, dry-run-counts-not-embeds, paging/resume, and
// idempotent (deterministic-id) re-runs -- against the in-memory fake store.

async function put(
  env: Env,
  ctx: ExecutionContext,
  settle: () => Promise<unknown[]>,
  m: { id: string; direction: "inbound" | "outbound"; to: string; text: string; date: string },
) {
  await store.put(
    env,
    {
      messageId: m.id,
      direction: m.direction,
      from: "sender@example.com",
      to: m.to,
      subject: "subject",
      date: m.date,
      bodyText: m.text,
      auth: { spf: "none", dkim: "none", dmarc: "none" },
      trusted: true,
      vectorize: false, // seed as UN-indexed (pre-index history) so the backfill does the work
    },
    ctx,
  );
  await settle();
}

type Vec = { metadata?: { message_id?: string; direction?: string } };
function indexedIds(vectors: unknown[]): Set<string> {
  return new Set((vectors as Vec[]).map((v) => v.metadata?.message_id).filter(Boolean) as string[]);
}

describe("reindex backfill (#116 ws4)", () => {
  it("indexes every message in one page (no allowlist) and reports totals", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    for (let i = 0; i < 5; i++) {
      await put(env, ctx, settle, { id: `m${i}@x`, direction: i % 2 ? "outbound" : "inbound", to: "conrad@skyphusion.org", text: "deploy release green invoice payment", date: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    expect(vectors.length).toBe(0); // seeded un-indexed

    const res = await store.reindexPage(env, {});
    expect(res.total).toBe(5); // first call (no cursor) carries the total
    expect(res.processed).toBe(5);
    expect(res.indexed).toBe(5);
    expect(res.vectors).toBe(5); // one short-body chunk each
    expect(res.skippedByGate).toBe(0);
    expect(res.done).toBe(true);
    expect(res.nextCursor).toBeNull();
    expect(indexedIds(vectors).size).toBe(5);
  });

  it("dry run counts the chunks WITHOUT embedding", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    for (let i = 0; i < 3; i++) {
      await put(env, ctx, settle, { id: `d${i}@x`, direction: "inbound", to: "conrad@skyphusion.org", text: "money billing invoice", date: `2026-02-0${i + 1}T00:00:00.000Z` });
    }
    const res = await store.reindexPage(env, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.total).toBe(3);
    expect(res.vectors).toBe(3); // the planned count
    expect(res.indexed).toBe(0); // nothing embedded
    expect(vectors.length).toBe(0); // and the index is untouched
  });

  it("mirrors the VECTORIZE_FOR gate: inbound off-allowlist is skipped, outbound always indexed", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "keep@skyphusion.org" });
    await put(env, ctx, settle, { id: "keep@x", direction: "inbound", to: "keep@skyphusion.org", text: "release deploy", date: "2026-03-01T00:00:00.000Z" });
    await put(env, ctx, settle, { id: "drop@x", direction: "inbound", to: "other@skyphusion.org", text: "release deploy", date: "2026-03-02T00:00:00.000Z" });
    await put(env, ctx, settle, { id: "out@x", direction: "outbound", to: "anyone@example.com", text: "release deploy", date: "2026-03-03T00:00:00.000Z" });

    const res = await store.reindexPage(env, {});
    expect(res.skippedByGate).toBe(1); // the off-allowlist inbound
    expect(res.indexed).toBe(2);
    const ids = indexedIds(vectors);
    expect(ids.has("keep@x")).toBe(true); // allowlisted inbound
    expect(ids.has("out@x")).toBe(true); // outbound always
    expect(ids.has("drop@x")).toBe(false); // skipped
  });

  it("pages with a cursor and covers every message exactly once on resume", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    for (let i = 0; i < 5; i++) {
      await put(env, ctx, settle, { id: `p${i}@x`, direction: "inbound", to: "conrad@skyphusion.org", text: "tacos lunch food", date: `2026-04-0${i + 1}T00:00:00.000Z` });
    }
    let cursor: string | undefined;
    let pages = 0;
    let processed = 0;
    for (;;) {
      const res: store.ReindexResult = await store.reindexPage(env, { cursor, limit: 2 });
      pages++;
      processed += res.processed;
      if (res.done) break;
      cursor = res.nextCursor ?? undefined;
      if (pages > 10) throw new Error("paging did not terminate");
    }
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(processed).toBe(5);
    expect(indexedIds(vectors).size).toBe(5); // every message indexed, none missed
  });

  it("is idempotent: a re-run produces the SAME deterministic vector ids (overwrite, not duplicate)", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    for (let i = 0; i < 2; i++) {
      await put(env, ctx, settle, { id: `id${i}@x`, direction: "inbound", to: "conrad@skyphusion.org", text: "render gpu video", date: `2026-05-0${i + 1}T00:00:00.000Z` });
    }
    await store.reindexPage(env, {});
    const firstIds = new Set((vectors as { id: string }[]).map((v) => v.id));
    await store.reindexPage(env, {});
    const secondIds = new Set((vectors as { id: string }[]).map((v) => v.id));
    // Same id set across runs => real Vectorize overwrites in place (no orphan vectors).
    expect([...secondIds].sort()).toEqual([...firstIds].sort());
  });
});

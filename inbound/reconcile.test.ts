import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { makeFakeEnv } from "./fakes";
import { sha256hex } from "./src/ingest";

// #134: reconcile / orphan-vector audit. These tests pin the read-only audit -- the
// expected-id scheme matching embedAndUpsert, the exact orphan count from
// describe()-minus-present, the (a) vs (b) cause classification, under-coverage
// detection, and the HARD invariant that reconcile NEVER deletes -- against the
// in-memory fake store + index.

async function seed(
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
      // Mirror the live ingest path: ingest.ts applies the SAME gate before store.put,
      // so the fake index reflects exactly what real ingest would have indexed.
      vectorize: store.shouldVectorize(store.vectorizeAllowlist(env), m.direction, store.parseRecipients(m.to)),
    },
    ctx,
  );
  await settle();
}

// sha256hex(messageId)[:56] + "." + chunk -- the SAME scheme embedAndUpsert uses,
// via the project's own sha256hex so the test derives ids identically to the code.
async function vid(messageId: string, chunk: number): Promise<string> {
  return `${(await sha256hex(messageId)).slice(0, 56)}.${chunk}`;
}

describe("reconcile orphan-vector audit (#134)", () => {
  it("reports zero orphans for a clean index (live == expected)", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "" });
    for (let i = 0; i < 4; i++) {
      await seed(env, ctx, settle, { id: `c${i}@x`, direction: "inbound", to: "conrad@skyphusion.org", text: "deploy release invoice", date: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    const r = await store.reconcile(env, {});
    expect(r.messages).toBe(4);
    expect(r.gatedMessages).toBe(4);
    expect(r.expectedVectors).toBe(4); // one short-body chunk each
    expect(r.liveVectorCount).toBe(4);
    expect(r.presentExpected).toBe(4);
    expect(r.missingExpected).toBe(0);
    expect(r.orphanCount).toBe(0);
    expect(r.enumerable).toBe(false);
  });

  it("expected ids match the embedAndUpsert scheme exactly", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, { id: "scheme@x", direction: "inbound", to: "conrad@skyphusion.org", text: "render gpu video", date: "2026-02-01T00:00:00.000Z" });
    const liveIds = new Set((vectors as { id: string }[]).map((v) => v.id));
    expect(liveIds.has(await vid("scheme@x", 0))).toBe(true);
    // A clean index over this message => zero orphans, proving the recomputed scheme
    // and the live ids agree.
    const r = await store.reconcile(env, {});
    expect(r.orphanCount).toBe(0);
  });

  it("counts a deleted-message orphan and classifies it cause (a)", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, { id: "live@x", direction: "inbound", to: "conrad@skyphusion.org", text: "deploy release invoice", date: "2026-03-01T00:00:00.000Z" });
    // Orphan: a vector whose message_id is NOT in D1 (the message was deleted). Reuse
    // the live vector's values so it surfaces as a near neighbour under sampling.
    const liveVec = (vectors as { id: string; values: number[] }[])[0];
    await env.VECTORIZE.upsert([
      { id: await vid("ghost@x", 0), values: liveVec.values, metadata: { message_id: "ghost@x", chunk: 0 } },
    ]);

    const r = await store.reconcile(env, { includeOrphanIds: true });
    expect(r.liveVectorCount).toBe(2);
    expect(r.expectedVectors).toBe(1);
    expect(r.presentExpected).toBe(1);
    expect(r.orphanCount).toBe(1);
    expect(r.sample.distinctOrphans).toBe(1);
    expect(r.sample.causeA).toBe(1);
    expect(r.sample.causeB).toBe(0);
    expect(r.causeDetermination).toBe("a");
    expect(r.sample.orphanIds).toContain(await vid("ghost@x", 0));
  });

  it("classifies a pre-#116 id-scheme orphan as cause (b) (message still live)", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, { id: "stays@x", direction: "inbound", to: "conrad@skyphusion.org", text: "render gpu video", date: "2026-04-01T00:00:00.000Z" });
    // Orphan under an OLD id scheme (id is NOT base.chunk) but metadata.message_id is
    // the STILL-LIVE message -- exactly cause (b).
    const liveVec = (vectors as { id: string; values: number[] }[])[0];
    await env.VECTORIZE.upsert([
      { id: "legacyid-stays-0", values: liveVec.values, metadata: { message_id: "stays@x", chunk: 0 } },
    ]);

    const r = await store.reconcile(env, { includeOrphanIds: true });
    expect(r.orphanCount).toBe(1);
    expect(r.sample.causeA).toBe(0);
    expect(r.sample.causeB).toBe(1);
    expect(r.causeDetermination).toBe("b");
    expect(r.sample.orphanIds).toContain("legacyid-stays-0");
  });

  it("reports MIXED when both deleted (a) and old-scheme (b) orphans exist", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, { id: "anchor@x", direction: "inbound", to: "conrad@skyphusion.org", text: "deploy release invoice payment", date: "2026-05-01T00:00:00.000Z" });
    const liveVec = (vectors as { id: string; values: number[] }[])[0];
    await env.VECTORIZE.upsert([
      { id: await vid("gone@x", 0), values: liveVec.values, metadata: { message_id: "gone@x", chunk: 0 } }, // (a)
      { id: "legacy-anchor-0", values: liveVec.values, metadata: { message_id: "anchor@x", chunk: 0 } }, // (b)
    ]);

    const r = await store.reconcile(env, {});
    expect(r.orphanCount).toBe(2);
    expect(r.sample.causeA).toBe(1);
    expect(r.sample.causeB).toBe(1);
    expect(r.causeDetermination).toBe("mixed");
  });

  it("detects UNDER-coverage: an expected vector missing from the index", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, { id: "have@x", direction: "inbound", to: "conrad@skyphusion.org", text: "deploy release", date: "2026-06-01T00:00:00.000Z" });
    await seed(env, ctx, settle, { id: "missing@x", direction: "inbound", to: "conrad@skyphusion.org", text: "deploy release", date: "2026-06-02T00:00:00.000Z" });
    // Drop missing@x's vector from the index to simulate an embed that never landed.
    const drop = await vid("missing@x", 0);
    const arr = vectors as { id: string }[];
    const idx = arr.findIndex((v) => v.id === drop);
    arr.splice(idx, 1);

    const r = await store.reconcile(env, {});
    expect(r.expectedVectors).toBe(2);
    expect(r.liveVectorCount).toBe(1);
    expect(r.presentExpected).toBe(1);
    expect(r.missingExpected).toBe(1);
    expect(r.missingExpectedSample).toContain(drop);
    expect(r.orphanCount).toBe(0); // under-coverage is NOT an orphan
  });

  it("is READ-ONLY: the index is byte-identical before and after a reconcile", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await seed(env, ctx, settle, { id: "ro@x", direction: "inbound", to: "conrad@skyphusion.org", text: "deploy release invoice", date: "2026-07-01T00:00:00.000Z" });
    await env.VECTORIZE.upsert([
      { id: await vid("dead@x", 0), values: (vectors as { values: number[] }[])[0].values, metadata: { message_id: "dead@x", chunk: 0 } },
    ]);
    const before = (vectors as { id: string }[]).map((v) => v.id).sort();
    await store.reconcile(env, { includeOrphanIds: true });
    const after = (vectors as { id: string }[]).map((v) => v.id).sort();
    expect(after).toEqual(before); // reconcile deleted nothing
  });

  it("honours the VECTORIZE_FOR gate when computing expected vectors", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "keep@skyphusion.org" });
    // Only outbound + allowlisted inbound are indexed on ingest, so the expected set
    // must mirror that gate or it would mis-count gated-out mail as orphans.
    await seed(env, ctx, settle, { id: "keep@x", direction: "inbound", to: "keep@skyphusion.org", text: "deploy release", date: "2026-08-01T00:00:00.000Z" });
    await seed(env, ctx, settle, { id: "drop@x", direction: "inbound", to: "other@skyphusion.org", text: "deploy release", date: "2026-08-02T00:00:00.000Z" });
    await seed(env, ctx, settle, { id: "out@x", direction: "outbound", to: "anyone@example.com", text: "deploy release", date: "2026-08-03T00:00:00.000Z" });

    const r = await store.reconcile(env, {});
    expect(r.messages).toBe(3);
    expect(r.gatedMessages).toBe(2); // keep + out (drop is gated out)
    expect(r.expectedVectors).toBe(2);
    expect(r.liveVectorCount).toBe(2); // ingest applied the same gate
    expect(r.orphanCount).toBe(0);
  });
});

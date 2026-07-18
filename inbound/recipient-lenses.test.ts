// #350: same-domain sends are recipient-honest. Two coupled fixes, tested against a
// REAL SQLite engine (node:sqlite) so the actual SQL -- the effective-seen COALESCE
// subquery, the viewer-relative INBOX predicate, the ON CONFLICT upserts, the seed --
// is validated, not just a hand-rolled fake's interpretation of it. (An earlier
// escaping slip silently corrupted the membership SQL; the fake still "passed" because
// it pattern-matches, not parses. Only the real engine catches that class. This file
// is that engine.) The API-surface tests use the shared fake env (they need tokens).

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// A minimal D1-compatible adapter over a real in-memory SQLite loaded with the
// production schema.sql (messages + FTS triggers + message_seen_by).
function realEnv(): { env: Env; ctx: ExecutionContext; raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const DB = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async all<T>() {
          return { results: stmt.all(...(bound as never[])) as unknown as T[] };
        },
        async first<T>() {
          return (stmt.get(...(bound as never[])) ?? null) as T | null;
        },
        async run() {
          const r = stmt.run(...(bound as never[]));
          return { meta: { changes: Number(r.changes) } };
        },
      };
    },
  };
  const env = { DB, ALLOWED_FROM_DOMAIN: "skyphusion.org" } as unknown as Env;
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  return { env, ctx, raw: db };
}

const AUTH = { spf: "none", dkim: "none", dmarc: "none" };

async function putOutbound(env: Env, ctx: ExecutionContext, o: { id: string; from: string; to: string[]; subject?: string; body?: string; date?: string }) {
  return store.put(
    env,
    {
      messageId: o.id,
      direction: "outbound",
      from: o.from,
      to: o.to.join(", "),
      subject: o.subject ?? "s",
      date: o.date ?? "2026-02-01T00:00:00.000Z",
      bodyText: o.body ?? "body",
      auth: AUTH,
      trusted: true,
      deliveredTo: o.to.map((a) => a.toLowerCase()),
    },
    ctx,
  );
}

async function putInbound(env: Env, ctx: ExecutionContext, o: { id: string; from: string; to: string; subject?: string; body?: string; date?: string }) {
  return store.put(
    env,
    {
      messageId: o.id,
      direction: "inbound",
      from: o.from,
      to: o.to,
      subject: o.subject ?? "s",
      date: o.date ?? "2026-02-02T00:00:00.000Z",
      bodyText: o.body ?? "body",
      auth: AUTH,
      trusted: false,
      deliveredTo: [o.to.toLowerCase()],
    },
    ctx,
  );
}

describe("#350 store lenses (real SQLite)", () => {
  it("seeds a per-recipient unread override for same-domain outbound, except the sender", async () => {
    const { env, ctx, raw } = realEnv();
    await putOutbound(env, ctx, { id: "ab@skyphusion.org", from: "alice@skyphusion.org", to: ["bob@skyphusion.org"] });

    const overrides = raw.prepare("SELECT message_id, recipient, seen FROM message_seen_by ORDER BY recipient").all() as { message_id: string; recipient: string; seen: number }[];
    expect(overrides).toEqual([{ message_id: "ab@skyphusion.org", recipient: "bob@skyphusion.org", seen: 0 }]);
    // messages.seen stays 1 (the sender's Sent view is unchanged).
    expect((await store.get(env, "ab@skyphusion.org"))!.seen).toBe(true);
  });

  it("does NOT seed overrides for external recipients or the sender", async () => {
    const { env, ctx, raw } = realEnv();
    await putOutbound(env, ctx, {
      id: "mix@skyphusion.org",
      from: "alice@skyphusion.org",
      to: ["bob@skyphusion.org", "ext@gmail.com", "alice@skyphusion.org"],
    });
    const recips = (raw.prepare("SELECT recipient FROM message_seen_by ORDER BY recipient").all() as { recipient: string }[]).map((r) => r.recipient);
    expect(recips).toEqual(["bob@skyphusion.org"]); // ext = off-domain, alice = sender
  });

  it("viewer-relative INBOX: a same-domain send surfaces in the recipient's INBOX, unseen", async () => {
    const { env, ctx } = realEnv();
    await putOutbound(env, ctx, { id: "ab@skyphusion.org", from: "alice@skyphusion.org", to: ["bob@skyphusion.org"], subject: "quarterly" });

    const bobInbox = await store.list(env, { to: "bob@skyphusion.org", direction: "inbound" });
    expect(bobInbox.items.map((m) => m.messageId)).toEqual(["ab@skyphusion.org"]);
    expect(bobInbox.items[0].seen).toBe(false); // effective seen from the override
    // B's unseen poll counts it.
    expect(bobInbox.items.filter((m) => !m.seen)).toHaveLength(1);

    // A's INBOX does not (A is not a delivered recipient, and authored it).
    const aliceInbox = await store.list(env, { to: "alice@skyphusion.org", direction: "inbound" });
    expect(aliceInbox.items).toHaveLength(0);
    // A's Sent (sender-based, from=A) still shows it, seen.
    const aliceSent = await store.list(env, { from: "alice@skyphusion.org" });
    expect(aliceSent.items.map((m) => m.messageId)).toEqual(["ab@skyphusion.org"]);
    expect(aliceSent.items[0].seen).toBe(true);
  });

  it("self-send edge: V -> V only stays Sent-only, born seen (not in V's INBOX)", async () => {
    const { env, ctx, raw } = realEnv();
    await putOutbound(env, ctx, { id: "self@skyphusion.org", from: "carol@skyphusion.org", to: ["carol@skyphusion.org"] });
    // No override seeded (recipient == sender).
    expect((raw.prepare("SELECT COUNT(*) n FROM message_seen_by").get() as { n: number }).n).toBe(0);
    // Not in carol's INBOX (outbound authored by carol).
    const inbox = await store.list(env, { to: "carol@skyphusion.org", direction: "inbound" });
    expect(inbox.items).toHaveLength(0);
    // Present in carol's Sent, seen.
    const sent = await store.list(env, { from: "carol@skyphusion.org" });
    expect(sent.items.map((m) => m.messageId)).toEqual(["self@skyphusion.org"]);
    expect(sent.items[0].seen).toBe(true);
  });

  it("scoped setSeen (for=V) flips only V's effective seen, never messages.seen", async () => {
    const { env, ctx } = realEnv();
    await putInbound(env, ctx, { id: "in@skyphusion.org", from: "ext@gmail.com", to: "bob@skyphusion.org" });
    // Inbound lands unread everywhere (messages.seen = 0).
    expect((await store.get(env, "in@skyphusion.org"))!.seen).toBe(false);

    const n = await store.setSeen(env, ["in@skyphusion.org"], true, "bob@skyphusion.org");
    expect(n).toBe(1);
    // B's effective seen is now read.
    const bob = await store.list(env, { to: "bob@skyphusion.org", direction: "inbound" });
    expect(bob.items[0].seen).toBe(true);
    // The row-level (estate) flag is untouched.
    expect((await store.get(env, "in@skyphusion.org"))!.seen).toBe(false);
  });

  it("scoped setSeen skips ids that do not exist (no junk overrides)", async () => {
    const { env, ctx, raw } = realEnv();
    await putInbound(env, ctx, { id: "real@skyphusion.org", from: "ext@gmail.com", to: "bob@skyphusion.org" });
    const n = await store.setSeen(env, ["real@skyphusion.org", "ghost@skyphusion.org"], true, "bob@skyphusion.org");
    expect(n).toBe(1);
    const recips = (raw.prepare("SELECT message_id FROM message_seen_by").all() as { message_id: string }[]).map((r) => r.message_id);
    expect(recips).toEqual(["real@skyphusion.org"]);
  });

  it("unscoped setSeen updates messages.seen AND realigns existing overrides", async () => {
    const { env, ctx, raw } = realEnv();
    await putOutbound(env, ctx, { id: "ab@skyphusion.org", from: "alice@skyphusion.org", to: ["bob@skyphusion.org"] });
    // Override seeded seen=0; messages.seen=1.
    await store.setSeen(env, ["ab@skyphusion.org"], false); // legacy, no `for`
    expect((await store.get(env, "ab@skyphusion.org"))!.seen).toBe(false); // messages.seen flipped
    const ov = raw.prepare("SELECT seen FROM message_seen_by WHERE message_id = ? AND recipient = ?").get("ab@skyphusion.org", "bob@skyphusion.org") as { seen: number };
    expect(ov.seen).toBe(0); // existing override realigned to the same value
  });

  it("effective seen flows through FTS search for a viewer", async () => {
    const { env, ctx } = realEnv();
    await putOutbound(env, ctx, { id: "ab@skyphusion.org", from: "alice@skyphusion.org", to: ["bob@skyphusion.org"], subject: "photosynthesis", body: "photosynthesis notes" });
    let hits = await store.search(env, { q: "photosynthesis", to: "bob@skyphusion.org", mode: "fts" });
    expect(hits.items.map((h) => h.message.messageId)).toEqual(["ab@skyphusion.org"]);
    expect(hits.items[0].message.seen).toBe(false);
    await store.setSeen(env, ["ab@skyphusion.org"], true, "bob@skyphusion.org");
    hits = await store.search(env, { q: "photosynthesis", to: "bob@skyphusion.org", mode: "fts" });
    expect(hits.items[0].message.seen).toBe(true);
  });

  it("unscoped reads are the estate lens, unchanged", async () => {
    const { env, ctx } = realEnv();
    await putOutbound(env, ctx, { id: "ab@skyphusion.org", from: "alice@skyphusion.org", to: ["bob@skyphusion.org"] });
    // No `to`: messages.seen (1 for outbound), and direction=inbound stays the stored fact.
    const all = await store.list(env, {});
    expect(all.items[0].seen).toBe(true);
    const inbound = await store.list(env, { direction: "inbound" });
    expect(inbound.items).toHaveLength(0); // the outbound row is not reinterpreted without a viewer
  });

  it("fc#792 mirror: A -> B same-domain, end to end", async () => {
    const { env, ctx } = realEnv();
    await putOutbound(env, ctx, { id: "fc792@skyphusion.org", from: "alice@skyphusion.org", to: ["bob@skyphusion.org"], subject: "status" });
    // B's lens surfaces it, unseen; B's unseen poll counts it.
    const bob1 = await store.list(env, { to: "bob@skyphusion.org", direction: "inbound" });
    expect(bob1.items.map((m) => m.messageId)).toEqual(["fc792@skyphusion.org"]);
    expect(bob1.items[0].seen).toBe(false);
    // A's Sent still shows it seen.
    expect((await store.list(env, { from: "alice@skyphusion.org" })).items[0].seen).toBe(true);
    // B marks read (for=B): A's row-level state untouched.
    await store.setSeen(env, ["fc792@skyphusion.org"], true, "bob@skyphusion.org");
    expect((await store.list(env, { to: "bob@skyphusion.org", direction: "inbound" })).items[0].seen).toBe(true);
    expect((await store.get(env, "fc792@skyphusion.org"))!.seen).toBe(true); // messages.seen was 1 all along
    // Legacy unscoped mark-read still works.
    await putInbound(env, ctx, { id: "legacy@skyphusion.org", from: "ext@gmail.com", to: "bob@skyphusion.org" });
    expect(await store.setSeen(env, ["legacy@skyphusion.org"], true)).toBe(1);
    expect((await store.get(env, "legacy@skyphusion.org"))!.seen).toBe(true);
  });
});

describe("#350 POST /api/messages/seen `for` (API surface)", () => {
  function post(body: unknown, token = "test-token"): Request {
    return new Request("https://postern.example/api/messages/seen", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  let fake: ReturnType<typeof makeFakeEnv>;
  beforeEach(() => {
    fake = makeFakeEnv();
  });

  it("scopes a mark-read to one recipient via `for`, leaving messages.seen alone", async () => {
    const { env, ctx, settle } = fake;
    await putInbound(env, ctx, { id: "a@skyphusion.org", from: "ext@gmail.com", to: "bob@skyphusion.org" });
    await settle();
    const res = await handleApi(post({ ids: ["a@skyphusion.org"], seen: true, for: "bob@skyphusion.org" }), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 1 });
    // B's effective seen flips; the row-level flag does not.
    expect((await store.list(env, { to: "bob@skyphusion.org", direction: "inbound" })).items[0].seen).toBe(true);
    expect((await store.get(env, "a@skyphusion.org"))!.seen).toBe(false);
  });

  it("rejects a malformed `for` with a 400", async () => {
    const { env, ctx } = fake;
    expect((await handleApi(post({ ids: ["a@skyphusion.org"], seen: true, for: "not-an-email" }), env, ctx)).status).toBe(400);
    expect((await handleApi(post({ ids: ["a@skyphusion.org"], seen: true, for: 123 }), env, ctx)).status).toBe(400);
  });

  it("omitting `for` keeps the legacy estate behavior", async () => {
    const { env, ctx, settle } = fake;
    await putInbound(env, ctx, { id: "a@skyphusion.org", from: "ext@gmail.com", to: "bob@skyphusion.org" });
    await settle();
    const res = await handleApi(post({ ids: ["a@skyphusion.org"], seen: true }), env, ctx);
    expect(res.status).toBe(200);
    expect((await store.get(env, "a@skyphusion.org"))!.seen).toBe(true); // messages.seen flipped
  });
});

// Semantic + hybrid honor to= (viewer scope): the vector index is not recipient-keyed,
// so the score-ranked modes post-filter on delivered-set membership + effective seen.
// These run against the fake env (semantic needs the deterministic embedder + vector
// store). Guards the leak the lead caught: mode=semantic&to=V returning mail never
// delivered to V.
describe("#350 semantic/hybrid viewer scope (fake env)", () => {
  async function seed(env: Env, ctx: ExecutionContext) {
    // Same-domain outbound to bob (seeds a seen=0 override for bob), vectorized.
    await store.put(
      env,
      { messageId: "tb@skyphusion.org", direction: "outbound", from: "alice@skyphusion.org", to: "bob@skyphusion.org", subject: "deploy", date: "2026-03-01T00:00:00.000Z", bodyText: "deploy release notes", auth: AUTH, trusted: true, deliveredTo: ["bob@skyphusion.org"], vectorize: true },
      ctx,
    );
    // Inbound to carol with the SAME vocabulary (a strong vector match), NOT for bob.
    await store.put(
      env,
      { messageId: "tc@skyphusion.org", direction: "inbound", from: "ext@gmail.com", to: "carol@skyphusion.org", subject: "deploy", date: "2026-03-02T00:00:00.000Z", bodyText: "deploy release plan", auth: AUTH, trusted: false, deliveredTo: ["carol@skyphusion.org"], vectorize: true },
      ctx,
    );
  }

  it("mode=semantic&to=V returns only mail delivered to V, with effective seen", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx);
    await settle();

    let res = await store.search(env, { q: "deploy release", mode: "semantic", to: "bob@skyphusion.org" });
    const ids = res.items.map((h) => h.message.messageId);
    expect(ids).toContain("tb@skyphusion.org");
    expect(ids).not.toContain("tc@skyphusion.org"); // never delivered to bob: no leak
    expect(res.items.find((h) => h.message.messageId === "tb@skyphusion.org")!.message.seen).toBe(false);

    await store.setSeen(env, ["tb@skyphusion.org"], true, "bob@skyphusion.org");
    res = await store.search(env, { q: "deploy release", mode: "semantic", to: "bob@skyphusion.org" });
    expect(res.items.find((h) => h.message.messageId === "tb@skyphusion.org")!.message.seen).toBe(true);
  });

  it("mode=hybrid&to=V scopes BOTH the fts and semantic legs", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx);
    await settle();
    const res = await store.search(env, { q: "deploy release", mode: "hybrid", to: "bob@skyphusion.org" });
    const ids = res.items.map((h) => h.message.messageId);
    expect(ids).toContain("tb@skyphusion.org");
    expect(ids).not.toContain("tc@skyphusion.org");
  });

  it("without to=, semantic is the estate lens (both surface)", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx);
    await settle();
    const res = await store.search(env, { q: "deploy release", mode: "semantic" });
    const ids = res.items.map((h) => h.message.messageId);
    expect(ids).toContain("tb@skyphusion.org");
    expect(ids).toContain("tc@skyphusion.org");
  });
});

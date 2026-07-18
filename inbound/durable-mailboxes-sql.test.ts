import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import * as store from "./src/store";

function realEnv(): { env: Env; ctx: ExecutionContext; raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

  function prepare(sql: string) {
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
        const result = stmt.run(...(bound as never[]));
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }

  const DB = {
    prepare,
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    env: { DB, ALLOWED_FROM_DOMAIN: "skyphusion.org" } as unknown as Env,
    ctx: { waitUntil() {} } as unknown as ExecutionContext,
    raw: db,
  };
}

async function seed(env: Env, ctx: ExecutionContext, id: string, to: string) {
  await store.put(env, {
    messageId: id,
    direction: "inbound",
    from: "sender@example.com",
    to,
    deliveredTo: [to],
    subject: "subject",
    date: "2026-07-18T00:00:00.000Z",
    bodyText: "body",
    auth: { spf: "none", dkim: "none", dmarc: "none" },
    trusted: false,
  }, ctx);
}

describe("durable mailbox production SQL (#352)", () => {
  it("keeps bound-session list and search reads inside the account boundary", async () => {
    const { env, ctx } = realEnv();
    await seed(env, ctx, "mine-in@example.com", "conrad@skyphusion.org");
    await seed(env, ctx, "other-in@example.com", "other@skyphusion.org");
    await store.put(env, {
      messageId: "mine-out@example.com",
      direction: "outbound",
      from: "conrad@skyphusion.org",
      to: "external@example.com",
      deliveredTo: ["external@example.com"],
      subject: "subject",
      date: "2026-07-18T01:00:00.000Z",
      bodyText: "body",
      auth: { spf: "none", dkim: "none", dmarc: "none" },
      trusted: true,
    }, ctx);

    const all = await store.list(env, { viewer: "conrad@skyphusion.org", mailbox: "all" });
    expect(all.items.map((m) => m.messageId).sort()).toEqual([
      "mine-in@example.com",
      "mine-out@example.com",
    ]);
    const inbox = await store.list(env, {
      viewer: "conrad@skyphusion.org", direction: "inbound",
    });
    expect(inbox.items.map((m) => m.messageId)).toEqual(["mine-in@example.com"]);
    const sent = await store.list(env, {
      viewer: "conrad@skyphusion.org", direction: "outbound",
    });
    expect(sent.items.map((m) => m.messageId)).toEqual(["mine-out@example.com"]);
    const search = await store.search(env, {
      viewer: "conrad@skyphusion.org", q: "subject", mode: "fts",
    });
    expect(search.items.map((h) => h.message.messageId).sort()).toEqual([
      "mine-in@example.com",
      "mine-out@example.com",
    ]);
  });

  it("round-trips flags, placement UID, Trash restore, and folder counts", async () => {
    const { env, ctx } = realEnv();
    await seed(env, ctx, "one@example.com", "conrad@skyphusion.org");

    expect(await store.setFlags(env, ["one@example.com"], { flagged: true })).toBe(1);
    expect(await store.moveMessages(env, ["one@example.com"], "trash")).toBe(1);
    const trash = await store.list(env, { mailbox: "trash" });
    expect(trash.items[0]).toMatchObject({
      messageId: "one@example.com",
      flagged: true,
      mailbox: "trash",
    });
    expect(trash.items[0].folderUid).toBe(1);
    const counts = await store.folders(env, "conrad@skyphusion.org");
    expect(counts.find((f) => f.id === "trash")).toMatchObject({ count: 1, unread: 1 });
    const firstValidity = counts.find((f) => f.id === "trash")?.uidValidity;
    expect(firstValidity).toBeGreaterThan(0);
    expect((await store.folders(env, "conrad@skyphusion.org"))
      .find((f) => f.id === "trash")?.uidValidity).toBe(firstValidity);

    expect(await store.moveMessages(env, ["one@example.com"], null)).toBe(1);
    expect((await store.list(env, {})).items[0]).toMatchObject({ mailbox: null, trashedAt: null });
  });

  it("enforces draft ownership/concurrency and never reuses a revision UID", async () => {
    const { env } = realEnv();
    const empty: store.DraftInput = {
      to: "friend@example.com", cc: null, bcc: null, subject: "one",
      bodyText: "body", bodyHtml: null, inReplyTo: null, threadId: null,
    };
    const first = await store.putDraft(env, "d1", "conrad@skyphusion.org", empty);
    expect(first.conflict).toBe(false);
    expect(await store.getDraft(env, "d1", "other@skyphusion.org")).toBeNull();

    const stale = await store.putDraft(env, "d1", "conrad@skyphusion.org", {
      ...empty, subject: "stale",
    }, "wrong");
    expect(stale.conflict).toBe(true);

    const second = await store.putDraft(env, "d1", "conrad@skyphusion.org", {
      ...empty, subject: "two",
    }, first.draft.updatedAt);
    expect(second.draft.uid).toBeGreaterThan(first.draft.uid);
    expect(second.draft.subject).toBe("two");
  });

  it("hard delete removes the placement ledger with the message", async () => {
    const { env, ctx, raw } = realEnv();
    await seed(env, ctx, "delete@example.com", "conrad@skyphusion.org");
    await store.moveMessages(env, ["delete@example.com"], "archive");
    expect((raw.prepare("SELECT COUNT(*) AS n FROM mailbox_placement").get() as { n: number }).n).toBe(1);
    expect(await store.deleteMessage(env, "delete@example.com", ctx)).toBe(true);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM mailbox_placement").get() as { n: number }).n).toBe(0);
  });
});

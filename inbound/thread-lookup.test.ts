import { describe, it, expect } from "vitest";
import { ingest } from "./src/ingest";
import { send } from "./src/mailbox";
import { realEnv } from "./realdb";
import { MAX_THREAD_REFERENCES } from "./src/store";

// Thread resolution reads In-Reply-To plus the most recent References, at most
// MAX_THREAD_REFERENCES of them, in ONE query, and picks the parent in candidate order:
// In-Reply-To first, then References newest first, each as written and as stored.

function countLookups(env: Env): () => number {
  let n = 0;
  const db = env.DB as unknown as { prepare: (sql: string) => unknown };
  const orig = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (/SELECT[\s\S]*thread_id[\s\S]*FROM messages WHERE message_id/.test(sql)) n++;
    return orig(sql);
  };
  return () => n;
}

const refs = (n: number, suffix = "") => Array.from({ length: n }, (_, i) => `r${i}${suffix}@example.net`);
const inbound = (messageId: string, extra: Record<string, unknown> = {}) => ({
  messageId, from: "a@example.net", to: "alice@skyphusion.org", subject: "s", text: "t", ...extra,
});

describe("thread lookup query count", () => {
  it("no In-Reply-To and no References: no lookup", async () => {
    const { env, ctx } = realEnv();
    const count = countLookups(env);
    await ingest(env, inbound("solo@example.net"), ctx);
    expect(count()).toBe(0);
  });

  it("ingest() with 2,000 References: one lookup", async () => {
    const { env, ctx } = realEnv();
    const count = countLookups(env);
    await ingest(env, inbound("many@example.net", { references: refs(2000) }), ctx);
    expect(count()).toBe(1);
  });

  it("ingest() with 2,000 non-ASCII References: one lookup", async () => {
    const { env, ctx } = realEnv();
    const count = countLookups(env);
    await ingest(env, inbound("many-u@example.net", { references: refs(2000, "é") }), ctx);
    expect(count()).toBe(1);
  });

  it("send() with 2,000 caller References: one lookup", async () => {
    const { env, ctx } = realEnv();
    (env as unknown as { EMAIL: unknown }).EMAIL = { send: async () => ({ messageId: "p" }) };
    const count = countLookups(env);
    const headers = { References: refs(2000).map((r) => `<${r}>`).join(" ") };
    await send(env, { to: "ext@example.net", from: "agent@skyphusion.org", subject: "s", text: "t", headers }, ctx, undefined, "estate");
    expect(count()).toBe(1);
  });
});

describe("thread lookup bounds", () => {
  it("binds two forms of In-Reply-To plus MAX_THREAD_REFERENCES References, for message_id and claimed_id", async () => {
    const { env, ctx } = realEnv();
    const db = env.DB as unknown as { prepare: (sql: string) => { bind: (...v: unknown[]) => unknown } };
    const orig = db.prepare.bind(db);
    let bound = -1;
    db.prepare = (sql: string) => {
      const stmt = orig(sql);
      if (!/thread_id[\s\S]*FROM messages WHERE message_id/.test(sql)) return stmt;
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...v: unknown[]) => { bound = v.length; return bind(...v); };
      return stmt;
    };
    await ingest(env, inbound("bound@example.net", { inReplyTo: "irt\u00e9@example.net", references: refs(2000, "\u00e9") }), ctx);
    expect(MAX_THREAD_REFERENCES).toBe(20);
    expect(bound).toBe(2 * 2 * (1 + MAX_THREAD_REFERENCES));
    expect(bound).toBeLessThanOrEqual(100);
  });

  it("a parent older than the most recent MAX_THREAD_REFERENCES References is not used", async () => {
    const { env, ctx } = realEnv();
    await ingest(env, inbound("ancient@example.net"), ctx);
    const list = ["ancient@example.net", ...refs(MAX_THREAD_REFERENCES)];
    const r = await ingest(env, inbound("c8@example.net", { references: list }), ctx);
    expect(r.threadId).toBe("c8@example.net");
    const within = ["ancient@example.net", ...refs(MAX_THREAD_REFERENCES - 1)];
    const r3 = await ingest(env, inbound("c10@example.net", { references: within }), ctx);
    expect(r3.threadId).toBe("ancient@example.net");
  });
});

describe("thread lookup picks the right parent", () => {
  it("In-Reply-To wins over References", async () => {
    const { env, ctx } = realEnv();
    await ingest(env, inbound("p1@example.net"), ctx);
    await ingest(env, inbound("p2@example.net"), ctx);
    const r = await ingest(env, inbound("c@example.net", { inReplyTo: "<p1@example.net>", references: ["p2@example.net"] }), ctx);
    expect(r.threadId).toBe("p1@example.net");
  });

  it("the newest matching Reference wins", async () => {
    const { env, ctx } = realEnv();
    await ingest(env, inbound("old@example.net"), ctx);
    await ingest(env, inbound("new@example.net"), ctx);
    const r = await ingest(env, inbound("c2@example.net", { references: ["old@example.net", "new@example.net", "missing@example.net"] }), ctx);
    expect(r.threadId).toBe("new@example.net");
  });

  it("an In-Reply-To that matches nothing falls through to References", async () => {
    const { env, ctx } = realEnv();
    await ingest(env, inbound("root@example.net"), ctx);
    const r = await ingest(env, inbound("c3@example.net", { inReplyTo: "missing@example.net", references: ["root@example.net"] }), ctx);
    expect(r.threadId).toBe("root@example.net");
  });

  it("a parent stored under its derived id is found from the id as written", async () => {
    const { env, ctx } = realEnv();
    const raw = "café-root@example.net";
    await ingest(env, inbound(raw), ctx);
    const r = await ingest(env, inbound("c4@example.net", { inReplyTo: `<${raw}>` }), ctx);
    expect(r.threadId).not.toBe("c4@example.net");
  });

  it("a parent among the most recent References of a long list is found", async () => {
    const { env, ctx } = realEnv();
    await ingest(env, inbound("recent-root@example.net"), ctx);
    const list = [...refs(1990), "recent-root@example.net", ...refs(5, "x")];
    const r = await ingest(env, inbound("c5@example.net", { references: list }), ctx);
    expect(r.threadId).toBe("recent-root@example.net");
  });

  it("nothing matches: the message starts its own thread", async () => {
    const { env, ctx } = realEnv();
    const r = await ingest(env, inbound("c6@example.net", { inReplyTo: "nope@example.net", references: refs(30) }), ctx);
    expect(r.threadId).toBe("c6@example.net");
  });

  it("repeated References are looked up once each", async () => {
    const { env, ctx } = realEnv();
    await ingest(env, inbound("dup-root@example.net"), ctx);
    const list = Array.from({ length: 500 }, () => "dup-root@example.net");
    const r = await ingest(env, inbound("c7@example.net", { inReplyTo: "dup-root@example.net", references: list }), ctx);
    expect(r.threadId).toBe("dup-root@example.net");
  });
});

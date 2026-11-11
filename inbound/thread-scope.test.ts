import { describe, it, expect } from "vitest";
import { ingest } from "./src/ingest";
import { send } from "./src/mailbox";
import * as store from "./src/store";
import { realEnv } from "./realdb";

// A message sent by a bound member joins a thread only through a parent that member can
// read (the same scope store.get applies). A parent outside that scope is treated like
// an id that does not exist: the message starts its own thread. Estate callers resolve
// across the whole store, as before.

const ALICE = "alice@skyphusion.org";
const MEMBER = "member@skyphusion.org";

async function setup() {
  const { env, ctx } = realEnv();
  (env as unknown as { EMAIL: unknown }).EMAIL = { send: async () => ({ messageId: "p" }) };
  await ingest(env, { messageId: "alice-only@corp.example", from: "x@corp.example", to: ALICE, subject: "a", text: "a" }, ctx);
  await ingest(env, { messageId: "member-mail@corp.example", from: "x@corp.example", to: MEMBER, subject: "m", text: "m" }, ctx);
  return { env, ctx };
}
const asMember = (env: Env, ctx: ExecutionContext, headers: Record<string, string>) =>
  send(env, { to: "ext@example.net", from: MEMBER, subject: "s", text: "t", headers }, ctx, { from: MEMBER }, [MEMBER]);

describe("thread resolution for a bound member's send", () => {
  it("a parent the member cannot read: the message starts its own thread", async () => {
    const { env, ctx } = await setup();
    const r = await asMember(env, ctx, { "In-Reply-To": "<alice-only@corp.example>" });
    expect(r.threadId).toBe(r.messageId);
  });

  it("the same answer as an id that does not exist", async () => {
    const { env, ctx } = await setup();
    const r = await asMember(env, ctx, { "In-Reply-To": "<no-such-id@corp.example>" });
    expect(r.threadId).toBe(r.messageId);
  });

  it("control: a parent the member can read is joined", async () => {
    const { env, ctx } = await setup();
    const r = await asMember(env, ctx, { "In-Reply-To": "<member-mail@corp.example>" });
    expect(r.threadId).toBe("member-mail@corp.example");
  });

  it("an unreadable In-Reply-To falls through to a readable Reference", async () => {
    const { env, ctx } = await setup();
    const r = await asMember(env, ctx, { "In-Reply-To": "<alice-only@corp.example>", References: "<member-mail@corp.example> <alice-only@corp.example>" });
    expect(r.threadId).toBe("member-mail@corp.example");
  });

  it("control: an estate send resolves across the whole store, as before", async () => {
    const { env, ctx } = await setup();
    const r = await send(env, { to: "ext@example.net", from: MEMBER, subject: "s", text: "t", headers: { "In-Reply-To": "<alice-only@corp.example>" } }, ctx, undefined, "estate");
    expect(r.threadId).toBe("alice-only@corp.example");
  });

  it("the stored sent copy carries the same thread", async () => {
    const { env, ctx } = await setup();
    const r = await asMember(env, ctx, { "In-Reply-To": "<alice-only@corp.example>" });
    expect((await store.getUnscoped(env, r.messageId))?.threadId).toBe(r.messageId);
  });

  it("stays within D1's 100 bound values with a wide scope and a long References list", async () => {
    const { env, ctx } = await setup();
    const db = env.DB as unknown as { prepare: (sql: string) => { bind: (...v: unknown[]) => unknown } };
    const orig = db.prepare.bind(db);
    let bound = 0;
    db.prepare = (sql: string) => {
      const stmt = orig(sql);
      if (!/thread_id[\s\S]*FROM messages WHERE \(?message_id IN/.test(sql)) return stmt;
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...v: unknown[]) => { bound = Math.max(bound, v.length); return bind(...v); };
      return stmt;
    };
    const scope = Array.from({ length: 12 }, (_, i) => `role${i}@skyphusion.org`).concat(MEMBER);
    const refs = Array.from({ length: 2000 }, (_, i) => `<r${i}é@example.net>`).join(" ");
    const r = await send(env, { to: "ext@example.net", from: MEMBER, subject: "s", text: "t", headers: { "In-Reply-To": "<member-mail@corp.example>", References: refs } }, ctx, { from: MEMBER }, scope);
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThanOrEqual(100);
    expect(r.threadId).toBe("member-mail@corp.example");
  });
});

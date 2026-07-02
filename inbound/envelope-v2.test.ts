import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { ingest } from "./src/ingest";
import { reply } from "./src/mailbox";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// M8 envelope fidelity v2 (docs/CONTRACT.md section 10; #189, #178, #128).

describe("delivered_to merge dedup (#178)", () => {
  it("merges a second envelope recipient into one row; both views see it", async () => {
    const { env, ctx, rows, vectors, settle } = makeFakeEnv();

    const r1 = await ingest(
      env,
      { messageId: "multi@example.com", from: "sender@example.com", to: "support@skyphusion.org", subject: "hi", text: "help please", toHeader: "Support <support@skyphusion.org>, Security <security@skyphusion.org>" },
      ctx,
    );
    expect(r1).toMatchObject({ stored: true, merged: false });

    const r2 = await ingest(
      env,
      { messageId: "multi@example.com", from: "sender@example.com", to: "security@skyphusion.org", subject: "hi", text: "help please" },
      ctx,
    );
    expect(r2).toMatchObject({ stored: false, merged: true });
    await settle();

    // One row, one message identity, N mailbox views.
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered_to).toBe(",support@skyphusion.org,security@skyphusion.org,");
    // to_addr is the raw To HEADER fidelity (from the first delivery), not the envelope.
    expect(rows[0].to_addr).toBe("Support <support@skyphusion.org>, Security <security@skyphusion.org>");

    const forSupport = await store.list(env, { to: "support@skyphusion.org" });
    const forSecurity = await store.list(env, { to: "security@skyphusion.org" });
    expect(forSupport.items.map((m) => m.messageId)).toEqual(["multi@example.com"]);
    expect(forSecurity.items.map((m) => m.messageId)).toEqual(["multi@example.com"]);
    expect(forSupport.items[0].deliveredTo).toEqual(["support@skyphusion.org", "security@skyphusion.org"]);

    // Side effects (Vectorize) ran ONLY on the first insert, not the merge.
    const ids = new Set((vectors as { metadata?: { message_id?: string } }[]).map((v) => v.metadata?.message_id));
    expect([...ids]).toEqual(["multi@example.com"]);
  });

  it("is a true no-op when the same recipient is delivered again (retry/loop)", async () => {
    const { env, ctx, rows, settle } = makeFakeEnv();
    await ingest(env, { messageId: "dup@example.com", from: "s@example.com", to: "conrad@skyphusion.org", text: "x" }, ctx);
    const again = await ingest(env, { messageId: "dup@example.com", from: "s@example.com", to: "CONRAD@skyphusion.org", text: "x" }, ctx);
    await settle();
    expect(again).toMatchObject({ stored: false, merged: false });
    expect(rows).toHaveLength(1);
    // Case-insensitive membership: the second (upper-cased) delivery is not re-added.
    expect(rows[0].delivered_to).toBe(",conrad@skyphusion.org,");
  });
});

describe("v1-row COALESCE fallback (pre-0006 rows)", () => {
  it("filters a NULL-delivered_to row on its to_addr, and reads deliveredTo=[to_addr]", async () => {
    const { env, ctx, rows, settle } = makeFakeEnv();
    await ingest(env, { messageId: "old@example.com", from: "a@example.com", to: "conrad@skyphusion.org", text: "legacy" }, ctx);
    await settle();
    // Simulate a pre-migration row: no envelope set was ever written.
    rows[0].delivered_to = null;

    const page = await store.list(env, { to: "conrad@skyphusion.org" });
    expect(page.items.map((m) => m.messageId)).toEqual(["old@example.com"]);
    expect(page.items[0].deliveredTo).toEqual(["conrad@skyphusion.org"]);

    const msg = await store.get(env, "old@example.com");
    expect(msg?.deliveredTo).toEqual(["conrad@skyphusion.org"]);
    expect(msg?.cc).toBeNull();
    expect(msg?.wireSize).toBeNull();
  });
});

describe("header fidelity fields ride the message shape", () => {
  it("stores + returns cc/sender/replyTo/wireSize for inbound", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "fid@example.com",
        from: "boss@example.com",
        to: "conrad@skyphusion.org",
        text: "team update",
        toHeader: "conrad@skyphusion.org",
        cc: "team@skyphusion.org, ops@skyphusion.org",
        sender: "assistant@example.com",
        replyTo: "Boss <boss-replies@example.com>",
        rawSize: 8123,
      },
      ctx,
    );
    await settle();
    const msg = await store.get(env, "fid@example.com");
    expect(msg?.cc).toBe("team@skyphusion.org, ops@skyphusion.org");
    expect(msg?.sender).toBe("assistant@example.com");
    expect(msg?.replyTo).toBe("Boss <boss-replies@example.com>");
    expect(msg?.bcc).toBeNull(); // inbound Bcc is never populated
    expect(msg?.wireSize).toBe(8123);
  });
});

describe("outbound envelope population", () => {
  it("writes the full to+cc+bcc delivered set and joined cc/bcc, no sender/wireSize", async () => {
    const { env, ctx, rows } = makeFakeEnv();
    await store.put(
      env,
      {
        messageId: "out@skyphusion.org",
        direction: "outbound",
        from: "noreply@skyphusion.org",
        to: "a@example.com, b@example.com",
        subject: "sent",
        date: "2026-02-01T00:00:00.000Z",
        bodyText: "hi",
        auth: { spf: "none", dkim: "none", dmarc: "none" },
        trusted: true,
        deliveredTo: ["a@example.com", "b@example.com", "c@example.com"],
        cc: "b@example.com",
        bcc: "c@example.com",
      },
      ctx,
    );
    expect(rows[0].delivered_to).toBe(",a@example.com,b@example.com,c@example.com,");
    // A bcc recipient's view is complete for our own sent mail.
    const forBcc = await store.list(env, { to: "c@example.com" });
    expect(forBcc.items.map((m) => m.messageId)).toEqual(["out@skyphusion.org"]);
    const msg = await store.get(env, "out@skyphusion.org");
    expect(msg?.cc).toBe("b@example.com");
    expect(msg?.bcc).toBe("c@example.com");
    expect(msg?.sender).toBeNull();
    expect(msg?.wireSize).toBeNull();
  });
});

describe("reply routing to stored Reply-To (#189)", () => {
  it("routes a reply to the stored reply_to_addr, not from", async () => {
    const { env, ctx, sent, settle } = makeFakeEnv();
    await ingest(
      env,
      { messageId: "list@lists.example.com", from: "bounce@lists.example.com", to: "conrad@skyphusion.org", text: "digest", replyTo: "List <list@lists.example.com>" },
      ctx,
    );
    await settle();
    await reply(env, { messageId: "list@lists.example.com", text: "thanks" }, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["list@lists.example.com"]);
  });

  it("falls back to from when no Reply-To was stored", async () => {
    const { env, ctx, sent, settle } = makeFakeEnv();
    await ingest(env, { messageId: "plain@example.com", from: "alice@example.com", to: "conrad@skyphusion.org", text: "hi" }, ctx);
    await settle();
    await reply(env, { messageId: "plain@example.com", text: "hi back" }, ctx);
    expect(sent[0].to).toEqual(["alice@example.com"]);
  });
});

describe("search direction (#128)", () => {
  async function seedBoth(env: Env, ctx: ExecutionContext, settle: () => Promise<unknown[]>) {
    await ingest(env, { messageId: "s-in@example.com", from: "x@example.com", to: "conrad@skyphusion.org", subject: "deploy status", text: "deploy status inbound", date: "2026-01-01T00:00:00.000Z" }, ctx);
    await settle();
    await store.put(
      env,
      { messageId: "s-out@skyphusion.org", direction: "outbound", from: "noreply@skyphusion.org", to: "x@example.com", subject: "deploy status", date: "2026-01-02T00:00:00.000Z", bodyText: "deploy status outbound", auth: { spf: "none", dkim: "none", dmarc: "none" }, trusted: true, deliveredTo: ["x@example.com"] },
      ctx,
    );
    await settle();
  }

  it("restricts fts results to one direction", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seedBoth(env, ctx, settle);
    const inb = await store.search(env, { q: "deploy", direction: "inbound" });
    expect(inb.items.map((h) => h.message.messageId)).toEqual(["s-in@example.com"]);
    const out = await store.search(env, { q: "deploy", direction: "outbound" });
    expect(out.items.map((h) => h.message.messageId)).toEqual(["s-out@skyphusion.org"]);
    const both = await store.search(env, { q: "deploy" });
    expect(both.items.length).toBe(2);
  });

  it("400s an invalid direction at the API edge", async () => {
    const { env, ctx } = makeFakeEnv();
    const req = (p: string) => new Request(`https://postern.example${p}`, { headers: { authorization: "Bearer test-token" } });
    const bad = await handleApi(req("/api/search?q=x&direction=sideways"), env, ctx);
    expect(bad.status).toBe(400);
    const good = await handleApi(req("/api/search?q=x&direction=inbound"), env, ctx);
    expect(good.status).toBe(200);
  });
});

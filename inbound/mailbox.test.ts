import { describe, it, expect } from "vitest";
import { send, reply, MailboxError } from "./src/mailbox";
import { ingest } from "./src/ingest";
import * as store from "./src/store";
import { makeFakeEnv } from "./fakes";

describe("mailbox.send", () => {
  it("sends, dispatches via CfEmailTransport, and stores an outbound copy", async () => {
    const { env, ctx, settle, sent, rows } = makeFakeEnv();
    const res = await send(env, { to: "dev@example.com", subject: "hi", text: "hello" }, ctx);
    await settle();

    // Dispatched through the transport (env.EMAIL.send).
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["dev@example.com"], subject: "hi", text: "hello" });
    // From defaults to DEFAULT_FROM + name.
    expect(sent[0].from).toMatchObject({ email: "noreply@skyphusion.org", name: "Skyphusion" });
    // A sent copy lands in the store, direction outbound, its own thread.
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("outbound");
    expect(res.messageId).toBe(rows[0].message_id);
    expect(res.threadId).toBe(res.messageId);
    // The generated Message-ID is stamped as a header so the recipient + store agree.
    expect(sent[0].headers?.["Message-ID"]).toBe(`<${res.messageId}>`);
  });

  it("rejects an off-domain from", async () => {
    const { env, ctx } = makeFakeEnv();
    await expect(send(env, { to: "a@b.com", from: "x@evil.com", subject: "s", text: "x" }, ctx)).rejects.toMatchObject(
      { code: "E_SENDER_NOT_ALLOWED" },
    );
  });

  it("requires subject and a body", async () => {
    const { env, ctx } = makeFakeEnv();
    await expect(send(env, { to: "a@b.com", text: "x" } as never, ctx)).rejects.toMatchObject({ code: "E_FIELD_MISSING" });
    await expect(send(env, { to: "a@b.com", subject: "s" }, ctx)).rejects.toMatchObject({ code: "E_FIELD_MISSING" });
  });

  it("rejects CRLF header injection in the subject and custom headers", async () => {
    const { env, ctx } = makeFakeEnv();
    await expect(
      send(env, { to: "a@b.com", subject: "ok\r\nBcc: victim@x.com", text: "x" }, ctx),
    ).rejects.toMatchObject({ code: "E_VALIDATION_ERROR" });
    await expect(
      send(env, { to: "a@b.com", subject: "s", text: "x", headers: { "X-Bad": "v\r\nBcc: v@x.com" } }, ctx),
    ).rejects.toMatchObject({ code: "E_VALIDATION_ERROR" });
  });

  it("does not hang on a crafted ReDoS-style recipient (rejects promptly)", async () => {
    const { env, ctx } = makeFakeEnv();
    const evil = "a@" + "a.".repeat(50_000);
    const start = Date.now();
    await expect(send(env, { to: evil, subject: "s", text: "x" }, ctx)).rejects.toMatchObject({
      code: "E_VALIDATION_ERROR",
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("mailbox.reply (close the loop)", () => {
  it("replies in-thread to a received message and stores the sent copy in the same thread", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    // An inbound message arrives.
    const inbound = await ingest(
      env,
      { messageId: "orig@example.com", from: "alice@example.com", to: "conrad@skyphusion.org", subject: "Question", text: "halp" },
      ctx,
    );
    await settle();

    const res = await reply(env, { messageId: "orig@example.com", text: "here is your answer" }, ctx);
    await settle();

    // Routed back to the original sender; subject prefixed Re:.
    expect(sent[0].to).toEqual(["alice@example.com"]);
    expect(sent[0].subject).toBe("Re: Question");
    // Threading headers reference the original.
    expect(sent[0].headers?.["In-Reply-To"]).toBe("<orig@example.com>");
    expect(sent[0].headers?.["References"]).toContain("<orig@example.com>");
    // The reply is stored in the SAME thread as the original.
    expect(res.threadId).toBe(inbound.threadId);

    // The thread now holds both sides.
    const convo = await store.thread(env, inbound.threadId);
    expect(convo).toHaveLength(2);
    expect(convo.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(convo[0].messageId).toBe("orig@example.com");
    expect(convo[1].messageId).toBe(res.messageId);
  });

  it("collapses an existing Re: prefix instead of stacking", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    await ingest(
      env,
      { messageId: "r@example.com", from: "bob@example.com", to: "conrad@skyphusion.org", subject: "Re: Status", text: "?" },
      ctx,
    );
    await settle();
    await reply(env, { messageId: "r@example.com", text: "ok" }, ctx);
    await settle();
    expect(sent[0].subject).toBe("Re: Status");
  });

  it("404s a reply to an unknown message", async () => {
    const { env, ctx } = makeFakeEnv();
    await expect(reply(env, { messageId: "nope@example.com", text: "x" }, ctx)).rejects.toMatchObject({
      code: "E_NOT_FOUND",
    });
  });

  it("builds a multi-hop References chain when replying to a reply", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    // root inbound, then a stored reply that points at root.
    await ingest(env, { messageId: "root@example.com", from: "a@example.com", to: "conrad@skyphusion.org", subject: "T", text: "1" }, ctx);
    await settle();
    const firstReply = await reply(env, { messageId: "root@example.com", text: "2" }, ctx);
    await settle();
    // Now a NEW inbound that is a reply to our sent reply, then we reply to that.
    await ingest(
      env,
      { messageId: "third@example.com", from: "a@example.com", to: "conrad@skyphusion.org", subject: "Re: T", text: "3", inReplyTo: firstReply.messageId },
      ctx,
    );
    await settle();
    await reply(env, { messageId: "third@example.com", text: "4" }, ctx);
    await settle();
    const refs = sent[sent.length - 1].headers?.["References"] ?? "";
    expect(refs).toContain(`<${firstReply.messageId}>`);
    expect(refs).toContain("<third@example.com>");
  });
});

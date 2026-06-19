import { describe, it, expect } from "vitest";
import { ingest, type ParsedInbound } from "./src/ingest";
import { makeFakeEnv } from "./fakes";

function baseMsg(over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    messageId: "abc@example.com",
    from: "alice@example.com",
    to: "conrad@skyphusion.org",
    subject: "hello",
    text: "this is the body",
    ...over,
  };
}

describe("ingest", () => {
  it("stores a new message and reports stored=true with a thread", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv();
    const res = await ingest(env, baseMsg(), ctx);
    await settle();
    expect(res).toMatchObject({ messageId: "abc@example.com", stored: true });
    // First message in a conversation roots its own thread.
    expect(res.threadId).toBe("abc@example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("inbound");
  });

  it("dedups on a repeated message_id (stored=false)", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv();
    await ingest(env, baseMsg(), ctx);
    const res = await ingest(env, baseMsg(), ctx);
    await settle();
    expect(res.stored).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("inherits the parent thread when in_reply_to matches a stored message", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(env, baseMsg({ messageId: "root@example.com" }), ctx);
    const res = await ingest(
      env,
      baseMsg({ messageId: "child@example.com", inReplyTo: "root@example.com" }),
      ctx,
    );
    await settle();
    expect(res.threadId).toBe("root@example.com");
  });

  it("inherits the thread via References when in_reply_to does not match", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(env, baseMsg({ messageId: "root@example.com" }), ctx);
    const res = await ingest(
      env,
      baseMsg({ messageId: "grand@example.com", references: ["root@example.com", "missing@example.com"] }),
      ctx,
    );
    await settle();
    expect(res.threadId).toBe("root@example.com");
  });

  it("hashes a Message-ID longer than 64 chars so it fits Vectorize's id limit", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    const long = "x".repeat(80) + "@example.com";
    const res = await ingest(env, baseMsg({ messageId: long }), ctx);
    await settle();
    expect(res.messageId).toHaveLength(64);
    expect(res.messageId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("strips quoted lines and the signature block from the body", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv();
    await ingest(env, baseMsg({ text: "real reply\n> quoted line\n-- \nsig block" }), ctx);
    await settle();
    expect(rows[0].body_text).toBe("real reply");
  });

  it("marks an allowlisted sender with a passing verdict as trusted", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv();
    await ingest(env, baseMsg({ auth: { spf: "pass", dkim: "pass", dmarc: "pass" } }), ctx);
    await settle();
    expect(rows[0].trusted).toBe(1);
  });

  it("does not trust a sender off the allowlist", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv();
    await ingest(env, baseMsg({ from: "mallory@evil.com", auth: { spf: "pass", dkim: "pass" } }), ctx);
    await settle();
    expect(rows[0].trusted).toBe(0);
  });

  it("stores attachment bytes to R2 and metadata to D1", async () => {
    const { env, ctx, settle, r2, atts } = makeFakeEnv();
    const content = new TextEncoder().encode("file data").buffer;
    await ingest(env, baseMsg({ attachments: [{ filename: "a.txt", mimeType: "text/plain", content }] }), ctx);
    await settle();
    expect(r2).toHaveLength(1);
    expect(r2[0].key).toContain("att/");
    expect(atts).toHaveLength(1);
  });

  it("only vectorizes recipients on the VECTORIZE_FOR allowlist", async () => {
    const off = makeFakeEnv({ VECTORIZE_FOR: "someone-else@skyphusion.org" });
    await ingest(off.env, baseMsg(), off.ctx);
    await off.settle();
    expect(off.vectors).toHaveLength(0);

    const on = makeFakeEnv({ VECTORIZE_FOR: "conrad@skyphusion.org" });
    await ingest(on.env, baseMsg(), on.ctx);
    await on.settle();
    expect(on.vectors.length).toBeGreaterThan(0);
  });

  it("indexes everything when VECTORIZE_FOR is empty", async () => {
    const { env, ctx, settle, vectors } = makeFakeEnv({ VECTORIZE_FOR: "" });
    await ingest(env, baseMsg(), ctx);
    await settle();
    expect(vectors.length).toBeGreaterThan(0);
  });
});

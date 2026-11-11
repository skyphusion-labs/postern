import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ingest } from "./src/ingest";
import { realEnv } from "./realdb";

// Cloudflare Email Sending rejects a custom Message-ID and sets its own
// (src/transport/cf.ts strips ours). So the id the RECIPIENT sees, and puts in
// In-Reply-To and References when they answer, is the provider id, not the id our
// sent copy is stored under. Measured 2026-11-11: a send returned messageId
// f402bf82...@skyphusion.org and providerMessageId <Et5vx9...@skyphusion.org>, and
// the receiving mailbox stored Et5vx9.... A reply that quotes only the provider id
// must still land in the sent copy's thread.

const ADMIN = "test-token"; // realdb's static both token
const ME = "agent@skyphusion.org";
const THEM = "someone@example.net";
const PROVIDER_ID = "Et5vx9jGpvlI6JLwKOvOqLajCmzHoHBAHJPK@skyphusion.org";

type Json = Record<string, unknown>;

function setup(providerReturns: string | null = `<${PROVIDER_ID}>`) {
  const sent: Json[] = [];
  const r = realEnv({
    DEFAULT_FROM: ME,
    EMAIL: { async send(m: Json) { sent.push(m); return providerReturns === null ? {} : { messageId: providerReturns }; } },
  });
  const send = async () => {
    const res = await handleApi(
      new Request("https://postern.example/api/send", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ to: THEM, subject: "Hello", text: "first message" }),
      }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return JSON.parse(text) as { messageId: string; threadId: string; providerMessageId?: string };
  };
  const reply = (over: { inReplyTo?: string; references?: string[] }) =>
    ingest(r.env, { messageId: `reply-${Math.random().toString(36).slice(2)}@example.net`, from: THEM, to: ME, subject: "Re: Hello", text: "the answer", ...over }, r.ctx);
  return { ...r, sent, send, reply };
}

describe("a reply to the provider's Message-ID threads to our sent copy", () => {
  it("CONTROL: a reply to OUR id threads (the existing path)", async () => {
    const s = setup();
    const out = await s.send();
    const r = await s.reply({ inReplyTo: `<${out.messageId}>` });
    expect(r.threadId).toBe(out.threadId);
  });

  it("the provider id differs from ours, and ours was not on the wire", async () => {
    const s = setup();
    const out = await s.send();
    expect(out.providerMessageId).toBe(`<${PROVIDER_ID}>`);
    expect(out.messageId).not.toBe(PROVIDER_ID);
    const headers = (s.sent[0].headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("message-id");
  });

  it("In-Reply-To with the provider id threads to the sent copy", async () => {
    const s = setup();
    const out = await s.send();
    const r = await s.reply({ inReplyTo: `<${PROVIDER_ID}>` });
    expect(r.threadId).toBe(out.threadId);
  });

  it("References with only the provider id threads to the sent copy", async () => {
    const s = setup();
    const out = await s.send();
    const r = await s.reply({ references: [`<${PROVIDER_ID}>`] });
    expect(r.threadId).toBe(out.threadId);
  });

  it("a provider id without angle brackets is matched too", async () => {
    const s = setup(PROVIDER_ID);
    const out = await s.send();
    const r = await s.reply({ inReplyTo: `<${PROVIDER_ID}>` });
    expect(r.threadId).toBe(out.threadId);
  });

  it("no provider id (a transport that returns none) changes nothing", async () => {
    const s = setup(null);
    const out = await s.send();
    expect(out.providerMessageId).toBeUndefined();
    const r = await s.reply({ inReplyTo: `<${out.messageId}>` });
    expect(r.threadId).toBe(out.threadId);
  });
});

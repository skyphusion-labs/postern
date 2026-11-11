import { describe, it, expect, vi } from "vitest";
// The entrypoint base class is a platform import; a minimal stand-in that keeps env and
// ctx, the way the runtime constructs it.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
import { EmailService, MailboxService } from "./src/index";
import { realEnv, putInbound } from "./realdb";

// The legacy EmailService RPC entrypoint is SEND-ONLY, as documented: send and reply,
// no read methods, and the same "addressing" rule the static send-only token follows.

const AGENT = "agent@skyphusion.org";
const OUTSIDER = "outsider@example.net";
const BODY = "a stored body that must not travel";

function harness() {
  const sent: Array<Record<string, unknown>> = [];
  const r = realEnv({
    DEFAULT_FROM: AGENT,
    EMAIL: { async send(m: Record<string, unknown>) { sent.push(m); return { messageId: "p" }; } },
  });
  type Rpc = Record<string, unknown> & {
    send(req: unknown): Promise<unknown>;
    reply(req: unknown): Promise<unknown>;
  };
  const make = (C: unknown) => new (C as new (ctx: unknown, env: unknown) => Rpc)(r.ctx, r.env);
  return { ...r, sent, email: make(EmailService), mailbox: make(MailboxService) };
}

describe("EmailService exposes send and reply only", () => {
  it("has no read method (get, thread, list, search)", () => {
    const { email } = harness();
    for (const m of ["get", "thread", "list", "search"]) expect(typeof email[m], m).toBe("undefined");
    expect(typeof email.send).toBe("function");
    expect(typeof email.reply).toBe("function");
  });

  it("CONTROL: MailboxService still has every read method", () => {
    const { mailbox } = harness();
    for (const m of ["get", "thread", "list", "search"]) expect(typeof mailbox[m], m).toBe("function");
  });
});

describe("EmailService follows the addressing rule", () => {
  it("send works, and a forward source is not found with nothing dispatched", async () => {
    const h = harness();
    await putInbound(h.env, h.ctx, { id: "m1@x", from: OUTSIDER, to: AGENT, body: BODY });
    await expect(h.email.send({ to: "someone@example.net", from: AGENT, subject: "s", text: "plain" })).resolves.toBeTruthy();
    expect(h.sent).toHaveLength(1);
    await expect(h.email.send({ to: "someone@example.net", from: AGENT, text: "fyi", forwardMessageId: "m1@x" })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    expect(h.sent).toHaveLength(1);
  });

  it("a reply reaches the original sender only and carries none of the stored body", async () => {
    const h = harness();
    await putInbound(h.env, h.ctx, { id: "m1@x", from: OUTSIDER, to: AGENT, body: BODY });
    await h.email.reply({ messageId: "m1@x", from: AGENT, text: "thanks" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toEqual([OUTSIDER]);
    expect(JSON.stringify(h.sent[0])).not.toContain(BODY);
  });

  it("a reply with bcc or quoteOriginal is refused and nothing is dispatched", async () => {
    const h = harness();
    await putInbound(h.env, h.ctx, { id: "m1@x", from: OUTSIDER, to: AGENT, body: BODY });
    await expect(h.email.reply({ messageId: "m1@x", from: AGENT, text: "x", bcc: ["someone@example.net"] })).rejects.toMatchObject({ code: "E_VALIDATION_ERROR" });
    await expect(h.email.reply({ messageId: "m1@x", from: AGENT, text: "x", quoteOriginal: true })).rejects.toMatchObject({ code: "E_VALIDATION_ERROR" });
    expect(h.sent).toHaveLength(0);
  });

  it("CONTROL: MailboxService still quotes the same message (estate, by design)", async () => {
    const h = harness();
    await putInbound(h.env, h.ctx, { id: "m1@x", from: OUTSIDER, to: AGENT, body: BODY });
    await h.mailbox.reply({ messageId: "m1@x", from: AGENT, text: "q", quoteOriginal: true });
    expect(JSON.stringify(h.sent[0])).toContain(BODY);
  });
});

// The MCP relays the From the worker actually used (#804). asSendResult used to
// drop every field but messageId, threadId, and providerMessageId, so a bound
// identity's substitution was invisible to the agent that asked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PosternClient } from "../src/client.js";
import { SEND_TOOLS } from "../src/tools.js";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new PosternClient("https://api.example/", "send-tok");
const tool = (name: string) => SEND_TOOLS.find((t) => t.name === name)!;

describe("PosternClient relays the From the worker used", () => {
  it("keeps from on send", async () => {
    mockFetch(200, { ok: true, messageId: "m1", threadId: "t1", from: "rollins@skyphusion.org" });
    const res = await client().send({
      to: "a@b.com", subject: "hi", text: "body", from: "someone-else@skyphusion.org",
    });
    expect(res.from).toBe("rollins@skyphusion.org");
  });

  it("keeps from on reply", async () => {
    mockFetch(200, { ok: true, messageId: "m2", threadId: "t1", from: "joan@skyphusion.org" });
    const res = await client().reply({ messageId: "orig@id", text: "thanks", from: "someone-else@skyphusion.org" });
    expect(res.from).toBe("joan@skyphusion.org");
  });

  it("keeps from on draft send", async () => {
    mockFetch(200, { ok: true, messageId: "m3", threadId: "t3", from: "strummer@skyphusion.org" });
    const res = await client().sendDraft("d1");
    expect(res.from).toBe("strummer@skyphusion.org");
  });

  it("does not invent a from when the worker omitted it", async () => {
    mockFetch(200, { ok: true, messageId: "m1", threadId: "t1" });
    const res = await client().send({ to: "a@b.com", subject: "hi", text: "body" });
    expect(res.from).toBeUndefined();
  });
});

describe("send tools report the From and say a bound identity wins", () => {
  it("says in the tool description that a bound identity overrides the caller's from", () => {
    for (const name of ["mailbox_send", "mailbox_reply"]) {
      const t = tool(name);
      expect(t.description, name).toContain("bound identity overrides the caller's from");
      expect(t.inputSchema.from.description ?? "", name).toContain("bound identity overrides");
    }
    expect(tool("mailbox_draft_send").description).toContain("from is the address actually used");
  });

  it("mailbox_send returns the from the worker used, not the one asked for", async () => {
    const send = vi.fn().mockResolvedValue({
      messageId: "m1", threadId: "t1", from: "rollins@skyphusion.org", providerMessageId: "p1",
    });
    const out = await tool("mailbox_send").handler({ send } as never, {
      to: "a@b.com", subject: "hi", text: "hello", from: "someone-else@skyphusion.org",
    }) as { from?: string };
    expect(out.from).toBe("rollins@skyphusion.org");
  });

  it("mailbox_reply returns the from the worker used", async () => {
    const reply = vi.fn().mockResolvedValue({ messageId: "m2", threadId: "t1", from: "joan@skyphusion.org" });
    const out = await tool("mailbox_reply").handler({ reply } as never, {
      message_id: "orig@id", text: "thanks", from: "someone-else@skyphusion.org",
    }) as { from?: string };
    expect(out.from).toBe("joan@skyphusion.org");
  });

  it("mailbox_draft_send returns the from the worker used", async () => {
    const sendDraft = vi.fn().mockResolvedValue({
      messageId: "m3", threadId: "t3", from: "strummer@skyphusion.org",
    });
    const out = await tool("mailbox_draft_send").handler({ sendDraft } as never, { draft_id: "d1" }) as { from?: string };
    expect(out.from).toBe("strummer@skyphusion.org");
  });
});

import { describe, expect, it, vi } from "vitest";
import { READ_TOOLS, SEND_TOOLS, registerTools, type Scope } from "../src/tools";

// A minimal McpServer double: capture (name -> handler) from registerTool.
function fakeServer() {
  const handlers = new Map<string, (args: unknown) => Promise<any>>();
  const server: any = {
    registerTool: (name: string, _cfg: unknown, cb: (args: unknown) => Promise<any>) => {
      handlers.set(name, cb);
    },
  };
  return { server, handlers };
}

describe("SEND_TOOLS surface", () => {
  it("exposes exactly the v1.1 send tools, all scope=send", () => {
    expect(SEND_TOOLS.map((t) => t.name).sort()).toEqual(["mailbox_reply", "mailbox_send"]);
    expect(SEND_TOOLS.every((t) => t.scope === "send")).toBe(true);
  });
});

describe("scope gate (the default-OFF send seam)", () => {
  it("a read-scoped server registers NO send tools", () => {
    const { server } = fakeServer();
    const names = registerTools(server, {} as any, new Set<Scope>(["read"]), SEND_TOOLS);
    expect(names).toEqual([]); // dormant until a send token grants the send scope
  });

  it("a send-scoped server registers both send tools", () => {
    const { server, handlers } = fakeServer();
    const names = registerTools(server, {} as any, new Set<Scope>(["send"]), SEND_TOOLS);
    expect(names.sort()).toEqual(["mailbox_reply", "mailbox_send"]);
    expect([...handlers.keys()].sort()).toEqual(["mailbox_reply", "mailbox_send"]);
  });

  it("a read-scoped server still registers all read tools (read MCP unchanged)", () => {
    const { server } = fakeServer();
    const names = registerTools(server, {} as any, new Set<Scope>(["read"]), READ_TOOLS);
    expect(names.sort()).toEqual(["mailbox_get", "mailbox_get_attachment", "mailbox_list", "mailbox_search", "mailbox_thread"]);
  });
});

describe("mailbox_send handler", () => {
  it("forwards a composed message to client.send and reports the result", async () => {
    const client: any = { send: vi.fn().mockResolvedValue({ messageId: "m1", threadId: "t1", providerMessageId: "p1" }) };
    const tool = SEND_TOOLS.find((t) => t.name === "mailbox_send")!;
    const out: any = await tool.handler(client, { to: "a@b.com", subject: "hi", text: "hello", reply_to: "me@x.com" });
    expect(client.send).toHaveBeenCalledWith({
      to: "a@b.com",
      subject: "hi",
      text: "hello",
      html: undefined,
      cc: undefined,
      bcc: undefined,
      from: undefined,
      replyTo: "me@x.com",
    });
    expect(out).toEqual({ sent: true, messageId: "m1", threadId: "t1", providerMessageId: "p1" });
  });

  it("rejects when neither text nor html is given (no empty send)", async () => {
    const client: any = { send: vi.fn() };
    const tool = SEND_TOOLS.find((t) => t.name === "mailbox_send")!;
    await expect(tool.handler(client, { to: "a@b.com", subject: "hi" })).rejects.toThrow(/text.*html/);
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("mailbox_reply handler", () => {
  it("forwards message_id + body to client.reply", async () => {
    const client: any = { reply: vi.fn().mockResolvedValue({ messageId: "m2", threadId: "t-orig" }) };
    const tool = SEND_TOOLS.find((t) => t.name === "mailbox_reply")!;
    const out: any = await tool.handler(client, { message_id: "orig@id", text: "thanks" });
    expect(client.reply).toHaveBeenCalledWith({
      messageId: "orig@id",
      text: "thanks",
      html: undefined,
      cc: undefined,
      bcc: undefined,
      from: undefined,
    });
    expect(out.sent).toBe(true);
    expect(out.threadId).toBe("t-orig");
    expect(out.providerMessageId).toBeNull();
  });

  it("rejects when neither text nor html is given", async () => {
    const client: any = { reply: vi.fn() };
    const tool = SEND_TOOLS.find((t) => t.name === "mailbox_reply")!;
    await expect(tool.handler(client, { message_id: "m" })).rejects.toThrow(/text.*html/);
    expect(client.reply).not.toHaveBeenCalled();
  });
});

describe("end-to-end through a registered send handler", () => {
  it("runs mailbox_send through registerTools and returns a non-error text result", async () => {
    const { server, handlers } = fakeServer();
    const client: any = { send: vi.fn().mockResolvedValue({ messageId: "m9", threadId: "t9" }) };
    registerTools(server, client, new Set<Scope>(["send"]), SEND_TOOLS);
    const res = await handlers.get("mailbox_send")!({ to: "a@b.com", subject: "s", text: "b" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.sent).toBe(true);
    expect(payload.messageId).toBe("m9");
  });

  it("surfaces a send error as an isError result, not a throw", async () => {
    const { server, handlers } = fakeServer();
    const client: any = { send: vi.fn().mockRejectedValue(new Error("requires send scope")) };
    registerTools(server, client, new Set<Scope>(["send"]), SEND_TOOLS);
    const res = await handlers.get("mailbox_send")!({ to: "a@b.com", subject: "s", text: "b" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("requires send scope");
  });
});

describe("mailbox_send attachments", () => {
  it("maps snake_case attachments to the worker content/filename/mimeType shape", async () => {
    const client: any = { send: vi.fn().mockResolvedValue({ messageId: "m1", threadId: "t1" }) };
    const t = SEND_TOOLS.find((x) => x.name === "mailbox_send")!;
    await t.handler(client, {
      to: "a@b.com",
      subject: "with file",
      text: "see attached",
      attachments: [{ content: "QUJD", filename: "a.txt", mime_type: "text/plain" }],
    });
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ content: "QUJD", filename: "a.txt", mimeType: "text/plain" }],
      }),
    );
  });

  it("sends no attachments field when none are given (unchanged no-attachment path)", async () => {
    const client: any = { send: vi.fn().mockResolvedValue({ messageId: "m1", threadId: "t1" }) };
    const t = SEND_TOOLS.find((x) => x.name === "mailbox_send")!;
    await t.handler(client, { to: "a@b.com", subject: "plain", text: "hi" });
    const arg = client.send.mock.calls[0][0];
    expect(arg.attachments).toBeUndefined();
  });
});

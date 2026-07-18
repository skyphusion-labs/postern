import { describe, expect, it, vi } from "vitest";
import { READ_TOOLS } from "../src/tools";

function tool(name: string) {
  const t = READ_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no such tool ${name}`);
  return t;
}

describe("READ_TOOLS surface", () => {
  it("exposes exactly the v1 read tools, all scope=read", () => {
    expect(READ_TOOLS.map((t) => t.name).sort()).toEqual(
      ["mailbox_get", "mailbox_get_attachment", "mailbox_list", "mailbox_search", "mailbox_thread"],
    );
    expect(READ_TOOLS.every((t) => t.scope === "read")).toBe(true);
  });
});

describe("mailbox_search", () => {
  it("defaults mode to hybrid and forwards query + direction to client.search", async () => {
    const client: any = { search: vi.fn().mockResolvedValue({ items: [{ message: { messageId: "m1" } }], cursor: null }) };
    const out: any = await tool("mailbox_search").handler(client, { query: "invoice", direction: "outbound" });
    expect(client.search).toHaveBeenCalledWith({ q: "invoice", mode: "hybrid", limit: undefined, cursor: undefined, direction: "outbound" });
    expect(out.mode).toBe("hybrid");
    expect(out.count).toBe(1);
    expect(out.results).toHaveLength(1);
  });

  it("honors an explicit mode", async () => {
    const client: any = { search: vi.fn().mockResolvedValue({ items: [], cursor: null }) };
    await tool("mailbox_search").handler(client, { query: "x", mode: "fts" });
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ mode: "fts" }));
  });
});

describe("mailbox_list", () => {
  it("maps filters to client.list", async () => {
    const client: any = { list: vi.fn().mockResolvedValue({ items: [{ messageId: "m2" }], cursor: "c" }) };
    const out: any = await tool("mailbox_list").handler(client, { direction: "inbound", to: "x@y.com" });
    expect(client.list).toHaveBeenCalledWith(expect.objectContaining({ direction: "inbound", to: "x@y.com" }));
    expect(out.count).toBe(1);
    expect(out.cursor).toBe("c");
  });
});

describe("mailbox_get", () => {
  it("returns found:true with the message", async () => {
    const client: any = { get: vi.fn().mockResolvedValue({ messageId: "m9", bodyText: "hi" }) };
    const out: any = await tool("mailbox_get").handler(client, { message_id: "m9" });
    expect(client.get).toHaveBeenCalledWith("m9");
    expect(out.found).toBe(true);
    expect(out.message.messageId).toBe("m9");
  });

  it("returns found:false when missing", async () => {
    const client: any = { get: vi.fn().mockResolvedValue(null) };
    const out: any = await tool("mailbox_get").handler(client, { message_id: "nope" });
    expect(out.found).toBe(false);
  });
});

describe("mailbox_thread", () => {
  it("maps to client.thread and counts messages", async () => {
    const client: any = { thread: vi.fn().mockResolvedValue([{ messageId: "m1" }, { messageId: "m2" }]) };
    const out: any = await tool("mailbox_thread").handler(client, { thread_id: "t1" });
    expect(client.thread).toHaveBeenCalledWith("t1");
    expect(out.count).toBe(2);
    expect(out.threadId).toBe("t1");
  });
});

describe("mailbox_get_attachment", () => {
  const DEFAULT_MAX = 5 * 1024 * 1024;

  it("returns base64 bytes + real filename/mime/size for an in-range index", async () => {
    const client: any = {
      get: vi.fn().mockResolvedValue({
        messageId: "m1",
        attachments: [{ filename: "report.pdf", mime: "application/pdf", size: 3 }],
      }),
      getAttachmentBytes: vi.fn().mockResolvedValue({ base64: "QUJD", contentType: "application/pdf", size: 3 }),
    };
    const out: any = await tool("mailbox_get_attachment").handler(client, { message_id: "m1", index: 0 });
    expect(client.get).toHaveBeenCalledWith("m1");
    expect(client.getAttachmentBytes).toHaveBeenCalledWith("m1", 0, DEFAULT_MAX);
    expect(out).toEqual({
      found: true,
      messageId: "m1",
      index: 0,
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 3,
      encoding: "base64",
      content: "QUJD",
    });
  });

  it("returns found:false when the message does not exist", async () => {
    const client: any = { get: vi.fn().mockResolvedValue(null), getAttachmentBytes: vi.fn() };
    const out: any = await tool("mailbox_get_attachment").handler(client, { message_id: "nope", index: 0 });
    expect(out.found).toBe(false);
    expect(client.getAttachmentBytes).not.toHaveBeenCalled();
  });

  it("throws a clear out-of-range error without fetching bytes", async () => {
    const client: any = {
      get: vi.fn().mockResolvedValue({ messageId: "m1", attachments: [{ filename: "a", mime: "text/plain", size: 1 }] }),
      getAttachmentBytes: vi.fn(),
    };
    await expect(tool("mailbox_get_attachment").handler(client, { message_id: "m1", index: 2 })).rejects.toThrow(
      /index 2 out of range: message has 1 attachment/,
    );
    expect(client.getAttachmentBytes).not.toHaveBeenCalled();
  });

  it("refuses an oversize attachment (by metadata) before downloading, honoring the env cap", async () => {
    const prev = process.env.POSTERN_MCP_MAX_ATTACHMENT_BYTES;
    process.env.POSTERN_MCP_MAX_ATTACHMENT_BYTES = "5";
    try {
      const client: any = {
        get: vi.fn().mockResolvedValue({ messageId: "m1", attachments: [{ filename: "big", mime: "application/octet-stream", size: 10 }] }),
        getAttachmentBytes: vi.fn(),
      };
      await expect(tool("mailbox_get_attachment").handler(client, { message_id: "m1", index: 0 })).rejects.toThrow(
        /over the 5-byte limit/,
      );
      expect(client.getAttachmentBytes).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.POSTERN_MCP_MAX_ATTACHMENT_BYTES;
      else process.env.POSTERN_MCP_MAX_ATTACHMENT_BYTES = prev;
    }
  });
});

describe("mailbox_search substr + field", () => {
  it("forwards mode=substr and the field selector to client.search", async () => {
    const client: any = { search: vi.fn().mockResolvedValue({ items: [], cursor: null }) };
    const out: any = await tool("mailbox_search").handler(client, { query: "invoice", mode: "substr", field: "subject" });
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ q: "invoice", mode: "substr", field: "subject" }),
    );
    expect(out.mode).toBe("substr");
    expect(out.field).toBe("subject");
  });
});

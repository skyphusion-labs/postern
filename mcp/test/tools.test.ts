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
      ["mailbox_get", "mailbox_list", "mailbox_search", "mailbox_thread"],
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

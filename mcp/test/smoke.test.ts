import { describe, expect, it, vi } from "vitest";
import { READ_TOOLS, registerTools, type Scope, type ToolDef } from "../src/tools";

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

describe("registerTools (tool listing + scope gate)", () => {
  it("registers exactly the read tools for a read-scoped server", () => {
    const { server, handlers } = fakeServer();
    const fakeClient: any = { search: vi.fn().mockResolvedValue({ items: [], cursor: null }) };
    const names = registerTools(server, fakeClient, new Set<Scope>(["read"]), READ_TOOLS);
    expect(names.sort()).toEqual(["mailbox_get", "mailbox_list", "mailbox_search", "mailbox_thread"]);
    expect([...handlers.keys()].sort()).toEqual(names.sort());
  });

  it("does NOT register a send-scoped tool without the send scope (the v1.1 seam)", () => {
    const { server } = fakeServer();
    const fakeClient: any = {};
    const sendTool: ToolDef = {
      name: "mailbox_send",
      scope: "send",
      description: "stub",
      inputSchema: {},
      handler: async () => ({}),
    };
    const names = registerTools(server, fakeClient, new Set<Scope>(["read"]), [sendTool]);
    expect(names).toEqual([]); // refused: no send scope
  });

  it("runs mailbox_search through the registered handler end-to-end", async () => {
    const { server, handlers } = fakeServer();
    const fakeClient: any = {
      search: vi.fn().mockResolvedValue({ items: [{ message: { messageId: "m1", subject: "hi" } }], cursor: null }),
    };
    registerTools(server, fakeClient, new Set<Scope>(["read"]), READ_TOOLS);
    const res = await handlers.get("mailbox_search")!({ query: "hi" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.results[0].message.messageId).toBe("m1");
  });

  it("surfaces a client error as an isError result, not a throw", async () => {
    const { server, handlers } = fakeServer();
    const fakeClient: any = { search: vi.fn().mockRejectedValue(new Error("boom")) };
    registerTools(server, fakeClient, new Set<Scope>(["read"]), READ_TOOLS);
    const res = await handlers.get("mailbox_search")!({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("boom");
  });
});

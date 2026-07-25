// #403 at the MCP seam: the tools that a crew session uses to ask "did this mail
// arrive". The defect class is a false PASS, so each case asserts what must NOT be
// on the wire (a swallowed filter, an invented parameter) as well as what must.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosternClient } from "../src/client";
import { READ_TOOLS } from "../src/tools";

function mockFetch(body: unknown) {
  const calls: { url: string; init: any }[] = [];
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new PosternClient("https://api.example", "tok-123");
const tool = (name: string) => READ_TOOLS.find((t) => t.name === name)!;

describe("#403 client carries the viewer + lens", () => {
  it("list sends lens and never invents a direction alongside it", async () => {
    const calls = mockFetch({ ok: true, items: [], cursor: null });
    await client().list({ to: "abuse@skyphusion.org", lens: "inbox" });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("to")).toBe("abuse@skyphusion.org");
    expect(u.searchParams.get("lens")).toBe("inbox");
    // The worker refuses lens+direction: sending both would 400 every call.
    expect(u.searchParams.get("direction")).toBeNull();
  });

  it("list keeps direction alone when no lens was asked for", async () => {
    const calls = mockFetch({ ok: true, items: [], cursor: null });
    await client().list({ to: "abuse@skyphusion.org", direction: "inbound" });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("direction")).toBe("inbound");
    expect(u.searchParams.get("lens")).toBeNull();
  });

  it("search carries to + lens (the viewer scope /api/search gained in #350)", async () => {
    const calls = mockFetch({ ok: true, items: [], cursor: null });
    await client().search({ q: "probe", mode: "fts", to: "abuse@skyphusion.org", lens: "inbox" });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/api/search");
    expect(u.searchParams.get("mode")).toBe("fts");
    expect(u.searchParams.get("to")).toBe("abuse@skyphusion.org");
    expect(u.searchParams.get("lens")).toBe("inbox");
    expect(u.searchParams.get("direction")).toBeNull();
  });

  it("omits both when neither is asked for (an unfiltered call stays unfiltered)", async () => {
    const calls = mockFetch({ ok: true, items: [], cursor: null });
    await client().list({});
    await client().search({ q: "x" });
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.searchParams.get("lens")).toBeNull();
      expect(u.searchParams.get("direction")).toBeNull();
    }
  });
});

describe("#403 tool surface", () => {
  it("mailbox_list accepts lens and forwards it", async () => {
    const calls = mockFetch({ ok: true, items: [], cursor: null });
    const t = tool("mailbox_list");
    t.inputSchema.lens.parse("inbox");
    t.inputSchema.lens.parse("sent");
    expect(() => t.inputSchema.lens.parse("inbund")).toThrow();
    await t.handler(client(), { to: "abuse@skyphusion.org", lens: "inbox" });
    expect(new URL(calls[0].url).searchParams.get("lens")).toBe("inbox");
  });

  it("mailbox_search echoes the mode, viewer and lens it actually used", async () => {
    mockFetch({ ok: true, items: [], cursor: null });
    const out = (await tool("mailbox_search").handler(client(), {
      query: "cp115-abuse-intake-probe-7f3a9c",
      mode: "fts",
      to: "abuse@skyphusion.org",
      lens: "inbox",
    })) as Record<string, unknown>;
    // An empty answer is only evidence if the caller can see WHICH query produced
    // it; the echo is what makes count 0 a usable "no".
    expect(out).toMatchObject({ mode: "fts", to: "abuse@skyphusion.org", lens: "inbox", count: 0 });
  });

  it("mailbox_search still defaults to hybrid with no lens (unchanged)", async () => {
    const calls = mockFetch({ ok: true, items: [], cursor: null });
    const out = (await tool("mailbox_search").handler(client(), { query: "budget" })) as Record<string, unknown>;
    expect(out).toMatchObject({ mode: "hybrid", to: null, lens: null });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("mode")).toBe("hybrid");
    expect(u.searchParams.get("lens")).toBeNull();
  });
});

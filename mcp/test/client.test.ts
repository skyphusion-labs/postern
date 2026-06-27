import { afterEach, describe, expect, it, vi } from "vitest";
import { PosternClient, PosternError, USER_AGENT } from "../src/client";

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: any }[] = [];
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new PosternClient("https://api.example/", "tok-123");

describe("PosternClient request hygiene", () => {
  it("sends the custom User-Agent + bearer + Accept on every call (CF WAF 1010 guard)", async () => {
    const calls = mockFetch(200, { ok: true, items: [], cursor: null });
    await client().search({ q: "hello" });
    expect(calls).toHaveLength(1);
    const h = calls[0].init.headers;
    expect(h["User-Agent"]).toBe(USER_AGENT);
    expect(h.Authorization).toBe("Bearer tok-123");
    expect(h.Accept).toBe("application/json");
  });

  it("strips a trailing slash from the base url", async () => {
    const calls = mockFetch(200, { ok: true, items: [], cursor: null });
    await client().list({});
    expect(calls[0].url.startsWith("https://api.example/api/messages")).toBe(true);
    expect(calls[0].url).not.toContain("//api/messages");
  });
});

describe("search", () => {
  it("maps to /api/search with q, mode, direction and returns hits", async () => {
    const hit = { message: { messageId: "m1", direction: "inbound", subject: "hi" }, score: 0.9 };
    const calls = mockFetch(200, { ok: true, items: [hit], cursor: "c1" });
    const page = await client().search({ q: "budget", mode: "hybrid", direction: "outbound", limit: 5 });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/api/search");
    expect(u.searchParams.get("q")).toBe("budget");
    expect(u.searchParams.get("mode")).toBe("hybrid");
    expect(u.searchParams.get("direction")).toBe("outbound");
    expect(u.searchParams.get("limit")).toBe("5");
    expect(page.items).toEqual([hit]);
    expect(page.cursor).toBe("c1");
  });
});

describe("list", () => {
  it("maps to /api/messages with direction + filters", async () => {
    const calls = mockFetch(200, { ok: true, items: [{ messageId: "m2" }], cursor: null });
    await client().list({ direction: "inbound", from: "a@b.com", limit: 10 });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/api/messages");
    expect(u.searchParams.get("direction")).toBe("inbound");
    expect(u.searchParams.get("from")).toBe("a@b.com");
  });
});

describe("get", () => {
  it("returns the message on 200", async () => {
    mockFetch(200, { ok: true, message: { messageId: "m9", bodyText: "hi" } });
    const msg = await client().get("m9");
    expect(msg?.messageId).toBe("m9");
  });

  it("encodes the id and returns null on 404", async () => {
    const calls = mockFetch(404, { ok: false, error: "E_NOT_FOUND" });
    const msg = await client().get("a@b.com");
    expect(calls[0].url).toContain("/api/messages/a%40b.com");
    expect(msg).toBeNull();
  });
});

describe("thread", () => {
  it("maps to /api/threads/{id} and returns messages", async () => {
    const calls = mockFetch(200, { ok: true, threadId: "t1", messages: [{ messageId: "m1" }, { messageId: "m2" }] });
    const msgs = await client().thread("t1");
    expect(calls[0].url).toContain("/api/threads/t1");
    expect(msgs).toHaveLength(2);
  });
});

describe("errors", () => {
  it("throws a clear PosternError on 401", async () => {
    mockFetch(401, { ok: false });
    await expect(client().search({ q: "x" })).rejects.toBeInstanceOf(PosternError);
  });

  it("throws on 5xx", async () => {
    mockFetch(503, { ok: false });
    await expect(client().list({})).rejects.toMatchObject({ status: 503 });
  });
});

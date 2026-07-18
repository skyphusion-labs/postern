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

// A fetch double for the raw attachment-bytes path (arrayBuffer + headers.get),
// distinct from the JSON mockFetch above.
function mockAttachmentFetch(status: number, bytes: Uint8Array, headers: Record<string, string>) {
  const calls: { url: string; init: any }[] = [];
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => "",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("getAttachmentBytes", () => {
  it("GETs the attachment path and returns base64 + content-type + size", async () => {
    const bytes = new Uint8Array([65, 66, 67]); // "ABC"
    const calls = mockAttachmentFetch(200, bytes, { "content-type": "text/plain", "content-length": "3" });
    const res = await client().getAttachmentBytes("m1", 0, 1024);
    expect(calls[0].url).toBe("https://api.example/api/messages/m1/attachments/0");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers["User-Agent"]).toBe(USER_AGENT);
    expect(res).toEqual({ base64: "QUJD", contentType: "text/plain", size: 3 });
  });

  it("returns null on 404 (no such message/index)", async () => {
    mockAttachmentFetch(404, new Uint8Array(), {});
    const res = await client().getAttachmentBytes("m1", 9, 1024);
    expect(res).toBeNull();
  });

  it("refuses (413) when the declared Content-Length exceeds the cap, before reading the body", async () => {
    let readBody = false;
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "999999" : "application/pdf") },
      arrayBuffer: async () => {
        readBody = true;
        return new ArrayBuffer(0);
      },
      text: async () => "",
    })) as any;
    vi.stubGlobal("fetch", fn);
    await expect(client().getAttachmentBytes("m1", 0, 10)).rejects.toMatchObject({ status: 413 });
    expect(readBody).toBe(false);
  });

  it("refuses (413) when the decoded body exceeds the cap even without Content-Length", async () => {
    const bytes = new Uint8Array(20);
    mockAttachmentFetch(200, bytes, { "content-type": "application/octet-stream" });
    await expect(client().getAttachmentBytes("m1", 0, 10)).rejects.toMatchObject({ status: 413 });
  });
});

describe("search field forwarding (substr)", () => {
  it("forwards mode=substr and field on /api/search", async () => {
    const calls = mockFetch(200, { ok: true, items: [], cursor: null });
    await client().search({ q: "x", mode: "substr", field: "body" });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("mode")).toBe("substr");
    expect(u.searchParams.get("field")).toBe("body");
  });
});

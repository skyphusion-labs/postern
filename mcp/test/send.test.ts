import { afterEach, describe, expect, it, vi } from "vitest";
import { PosternClient, PosternError, USER_AGENT } from "../src/client";

// Capture each fetch call so we can assert method, headers, URL, and JSON body.
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

const client = () => new PosternClient("https://api.example/", "send-tok");

describe("PosternClient.send", () => {
  it("POSTs /api/send with the custom UA, bearer, JSON content-type, and JSON body", async () => {
    const calls = mockFetch(200, { ok: true, messageId: "m-new", threadId: "t-new", providerMessageId: "p-1" });
    const res = await client().send({ to: "a@b.com", subject: "hi", text: "body" });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://api.example/api/send");
    expect(init.method).toBe("POST");
    expect(init.headers["User-Agent"]).toBe(USER_AGENT);
    expect(init.headers.Authorization).toBe("Bearer send-tok");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ to: "a@b.com", subject: "hi", text: "body" });
    expect(res).toEqual({ messageId: "m-new", threadId: "t-new", providerMessageId: "p-1" });
  });

  it("omits providerMessageId when the worker did not return one", async () => {
    mockFetch(200, { ok: true, messageId: "m1", threadId: "t1" });
    const res = await client().send({ to: ["x@y.com", "z@y.com"], subject: "s", html: "<p>h</p>" });
    expect(res.providerMessageId).toBeUndefined();
    expect(res.messageId).toBe("m1");
  });
});

describe("PosternClient.reply", () => {
  it("POSTs /api/reply with the referenced message id and new body", async () => {
    const calls = mockFetch(200, { ok: true, messageId: "m-r", threadId: "t-orig" });
    const res = await client().reply({ messageId: "orig@id", text: "thanks" });
    expect(calls[0].url).toBe("https://api.example/api/reply");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ messageId: "orig@id", text: "thanks" });
    expect(res.threadId).toBe("t-orig");
  });
});

describe("send scope-gating + validation errors surface clearly", () => {
  it("turns a 403 (wrong scope) into a PosternError carrying the worker's message", async () => {
    mockFetch(403, { ok: false, error: "forbidden", message: "requires send scope" });
    await expect(client().send({ to: "a@b.com", subject: "s", text: "t" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(client().send({ to: "a@b.com", subject: "s", text: "t" })).rejects.toThrow(/requires send scope/);
  });

  it("turns a 400 validation error into a PosternError with the worker's message", async () => {
    mockFetch(400, { ok: false, error: "E_VALIDATION_ERROR", message: "invalid to address: nope" });
    await expect(client().send({ to: "nope", subject: "s", text: "t" })).rejects.toMatchObject({ status: 400 });
  });

  it("surfaces a 413 (too large) as a PosternError", async () => {
    mockFetch(413, { ok: false, error: "E_CONTENT_TOO_LARGE", message: "message too large" });
    await expect(client().reply({ messageId: "m", text: "x" })).rejects.toBeInstanceOf(PosternError);
  });
});

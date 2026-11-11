import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosternClient, apiUrlForLog, apiUrlProblem } from "../src/client.js";
import { READ_TOOLS } from "../src/tools.js";

function tool(name: string) {
  const t = READ_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no such tool ${name}`);
  return t;
}

function mockFetch(status: number, body: unknown) {
  const calls: { url: string }[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push({ url });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("API URL", () => {
  it("refuses http except loopback and does not log the URL query", () => {
    expect(apiUrlProblem("http://example.com")).toMatch(/http is accepted only for localhost/);
    expect(apiUrlProblem("http://127.0.0.1:8787")).toBeNull();
    expect(apiUrlProblem("http://localhost/api")).toBeNull();
    expect(apiUrlProblem("http://[::1]:8787")).toBeNull();
    expect(apiUrlProblem("https://example.com/v1")).toBeNull();
    expect(apiUrlProblem("ftp://example.com")).toMatch(/http/);
    const logged = apiUrlForLog("https://example.com/v1?token=sekret");
    expect(logged).toBe("https://example.com");
    expect(logged).not.toContain("sekret");
    expect(logged).not.toContain("?");
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain("apiUrlProblem(apiUrl)");
    expect(src).toContain("apiUrlForLog(apiUrl)");
    expect(src).not.toMatch(/-> \$\{apiUrl\}/);
  });
});

describe("path ids", () => {
  it("refuses an empty id and dot segments before a request", async () => {
    const calls = mockFetch(200, { message: { messageId: "m" } });
    const client = new PosternClient("https://api.example/", "tok");
    for (const id of ["", ".", ".."]) {
      await expect(client.get(id)).rejects.toThrow(/empty/);
      await expect(client.thread(id)).rejects.toThrow(/empty/);
      await expect(client.getDraft(id)).rejects.toThrow(/empty/);
      await expect(client.sendDraft(id)).rejects.toThrow(/empty/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("returned bodies", () => {
  it("caps mailbox_get and mailbox_thread, keeps the envelope, and sets bodyTruncated", async () => {
    const body = "x".repeat(70_000);
    const getClient: any = {
      get: async () => ({ message: { messageId: "m", bodyText: body, bodyHtml: body } }),
    };
    const got: any = await tool("mailbox_get").handler(getClient, { message_id: "m" });
    expect(got.contentNotice).toMatch(/untrustedFields/);
    expect(got.untrustedFields).toContain("bodyText");
    expect(got.untrustedFields).toContain("bodyHtml");
    expect(got.untrustedFields).not.toContain("bodyTruncated");
    expect(got.untrustedFields).not.toContain("bodyTextTruncated");
    expect(got.untrustedFields).not.toContain("bodyHtmlTruncated");
    expect(got.untrustedFields).not.toContain("bodyTextLength");
    expect(got.untrustedFields).not.toContain("bodyHtmlLength");
    expect(got.message.bodyTruncated).toBe(true);
    expect(got.message.bodyTextLength).toBe(70_000);
    expect(got.message.bodyHtmlLength).toBe(70_000);
    expect(got.message.bodyText.length).toBeLessThanOrEqual(65_536);
    expect(got.message.bodyHtml.length).toBeLessThanOrEqual(65_536);
    expect(got.message.bodyTextTruncated).toBe(true);

    const threadClient: any = {
      thread: async () => ({ items: [{ messageId: "m", bodyText: body }], cursor: null }),
    };
    const thread: any = await tool("mailbox_thread").handler(threadClient, { thread_id: "t" });
    expect(thread.messages[0].bodyTruncated).toBe(true);
    expect(thread.messages[0].bodyText.length).toBeLessThanOrEqual(65_536);
    expect(thread.messages[0].bodyTextLength).toBe(70_000);
  });

  it("leaves a short body unchanged", async () => {
    const client: any = { get: async () => ({ message: { messageId: "m", bodyText: "hi" } }) };
    const out: any = await tool("mailbox_get").handler(client, { message_id: "m" });
    expect(out.message.bodyText).toBe("hi");
    expect(out.message.bodyTruncated).toBeUndefined();
  });
});

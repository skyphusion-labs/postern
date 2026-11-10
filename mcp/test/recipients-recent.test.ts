// #805: mailbox_recipients_recent over GET /api/recipients/recent.
//
// The worker already answers this route for webmail autocomplete. What an agent
// could not do is call it, and what a thin wrapper must not do is drop
// identityScope or rename the row. The row is the worker's: address, displayName,
// lastUsedAt (when the address was last a recipient of this identity's outbound
// mail), messageCount. scanLimited is present only when the worker says the
// 200-row scan stopped early.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosternClient } from "../src/client.js";
import { READ_TOOLS } from "../src/tools.js";

function tool(name: string) {
  const t = READ_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no such tool ${name}`);
  return t;
}

function mockFetch(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        headers: { get: () => "application/json" },
      } as unknown as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new PosternClient("https://api.example", "tok");

const ROW = {
  address: "bob@example.com",
  displayName: "Bob Example",
  lastUsedAt: "2026-06-18T12:00:00Z",
  messageCount: 2,
};

describe("mailbox_recipients_recent (#805)", () => {
  it("is a read tool", () => {
    const t = tool("mailbox_recipients_recent");
    expect(t.scope).toBe("read");
  });

  it("tells the agent what the row means, including identityScope", () => {
    const d = tool("mailbox_recipients_recent").description;
    expect(d).toMatch(/identityScope/);
    expect(d).toMatch(/displayName/);
    expect(d).toMatch(/lastUsedAt/);
    expect(d).toMatch(/messageCount/);
    // Outbound only. An agent that reads this as "everyone who wrote to me" will
    // compose against the wrong set.
    expect(d).toMatch(/outbound/);
    expect(d).toMatch(/scanLimited/);
  });

  it("GETs /api/recipients/recent and passes the worker row and scope through", async () => {
    const calls = mockFetch({
      ok: true,
      identityScope: { kind: "member", addresses: ["alice@skyphusion.org"] },
      recipients: [ROW],
    });
    const out = await tool("mailbox_recipients_recent").handler(client(), {
      viewer: "alice@skyphusion.org",
      to: "alice@skyphusion.org",
      limit: 10,
    }) as {
      identityScope: { kind: string; addresses: string[] };
      recipients: typeof ROW[];
    };

    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/api/recipients/recent");
    expect(u.searchParams.get("viewer")).toBe("alice@skyphusion.org");
    expect(u.searchParams.get("to")).toBe("alice@skyphusion.org");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(out.identityScope).toEqual({ kind: "member", addresses: ["alice@skyphusion.org"] });
    expect(out.recipients).toEqual([ROW]);
  });

  it("omits identityScope and scanLimited when the worker sent neither", async () => {
    mockFetch({ ok: true, recipients: [ROW] });
    const out = await tool("mailbox_recipients_recent").handler(client(), {}) as Record<string, unknown>;
    expect(out.recipients).toEqual([ROW]);
    expect("identityScope" in out, "an absent scope is not invented").toBe(false);
    expect("scanLimited" in out, "an absent cap flag is not invented").toBe(false);
  });

  it("relays scanLimited only when the worker set it", async () => {
    mockFetch({
      ok: true,
      identityScope: { kind: "estate" },
      scanLimited: true,
      recipients: [],
    });
    const out = await tool("mailbox_recipients_recent").handler(client(), { limit: 50 }) as {
      scanLimited?: boolean;
      identityScope: { kind: string };
    };
    expect(out.scanLimited).toBe(true);
    expect(out.identityScope).toEqual({ kind: "estate" });
  });

  it("does not send viewer, to, or limit when the caller omitted them", async () => {
    const calls = mockFetch({ ok: true, recipients: [] });
    await tool("mailbox_recipients_recent").handler(client(), {});
    const u = new URL(calls[0].url);
    expect(u.searchParams.has("viewer")).toBe(false);
    expect(u.searchParams.has("to")).toBe(false);
    expect(u.searchParams.has("limit")).toBe(false);
  });
});

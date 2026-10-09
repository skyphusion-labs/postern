// #650 agent arm: mailbox_whoami.
//
// The worker route is the substance; this file guards the ONE thing the client half can
// get wrong. The client reads a worker body and applies `?? null` / `?? []` defaults, so a
// worker that omitted a field would be reported as a CONFIDENT null or an empty list
// rather than as a gap. That is the same accepted-and-ignored shape #632 catalogued, moved
// to the client side of the wire, so it is asserted here instead of assumed.

import { describe, expect, it, vi } from "vitest";
import { READ_TOOLS } from "../src/tools.js";
import { PosternClient } from "../src/client.js";

const tool = (name: string) => READ_TOOLS.find((t) => t.name === name)!;

/** A PosternClient whose only fake is the HTTP hop, so the real method body runs. */
function clientWithBody(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status === 200,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return { client: new PosternClient("https://postern.example", "tok"), fetchMock };
}

describe("#650 mailbox_whoami is registered as a read tool that takes nothing", () => {
  it("exists, is read-scoped, and declares an empty input schema", () => {
    const t = tool("mailbox_whoami");
    expect(t).toBeDefined();
    expect(t.scope).toBe("read");
    expect(Object.keys(t.inputSchema)).toEqual([]);
  });

  it("tells the agent to call it BEFORE spending a query, which the shape cannot convey", () => {
    // The whole value is ORDER: learn the scope first. A description that did not say so
    // would leave the agent doing what it already did, reading identityScope off a query
    // it had already chosen.
    expect(tool("mailbox_whoami").description).toMatch(/FIRST|before spending/i);
    expect(tool("mailbox_whoami").description).toMatch(/identityScope/);
  });
});

describe("#650 the client reports the worker's answer and invents nothing", () => {
  const FULL = {
    ok: true,
    identity: "me@skyphusion.org",
    identityScope: { kind: "member", addresses: ["me@skyphusion.org"] },
    roleQueues: ["support@skyphusion.org"],
    capabilities: ["read", "send"],
    via: "bearer",
  };

  it("passes every field through unchanged, and sends no parameters", async () => {
    const { client, fetchMock } = clientWithBody(FULL);

    const out = await client.whoami();

    expect(out).toEqual({
      identity: "me@skyphusion.org",
      identityScope: { kind: "member", addresses: ["me@skyphusion.org"] },
      roleQueues: ["support@skyphusion.org"],
      capabilities: ["read", "send"],
      via: "bearer",
    });
    // No query string: the route takes nothing, and a client that invented a parameter
    // would fail the worker's own contract suite.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe("https://postern.example/api/whoami");
  });

  it("reports an estate credential's null identity as null, not as a missing key", async () => {
    const { client } = clientWithBody({ ...FULL, identity: null, identityScope: { kind: "estate" }, roleQueues: [] });

    const out = await client.whoami();

    expect(out).toHaveProperty("identity", null);
    expect(out.identityScope).toEqual({ kind: "estate" });
    expect(out.roleQueues).toEqual([]);
  });

  it("CONTROL: the passthrough is real, so a DIFFERENT worker answer gives a different result", async () => {
    // Without this, the two arms above would pass against a client that returned a
    // hard-coded shape resembling the fixture.
    const { client } = clientWithBody({
      ...FULL,
      identity: "someone-else@skyphusion.org",
      capabilities: ["read"],
      via: "session",
    });

    const out = await client.whoami();

    expect(out.identity).toBe("someone-else@skyphusion.org");
    expect(out.capabilities).toEqual(["read"]);
    expect(out.via).toBe("session");
  });

  it("the tool hands the agent exactly what the client returned", async () => {
    const { client } = clientWithBody(FULL);

    const out = await tool("mailbox_whoami").handler(client, {});

    expect(out).toEqual(await (async () => {
      const { client: c2 } = clientWithBody(FULL);
      return c2.whoami();
    })());
  });
});

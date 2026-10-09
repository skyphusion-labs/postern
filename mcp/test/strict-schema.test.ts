// An unknown tool parameter must be REFUSED, not silently stripped. Refs #632 F1, #631.
//
// WHY THIS SUITE DRIVES A REAL SERVER AND A REAL CLIENT. Every other suite here registers tools
// against a fake server that captures the callback and invokes it directly, which bypasses
// argument validation entirely. A refusal asserted that way would be asserted against nothing.
// The SDK validates in `validateToolInput` and calls our handler with `parseResult.data`, so by
// the time a handler could look, a non-strict object schema has already dropped the unknown key.
// That is precisely why the refusal lives in the schema and why it can only be proved end to
// end, over a transport, through the code path that production uses.
//
// The defect this prevents: `mailbox_list after=2026-08-27 before=2026-08-28` returned newest-N
// and read like a date-windowed answer, because zod stripped two parameters the tool never
// declared and the call succeeded anyway. A supplied filter that is silently dropped is worse
// than one that is rejected, because the caller reasonably believes it applied.
//
// THAT EXAMPLE IS NOW HISTORY, in two steps, and this file had to change with it. #632 turned
// the strip into a refusal; #647 then DECLARED after/before on mailbox_list, so the original
// call is now answered rather than refused. The rule under test is unchanged and still
// load-bearing for every name the tools do not declare, so the arms below keep proving it with
// a decoy that will never become a real parameter. The old decoy could not stay: once a name is
// declared, the refusal it triggers is schema validation of a KNOWN key, which proves nothing
// about unknown ones. (The sibling arm in this file had the same problem with `fields` after
// #646, for the same reason.) A positive arm now pins that mailbox_list HONORS the window,
// which is what stops this file from silently going back to asserting the old behaviour.

import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { READ_TOOLS, registerTools, type Scope } from "../src/tools.js";

async function connected() {
  // The fake keeps its OWN type, so the assertions below can read `.list` as the mock it
  // is. The one cast is at the boundary where the fake meets the production signature, and
  // it stays there: casting to PosternClient here and back to a mock at every assertion is
  // what made those assertions un-type-checkable.
  const fakeClient = {
    list: vi.fn().mockResolvedValue({ items: [], cursor: null }),
    search: vi.fn().mockResolvedValue({ items: [], cursor: null }),
  };

  const server = new McpServer({ name: "postern-test", version: "0.0.0" });
  registerTools(
    server,
    fakeClient as unknown as Parameters<typeof registerTools>[1],
    new Set<Scope>(["read"]),
    READ_TOOLS,
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, fakeClient };
}

describe("an undeclared tool parameter is refused end to end", () => {
  it("mailbox_list REFUSES an undeclared parameter instead of stripping it and answering anyway", async () => {
    const { client, fakeClient } = await connected();

    // The decoy used to be `after`/`before`, the exact call from #631. #647 declares both, so
    // that call is now a legitimate windowed read (pinned by the arm below) and cannot test
    // this rule any more. The decoy has to be a name the schema will never declare.
    const res = await client.callTool({
      name: "mailbox_list",
      arguments: { direction: "inbound", notAParameter: "x", alsoNotOne: "y", limit: 20 },
    });

    // The SDK surfaces a validation failure as an error RESULT rather than a transport
    // rejection, which is the better shape here: the agent gets a readable message naming the
    // offending keys instead of an opaque protocol failure it cannot act on.
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Unrecognized key/i);
    expect(text).toContain("notAParameter");
    expect(text).toContain("alsoNotOne");
    // The stronger half: the refusal happened BEFORE any work, so no request was made and the
    // caller cannot receive a plausible-looking answer to a question it did not ask.
    expect(fakeClient.list).not.toHaveBeenCalled();
  });

  it("#647: the call from #631 is now HONORED, and the window reaches the client", async () => {
    const { client, fakeClient } = await connected();

    // The literal #631 call. It is the regression guard for this whole file: if mailbox_list
    // ever loses after/before again, the refusal arm above would still pass (a dropped
    // declaration makes them unknown keys again) and nothing else would notice.
    const res = await client.callTool({
      name: "mailbox_list",
      arguments: { direction: "inbound", after: "2026-08-27", before: "2026-08-28", limit: 20 },
    });

    expect(res.isError).toBeFalsy();
    expect(fakeClient.list).toHaveBeenCalledTimes(1);
    expect(fakeClient.list.mock.calls[0][0]).toMatchObject({
      direction: "inbound",
      after: "2026-08-27",
      before: "2026-08-28",
      limit: 20,
    });
  });

  it("CONTROL: the same call WITHOUT the undeclared parameters succeeds", async () => {
    const { client, fakeClient } = await connected();

    const res = await client.callTool({
      name: "mailbox_list",
      arguments: { direction: "inbound", limit: 20 },
    });

    // This is what makes the refusal above meaningful rather than a broken tool: the gate has a
    // reachable world in which it passes.
    expect(res.isError).toBeFalsy();
    expect(fakeClient.list).toHaveBeenCalledTimes(1);
  });

  it("mailbox_search refuses an undeclared parameter too (the rule is per-registration, not per-tool)", async () => {
    const { client } = await connected();

    // The decoy used to be `fields`, which #646 then DECLARED on this tool. That would have
    // left this gate passing for the wrong reason: `fields: "uid,date"` is now a declared key
    // carrying the wrong TYPE, so the refusal would come from schema validation of a known
    // parameter and the text would still contain "fields" -- a green test no longer measuring
    // the undeclared-key rule at all. A decoy has to be a name the schema will never declare.
    const res = await client.callTool({
      name: "mailbox_search",
      arguments: { query: "hi", notAParameter: "uid,date" },
    });

    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/Unrecognized key/i);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("notAParameter");
  });

  it("the ADVERTISED schema says so, so a well-behaved client never sends the key", async () => {
    const { client } = await connected();

    const { tools } = await client.listTools();
    const list = tools.find((t) => t.name === "mailbox_list")!;

    expect(list.inputSchema.additionalProperties).toBe(false);
    // And the declared properties are still all there: strictness must not have cost the schema.
    expect(Object.keys(list.inputSchema.properties ?? {}).sort()).toEqual(
      ["after", "before", "countOnly", "cursor", "direction", "fields", "from", "lens", "limit",
        "mailbox", "q", "seenFor", "thread", "to"],
    );
  });

  it("mailbox_list can now reach `q`, which the worker always honored on this route", async () => {
    const { client, fakeClient } = await connected();

    await client.callTool({ name: "mailbox_list", arguments: { q: "invoice" } });

    // #632 F17: the worker declares `q` on messages-list and PosternClient could always send it;
    // the tool schema was the only thing standing between an agent and the filter.
    expect(fakeClient.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: "invoice" }),
    );
  });
});

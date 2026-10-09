// #645: the read-state and placement routes as MCP tools.
//
// The worker side needed nothing. POST /api/messages/{seen,flags,move} already exist,
// are declared in inbound/src/routes.ts, and are emitted into contracts/api-routes.json.
// This file covers the two halves that were missing: client methods, and tools that
// register only when an organize-capable credential exists.
//
// Three things here are the POINT of the issue rather than incidental coverage:
//
//  1. CONDITIONAL REGISTRATION. These routes carry the `organize` scope (#685), which a
//     `read` token does not satisfy. A tool that is advertised and always 403s is worse
//     than an absent tool, because an agent cannot tell a missing grant from a broken
//     route. So the gate is driven directly, both ways.
//  2. THE COUNT IS NOT A PER-ID RESULT. Every route answers `{ updated }`, a count. An
//     agent that sends five ids and reads `updated: 3` cannot learn WHICH two were
//     skipped, so the tools must not imply they know. Asserted by what the result does
//     NOT contain.
//  3. A REFUSAL PASSES THROUGH AS ITSELF. `for` is refused when it disagrees with a
//     bound identity. That must reach the agent as the worker's refusal, never flattened
//     into `updated: 0`, which reads as "nothing matched" and is a different fact.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ORGANIZE_TOOLS,
  READ_TOOLS,
  SEND_TOOLS,
  organizeTokenFrom,
  registerTools,
  type Scope,
} from "../src/tools.js";
import { PosternClient, PosternError } from "../src/client.js";

function tool(name: string) {
  const t = ORGANIZE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no such organize tool ${name}`);
  return t;
}

function fakeServer() {
  const handlers = new Map<string, (args: unknown) => Promise<any>>();
  const server: any = {
    registerTool: (name: string, _cfg: unknown, cb: (args: unknown) => Promise<any>) => {
      handlers.set(name, cb);
    },
  };
  return { server, handlers };
}

const NAMES = ["mailbox_mark_seen", "mailbox_move", "mailbox_set_flags"];

describe("ORGANIZE_TOOLS surface (#645)", () => {
  it("exposes exactly the three organize tools, all scope=organize", () => {
    expect(ORGANIZE_TOOLS.map((t) => t.name).sort()).toEqual(NAMES);
    expect(ORGANIZE_TOOLS.every((t) => t.scope === "organize")).toBe(true);
  });

  it("does not leak into the read or send sets", () => {
    // A read token must not acquire these by them sitting in the always-registered list.
    const readNames = READ_TOOLS.map((t) => t.name);
    const sendNames = SEND_TOOLS.map((t) => t.name);
    for (const n of NAMES) {
      expect(readNames).not.toContain(n);
      expect(sendNames).not.toContain(n);
    }
  });
});

describe("the organize scope gate (#645: never advertise a tool that always 403s)", () => {
  it("a read-scoped server registers NONE of them", () => {
    const { server, handlers } = fakeServer();
    const names = registerTools(server, {} as any, new Set<Scope>(["read"]), ORGANIZE_TOOLS);
    expect(names).toEqual([]);
    expect([...handlers.keys()]).toEqual([]);
  });

  it("a send-scoped server registers NONE of them either", () => {
    // `send` does not satisfy `organize` on the worker (scopeSatisfies, routes.ts), so a
    // send token must not turn these on.
    const { server } = fakeServer();
    expect(registerTools(server, {} as any, new Set<Scope>(["send"]), ORGANIZE_TOOLS)).toEqual([]);
  });

  it("an organize-scoped server registers all three", () => {
    const { server, handlers } = fakeServer();
    const names = registerTools(server, {} as any, new Set<Scope>(["organize"]), ORGANIZE_TOOLS);
    expect(names.sort()).toEqual(NAMES);
    expect([...handlers.keys()].sort()).toEqual(NAMES);
  });

  it("CONTROL: the same call still registers the read tools, so the gate is not refusing everything", () => {
    const { server } = fakeServer();
    const names = registerTools(server, {} as any, new Set<Scope>(["read"]), READ_TOOLS);
    expect(names.sort()).toEqual([
      "mailbox_folders", "mailbox_get", "mailbox_get_attachment", "mailbox_list",
      "mailbox_search", "mailbox_thread", "mailbox_whoami",
    ]);
  });
});

describe("organizeTokenFrom: the credential decision (#645)", () => {
  it("no slots set means NO organize credential", () => {
    expect(organizeTokenFrom({}, "primary")).toBe("");
  });

  it("POSTERN_ORGANIZE_TOKEN is used on its own", () => {
    expect(organizeTokenFrom({ POSTERN_ORGANIZE_TOKEN: "org-tok" }, "primary")).toBe("org-tok");
  });

  it("POSTERN_MCP_ORGANIZE=1 reuses the primary token", () => {
    expect(organizeTokenFrom({ POSTERN_MCP_ORGANIZE: "1" }, "primary")).toBe("primary");
  });

  it("its own token WINS over the reuse flag, so the narrower credential is preferred", () => {
    expect(
      organizeTokenFrom({ POSTERN_ORGANIZE_TOKEN: "org-tok", POSTERN_MCP_ORGANIZE: "1" }, "primary"),
    ).toBe("org-tok");
  });

  it("a blank or whitespace token is UNSET, not a credential", () => {
    // This is how a half-finished config reaches production. A blank Bearer would 401 at
    // the worker with nothing for the agent to read, so it must not enable the tools.
    expect(organizeTokenFrom({ POSTERN_ORGANIZE_TOKEN: "   " }, "primary")).toBe("");
    expect(organizeTokenFrom({ POSTERN_ORGANIZE_TOKEN: "" }, "primary")).toBe("");
  });

  it("only the literal 1 turns on reuse", () => {
    // POSTERN_MCP_ORGANIZE=0 means off to anyone who writes it, so a truthiness test
    // would read it backwards.
    for (const v of ["0", "true", "yes", "", " "]) {
      expect(organizeTokenFrom({ POSTERN_MCP_ORGANIZE: v }, "primary")).toBe("");
    }
  });
});

describe("mailbox_mark_seen (#645)", () => {
  it("forwards ids and the value to client.setSeen", async () => {
    const client: any = { setSeen: vi.fn().mockResolvedValue(2) };
    const out: any = await tool("mailbox_mark_seen").handler(client, { ids: ["a", "b"], seen: true });
    expect(client.setSeen).toHaveBeenCalledWith(["a", "b"], true, undefined);
    expect(out).toEqual({ updated: 2, requested: 2, unchanged: 0, seen: true });
  });

  it("forwards for_recipient as the per-recipient override", async () => {
    const client: any = { setSeen: vi.fn().mockResolvedValue(1) };
    await tool("mailbox_mark_seen").handler(client, {
      ids: ["a"], seen: false, for_recipient: "ada@example.com",
    });
    expect(client.setSeen).toHaveBeenCalledWith(["a"], false, "ada@example.com");
  });

  it("reports a SHORT count as requested/updated/unchanged and names no ids", async () => {
    // The #645 warning, asserted. Five asked, three matched: the caller can SEE the
    // shortfall, and the answer carries nothing that could be mistaken for the list that
    // landed.
    const client: any = { setSeen: vi.fn().mockResolvedValue(3) };
    const out: any = await tool("mailbox_mark_seen").handler(client, {
      ids: ["a", "b", "c", "d", "e"], seen: true,
    });
    expect(out.requested).toBe(5);
    expect(out.updated).toBe(3);
    expect(out.unchanged).toBe(2);
    expect(out.ids).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("\"a\"");
  });

  it("does NOT echo for_recipient back, because the server may override it", async () => {
    // Under a bound token the worker binds the write to the token's identity even when
    // for_recipient is omitted, so echoing the ARGUMENT would be a false confirmation of
    // whose state was written. Same defect class as #651.
    const client: any = { setSeen: vi.fn().mockResolvedValue(1) };
    const out: any = await tool("mailbox_mark_seen").handler(client, {
      ids: ["a"], seen: true, for_recipient: "ada@example.com",
    });
    expect(out.forRecipient).toBeUndefined();
    expect(out.for_recipient).toBeUndefined();
  });

  it("passes a `for` REFUSAL through as itself, never as a zero count", async () => {
    // The issue is explicit: pass the refusal through as itself rather than as a zero
    // count. `updated: 0` reads as "nothing matched", which is a different fact from
    // "you may not write that identity's state".
    const refusal = new PosternError(
      "Postern API returned 403: for must match the session identity",
      403,
    );
    const client: any = { setSeen: vi.fn().mockRejectedValue(refusal) };
    await expect(
      tool("mailbox_mark_seen").handler(client, {
        ids: ["a"], seen: true, for_recipient: "someone-else@example.com",
      }),
    ).rejects.toThrow(/for must match the session identity/);
  });

  it("the refusal reaches an agent as an isError result carrying the worker's words", async () => {
    // End to end through the registered handler, which is where an agent actually sees it.
    const { server, handlers } = fakeServer();
    const client: any = {
      setSeen: vi.fn().mockRejectedValue(
        new PosternError("Postern API returned 403: for must match the session identity", 403),
      ),
    };
    registerTools(server, client, new Set<Scope>(["organize"]), ORGANIZE_TOOLS);
    const res = await handlers.get("mailbox_mark_seen")!({ ids: ["a"], seen: true, for_recipient: "x@y.com" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("for must match the session identity");
    // And it is NOT a success payload with a zero count.
    expect(res.content[0].text).not.toContain("updated");
  });
});

describe("mailbox_set_flags (#645)", () => {
  it("sends only the flags the caller set, so an omitted flag is left alone", async () => {
    const client: any = { setFlags: vi.fn().mockResolvedValue(1) };
    const out: any = await tool("mailbox_set_flags").handler(client, { ids: ["a"], flagged: true });
    expect(client.setFlags).toHaveBeenCalledWith(["a"], { flagged: true });
    // `answered` must be absent from the set, not present-and-undefined: the worker
    // reads the set it is given.
    const sent = client.setFlags.mock.calls[0][1];
    expect("answered" in sent).toBe(false);
    expect(out).toEqual({ updated: 1, requested: 1, unchanged: 0, set: { flagged: true } });
  });

  it("carries both flags when both are set, including false", async () => {
    const client: any = { setFlags: vi.fn().mockResolvedValue(1) };
    await tool("mailbox_set_flags").handler(client, { ids: ["a"], flagged: false, answered: true });
    expect(client.setFlags).toHaveBeenCalledWith(["a"], { flagged: false, answered: true });
  });

  it("refuses a call that sets NEITHER flag, and sends nothing", async () => {
    // The worker refuses the same shape. Refusing here gives the caller the reason
    // instead of a 400 to interpret, and a no-op that reports success would be worse
    // than either.
    const client: any = { setFlags: vi.fn() };
    await expect(
      tool("mailbox_set_flags").handler(client, { ids: ["a"] }),
    ).rejects.toThrow(/flagged.*answered|at least one/);
    expect(client.setFlags).not.toHaveBeenCalled();
  });
});

describe("mailbox_move (#645)", () => {
  it("forwards the destination folder", async () => {
    const client: any = { move: vi.fn().mockResolvedValue(2) };
    const out: any = await tool("mailbox_move").handler(client, { ids: ["a", "b"], mailbox: "archive" });
    expect(client.move).toHaveBeenCalledWith(["a", "b"], "archive");
    expect(out).toEqual({ updated: 2, requested: 2, unchanged: 0, mailbox: "archive" });
  });

  it("sends a literal null to RESTORE the default view", async () => {
    // null is a real destination on this route, not a missing value, so it must reach
    // the client as null rather than being dropped.
    const client: any = { move: vi.fn().mockResolvedValue(1) };
    const out: any = await tool("mailbox_move").handler(client, { ids: ["a"], mailbox: null });
    expect(client.move).toHaveBeenCalledWith(["a"], null);
    expect(out.mailbox).toBeNull();
  });

  it("accepts trash and junk, which are SOFT placements", async () => {
    for (const box of ["trash", "junk"]) {
      const client: any = { move: vi.fn().mockResolvedValue(1) };
      await tool("mailbox_move").handler(client, { ids: ["a"], mailbox: box });
      expect(client.move).toHaveBeenCalledWith(["a"], box);
    }
  });
});

describe("the client methods on the wire (#645)", () => {
  function recorder(responseBody: unknown) {
    const seen: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        seen.push({ url, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(responseBody),
          headers: { get: () => null },
        } as unknown as Response;
      }),
    );
    return seen;
  }

  it("setSeen POSTs ids + seen, and omits `for` when not supplied", async () => {
    const seen = recorder({ ok: true, updated: 2 });
    const c = new PosternClient("https://api.example", "tok");
    await expect(c.setSeen(["a", "b"], true)).resolves.toBe(2);
    const call = seen[0];
    expect(new URL(call.url).pathname).toBe("/api/messages/seen");
    expect(call.init.method).toBe("POST");
    const body = JSON.parse(call.init.body);
    expect(body).toEqual({ ids: ["a", "b"], seen: true });
    // Absent `for` is the ESTATE write, a different operation from a per-recipient
    // override, so it must not be defaulted onto the wire.
    expect("for" in body).toBe(false);
    vi.unstubAllGlobals();
  });

  it("setSeen sends `for` under the route's own name when supplied", async () => {
    const seen = recorder({ ok: true, updated: 1 });
    const c = new PosternClient("https://api.example", "tok");
    await c.setSeen(["a"], false, "ada@example.com");
    expect(JSON.parse(seen[0].init.body)).toEqual({
      ids: ["a"], seen: false, for: "ada@example.com",
    });
    vi.unstubAllGlobals();
  });

  it("setFlags POSTs a nested set, and move POSTs the placement", async () => {
    const seen = recorder({ ok: true, updated: 1 });
    const c = new PosternClient("https://api.example", "tok");
    await c.setFlags(["a"], { flagged: true });
    await c.move(["a"], null);
    expect(new URL(seen[0].url).pathname).toBe("/api/messages/flags");
    expect(JSON.parse(seen[0].init.body)).toEqual({ ids: ["a"], set: { flagged: true } });
    expect(new URL(seen[1].url).pathname).toBe("/api/messages/move");
    expect(JSON.parse(seen[1].init.body)).toEqual({ ids: ["a"], mailbox: null });
    vi.unstubAllGlobals();
  });

  it("a response with NO updated count throws, instead of reporting zero", async () => {
    // Zero is a real answer here ("nothing you named was reachable"), so coercing a
    // MISSING count into zero would manufacture that answer from a malformed response.
    // Same defect as the old `cursor ?? null` flattening.
    recorder({ ok: true });
    const c = new PosternClient("https://api.example", "tok");
    await expect(c.setSeen(["a"], true)).rejects.toThrow(/updated count/);
    vi.unstubAllGlobals();
  });

  it("CONTROL: a well-formed zero IS reported as zero", async () => {
    // Otherwise the guard above could be passing by refusing every answer.
    recorder({ ok: true, updated: 0 });
    const c = new PosternClient("https://api.example", "tok");
    await expect(c.setSeen(["a"], true)).resolves.toBe(0);
    vi.unstubAllGlobals();
  });
});

describe("#645 REACHABILITY: the tools expose every body key the worker honors", () => {
  // The body-route counterpart of the #632 F17 arm in worker-contract.test.ts, which
  // only covers the two GET surfaces. Read from the generated contract, never a
  // hand-copied list, so a worker-side rename shows up here.
  const PARAMS: Record<string, { body?: string[] }> = JSON.parse(
    readFileSync(new URL("../../contracts/api-params.json", import.meta.url), "utf8"),
  ).params;

  // Worker body key -> tool input name. A rename is legitimate; an unrecorded rename and
  // a missing parameter look identical from outside, so each one is written down.
  const ALIASES: Record<string, Record<string, string>> = {
    "messages-seen": { for: "for_recipient" },
    "messages-flags": { set: "", "set.flagged": "flagged", "set.answered": "answered" },
    "messages-move": {},
  };

  const ROUTE_FOR: Record<string, string> = {
    mailbox_mark_seen: "messages-seen",
    mailbox_set_flags: "messages-flags",
    mailbox_move: "messages-move",
  };

  for (const [toolName, routeId] of Object.entries(ROUTE_FOR)) {
    it(`${toolName}: every declared body key is reachable`, () => {
      const declared = PARAMS[routeId]?.body ?? [];
      expect(declared.length, `no body keys declared for ${routeId}: measuring nothing`).toBeGreaterThan(1);
      const keys = new Set(Object.keys(tool(toolName).inputSchema));
      const alias = ALIASES[routeId];
      const missing = declared.filter((n) => {
        const mapped = n in alias ? alias[n] : n;
        // "" marks a key that exists only as the CONTAINER of aliased children
        // (flags' `set`), which the tool builds rather than accepts.
        return mapped !== "" && !keys.has(mapped);
      });
      expect(missing, `declared by the worker, absent from ${toolName}: ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("CONTROL: the check can report a genuine gap", () => {
    const keys = new Set(Object.keys(tool("mailbox_move").inputSchema));
    expect(["nOtApArAm"].filter((n) => !keys.has(n))).toEqual(["nOtApArAm"]);
    expect(keys.has("ids")).toBe(true);
  });
});

describe("#645 the descriptions say what a short count means", () => {
  it("every organize tool warns that the answer is a count, not a per-id result", () => {
    // The issue's requirement: do not let the tool imply it knows which ids landed. The
    // result shape carries the counts; the description is where a caller learns what a
    // shortfall means and what to do about it.
    for (const t of ORGANIZE_TOOLS) {
      expect(t.description, t.name).toMatch(/COUNTS, NOT PER-ID RESULTS/);
      expect(t.description, t.name).toMatch(/CANNOT SAY WHICH/);
      expect(t.description, t.name).toMatch(/mailbox_list|mailbox_get/);
    }
  });

  it("every organize tool says it is MUTATING", () => {
    for (const t of ORGANIZE_TOOLS) expect(t.description, t.name).toMatch(/MUTATING/);
  });

  it("mailbox_move says trash is a soft placement, not a delete", () => {
    expect(tool("mailbox_move").description).toMatch(/SOFT move|never deletes/);
  });
});

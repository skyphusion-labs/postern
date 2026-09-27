// #417: the MCP client against the worker's real route table, not a fake of it.
//
// Every suite in this repo used to mock its own idea of the worker: this one faked
// fetch, clients/python injected a fake transport, the door faked the API. A fake can
// never disagree with the client it was written beside, which is exactly how the
// published clients drifted a feature generation behind the worker with green CI the
// whole way.
//
// This test drives the REAL client and compares what it EMITS against
// inbound/route-table.json, the projection of the worker's own declared table
// (inbound/src/routes.ts, kept honest by inbound/route-table.test.ts, which proves
// every declared parameter is live against the real handler). Two directions, kept
// separate on purpose:
//
//   A. SOUNDNESS (hard): every path, method, query parameter, and body key the client
//      emits must exist in the table. A worker-side rename or removal fails here.
//   B. PARITY (tracked): every parameter the worker honors should be reachable from
//      the client. Gaps are listed explicitly in KNOWN_PARITY_GAPS, and a gap that
//      CLOSES without the list shrinking fails too, so the list can only ever shrink
//      and cannot rot into a permanent excuse.

import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PosternClient } from "../src/client.js";
import { z } from "zod";
import { READ_TOOLS, SEND_TOOLS, type ToolDef } from "../src/tools.js";

interface RouteRow {
  id: string;
  method: string;
  path: string;
  match: "exact" | "prefix";
  scope: string | null;
  auth: string;
  exclude?: string;
  requireChild?: boolean;
  requireSeparator?: boolean;
  template?: string;
  note?: string;
}

const ROUTES: RouteRow[] = JSON.parse(
  readFileSync(new URL("../../contracts/api-routes.json", import.meta.url), "utf8"),
).routes;

const PARAMS: Record<string, { query?: string[]; body?: string[]; note?: string }> = JSON.parse(
  readFileSync(new URL("../../contracts/api-params.json", import.meta.url), "utf8"),
).params;

// The matching rules api-routes.json documents, implemented the way any client would
// have to implement them. Controls below prove this agrees with the manifest.
function matchRoute(method: string, path: string): RouteRow | null {
  for (const row of ROUTES) {
    if (row.method !== "ANY" && row.method !== method) continue;
    let hit: boolean;
    if (row.match === "exact") hit = path === row.path;
    else if (row.exclude && path.includes(row.exclude)) hit = false;
    // The bare path or a child under it, never a SIBLING: /api/drafts2 is not
    // /api/drafts. The flag exists because a plain prefix cannot say that.
    else if (row.requireSeparator) hit = path === row.path || path.startsWith(`${row.path}/`);
    else hit = path.startsWith(row.path) && path.length - row.path.length >= (row.requireChild ? 1 : 0);
    if (hit) return row;
  }
  return null;
}

/** The query/body names api-params.json declares for a matched row. */
function accepted(row: RouteRow | null, kind: "query" | "body"): Set<string> {
  return new Set(row ? PARAMS[row.id]?.[kind] ?? [] : []);
}

interface Emitted {
  label: string;
  method: string;
  path: string;
  query: string[];
  body: string[];
}

/** Records what the client puts on the wire, with no opinion about it. */
function recorder() {
  const seen: Array<{ url: string; init: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      seen.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, items: [], cursor: null, message: null, messages: [] }),
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response;
    }),
  );
  return seen;
}

function describeCall(label: string, call: { url: string; init: any }): Emitted {
  const u = new URL(call.url);
  let body: string[] = [];
  if (typeof call.init?.body === "string") {
    const parsed = JSON.parse(call.init.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = Object.keys(parsed);
      const nested = (parsed as Record<string, unknown>).set;
      if (nested && typeof nested === "object") {
        body.push(...Object.keys(nested as Record<string, unknown>).map((k) => `set.${k}`));
      }
    }
  }
  return {
    label,
    method: call.init?.method ?? "GET",
    path: u.pathname,
    query: [...new Set(u.searchParams.keys())],
    body,
  };
}

/** Drive every client method with every argument it accepts, so nothing is missed. */
async function emissions(): Promise<Emitted[]> {
  const seen = recorder();
  const c = new PosternClient("https://api.example", "tok");
  const client = c as unknown as Record<string, (...a: any[]) => Promise<unknown>>;
  const out: Emitted[] = [];
  const run = async (label: string, fn: () => Promise<unknown>) => {
    const before = seen.length;
    try {
      await fn();
    } catch {
      // A client-side throw still leaves the emitted request recorded; the contract
      // is about what went on the wire, not what came back from a stub response.
    }
    for (const call of seen.slice(before)) out.push(describeCall(label, call));
  };

  // Search and list carry every filter the client knows how to send. Unknown-to-this
  // -client arguments are simply ignored by it, which is what parity below measures.
  await run("search", () =>
    client.search({
      q: "x", mode: "substr", field: "subject", limit: 5, cursor: "c", direction: "inbound",
      to: "a@x.com", from: "b@x.com", lens: "inbox", mailbox: "archive", seenFor: "a@x.com",
      after: "2026-01-01", before: "2026-02-01", hasAttachment: true, seen: false,
    }),
  );
  await run("list", () =>
    client.list({
      to: "a@x.com", from: "b@x.com", thread: "t", direction: "inbound", lens: "inbox",
      q: "x", limit: 5, cursor: "c", mailbox: "archive", seenFor: "a@x.com",
    }),
  );
  await run("get", () => client.get("m1"));
  await run("thread", () => client.thread("t1"));
  await run("getAttachmentBytes", () => client.getAttachmentBytes("m1", 0));
  await run("send", () =>
    client.send({
      to: ["a@x.com"], cc: ["c@x.com"], bcc: ["b@x.com"], subject: "s", text: "t", html: "<p>t</p>",
      from: "me@x.com", replyTo: "r@x.com", headers: { "X-Tag": "v" },
    }),
  );
  await run("reply", () => client.reply({ messageId: "m1", text: "t", cc: ["c@x.com"] }));

  // Optional surfaces: present only once the client grows them (#415). Calling a
  // method that does not exist records nothing, which parity then reports as a gap.
  for (const [label, call] of [
    ["folders", () => client.folders?.({})],
    ["setSeen", () => client.setSeen?.(["m1"], true)],
    ["setFlags", () => client.setFlags?.(["m1"], { flagged: true })],
    ["move", () => client.move?.(["m1"], "archive")],
    ["deleteMessage", () => client.deleteMessage?.("m1")],
  ] as const) {
    if (typeof client[label] === "function") await run(label, async () => call());
  }
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("#417 the route table fixture is usable and this matcher agrees with it", () => {
  it("CONTROL: both fixtures loaded, and they JOIN", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
    expect(Object.keys(PARAMS).length).toBeGreaterThan(10);
    for (const path of ["/api/send", "/api/reply", "/api/messages", "/api/search", "/api/folders"]) {
      expect(ROUTES.some((r) => r.path === path)).toBe(true);
    }
    // Without the join every allowed-set below would be empty and every subset
    // assertion would pass for the wrong reason.
    expect(accepted(matchRoute("GET", "/api/messages"), "query").size).toBeGreaterThan(5);
    expect(accepted(matchRoute("POST", "/api/send"), "body").size).toBeGreaterThan(5);
  });

  it("CONTROL: the matcher resolves the shapes the manifest declares, and can miss", () => {
    expect(matchRoute("GET", "/api/messages")?.id).toBe("messages-list");
    expect(matchRoute("GET", "/api/messages/m1")?.id).toBe("message-get");
    expect(matchRoute("GET", "/api/messages/m1/attachments/0")?.scope).toBe("read");
    expect(matchRoute("DELETE", "/api/messages/m1")?.scope).toBe("delete");
    expect(matchRoute("GET", "/api/not-a-route")).toBeNull();
    expect(matchRoute("PUT", "/api/messages")).toBeNull();
  });
});

describe("#417 COVERAGE: no client method can skip this file", () => {
  // Folded in from the route-contract suite this file replaces (#449, strummer): the
  // emission driver above is only as good as its list of calls, so reflect over the
  // client and require every public method to be exercised. A new method with a new
  // path or parameter cannot slip past by simply not being called here.
  const NON_EMITTING = new Set(["request", "requestGet", "requestPost", "asSendResult"]);

  it("every public client method is either exercised or declared request-free", async () => {
    const methods = Object.getOwnPropertyNames(PosternClient.prototype).filter(
      (n) => n !== "constructor" && typeof (PosternClient.prototype as never)[n] === "function",
    );
    const exercised = new Set((await emissions()).map((e) => e.label));
    const missing = methods.filter((m) => !exercised.has(m) && !NON_EMITTING.has(m));
    expect(missing, `client methods with no contract exercise: ${missing.join(", ")}`).toEqual([]);
  });

  it("CONTROL: the reflection sees real methods, and the allowlist is not a blanket", async () => {
    const methods = Object.getOwnPropertyNames(PosternClient.prototype);
    expect(methods).toContain("search");
    expect(methods).toContain("list");
    expect(methods.length).toBeGreaterThan(5);
    // A method that emits nothing AND is not allowlisted would fail the test above,
    // which is what makes it a gate rather than a formality.
    expect(NON_EMITTING.has("search")).toBe(false);
  });
});

describe("#417 SOUNDNESS: everything the MCP client emits exists in the worker table", () => {
  it("CONTROL: driving the client actually emitted requests", async () => {
    const calls = await emissions();
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.some((c) => c.path === "/api/search")).toBe(true);
  });

  it("every emitted path+method is routed by the worker", async () => {
    const unrouted = (await emissions())
      .filter((c) => !matchRoute(c.method, c.path))
      .map((c) => `${c.label}: ${c.method} ${c.path}`);
    expect(unrouted).toEqual([]);
  });

  it("every emitted query parameter is one the worker reads on that route", async () => {
    const bad: string[] = [];
    for (const call of await emissions()) {
      const allowed = accepted(matchRoute(call.method, call.path), "query");
      for (const name of call.query) {
        if (!allowed.has(name)) bad.push(`${call.label}: ${call.method} ${call.path}?${name}=`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every emitted body key is one the worker reads on that route", async () => {
    const bad: string[] = [];
    for (const call of await emissions()) {
      const allowed = accepted(matchRoute(call.method, call.path), "body");
      for (const key of call.body) {
        if (!allowed.has(key)) bad.push(`${call.label}: ${call.method} ${call.path} body.${key}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// Parameters the worker honors that this client cannot send today. This list is a
// LEDGER, not a permission: it must only ever shrink, and the test below fails if an
// entry is stale, so closing a gap forces the entry out in the same PR.
//
// This ledger was written with the two list filters and seven search filters the
// client could not send. #415 (PR #445) closed all but one; #453 closed the last one,
// `seenFor` (the #404 read-state PROJECTION key: whose seen state a read renders,
// independent of which rows come back). Decided #453: an MCP token is a static,
// estate-scoped credential, exactly the caller class docs/CONTRACT.md 10.9 allows to
// name any address via `seenFor`, so this client can and now does send it, matching
// python (#413) and the imap door (#423). The path keys stay (values empty) so a
// future declared param on either route that this client cannot reach is still
// caught, rather than the routes dropping out of parity coverage entirely.
const KNOWN_PARITY_GAPS: Record<string, string[]> = {
  "/api/messages": [],
  "/api/search": [],
};

describe("#417 PARITY: what the worker honors, the client can reach", () => {
  async function reachable(path: string): Promise<Set<string>> {
    const calls = await emissions();
    const names = new Set<string>();
    for (const c of calls) if (c.path === path) c.query.forEach((n) => names.add(n));
    return names;
  }

  for (const path of Object.keys(KNOWN_PARITY_GAPS)) {
    it(`${path}: every honored parameter is reachable, except the listed gaps`, async () => {
      const row = ROUTES.find((r) => r.path === path && r.method === "GET")!;
      const declared = PARAMS[row.id]?.query ?? [];
      const can = await reachable(path);
      const missing = declared.filter((n) => !can.has(n)).sort();
      expect(missing).toEqual([...KNOWN_PARITY_GAPS[path]].sort());
    });

    it(`${path}: no STALE gap entries (a closed gap must leave the ledger)`, async () => {
      const can = await reachable(path);
      const stale = KNOWN_PARITY_GAPS[path].filter((n) => can.has(n));
      expect(
        stale,
        `these parameters now work and must be deleted from KNOWN_PARITY_GAPS["${path}"]: ${stale.join(", ")}`,
      ).toEqual([]);
    });

    it(`${path}: CONTROL: the ledger mechanism itself can fail`, async () => {
      // joan's #425 point: a gap list is exactly the kind of thing that quietly stops
      // being consulted, and a negative-only check over a dead mechanism passes for the
      // wrong reason. So exercise both arms against a KNOWN answer: a parameter the
      // client demonstrably CAN send must read as stale if it were listed, and one it
      // cannot must read as a live gap.
      const can = await reachable(path);
      expect(can.size, "no parameters recorded at all: the ledger is measuring nothing").toBeGreaterThan(3);
      expect([...can].filter((n) => can.has(n)).length).toBeGreaterThan(0); // stale arm fires
      expect(["nOtApArAm"].filter((n) => !can.has(n))).toEqual(["nOtApArAm"]); // gap arm fires
    });
  }
});

// ---------------------------------------------------------------------------------------
// #632 F1/F17: the two arms this suite was missing, and why its two existing arms could not
// see the defect that shipped.
//
// SOUNDNESS asks: is every EMITTED parameter declared by the worker?
// PARITY asks: is every DECLARED parameter reachable by the CLIENT?
//
// A parameter that a TOOL SCHEMA accepts and then drops is emitted by nobody and declared by
// nobody, so it satisfies both arms and neither can observe it. That is exactly what happened:
// `mailbox_list` accepted `after`/`before` in practice (zod stripped them), the call succeeded,
// and the suite stayed green while the answer was newest-N. The mirror image also hid: `q` is
// declared by the worker on messages-list and PosternClient could always send it, so PARITY
// read clean, while no agent could reach it because the TOOL did not expose it.
//
// So the missing axis is the TOOL schema, on both sides of it:
//   FORWARDING  -- every inputSchema key must demonstrably change the request.
//   REACHABILITY -- every parameter the worker honors on a tool's route must be in that
//                   tool's inputSchema.
// ---------------------------------------------------------------------------------------

/** A valid sample per parameter NAME, shared across tools so a new key cannot be tested with a
 *  value that happens to be ignored. A key with no sample is a FAILURE, not a skip: that keeps
 *  this table honest as the schemas grow, instead of letting new parameters quietly opt out. */
const SAMPLE: Record<string, unknown> = {
  query: "kw", q: "kw", mode: "substr", field: "subject", limit: 7, cursor: "cur-1",
  direction: "inbound", to: "a@example.com", from: "b@example.com", lens: "inbox",
  mailbox: "archive", seenFor: "a@example.com", after: "2026-01-01", before: "2026-02-01",
  hasAttachment: true, seen: false, thread: "t-1", message_id: "m-1", thread_id: "t-1",
  index: 0, subject: "s", text: "t", html: "<p>h</p>", cc: "c@example.com",
  bcc: "d@example.com", reply_to: "r@example.com", quote_original: true,
  attachments: [{ content: "QQ==", filename: "a.txt", mime_type: "text/plain" }],
};

/** Keys a tool needs for its handler to reach the wire at all. */
const REQUIRED: Record<string, string[]> = {
  mailbox_search: ["query"],
  mailbox_list: [],
  mailbox_get: ["message_id"],
  mailbox_thread: ["thread_id"],
  mailbox_get_attachment: ["message_id", "index"],
  mailbox_send: ["to", "subject", "text"],
  mailbox_reply: ["message_id", "text"],
};

/** Everything a request carries, VALUES included: a key whose presence changes only a value
 *  (mode, which the handler always sends with a default) would be invisible to a key-set diff. */
function fingerprint(calls: Emitted[], raw: Array<{ url: string; init: any }>): string {
  return JSON.stringify(
    raw.map((c) => {
      const u = new URL(c.url);
      const q = [...u.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`);
      return { m: c.init?.method ?? "GET", p: u.pathname, q, b: c.init?.body ?? null };
    }),
  );
}

async function emitFor(tool: ToolDef, args: Record<string, unknown>): Promise<string> {
  const seen = recorder();
  const client = new PosternClient("https://api.example", "tok");
  try {
    await tool.handler(client, args);
  } catch {
    // A client-side or stub-response throw still leaves the request recorded, and the request
    // is the subject here.
  }
  const fp = fingerprint([], seen);
  vi.unstubAllGlobals();
  return fp;
}

function baselineArgs(tool: ToolDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of REQUIRED[tool.name] ?? []) out[k] = SAMPLE[k];
  return out;
}

const ALL_TOOLS: ToolDef[] = [...READ_TOOLS, ...SEND_TOOLS];

describe("#632 F1 FORWARDING: every inputSchema key demonstrably changes the request", () => {
  for (const tool of ALL_TOOLS) {
    it(`${tool.name}: no declared parameter is accepted and dropped`, async () => {
      const base = baselineArgs(tool);
      const baseFp = await emitFor(tool, base);
      const required = new Set(REQUIRED[tool.name] ?? []);
      const dropped: string[] = [];
      const unsampled: string[] = [];

      for (const key of Object.keys(tool.inputSchema)) {
        if (required.has(key)) continue; // already in the baseline
        if (!(key in SAMPLE)) {
          unsampled.push(key);
          continue;
        }
        const withKey = await emitFor(tool, { ...base, [key]: SAMPLE[key] });
        if (withKey === baseFp) dropped.push(key);
      }

      expect(
        unsampled,
        `add a SAMPLE value for these so they are actually exercised: ${unsampled.join(", ")}`,
      ).toEqual([]);
      expect(
        dropped,
        `these parameters are declared to the agent and never reach the worker: ${dropped.join(", ")}`,
      ).toEqual([]);
    });
  }

  it("CONTROL: the checker CATCHES an accepted-and-dropped parameter", async () => {
    // The arm above passes on today's code, so on its own it proves nothing about whether it
    // could fail. This is the defect it exists for, built deliberately: a tool that advertises
    // `after` and never forwards it, which is the exact shape of #631's mailbox_list call.
    const decoy: ToolDef = {
      name: "decoy_list",
      scope: "read",
      description: "stub",
      inputSchema: {
        to: z.string().optional(),
        after: z.string().optional(), // declared, never forwarded
      },
      handler: async (client, a) => client.list({ to: (a as { to?: string }).to }),
    };

    const base = await emitFor(decoy, {});
    const withTo = await emitFor(decoy, { to: SAMPLE.to });
    const withAfter = await emitFor(decoy, { after: SAMPLE.after });

    expect(withTo, "a forwarded parameter must change the request").not.toBe(base);
    expect(withAfter, "a dropped parameter leaves the request identical: this is the catch").toBe(base);
  });
});

/** Worker parameters a tool reaches under a DIFFERENT name. Renames are legitimate (an agent
 *  reads `query` more easily than `q`) but each one is written down here, because an unrecorded
 *  rename and a missing parameter look identical from the outside. */
const TOOL_PARAM_ALIASES: Record<string, Record<string, string>> = {
  mailbox_search: { q: "query" },
  mailbox_list: {},
};

/** Worker parameters a tool deliberately does not expose. MUST only ever shrink, and the test
 *  below fails on a STALE entry, so closing a gap forces the entry out in the same change. */
const TOOL_REACH_GAPS: Record<string, string[]> = {
  mailbox_search: [],
  mailbox_list: [],
};

describe("#632 F17 REACHABILITY: what the worker honors on a tool's route, the TOOL exposes", () => {
  const routeFor: Record<string, string> = {
    mailbox_search: "search",
    mailbox_list: "messages-list",
  };

  for (const [toolName, routeId] of Object.entries(routeFor)) {
    const tool = READ_TOOLS.find((t) => t.name === toolName)!;

    it(`${toolName}: every honored parameter is in the inputSchema, except the listed gaps`, () => {
      const declared = PARAMS[routeId]?.query ?? [];
      const alias = TOOL_PARAM_ALIASES[toolName];
      const keys = new Set(Object.keys(tool.inputSchema));
      const missing = declared.filter((n) => !keys.has(alias[n] ?? n)).sort();
      expect(missing).toEqual([...TOOL_REACH_GAPS[toolName]].sort());
    });

    it(`${toolName}: no STALE gap entry`, () => {
      const alias = TOOL_PARAM_ALIASES[toolName];
      const keys = new Set(Object.keys(tool.inputSchema));
      const stale = TOOL_REACH_GAPS[toolName].filter((n) => keys.has(alias[n] ?? n));
      expect(stale, `now reachable, delete from TOOL_REACH_GAPS: ${stale.join(", ")}`).toEqual([]);
    });

    it(`${toolName}: CONTROL: the check can report a genuine gap`, () => {
      const declared = PARAMS[routeId]?.query ?? [];
      expect(declared.length, "no declared parameters read at all: measuring nothing").toBeGreaterThan(3);
      const keys = new Set(Object.keys(tool.inputSchema));
      expect(["nOtApArAm"].filter((n) => !keys.has(n))).toEqual(["nOtApArAm"]);
    });
  }
});

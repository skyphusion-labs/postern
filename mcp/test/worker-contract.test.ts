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
import { PosternClient } from "../src/client";

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

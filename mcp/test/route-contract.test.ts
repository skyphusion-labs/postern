import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PosternClient } from "../src/client";

// Cross-seam route contract for the MCP client (#417).
//
// The rest of this suite stubs global fetch, and a stub can never disagree with
// the client: that is how the published clients drifted a feature generation
// behind the worker with every suite green. Here the URLs the client ACTUALLY
// emits are checked against contracts/api-routes.json, the shared route table the
// worker validates itself against (inbound/route-contract.test.ts drives the real
// handleApi over the same file). So a worker route that is renamed or removed
// fails HERE, in the client that would have started 404ing in production.
//
// What this proves: every path this client emits is a path the worker serves, with
// a method the worker accepts on it. Param-level agreement is the next layer.

type Row = {
  id: string;
  method: string;
  path: string;
  match: "exact" | "prefix";
  scope: string | null;
  auth: string;
};

const MANIFEST = JSON.parse(
  readFileSync(new URL("../../contracts/api-routes.json", import.meta.url), "utf8"),
) as { routes: Row[] };

function rowFor(method: string, path: string): Row | undefined {
  return MANIFEST.routes.find((r) => {
    const methodOk = r.method === "ANY" || r.method === method;
    if (!methodOk) return false;
    return r.match === "exact" ? r.path === path : path.startsWith(r.path);
  });
}

function recordFetch() {
  const calls: { method: string; path: string; url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const u = new URL(url);
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, url });
      // Satisfies both request paths: the JSON one (text) and the raw-bytes
      // attachment one (headers + arrayBuffer), so every method gets far enough to
      // have emitted its request.
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json", "content-length": "2" }),
        text: async () => JSON.stringify({ ok: true, items: [], messages: [], cursor: null, id: "x" }),
        arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
      } as unknown as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new PosternClient("https://api.example", "tok");

// Every public method of the client, each exercised once. A new client method with
// a new path fails the assertion below unless the route is declared in the shared
// manifest (and therefore validated against the real worker).
const EXERCISES: Array<{ name: string; run: (c: PosternClient) => Promise<unknown> }> = [
  { name: "search", run: (c) => c.search({ q: "hello" }) },
  { name: "list", run: (c) => c.list({}) },
  { name: "get", run: (c) => c.get("msg-1") },
  { name: "getAttachmentBytes", run: (c) => c.getAttachmentBytes("msg-1", 0, 1024) },
  { name: "thread", run: (c) => c.thread("thread-1") },
  { name: "send", run: (c) => c.send({ to: "a@example.net", subject: "s", text: "t" } as never) },
  { name: "reply", run: (c) => c.reply({ messageId: "msg-1", text: "t" } as never) },
];

describe("MCP client route contract", () => {
  for (const ex of EXERCISES) {
    it(`${ex.name} emits a route the worker declares`, async () => {
      const calls = recordFetch();
      await ex.run(client());
      expect(calls.length, `${ex.name} emitted no request`).toBeGreaterThan(0);
      for (const call of calls) {
        const row = rowFor(call.method, call.path);
        expect(
          row,
          `${ex.name}: ${call.method} ${call.path} is not in contracts/api-routes.json`,
        ).toBeDefined();
      }
    });
  }

  // Helpers that emit no request. Listed explicitly, so a NEW method is a failure
  // here until someone either exercises it above or declares it request-free.
  const NON_EMITTING = new Set(["request", "requestGet", "requestPost", "asSendResult"]);

  it("covers every method of the client (so a new method cannot skip this file)", async () => {
    const methods = Object.getOwnPropertyNames(PosternClient.prototype).filter(
      (n) => n !== "constructor" && typeof (PosternClient.prototype as never)[n] === "function",
    );
    const exercised = new Set(EXERCISES.map((e) => e.name));
    const missing = methods.filter((m) => !exercised.has(m) && !NON_EMITTING.has(m));
    expect(missing, `client methods with no route-contract exercise: ${missing.join(", ")}`).toEqual([]);
  });

  it("control: a path the worker does not serve is NOT accepted by the matcher", () => {
    // Without this, a matcher bug that returns a row for anything would make every
    // assertion above vacuous.
    expect(rowFor("GET", "/api/not-a-route")).toBeUndefined();
    expect(rowFor("DELETE", "/api/search")).toBeUndefined();
    expect(rowFor("GET", "/api/messages")).toBeDefined();
  });
});

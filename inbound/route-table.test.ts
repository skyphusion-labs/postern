// #417 convergence: inbound/src/routes.ts is the SOURCE, and this file is what makes
// that safe. #449 made the route spine shared data and validated the scope column
// behaviorally (route-contract.test.ts, which still runs and still owns that job).
// The manifest is now GENERATED from the same declaration requiredScope() derives from,
// so there is no hand-maintained second list to be wrong. What has to be proved:
//
//   1. DERIVATION: api.ts no longer has its own copy of this mapping. The gate calls the
//      DERIVED requiredScope, and the if-chain that used to live in api.ts is copied
//      here verbatim as a REFERENCE, so the migration is proved faithful over every
//      route plus adversarial paths rather than asserted to be. It keeps earning its
//      place afterwards as a change-detector: an edit to the table that would move the
//      AUTH GATE fails against the recorded original, and has to be made deliberately.
//      It caught three such moves while this was being written (the bare
//      /api/messages/, which the original DOES gate; the bare
//      /api/admin/smtp-credentials/, which it does NOT; and a plain prefix on
//      /api/drafts swallowing the sibling /api/drafts2).
//
//      The swap is verified by BEHAVIOR too, not only by this file: scopes.test.ts and
//      route-contract.test.ts drive the real handleApi with a token per scope, and
//      flipping one row's scope in the table makes them fail, which is what proves the
//      table is wired to the live gate rather than merely imported next to it.
//   2. ORDERING: every row is reachable, i.e. matchRoute returns THAT row for its own
//      path. A broad prefix shadowing a later exact route is the classic way a table
//      like this rots, and it is invisible without this test.
//   3. SYNC: the committed contracts/*.json equal the projection of the source. A stale
//      projection is worse than none: it hands a client a confident wrong answer.
//
// Parameter claims are proved LIVE against the real handler in route-params.test.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTE_TABLE, matchRoute, requiredScope, type RouteScope } from "./src/routes";

// ---------------------------------------------------------------------------
// 1. Derivation: the if-chain this table replaced, copied verbatim as a reference.
// ---------------------------------------------------------------------------
function referenceRequiredScope(method: string, path: string): RouteScope | null {
  if (method === "POST" && (path === "/api/send" || path === "/send")) return "send";
  if (method === "POST" && path === "/api/reply") return "send";
  if (method === "POST" && path === "/api/messages/seen") return "read";
  if (method === "POST" && (path === "/api/messages/flags" || path === "/api/messages/move")) return "read";
  if (path === "/api/drafts" || path.startsWith("/api/drafts/")) return "send";
  if (path === "/api/imap/drafts" || path.startsWith("/api/imap/drafts/")) return "imap";
  if (method === "POST" && path === "/api/imap/import") return "imap";
  if (method === "POST" && path === "/api/admin/smtp-credentials") return "admin";
  if (method === "DELETE" && /^\/api\/admin\/smtp-credentials\/(.+)$/.test(path)) return "admin";
  if (method === "POST" && path === "/api/admin/reindex") return "admin";
  if (method === "POST" && path === "/api/admin/reconcile") return "admin";
  if (method === "DELETE" && path.startsWith("/api/messages/") && !path.includes("/attachments/")) return "delete";
  if (method === "GET" && (path === "/api/messages" || path === "/api/messages/")) return "read";
  if (method === "GET" && path === "/api/search") return "read";
  if (method === "GET" && path === "/api/recipients/recent") return "read";
  if (method === "GET" && path === "/api/folders") return "read";
  if (method === "GET" && path === "/api/roles") return "admin";
  if (method === "GET" && path === "/api/mobileconfig") return "read";
  if (method === "GET" && path.startsWith("/api/messages/")) return "read";
  if (method === "GET" && path.startsWith("/api/threads/")) return "read";
  return null;
}

const METHODS = ["GET", "POST", "PUT", "DELETE"];
const CORPUS = [
  "/api/send", "/send", "/api/reply",
  "/api/messages", "/api/messages/", "/api/messages/m1", "/api/messages/m%201",
  "/api/messages/m1/attachments/0", "/api/messages/seen", "/api/messages/flags", "/api/messages/move",
  "/api/threads/t1", "/api/search", "/api/folders", "/api/recipients/recent", "/api/mobileconfig",
  "/api/roles", "/api/drafts", "/api/drafts/", "/api/drafts/d1", "/api/drafts/d1/send",
  "/api/drafts/d1/attachments", "/api/drafts/d1/attachments/a1",
  "/api/imap/drafts", "/api/imap/drafts/d1", "/api/imap/import",
  "/api/admin/smtp-credentials", "/api/admin/smtp-credentials/", "/api/admin/smtp-credentials/bob",
  "/api/admin/reindex", "/api/admin/reconcile",
  // Pre-gate rows: they never reach the gate, and the table says so.
  "/health", "/", "/webmail", "/.well-known/mta-sts.txt", "/api/smtp-auth", "/api/session",
  "/api/session/refresh", "/ingest",
  // Adversarial: near-misses, and paths with no handler at all.
  "/api/message", "/api/messages2", "/api/messagesx/m1", "/api/drafts2", "/api/draftsx/d1",
  "/api/imap/draftsx", "/api/", "/api", "/api/threads", "/api/threadsx/t", "/api/sendx", "/sendx",
  "/api/messages/../drafts",
];

describe("#417 the derived requiredScope is equivalent to the if-chain it replaced", () => {
  it("answers identically for every method over the whole corpus", () => {
    const disagreements: string[] = [];
    for (const method of METHODS) {
      for (const path of CORPUS) {
        const before = referenceRequiredScope(method, path);
        const after = requiredScope(method, path);
        if (before !== after) disagreements.push(`${method} ${path}: was ${before}, now ${after}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("CONTROL: the derivation can disagree, so agreement means something", () => {
    expect(requiredScope("GET", "/api/messages")).toBe("read");
    expect(requiredScope("GET", "/api/nothing-here")).toBeNull();
    expect(requiredScope("POST", "/api/messages")).toBeNull(); // POST has no list handler
    expect(requiredScope("DELETE", "/api/messages/m1/attachments/0")).toBeNull(); // carved out
    expect(requiredScope("DELETE", "/api/admin/smtp-credentials/")).toBeNull(); // needs a username
    expect(requiredScope("DELETE", "/api/messages/")).toBe("delete"); // but this one IS gated
    expect(requiredScope("GET", "/api/drafts2")).toBeNull(); // a SIBLING, not a child
    expect(requiredScope("GET", "/api/drafts/d1")).toBe("send"); // a child, though
  });

  it("the corpus covers every row (no row is untested)", () => {
    const untested = ROUTE_TABLE.filter(
      (spec) => !CORPUS.some((p) => (spec.match === "exact" ? p === spec.path : p.startsWith(spec.path))),
    ).map((s) => s.id);
    // The sibling near-misses are in the corpus too, which is what proves the
    // requireSeparator rows do not swallow them.
    expect(CORPUS).toContain("/api/drafts2");
    expect(CORPUS).toContain("/api/imap/draftsx");
    expect(untested).toEqual([]);
  });
});

describe("#417 ordering: every row is reachable, none is shadowed", () => {
  it("matchRoute returns the row that declared the path, not an earlier one", () => {
    const shadowed: string[] = [];
    for (const spec of ROUTE_TABLE) {
      const method = spec.method === "ANY" ? "GET" : spec.method;
      // A prefix row needs a child path to match. requireSeparator rows take the
      // separator explicitly, which is the whole point of that flag: `${path}probe-id`
      // is a SIBLING to them, not a child.
      const probe =
        spec.match !== "prefix"
          ? spec.path
          : spec.requireSeparator
            ? `${spec.path}/probe-id`
            : `${spec.path}probe-id`;
      const hit = matchRoute(method, probe);
      if (hit !== spec) shadowed.push(`${method} ${probe} -> ${hit ? hit.id : "null"} (declared by ${spec.id})`);
    }
    expect(shadowed).toEqual([]);
  });

  it("the delete carve-out still lets the attachment GET through", () => {
    expect(matchRoute("DELETE", "/api/messages/m1")?.id).toBe("message-delete");
    expect(matchRoute("GET", "/api/messages/m1/attachments/0")?.id).toBe("message-get");
    expect(matchRoute("DELETE", "/api/messages/m1/attachments/0")).toBeNull();
  });

  it("every row id is unique (the id is the join key for the parameter manifest)", () => {
    const ids = ROUTE_TABLE.map((r) => r.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("#417 the committed contracts/ files match the source", () => {
  const spine = JSON.parse(
    readFileSync(new URL("../contracts/api-routes.json", import.meta.url), "utf8"),
  ) as { version: number; routes: Array<Record<string, unknown>> };
  const params = JSON.parse(
    readFileSync(new URL("../contracts/api-params.json", import.meta.url), "utf8"),
  ) as { version: number; params: Record<string, { query?: string[]; body?: string[] }> };

  it("the spine is in sync (run `npm run routes:emit` if this fails)", () => {
    const projected = ROUTE_TABLE.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      match: r.match,
      scope: r.scope,
      auth: r.auth,
      ...(r.exclude ? { exclude: r.exclude } : {}),
      ...(r.requireChild ? { requireChild: true } : {}),
      ...(r.requireSeparator ? { requireSeparator: true } : {}),
      ...(r.template ? { template: r.template } : {}),
      ...(r.note ? { note: r.note } : {}),
    }));
    expect(spine.routes).toEqual(JSON.parse(JSON.stringify(projected)));
  });

  it("the params file is in sync (run `npm run routes:emit` if this fails)", () => {
    const projected = Object.fromEntries(
      ROUTE_TABLE.filter((r) => r.query?.length || r.body?.length).map((r) => [
        r.id,
        {
          ...(r.query?.length ? { query: r.query } : {}),
          ...(r.body?.length ? { body: r.body } : {}),
          ...(r.note ? { note: r.note } : {}),
        },
      ]),
    );
    expect(params.params).toEqual(JSON.parse(JSON.stringify(projected)));
  });

  it("CONTROL: the comparisons are not vacuous, and the two files JOIN", () => {
    expect(spine.routes.length).toBe(ROUTE_TABLE.length);
    expect(spine.routes.length).toBeGreaterThan(20);
    expect(Object.keys(params.params).length).toBeGreaterThan(10);
    const ids = new Set(spine.routes.map((r) => r.id as string));
    expect(Object.keys(params.params).filter((id) => !ids.has(id))).toEqual([]);
  });
});

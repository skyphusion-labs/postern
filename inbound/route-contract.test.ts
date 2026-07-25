import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// Cross-seam route contract (#417).
//
// The structural finding behind the drift in this repo: nothing tested across a
// seam. Every suite mocked its own idea of the worker, so the published clients
// drifted a feature generation behind while every suite stayed green.
// contracts/api-routes.json is the shared, machine-readable answer to "what
// routes exist and what scope does each demand", and THIS file is what keeps that
// file honest: every assertion below runs against the REAL handleApi with a real
// (faked-binding) env, never against a description of it.
//
// It fails in BOTH directions:
//   * a manifest row the worker does not serve -> requiredScope() returns null for
//     it, the wrong-scope request sails past the gate, and the 403 assertion fails.
//   * a route added to api.ts with no row here -> the coverage test fails on the
//     path literal.
//
// Param-level contract (which query/body names each route accepts) is the next
// layer; clients/python already carries a name-level guard for its own emissions
// (#413/#440) and #417 tracks the rest.

type Row = {
  id: string;
  method: string;
  path: string;
  match: "exact" | "prefix";
  scope: "read" | "send" | "delete" | "imap" | "admin" | null;
  auth: string;
  note?: string;
};

const MANIFEST = JSON.parse(readFileSync(new URL("../contracts/api-routes.json", import.meta.url), "utf8")) as {
  version: number;
  routes: Row[];
};
const API_TS = readFileSync(new URL("./src/api.ts", import.meta.url), "utf8");

const SCOPED = MANIFEST.routes.filter((r) => r.scope !== null);
const ALL_SCOPES = ["read", "send", "delete", "imap"] as const;

// One token per scope, plus the unscoped `both`. These are the env names the
// worker itself resolves (POSTERN_API_TOKEN* in resolveToken), so the scope
// mapping under test is the production one.
const TOKENS: Record<string, string> = {
  both: "tok-both",
  read: "tok-read",
  send: "tok-send",
  delete: "tok-delete",
  imap: "tok-imap",
};

function env() {
  return makeFakeEnv({
    POSTERN_API_TOKEN: TOKENS.both,
    POSTERN_API_TOKEN_READ: TOKENS.read,
    POSTERN_API_TOKEN_SEND: TOKENS.send,
    POSTERN_API_TOKEN_DELETE: TOKENS.delete,
    POSTERN_API_TOKEN_IMAP: TOKENS.imap,
  });
}

// A concrete request URL for a row: prefix rows get an id appended so the path is
// the shape a client actually sends.
function urlFor(row: Row): string {
  const path = row.match === "prefix" ? row.path.replace(/\/$/, "") + "/x1" : row.path;
  return "https://mail.example.net" + path;
}

function methodFor(row: Row): string {
  return row.method === "ANY" ? "GET" : row.method;
}

async function call(row: Row, scope: string) {
  const { env: e, ctx } = env();
  const init: RequestInit = {
    method: methodFor(row),
    headers: { authorization: `Bearer ${TOKENS[scope]}`, "content-type": "application/json" },
  };
  if (methodFor(row) !== "GET" && methodFor(row) !== "DELETE") init.body = "{}";
  const res = await handleApi(new Request(urlFor(row), init), e as Env, ctx);
  return res;
}

// "The scope gate admitted this request" is narrower than "the response was not
// 403": a route can clear the gate and still refuse for its own reasons (a bearer
// token with no send identity cannot touch /api/drafts, for one). So the control
// asserts the request was not rejected AS A SCOPE FAILURE, which is the only thing
// this contract governs.
async function expectScopeGatePassed(row: Row, scope: string) {
  const res = await call(row, scope);
  expect(res.status, `${scope} token on ${row.id} must authenticate`).not.toBe(401);
  if (res.status === 403) {
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string; message?: string };
    const scopeRefusal = body.error === "forbidden" && (body.message ?? "").includes("scope");
    expect(scopeRefusal, `${scope} token on ${row.id} was refused by the SCOPE gate: ${body.message}`).toBe(false);
  }
}

describe("route contract: the manifest matches the real worker", () => {
  it("has a row for every /api path literal in api.ts (a new route must be declared)", () => {
    const literals = new Set<string>();
    for (const m of API_TS.matchAll(/path === "(\/[^"]*)"/g)) literals.add(m[1]);
    for (const m of API_TS.matchAll(/path\.startsWith\("(\/[^"]*)"\)/g)) literals.add(m[1]);

    const covered = (p: string) =>
      MANIFEST.routes.some((r) =>
        r.match === "exact"
          ? r.path === p || r.path + "/" === p || r.path === p.replace(/\/$/, "")
          : p.startsWith(r.path) || r.path.startsWith(p),
      );

    const missing = [...literals].filter((p) => !covered(p));
    expect(missing, `paths in api.ts with no row in contracts/api-routes.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("names only paths the worker source still contains (no rows for dead routes)", () => {
    const stale = MANIFEST.routes.filter((r) => {
      if (r.path === "/") return true; // matched as a bare literal, checked by the health test below
      return !API_TS.includes(`"${r.path}"`) && !API_TS.includes(`"${r.path.replace(/\/$/, "")}"`);
    });
    expect(stale.map((r) => r.id)).toEqual(["root"]);
  });

  // The scope column is the load-bearing part: it is what stops a read token from
  // reaching a delete or admin route. Each row is checked against the real gate
  // with EVERY other scope, so a mis-declared row cannot pass.
  for (const row of SCOPED) {
    describe(`${row.method} ${row.path} (${row.scope})`, () => {
      it("refuses every token scope that is not its own", async () => {
        const wrong = ALL_SCOPES.filter((s) => s !== row.scope);
        for (const scope of wrong) {
          const res = await call(row, scope);
          expect(res.status, `${scope} token on ${row.id} should be 403`).toBe(403);
          const body = (await res.json()) as { error?: string; message?: string };
          expect(body.error).toBe("forbidden");
          expect(body.message).toContain(row.scope as string);
        }
      });

      it("admits a both-scoped token (positive control: the route exists and the gate is not blanket-denying)", async () => {
        await expectScopeGatePassed(row, "both");
      });

      if (row.scope !== "admin") {
        it("admits its own scope", async () => {
          await expectScopeGatePassed(row, row.scope as string);
        });
      } else {
        it("refuses a read token even though the route reads (admin is both-only)", async () => {
          const res = await call(row, "read");
          expect(res.status).toBe(403);
        });
      }
    });
  }

  it("an unknown /api path is 404, not an open door", async () => {
    const { env: e, ctx } = env();
    const res = await handleApi(
      new Request("https://mail.example.net/api/not-a-route", {
        headers: { authorization: `Bearer ${TOKENS.both}` },
      }),
      e as Env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("a bad token is 401 before any scope decision", async () => {
    const { env: e, ctx } = env();
    const res = await handleApi(
      new Request("https://mail.example.net/api/messages", { headers: { authorization: "Bearer nope" } }),
      e as Env,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

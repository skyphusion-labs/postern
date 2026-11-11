import { sqliteBatch } from "./test-support";
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";

// #829: the route table is the published client contract (contracts/api-params.json).
// For the PRE-GATE credential routes (they carry their own auth and are not covered by
// route-params.test.ts), every declared body key must be one the handler READS. Two
// drifts of this class shipped: the admin upsert declared `password` and read `secret`
// (fixed in #810), and /api/smtp-auth declared `password` while its handler and both
// real callers use `secret` (#829). The probe: send EXACTLY the declared keys and the
// request must get past field validation; drop any REQUIRED one and it must not.
//
// WHAT THIS CANNOT SEE (measured by mutation): a declared OPTIONAL key that the handler
// never reads. Sending it changes nothing and omitting it is allowed, so this file stays
// green. It catches the class that actually shipped twice (a required key declared
// under the wrong name); proving an optional key has an effect needs a per-route probe
// of that effect, as route-params.test.ts does for the gated routes.

const ORIGIN = "https://postern.example";
const TRANSPORT = "transport-token-0123456789";
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function realEnv(overrides: Record<string, unknown> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  function prepare(sql: string) {
    const stmt = db.prepare(sql);
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) { bound = args; return this; },
      async all<T>() { return { results: stmt.all(...(bound as never[])) as unknown as T[] }; },
      async first<T>() { return (stmt.get(...(bound as never[])) ?? null) as T | null; },
      async run() { const r = stmt.run(...(bound as never[])); return { meta: { changes: Number(r.changes) } }; },
    };
  }
  return {
    DB: { prepare, batch: sqliteBatch(db) }, ALLOWED_FROM_DOMAIN: "skyphusion.org", WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_TRANSPORT_TOKEN: TRANSPORT, ...overrides,
  } as unknown as Env;
}

// One probe per pre-gate credential row: how to call it, which env makes the route LIVE
// (a route that is not armed answers 404 and would pass the check vacuously), and which
// declared keys are REQUIRED (the drop-a-key control applies only to those). A row of
// these kinds with no probe here FAILS the coverage test below.
const SETUP_TOKEN = "setup-token-0123456789abcdef0123456789";
const PROBES: Record<string, { headers: Record<string, string>; env?: Record<string, unknown>; required: string[] }> = {
  "smtp-auth": { headers: { authorization: "Bearer " + TRANSPORT }, required: ["username", "secret"] },
  session: { headers: {}, required: ["username", "password"] },
  // Armed: explicit native (realEnv), the setup secret, and an empty account table.
  setup: { headers: {}, env: { POSTERN_SETUP_TOKEN: SETUP_TOKEN }, required: ["setupToken", "username", "password"] },
};
const KINDS = new Set(["smtp-credential", "session-mint"]);
const rows = ROUTE_TABLE.filter((r) => KINDS.has(r.auth) && (r.body ?? []).length > 0);

function value(key: string): string {
  if (key === "username" || key === "from") return "alice@skyphusion.org";
  if (key === "displayName") return "Alice";
  if (key === "setupToken") return SETUP_TOKEN;
  return "a-long-enough-value-123";
}

async function probe(id: string, path: string, keys: string[]) {
  const body: Record<string, string> = {};
  for (const k of keys) body[k] = value(k);
  const res = await handleApi(new Request(ORIGIN + path, {
    method: "POST", headers: { "content-type": "application/json", ...PROBES[id].headers }, body: JSON.stringify(body),
  }), realEnv(PROBES[id].env), CTX);
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: json.error };
}

describe("#829 pre-gate credential routes read exactly the body keys they declare", () => {
  it("every pre-gate credential row that declares a body has a probe (coverage cannot rot)", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.id).filter((id) => !(id in PROBES))).toEqual([]);
  });

  for (const row of rows) {
    const keys = row.body ?? [];
    it(row.id + ": the declared body (" + keys.join(", ") + ") gets past field validation", async () => {
      const r = await probe(row.id, row.path, keys);
      expect([r.status, r.error]).not.toEqual([400, "E_FIELD_MISSING"]);
      expect(r.status).not.toBe(400);
      // Not vacuous: the route was live (an unarmed or missing route answers 404).
      expect(r.status).not.toBe(404);
    });

    it(row.id + ": every REQUIRED key is a declared key", () => {
      expect(PROBES[row.id].required.filter((k) => !keys.includes(k))).toEqual([]);
    });

    for (const dropped of PROBES[row.id]?.required ?? []) {
      it(row.id + ": CONTROL, dropping declared key `" + dropped + "` IS refused", async () => {
        const r = await probe(row.id, row.path, keys.filter((k) => k !== dropped));
        expect(r.status).toBe(400);
      });
    }
  }
});

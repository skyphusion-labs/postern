// A REAL SQLite engine (node:sqlite) behind the D1 surface, loaded with the
// production schema.sql. Extracted from recipient-lenses.test.ts (#350) so every
// view/predicate suite can share it: the store's SQL -- the effective-seen COALESCE
// subquery, the viewer-relative INBOX predicate, the FTS5 MATCH expression, the
// ON CONFLICT upserts -- is validated by the engine that ships, not by a fake that
// pattern-matches SQL strings and would "pass" a corrupted predicate.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import * as store from "./src/store";

export function realEnv(
  overrides: Record<string, unknown> = {},
): { env: Env; ctx: ExecutionContext; raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const DB = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async all<T>() {
          return { results: stmt.all(...(bound as never[])) as unknown as T[] };
        },
        async first<T>() {
          return (stmt.get(...(bound as never[])) ?? null) as T | null;
        },
        async run() {
          const r = stmt.run(...(bound as never[]));
          return { meta: { changes: Number(r.changes) } };
        },
      };
    },
    // D1 `batch` over the same engine. The store uses it wherever two writes must
    // land together (moveMessages), so a suite that omits it cannot measure those
    // paths at all: the call throws before the predicate under test is ever
    // evaluated, and the failure reads like a defect in the predicate. Sequential
    // rather than transactional, which is the one way this differs from D1; no
    // caller here depends on rollback.
    async batch(statements: { run(): Promise<{ meta: { changes: number } }> }[]) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
  const env = {
    DB,
    ALLOWED_FROM_DOMAIN: "skyphusion.org",
    // Read-door token, so an API-surface test can drive handleApi against the
    // real engine instead of the fake store.
    POSTERN_API_TOKEN: "test-token",
    // Overrides let a suite turn on a real feature gate (e.g.
    // WEBMAIL_AUTH_BACKEND=native, so a REAL session can be minted against the
    // real webmail_sessions table instead of a stand-in for one).
    ...overrides,
  } as unknown as Env;
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  return { env, ctx, raw: db };
}

export const AUTH = { spf: "none", dkim: "none", dmarc: "none" };

export async function putOutbound(
  env: Env,
  ctx: ExecutionContext,
  o: { id: string; from: string; to: string[]; subject?: string; body?: string; date?: string },
) {
  return store.put(
    env,
    {
      messageId: o.id,
      direction: "outbound",
      from: o.from,
      to: o.to.join(", "),
      subject: o.subject ?? "s",
      date: o.date ?? "2026-02-01T00:00:00.000Z",
      bodyText: o.body ?? "body",
      auth: AUTH,
      trusted: true,
      deliveredTo: o.to.map((a) => a.toLowerCase()),
    },
    ctx,
  );
}

export async function putInbound(
  env: Env,
  ctx: ExecutionContext,
  o: { id: string; from: string; to: string; subject?: string; body?: string; date?: string },
) {
  return store.put(
    env,
    {
      messageId: o.id,
      direction: "inbound",
      from: o.from,
      to: o.to,
      subject: o.subject ?? "s",
      date: o.date ?? "2026-02-02T00:00:00.000Z",
      bodyText: o.body ?? "body",
      auth: AUTH,
      trusted: false,
      deliveredTo: [o.to.toLowerCase()],
    },
    ctx,
  );
}

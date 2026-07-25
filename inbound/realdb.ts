// A REAL SQLite engine (node:sqlite) behind the D1 surface, loaded with the
// production schema.sql. Extracted from recipient-lenses.test.ts (#350) so every
// view/predicate suite can share it: the store's SQL -- the effective-seen COALESCE
// subquery, the viewer-relative INBOX predicate, the FTS5 MATCH expression, the
// ON CONFLICT upserts -- is validated by the engine that ships, not by a fake that
// pattern-matches SQL strings and would "pass" a corrupted predicate.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import * as store from "./src/store";

export function realEnv(): { env: Env; ctx: ExecutionContext; raw: DatabaseSync } {
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
  };
  const env = {
    DB,
    ALLOWED_FROM_DOMAIN: "skyphusion.org",
    // Read-door token, so an API-surface test can drive handleApi against the
    // real engine instead of the fake store.
    POSTERN_API_TOKEN: "test-token",
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

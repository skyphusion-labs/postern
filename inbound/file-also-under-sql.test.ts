// FILE_ALSO_UNDER against REAL SQLite, built from the REAL schema (#178 delivered_to semantics).
//
// WHY THIS FILE EXISTS AND THE FAKE-BASED SUITE IS NOT ENOUGH. The claim under test is a SQL claim:
// "every address this delivery is for ends up in delivered_to, in whatever order the deliveries
// arrive". The store fake is a hand-written statement matcher, so asserting through it would assert
// my own reimplementation of the merge -- and in fact the first version of this feature passed the
// fake suite while being WRONG on real SQL ordering (see below).
//
// THE DEFECT THIS PINS. Cloudflare invokes the worker once per envelope recipient and we do not
// control the order. The shipped v1 appended only deliveredList[0] on a same-Message-ID merge, so a
// report addressed to a role address AND anything else was filed under the owner only when the ROLE
// address happened to be delivered FIRST. The other order silently dropped the owner, which is the
// original defect (role mail nobody can see) surviving in a narrower, harder-to-notice form.

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import * as store from "./src/store";

function realEnv(): { env: Env; ctx: ExecutionContext } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  function prepare(sql: string) {
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
  }
  const DB = {
    prepare,
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return {
    env: { DB, ALLOWED_FROM_DOMAIN: "skyphusion.org" } as unknown as Env,
    ctx: { waitUntil() {} } as unknown as ExecutionContext,
  };
}

/** One delivery, as ingest would hand it over: the envelope recipient first, then any owners. */
async function deliver(env: Env, ctx: ExecutionContext, id: string, deliveredTo: string[]) {
  await store.put(env, {
    messageId: id,
    direction: "inbound",
    from: "reporter@elsewhere.test",
    to: deliveredTo[0],
    deliveredTo,
    subject: "report",
    date: "2026-07-25T00:00:00.000Z",
    bodyText: "body",
    auth: { spf: "none", dkim: "none", dmarc: "none" },
    trusted: false,
  }, ctx);
}

async function deliveredSet(env: Env, id: string): Promise<string[]> {
  const row = await env.DB.prepare("SELECT delivered_to, to_addr FROM messages WHERE message_id = ?")
    .bind(id)
    .first<{ delivered_to: string | null; to_addr: string }>();
  return (row!.delivered_to ?? `,${row!.to_addr},`).split(",").filter(Boolean);
}

describe("FILE_ALSO_UNDER delivered_to, on real SQL", () => {
  it("role address delivered FIRST: owner is filed", async () => {
    const { env, ctx } = realEnv();
    await deliver(env, ctx, "a@x", ["abuse@example.com", "owner@example.com"]);
    await deliver(env, ctx, "a@x", ["ops@example.com"]);
    expect(await deliveredSet(env, "a@x")).toEqual(
      expect.arrayContaining(["abuse@example.com", "owner@example.com", "ops@example.com"]),
    );
  });

  it("role address delivered SECOND: owner is STILL filed (the order we do not control)", async () => {
    const { env, ctx } = realEnv();
    await deliver(env, ctx, "b@x", ["ops@example.com"]);
    await deliver(env, ctx, "b@x", ["abuse@example.com", "owner@example.com"]);
    const set = await deliveredSet(env, "b@x");
    expect(set).toContain("ops@example.com");
    expect(set).toContain("abuse@example.com");
    expect(set, "the owner must not depend on delivery order").toContain("owner@example.com");
  });

  it("IDEMPOTENT: the same delivery three times adds each address exactly once", async () => {
    const { env, ctx } = realEnv();
    for (let i = 0; i < 3; i++) await deliver(env, ctx, "c@x", ["abuse@example.com", "owner@example.com"]);
    const set = await deliveredSet(env, "c@x");
    expect(set.filter((a) => a === "abuse@example.com")).toHaveLength(1);
    expect(set.filter((a) => a === "owner@example.com")).toHaveLength(1);
  });

  it("CONTROL: a delivery with NO extra addresses gains nothing", async () => {
    // The guard against the fix widening every recipient: without an owner in the list, the row
    // must carry exactly what the envelope said, on both the insert and the merge path.
    const { env, ctx } = realEnv();
    await deliver(env, ctx, "d@x", ["ops@example.com"]);
    expect(await deliveredSet(env, "d@x")).toEqual(["ops@example.com"]);
    await deliver(env, ctx, "d@x", ["second@example.com"]);
    expect(await deliveredSet(env, "d@x")).toEqual(["ops@example.com", "second@example.com"]);
  });

  it("CONTROL: the delimiter-safe membership test is not fooled by a substring address", async () => {
    // ",abuse@example.com," must not match "notabuse@example.com". If it did, the idempotence
    // guard would skip a real address and the owner would be dropped.
    const { env, ctx } = realEnv();
    await deliver(env, ctx, "e@x", ["notabuse@example.com"]);
    await deliver(env, ctx, "e@x", ["abuse@example.com", "owner@example.com"]);
    const set = await deliveredSet(env, "e@x");
    expect(set).toContain("notabuse@example.com");
    expect(set).toContain("abuse@example.com");
    expect(set).toContain("owner@example.com");
  });
});

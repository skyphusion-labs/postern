// #417 param layer: what makes contracts/api-params.json TRUE.
//
// api-routes.json (#449) is the spine: which routes exist, which scope each demands,
// verified behaviorally against the real handleApi. This file is the same discipline
// for the layer the published clients actually drifted on -- WHICH PARAMETERS a route
// honors. A manifest of names is worthless on its own: it would just be a second thing
// to drift. So every claim in it is proved here against the real handler:
//
//   1. JOIN: every id in api-params.json is a row in api-routes.json, so the two files
//      cannot come apart.
//   2. LIVE: every declared query parameter on the two big read surfaces is either
//      strictly REFUSED when bogus, or demonstrably CHANGES the result set. A declared
//      parameter that does neither is INERT, which is exactly the #413/#422 defect
//      shape (a filter the answer was not filtered by). A declared parameter with no
//      probe also fails, so this coverage cannot rot quietly.
//   3. COMPLETENESS: every parameter name api.ts actually reads is declared somewhere,
//      so a worker-side addition cannot land undeclared and invisible to the clients.
//   4. NOTHING INVENTED: every declared name is read somewhere in api.ts.
//
// Real SQLite via ./realdb, because 2 asserts on result SETS from real predicates.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handleApi } from "./src/api";
import { realEnv, putInbound, putOutbound } from "./realdb";

const ROUTES = JSON.parse(
  readFileSync(new URL("../contracts/api-routes.json", import.meta.url), "utf8"),
) as { routes: Array<{ id: string; method: string; path: string; match: string; scope: string | null }> };

const PARAMS = JSON.parse(
  readFileSync(new URL("../contracts/api-params.json", import.meta.url), "utf8"),
) as { version: number; params: Record<string, { query?: string[]; body?: string[]; note?: string }> };

const API_SRC = readFileSync(new URL("./src/api.ts", import.meta.url), "utf8");
const TOKEN = "test-token";
const ME = "me@skyphusion.org";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";

function get(path: string): Request {
  return new Request(`https://postern.example${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

async function ids(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    items: Array<{ messageId?: string; message?: { messageId: string } }>;
  };
  return body.items.map((i) => i.messageId ?? i.message!.messageId).sort();
}

async function seed(env: Env, ctx: ExecutionContext, raw: import("node:sqlite").DatabaseSync) {
  await putInbound(env, ctx, {
    id: "m-alpha@x", from: ALICE, to: ME, subject: "alpha subject",
    body: "keyword uniqueone", date: "2026-01-10T00:00:00.000Z",
  });
  await putInbound(env, ctx, {
    id: "m-beta@x", from: BOB, to: ME, subject: "beta subject",
    body: "keyword uniquetwo", date: "2026-02-10T00:00:00.000Z",
  });
  await putOutbound(env, ctx, {
    id: "m-gamma@x", from: ME, to: [ALICE], subject: "gamma subject",
    body: "keyword uniquethree", date: "2026-03-10T00:00:00.000Z",
  });
  await putInbound(env, ctx, {
    id: "m-trashed@x", from: BOB, to: ME, subject: "delta subject",
    body: "keyword uniquefour", date: "2026-04-10T00:00:00.000Z",
  });
  raw.prepare("UPDATE messages SET mailbox = 'trash' WHERE message_id = ?").run("m-trashed@x");
  raw.prepare("UPDATE messages SET seen = 1 WHERE message_id = ?").run("m-beta@x");
  raw
    .prepare(
      "INSERT INTO attachments (message_id, filename, mime, size, r2_key, created_at) " +
        "VALUES (?, 'a.txt', 'text/plain', 3, 'k', '2026-01-10T00:00:00.000Z')",
    )
    .run("m-alpha@x");
}

type Probe = (env: Env, ctx: ExecutionContext) => Promise<void>;

async function refuses(env: Env, ctx: ExecutionContext, path: string): Promise<void> {
  const res = await handleApi(get(path), env, ctx);
  expect(res.status, `${path} should be refused`).toBe(400);
  expect(await res.json()).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });
}

async function changes(env: Env, ctx: ExecutionContext, base: string, filtered: string): Promise<string[]> {
  const before = await ids(await handleApi(get(base), env, ctx));
  const after = await ids(await handleApi(get(filtered), env, ctx));
  expect(before, `${base} must return something, else the comparison is vacuous`).not.toEqual([]);
  expect(after, `${filtered} did not change the answer: the parameter is inert`).not.toEqual(before);
  return after;
}

const LIST_PROBES: Record<string, Probe> = {
  to: async (e, c) => {
    expect(await changes(e, c, "/api/messages", `/api/messages?to=${ALICE}`)).toEqual(["m-gamma@x"]);
  },
  from: async (e, c) => {
    expect(await changes(e, c, "/api/messages", `/api/messages?from=${ALICE}`)).toEqual(["m-alpha@x"]);
  },
  thread: async (e, c) => {
    const all = await ids(await handleApi(get("/api/messages"), e, c));
    expect(all.length).toBeGreaterThan(1);
    expect(await ids(await handleApi(get("/api/messages?thread=m-alpha@x"), e, c))).toEqual(["m-alpha@x"]);
  },
  direction: async (e, c) => refuses(e, c, "/api/messages?direction=sideways"),
  lens: async (e, c) => refuses(e, c, "/api/messages?lens=nope"),
  seenFor: async (e, c) => refuses(e, c, "/api/messages?seenFor=not-an-address"),
  mailbox: async (e, c) => {
    // Not validated at the edge (an unknown value falls back to the default view), so
    // it is proved by effect: the trashed row is reachable ONLY with mailbox=trash.
    expect(await changes(e, c, "/api/messages", "/api/messages?mailbox=trash")).toEqual(["m-trashed@x"]);
  },
  q: async (e, c) => {
    expect(await changes(e, c, "/api/messages", "/api/messages?q=uniqueone")).toEqual(["m-alpha@x"]);
  },
  limit: async (e, c) => {
    expect(await ids(await handleApi(get("/api/messages?limit=1"), e, c))).toHaveLength(1);
  },
  cursor: async (e, c) => {
    const page1 = (await (await handleApi(get("/api/messages?limit=1"), e, c)).json()) as {
      items: Array<{ messageId: string }>;
      cursor: string | null;
    };
    expect(page1.cursor, "no cursor: the pagination probe would be vacuous").toBeTruthy();
    const page2 = await ids(
      await handleApi(get(`/api/messages?limit=1&cursor=${encodeURIComponent(page1.cursor!)}`), e, c),
    );
    expect(page2).not.toEqual([page1.items[0].messageId]);
  },
};

const SEARCH_PROBES: Record<string, Probe> = {
  q: async (e, c) => {
    expect(await ids(await handleApi(get("/api/search?q=uniqueone"), e, c))).toEqual(["m-alpha@x"]);
    expect((await handleApi(get("/api/search"), e, c)).status, "q is required").toBe(400);
  },
  mode: async (e, c) => {
    // substr matches INSIDE a token, which fts cannot: that difference is the proof
    // the parameter selects a different engine and is not decorative.
    expect(await ids(await handleApi(get("/api/search?q=niqueon"), e, c))).toEqual([]);
    expect(await ids(await handleApi(get("/api/search?q=niqueon&mode=substr&field=body"), e, c))).toEqual([
      "m-alpha@x",
    ]);
  },
  field: async (e, c) => refuses(e, c, "/api/search?q=x&mode=substr&field=nope"),
  direction: async (e, c) => refuses(e, c, "/api/search?q=keyword&direction=sideways"),
  lens: async (e, c) => refuses(e, c, "/api/search?q=keyword&lens=nope"),
  seenFor: async (e, c) => refuses(e, c, "/api/search?q=keyword&seenFor=not-an-address"),
  hasAttachment: async (e, c) => {
    await refuses(e, c, "/api/search?q=keyword&hasAttachment=maybe");
    expect(await ids(await handleApi(get("/api/search?q=keyword&hasAttachment=true"), e, c))).toEqual([
      "m-alpha@x",
    ]);
  },
  seen: async (e, c) => {
    await refuses(e, c, "/api/search?q=keyword&seen=maybe");
    const unread = await ids(await handleApi(get("/api/search?q=keyword&seen=false"), e, c));
    expect(unread).not.toContain("m-beta@x");
    expect(unread).toContain("m-alpha@x");
  },
  to: async (e, c) => {
    expect(await changes(e, c, "/api/search?q=keyword", `/api/search?q=keyword&to=${ALICE}`)).toEqual([
      "m-gamma@x",
    ]);
  },
  from: async (e, c) => {
    expect(await changes(e, c, "/api/search?q=keyword", `/api/search?q=keyword&from=${ALICE}`)).toEqual([
      "m-alpha@x",
    ]);
  },
  mailbox: async (e, c) => {
    expect(await changes(e, c, "/api/search?q=keyword", "/api/search?q=keyword&mailbox=trash")).toEqual([
      "m-trashed@x",
    ]);
  },
  after: async (e, c) => {
    const recent = await changes(e, c, "/api/search?q=keyword", "/api/search?q=keyword&after=2026-03-01");
    expect(recent).not.toContain("m-alpha@x");
  },
  before: async (e, c) => {
    expect(await changes(e, c, "/api/search?q=keyword", "/api/search?q=keyword&before=2026-01-31")).toEqual([
      "m-alpha@x",
    ]);
  },
  limit: async (e, c) => {
    expect(await ids(await handleApi(get("/api/search?q=keyword&limit=1"), e, c))).toHaveLength(1);
  },
  cursor: async (e, c) => {
    const page1 = (await (await handleApi(get("/api/search?q=keyword&limit=1"), e, c)).json()) as {
      items: Array<{ message: { messageId: string } }>;
      cursor: string | null;
    };
    expect(page1.cursor).toBeTruthy();
    const page2 = await ids(
      await handleApi(get(`/api/search?q=keyword&limit=1&cursor=${encodeURIComponent(page1.cursor!)}`), e, c),
    );
    expect(page2).not.toEqual([page1.items[0].message.messageId]);
  },
};

describe("#417 the two contract files join", () => {
  it("every params id is a route id (neither file can drift from the other)", () => {
    const routeIds = new Set(ROUTES.routes.map((r) => r.id));
    expect(Object.keys(PARAMS.params).filter((id) => !routeIds.has(id))).toEqual([]);
  });

  it("CONTROL: the join can fail, and both files actually loaded", () => {
    const routeIds = new Set(ROUTES.routes.map((r) => r.id));
    expect(routeIds.size).toBeGreaterThan(20);
    expect(Object.keys(PARAMS.params).length).toBeGreaterThan(10);
    expect(routeIds.has("not-a-route-id")).toBe(false);
  });

  it("every route that takes parameters has a row (the ones that do not are named)", () => {
    // Routes with no row here take nothing: assert that explicitly rather than letting
    // an absent row mean "nobody looked".
    const takesNothing = [
      "health", "root", "robots", "sitemap", "webmail", "mta-sts", "ingest", "session-refresh",
      "message-get", "thread-get", "message-delete", "mobileconfig",
      "admin-smtp-credential-delete", "admin-roles", "imap-roles",
    ];
    const withRows = new Set(Object.keys(PARAMS.params));
    const all = ROUTES.routes.map((r) => r.id);
    expect(all.filter((id) => !withRows.has(id)).sort()).toEqual([...takesNothing].sort());
  });
});

describe("#417 every declared query parameter is LIVE against the real handler", () => {
  for (const [id, probes] of [
    ["messages-list", LIST_PROBES],
    ["search", SEARCH_PROBES],
  ] as const) {
    const declared = PARAMS.params[id].query ?? [];

    it(`${id}: every declared parameter has a probe (coverage cannot rot silently)`, () => {
      expect([...declared].sort()).toEqual(Object.keys(probes).sort());
    });

    for (const param of declared) {
      it(`${id}?${param}= is refused when bogus, or changes the answer`, async () => {
        const { env, ctx, raw } = realEnv();
        await seed(env, ctx, raw);
        await probes[param](env, ctx);
      });
    }
  }
});

describe("#417 the manifest describes THIS worker, not a remembered one", () => {
  const readByWorker = new Set(
    [...API_SRC.matchAll(/(?:searchParams|\bp)\.get\("([^"]+)"\)/g)].map((m) => m[1]),
  );
  const declared = new Set(Object.values(PARAMS.params).flatMap((r) => r.query ?? []));

  it("CONTROL: the extraction found real parameter names and can miss", () => {
    expect(readByWorker.size).toBeGreaterThan(5);
    for (const name of ["direction", "lens", "mailbox", "seenFor", "field", "cursor", "limit"]) {
      expect(readByWorker).toContain(name);
    }
    expect(readByWorker).not.toContain("nOtApArAm");
  });

  it("nothing the worker reads is undeclared", () => {
    expect([...readByWorker].filter((n) => !declared.has(n)).sort()).toEqual([]);
  });

  it("nothing declared is invented", () => {
    expect([...declared].filter((n) => !readByWorker.has(n)).sort()).toEqual([]);
  });
});

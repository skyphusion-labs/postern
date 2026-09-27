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
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
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
  // MIDDAY on the boundary day, for the #647 inclusivity arms. A row exactly at midnight
  // would pass a broken `before=<day>` by accident, so it has to be inside the day.
  await putInbound(env, ctx, {
    id: "m-boundary@x", from: BOB, to: ME, subject: "boundary subject",
    body: "keyword uniquefive", date: "2026-01-31T12:00:00.000Z",
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

/** The key sets a read surface actually returned, one entry per row.
 *
 *  `fields=` is the one declared parameter that changes the SHAPE of a row rather than
 *  WHICH rows come back, so the `changes()` helper above (which compares id sets) is
 *  structurally blind to it: an accepted-and-ignored projection would sail through a
 *  refusal-only probe. Hence both arms below, and the CONTROL that the unprojected page
 *  is genuinely wider than the projected one. */
async function rowKeys(res: Response, pick: (row: any) => any = (row) => row): Promise<string[][]> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: unknown[] };
  expect(body.items.length, "no rows: a projection assertion would be vacuous").toBeGreaterThan(0);
  return body.items.map((row) => Object.keys(pick(row)).sort());
}

/** The date-window probe, shared by both read surfaces (#647).
 *
 *  It asserts the three defects measured on the real engine before #647 STAY fixed, because
 *  each one passed the old refuses-or-changes bar while answering wrongly:
 *
 *  1. INCLUSIVE AT BOTH ENDS for a bare date. `before=<the boundary day>` must RETURN a
 *     message stored at midday on that day. It did not: "...T12:00:00.000Z" > "2026-01-31"
 *     as a string, so a caller asking for January silently lost the 31st.
 *  2. A BOGUS value is REFUSED, not applied. `before=yesterday` used to return EVERY row
 *     and `after=yesterday` ZERO rows, in both cases 200 OK. The zero case is the one that
 *     matters: a typo that reads as "no mail in that window" is #631's own ambiguity,
 *     manufactured from a spelling mistake.
 *  3. A FULL TIMESTAMP whose form differs from the stored one still compares right.
 *     `after=<midnight>Z` used to EXCLUDE a row stored at `<midnight>.000Z` because
 *     "Z" > "." lexically.
 *
 *  The seeded row at 2026-01-31T12:00:00.000Z exists only for arm 1; without a row INSIDE
 *  the boundary day the inclusivity assertion cannot fail and would be decoration. */
async function dateProbe(
  env: Env,
  ctx: ExecutionContext,
  base: string,
  sep: string,
): Promise<void> {
  // 2. Refusals first, both ends, including the empty bound and a plausible impossible day.
  for (const bad of ["yesterday", "not-a-date", "2026-13-45", "", "31/01/2026", "2026-02-30"]) {
    await refuses(env, ctx, `${base}${sep}after=${encodeURIComponent(bad)}`);
    await refuses(env, ctx, `${base}${sep}before=${encodeURIComponent(bad)}`);
  }

  // 1. A bare date covers its WHOLE named day, at both ends.
  const onBoundary = await ids(await handleApi(get(`${base}${sep}before=2026-01-31`), env, ctx));
  expect(onBoundary, "before=<day> must INCLUDE a message stored at midday on that day").toContain(
    "m-boundary@x",
  );
  const afterBoundary = await ids(await handleApi(get(`${base}${sep}after=2026-01-31`), env, ctx));
  expect(afterBoundary, "after=<day> must include that same message").toContain("m-boundary@x");
  // CONTROL: the bound is a real filter, not a passthrough that includes everything.
  const before10 = await ids(await handleApi(get(`${base}${sep}before=2026-01-10`), env, ctx));
  expect(before10, "before=2026-01-10 must EXCLUDE the 31st").not.toContain("m-boundary@x");
  expect(before10.length, "and must still return something, else the arm above is vacuous")
    .toBeGreaterThan(0);

  // 3. A full timestamp naming an instant INCLUDES a row stored at that instant.
  const atInstant = await ids(
    await handleApi(get(`${base}${sep}after=2026-01-31T12:00:00Z`), env, ctx),
  );
  expect(atInstant, "an inclusive bound must include the instant it names").toContain("m-boundary@x");

  // Both ends together bound a window.
  const window = await ids(
    await handleApi(get(`${base}${sep}after=2026-01-31&before=2026-01-31`), env, ctx),
  );
  expect(window).toEqual(["m-boundary@x"]);
}

/** Both refusal arms and the applied arm, shared by the two read surfaces.
 *
 *  `snippet` is REFUSED on purpose. It is declared on the search hit and on
 *  mcp/src/types.ts with zero producers (#652, populate-or-delete, undecided); a
 *  projection that accepted it would answer a key nothing fills, which is the very
 *  defect #652 exists to settle. The projection must not pre-empt that decision. */
async function fieldsProbe(
  env: Env,
  ctx: ExecutionContext,
  base: string,
  sep: string,
  pick?: (row: any) => any,
): Promise<void> {
  await refuses(env, ctx, `${base}${sep}fields=nope`);
  await refuses(env, ctx, `${base}${sep}fields=`);
  await refuses(env, ctx, `${base}${sep}fields=uid,nope`);
  await refuses(env, ctx, `${base}${sep}fields=snippet`);
  const full = await rowKeys(await handleApi(get(base), env, ctx), pick);
  const want = ["date", "from", "subject", "uid"];
  const projected = await rowKeys(
    await handleApi(get(`${base}${sep}fields=uid,date,from,subject`), env, ctx),
    pick,
  );
  expect(projected.length).toBe(full.length);
  for (const keys of projected) expect(keys).toEqual(want);
  // CONTROL: the unprojected row is genuinely wider, so the assertion above is a real
  // narrowing and not a row that happened to carry four keys all along.
  for (const keys of full) expect(keys.length).toBeGreaterThan(want.length);
  // A repeated name cannot repeat a key or reorder the row: projectSummary walks the
  // TYPE's key order, not the caller's argument order.
  const dup = await rowKeys(
    await handleApi(get(`${base}${sep}fields=subject,uid,subject,date,from`), env, ctx),
    pick,
  );
  for (const keys of dup) expect(keys).toEqual(want);
}

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
  fields: async (e, c) => fieldsProbe(e, c, "/api/messages", "?"),
  after: async (e, c) => dateProbe(e, c, "/api/messages", "?"),
  // Same probe, because after/before are ONE definition shared with search (#647). Running
  // it under both names is deliberate: the coverage gate demands a probe per declared name,
  // and a bound that only works when its partner is absent is a real failure mode.
  before: async (e, c) => dateProbe(e, c, "/api/messages", "?"),
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
  // The PLURAL neighbour of `field` above, and a different axis: `field` picks the
  // column substr MATCHES, `fields` picks the summary keys hit.message RETURNS. Probed
  // on hit.message, and `score`/the page envelope stay untouched by construction.
  fields: async (e, c) => fieldsProbe(e, c, "/api/search?q=keyword", "&", (row) => row.message),
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
  // These used to be a bare changes() on each end. That bar is met by a filter that answers
  // the WRONG rows, which is what both of these did: before=2026-01-31 returned ["m-alpha@x"]
  // and looked right precisely because no seeded row sat inside the 31st. The shared probe
  // now pins the boundary, the refusals and the canonicalization.
  after: async (e, c) => dateProbe(e, c, "/api/search?q=keyword", "&"),
  before: async (e, c) => dateProbe(e, c, "/api/search?q=keyword", "&"),
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

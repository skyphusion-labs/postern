// #718: an agent credential reads the estate; a human in a browser does not.
//
// Conrad's ruling, 2026-10-14, after being asked whether to ship it behind an operator
// opt-in: *"yeah, it's on by default, the product's tag line is email for agents and humans
// after all"*. So: estate-wide agent read, ON by default, no config key. An agent that
// cannot read the humans' mail does not deliver the product.
//
// WHAT PROMPTED IT. The lead's `mackaye@` credential searched for a Cloudflare invoice that
// was in the mailbox, addressed to `conrad@`. Production D1 row 29427, 2026-10-09T13:07:24Z,
// from noreply@notify.cloudflare.com, subject "Your invoice is attached". Every row that
// credential could return also carried `mackaye@` in delivered_to, so it saw the
// intersection and reported the invoice absent. Reading it meant going to production D1
// directly, which is the lead bypassing the product to do what the product should support.
//
// THE TRAP THIS FILE EXISTS FOR. The narrowing was one function, `sessionReadScope`, and it
// served TWO callers that are indistinguishable at that line: a registry Bearer (an agent)
// and a webmail session cookie (a human who logged in). Widening the function itself would
// have turned every human webmail login into an estate reader, which Conrad was never asked
// about and which every self-hoster would inherit on first run. The discriminator is
// `viaSession`, set in exactly one place (`resolveCookieAuth`) and never on a Bearer.
//
// So the load-bearing assertions here are PAIRS. One store, one route, one set of rows,
// read once as an agent and once as a human, answering DIFFERENTLY. Either half alone
// proves nothing: an estate result could be a broken predicate, and a narrow result could be
// a change that never landed.
//
// realEnv and a REAL minted session throughout, because every claim here is about an access
// predicate. A fake store would only prove the fake agrees with itself.

import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import { sha256Hex } from "./src/sendidentity";
import { mintNativeSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { hashSecret } from "./src/smtpcreds";
import { realEnv, putInbound } from "./realdb";

const ESTATE = "test-token";
const AGENT_TOKEN = "mackaye-registry-token";
const AGENT = "mackaye@skyphusion.org";
const CONRAD = "conrad@skyphusion.org";
const QUEUE = "abuse@skyphusion.org";
const PASSWORD = "hunter2hunter2";

// The real case, by its real values. `INVOICE_ID` stands in for the Message-ID of D1 row
// 29427; everything else is verbatim from the incident so the arm reads as the report.
const INVOICE_ID = "cf-invoice-29427@notify.cloudflare.com";
const CF_SENDER = "noreply@notify.cloudflare.com";
const CF_SUBJECT = "Your invoice is attached";
const CF_DATE = "2026-10-09T13:07:24.000Z";
const CF_BODY = "your invoice for the billing period is attached";

async function env(scopes: string[] = ["read"], roles = "") {
  const registry = { [await sha256Hex(AGENT_TOKEN)]: { from: AGENT, scopes } };
  return realEnv({
    WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_SEND_IDENTITIES: JSON.stringify(registry),
    POSTERN_VIEWER_ROLES: roles,
  });
}

/** The invoice, addressed to CONRAD and to nobody else: the whole point of the case. */
async function seedInvoice(e: Env, ctx: ExecutionContext) {
  await putInbound(e, ctx, {
    id: INVOICE_ID, from: CF_SENDER, to: CONRAD, subject: CF_SUBJECT, body: CF_BODY, date: CF_DATE,
  });
}

async function signIn(
  e: Env,
  raw: import("node:sqlite").DatabaseSync,
  address: string,
): Promise<string> {
  raw
    .prepare(
      "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
        "VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(address, address, await hashSecret(PASSWORD), "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
  const minted = await mintNativeSession(e, address, PASSWORD);
  if (!minted) throw new Error("session mint failed: the test would prove nothing");
  return `${SESSION_COOKIE}=${minted.rawId}; ${CSRF_COOKIE}=${minted.csrfToken}`;
}

type Auth = { token: string } | { cookie: string };

function req(path: string, auth: Auth, method = "GET", payload?: unknown): Request {
  const headers: Record<string, string> =
    "cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://postern.example${path}`, {
    method,
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

async function read(path: string, auth: Auth, e: Env, ctx: ExecutionContext) {
  const res = await handleApi(req(path, auth), e, ctx);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const hits = (j: Record<string, unknown>): string[] =>
  ((j.items ?? []) as Array<{ messageId?: string; message?: { messageId: string } }>).map(
    (i) => i.messageId ?? i.message!.messageId,
  );

describe("#718 ARM 1: the agent credential retrieves the invoice that prompted the issue", () => {
  // The two probes below are the ones in the report, with the parameters they were run
  // with. They each returned count: 0 against production on 2026-10-09.
  it("mode=fts query=invoice after=2026-10-09 now finds it (was count: 0)", async () => {
    const { env: e, ctx } = await env();
    await seedInvoice(e, ctx);

    const r = await read(
      "/api/search?q=invoice&mode=fts&after=2026-10-09", { token: AGENT_TOKEN }, e, ctx,
    );

    expect(r.status).toBe(200);
    expect(hits(r.json), "the exact query that reported the invoice absent").toEqual([INVOICE_ID]);
    expect(r.json.identityScope, "and it SAYS the read was estate-wide (#717)").toEqual({
      kind: "estate",
    });
  });

  it("from=notify.cloudflare.com after=2026-09-15 now finds it (was count: 0)", async () => {
    const { env: e, ctx } = await env();
    await seedInvoice(e, ctx);

    const r = await read(
      `/api/messages?from=${CF_SENDER}&after=2026-09-15`, { token: AGENT_TOKEN }, e, ctx,
    );

    expect(hits(r.json)).toEqual([INVOICE_ID]);
  });

  it("and the message itself opens, with the sender, subject and date from the report", async () => {
    const { env: e, ctx } = await env();
    await seedInvoice(e, ctx);

    const r = await read(`/api/messages/${encodeURIComponent(INVOICE_ID)}`, { token: AGENT_TOKEN }, e, ctx);

    expect(r.status, "a 404 here is what sent the lead to production D1").toBe(200);
    const msg = r.json.message as { from: string; subject: string; date: string; bodyText: string };
    expect(msg.from).toBe(CF_SENDER);
    expect(msg.subject).toBe(CF_SUBJECT);
    expect(msg.date).toBe(CF_DATE);
    // The bytes, not just the metadata: a projection that returned a header-only row would
    // satisfy every assertion above and still not deliver the invoice.
    expect(msg.bodyText).toContain("invoice");
  });
});

describe("#718 ARM 2: the negative direction, so the arms above are not true by construction", () => {
  it("the SAME credential with the read cap removed is still refused", async () => {
    // One string differs from ARM 1's env: `scopes: ["send"]`. Same token value, same
    // identity, same store, same routes. If ARM 1 passed because the predicate had been
    // removed outright rather than split, this would pass too, and it must not.
    const { env: e, ctx } = await env(["send"]);
    await seedInvoice(e, ctx);

    for (const path of [
      "/api/search?q=invoice&mode=fts",
      "/api/messages",
      `/api/messages/${encodeURIComponent(INVOICE_ID)}`,
      "/api/folders",
    ]) {
      const res = await handleApi(req(path, { token: AGENT_TOKEN }), e, ctx);
      expect(res.status, `${path} must refuse a send-only identity`).toBe(403);
    }
  });

  it("an unknown token is 401, so the 403s above are about the grant and not the value", async () => {
    const { env: e, ctx } = await env(["send"]);
    const res = await handleApi(req("/api/messages", { token: "not-a-real-token" }), e, ctx);
    expect(res.status).toBe(401);
  });
});

describe("#718 ARM 3: a webmail SESSION must still not read another human's mail", () => {
  // The arm this design exists for. Conrad ruled on AGENT credentials. Nothing was ruled
  // about turning every browser login into an estate reader, and that is what the one-line
  // widening would have shipped, into the self-host tier, on first run.
  it("a human session cannot see the invoice, on any read surface", async () => {
    const { env: e, ctx, raw } = await env();
    const cookie = await signIn(e, raw, AGENT);
    await seedInvoice(e, ctx);

    const search = await read("/api/search?q=invoice&mode=fts", { cookie }, e, ctx);
    expect(hits(search.json), "a human must not inherit the agent widening").toEqual([]);
    expect(search.json.identityScope).toEqual({ kind: "member", addresses: [AGENT] });

    const list = await read("/api/messages", { cookie }, e, ctx);
    expect(hits(list.json)).toEqual([]);

    const got = await read(`/api/messages/${encodeURIComponent(INVOICE_ID)}`, { cookie }, e, ctx);
    expect(got.status, "nor open it by id").toBe(404);

    const thread = await read(`/api/threads/${encodeURIComponent(INVOICE_ID)}`, { cookie }, e, ctx);
    expect((thread.json.messages as unknown[]) ?? []).toEqual([]);

    // And the bytes never travel, on any of them.
    const all = JSON.stringify([search.json, list.json, got.json, thread.json]);
    expect(all).not.toContain(CF_BODY);
    expect(all).not.toContain(CF_SUBJECT);
  });

  it("PAIR: the agent, on the same store and the same cookie-less request, DOES see it", async () => {
    // Without this the arm above passes against an empty store or a broken search. Same
    // env, same seeded row, the only difference being which door the request came through.
    const { env: e, ctx, raw } = await env();
    await signIn(e, raw, AGENT);
    await seedInvoice(e, ctx);

    const asAgent = await read("/api/search?q=invoice&mode=fts", { token: AGENT_TOKEN }, e, ctx);
    expect(hits(asAgent.json), "the invoice is there to be found").toEqual([INVOICE_ID]);
  });

  it("the session keeps its OWN mail and its role queues, which is the #425 model intact", async () => {
    // Widening must not have cost the human anything either. This is also where the role
    // membership property lives now: it left whoami.test.ts because a Bearer reports no
    // queues after #718, which made member and non-member the same answer there.
    const { env: e, ctx, raw } = await env(["read"], `${QUEUE}=${AGENT}`);
    const cookie = await signIn(e, raw, AGENT);
    await putInbound(e, ctx, { id: "mine@x", from: "friend@example.com", to: AGENT, subject: "hello" });
    await putInbound(e, ctx, { id: "q@x", from: "reporter@example.com", to: QUEUE, subject: "report" });

    const list = await read("/api/messages", { cookie }, e, ctx);
    expect(hits(list.json), "own mail, still readable").toEqual(["mine@x"]);

    const queue = await read(`/api/messages/q@x`, { cookie }, e, ctx);
    expect(queue.status, "queue mail, still readable as a member").toBe(200);

    const me = await read("/api/whoami", { cookie }, e, ctx);
    expect(me.json.identityScope).toEqual({ kind: "member", addresses: [AGENT] });
    expect(me.json.roleQueues, "the queue is reported as the separate fact it is").toEqual([QUEUE]);
    expect(me.json.via).toBe("session");
  });

  it("CONTROL: a configured queue the session is NOT a member of is not reported", async () => {
    // The membership arm has to be able to go red, so the map is configured and non-empty
    // and names someone else. An empty answer here is membership being evaluated.
    const { env: e, ctx, raw } = await env(["read"], `${QUEUE}=${CONRAD}`);
    const cookie = await signIn(e, raw, AGENT);

    const me = await read("/api/whoami", { cookie }, e, ctx);
    expect(me.json.roleQueues).toEqual([]);
  });
});

describe("#718 the WRITE paths did not move with the read", () => {
  // The ruling widened READ. `writeReadScope` refs GHSA-49mc-vh6w-95h4 and the #404 ruling
  // keeps the state-changing paths single-identity, so an agent now reads mail it still
  // cannot act on. That asymmetry is deliberate and is pinned here, because the natural
  // next edit is to "finish the job" and widen these too.
  it("an agent cannot mark another address's mail read, and the refusal is not silent breakage", async () => {
    const { env: e, ctx } = await env(["read", "organize"]);
    await seedInvoice(e, ctx);
    await putInbound(e, ctx, { id: "mine@x", from: "friend@example.com", to: AGENT, subject: "hello" });

    const theirs = await handleApi(
      req("/api/messages/seen", { token: AGENT_TOKEN }, "POST", { ids: [INVOICE_ID], seen: true }),
      e, ctx,
    );
    expect(theirs.status).toBe(200);
    expect((await theirs.json() as { updated: number }).updated,
      "whose read state an agent may write did not change").toBe(0);

    // POSITIVE CONTROL, and it is what makes the 0 above mean "scoped" rather than "this
    // route is broken for agents". The seen route shares `sessionReadScope` with the read
    // paths, and switching that one line to the widened scope would have made the agent's
    // scope the EMPTY set, which `accessClause` turns into `1=0`: every agent mark-read
    // would then update zero rows and look exactly like the refusal above.
    const own = await handleApi(
      req("/api/messages/seen", { token: AGENT_TOKEN }, "POST", { ids: ["mine@x"], seen: true }),
      e, ctx,
    );
    expect((await own.json() as { updated: number }).updated,
      "an agent must still be able to mark its OWN mail read").toBe(1);
  });

  it("an agent cannot flag or move another address's mail", async () => {
    const { env: e, ctx } = await env(["read", "organize"]);
    await seedInvoice(e, ctx);

    for (const [path, payload] of [
      ["/api/messages/flags", { ids: [INVOICE_ID], set: { flagged: true } }],
      ["/api/messages/move", { ids: [INVOICE_ID], mailbox: "trash" }],
    ] as Array<[string, unknown]>) {
      const res = await handleApi(req(path, { token: AGENT_TOKEN }, "POST", payload), e, ctx);
      expect(res.status).toBe(200);
      expect((await res.json() as { updated: number }).updated, `${path} must not touch it`).toBe(0);
    }
  });

  it("an agent cannot quote another address's mail into a reply, which is the GHSA boundary", async () => {
    const sent: Array<{ to: string[]; text?: string }> = [];
    const registry = { [await sha256Hex(AGENT_TOKEN)]: { from: AGENT, scopes: ["read", "send"] } };
    const { env: e, ctx } = realEnv({
      POSTERN_SEND_IDENTITIES: JSON.stringify(registry),
      DEFAULT_FROM: AGENT,
      ALLOWED_FROM_DOMAIN: "skyphusion.org",
      EMAIL: {
        async send(m: { to: string[]; text?: string }) {
          sent.push(m);
          return { messageId: "provider-1" };
        },
      },
    });
    await seedInvoice(e, ctx);

    // It can READ this message now.
    const got = await read(`/api/messages/${encodeURIComponent(INVOICE_ID)}`, { token: AGENT_TOKEN }, e, ctx);
    expect(got.status).toBe(200);

    // It still cannot pull it onto the wire as a quote.
    const res = await handleApi(
      req("/api/reply", { token: AGENT_TOKEN }, "POST", {
        messageId: INVOICE_ID, text: "see below", quoteOriginal: true,
      }),
      e, ctx,
    );
    expect(res.status, "writeReadScope was left alone on purpose").toBe(404);
    expect(sent, "and nothing was dispatched").toHaveLength(0);
  });
});

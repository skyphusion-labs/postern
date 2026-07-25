// #422: session-mode reads ACCEPTED `to=` and then silently ignored it.
//
// store.list / ftsSearch / substrSearch resolved the viewer as `viewer ?? to`, and a
// bound session sets `viewer`, so the caller's recipient filter never reached the
// WHERE clause. Nothing leaked (the account boundary still applied), but a session
// client that filtered by correspondent got the UNFILTERED page back with no way to
// tell -- the same false-PASS family as #403 defect 2: a filter the answer was not
// actually filtered by. Ruling: HONOR it, as a recipient filter ANDed INSIDE the
// account boundary, matching what `to=` means on every other auth path.
//
// Every case is anchored on the NEGATIVE (what must not come back) plus a positive
// control on the same query path, because a zero from a dead path passes for the
// wrong reason. The session is a REAL one (native backend, minted against the real
// webmail_sessions table and presented as a cookie to handleApi), never a
// hand-set `viewer` field: the whole defect lived in how the API derives the viewer,
// so a test that sets it directly would be testing my own assumption.
//
// Real SQLite (./realdb): the fix IS a WHERE predicate, which a SQL-pattern-matching
// fake cannot judge.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { hashSecret } from "./src/smtpcreds";
import { mintNativeSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { resetRoleCache } from "./src/roles";
import { realEnv, putInbound, putOutbound } from "./realdb";

const ME = "me@skyphusion.org";
const OTHER = "other@skyphusion.org"; // another account on the same estate
const ALICE = "alice@example.com"; // a correspondent
const BOB = "bob@example.com"; // a different correspondent
const PASSWORD = "correct-horse-battery-staple";

function sessionEnv() {
  return realEnv({ WEBMAIL_AUTH_BACKEND: "native" });
}

async function seedCredential(db: DatabaseSync, owner: string): Promise<void> {
  const hash = await hashSecret(PASSWORD);
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, ?, ?)",
  ).run(owner, owner, hash, "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
}

async function sessionCookie(env: Env, raw: DatabaseSync, owner: string): Promise<string> {
  await seedCredential(raw, owner);
  const minted = await mintNativeSession(env, owner, PASSWORD);
  if (!minted) throw new Error("session mint failed: the test cannot prove anything");
  return `${SESSION_COOKIE}=${minted.rawId}; ${CSRF_COOKIE}=${minted.csrfToken}`;
}

function sessionGet(path: string, cookie: string): Request {
  return new Request(`https://postern.example${path}`, { headers: { cookie } });
}

function tokenGet(path: string): Request {
  return new Request(`https://postern.example${path}`, {
    headers: { authorization: "Bearer test-token" },
  });
}

async function ids(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    items: Array<{ messageId?: string; message?: { messageId: string } }>;
  };
  return body.items.map((i) => i.messageId ?? i.message!.messageId).sort();
}

/** My mailbox: mail from two correspondents, mail I sent to each, and one message
 *  that belongs to ANOTHER account entirely (the boundary probe). */
async function seedEstate(env: Env, ctx: ExecutionContext) {
  await putInbound(env, ctx, { id: "in-alice@x", from: ALICE, to: ME, subject: "from alice", body: "alpha marker" });
  await putInbound(env, ctx, { id: "in-bob@x", from: BOB, to: ME, subject: "from bob", body: "alpha marker" });
  await putOutbound(env, ctx, { id: "out-alice@x", from: ME, to: [ALICE], subject: "to alice", body: "alpha marker" });
  await putOutbound(env, ctx, { id: "out-bob@x", from: ME, to: [BOB], subject: "to bob", body: "alpha marker" });
  // Not mine at all: delivered to another account, authored by neither me nor a
  // correspondent I know. Nothing I ask for may ever return this.
  await putInbound(env, ctx, { id: "not-mine@x", from: ALICE, to: OTHER, subject: "private", body: "alpha marker" });
}

describe("#422 list: a session's to= is honored INSIDE the account boundary", () => {
  it("filters to the named correspondent instead of returning the whole account", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    // Positive control FIRST: with no to=, the session really does see its whole
    // account, so the filtered result below cannot be a broken query path.
    const all = await ids(await handleApi(sessionGet("/api/messages", cookie), env, ctx));
    expect(all).toEqual(["in-alice@x", "in-bob@x", "out-alice@x", "out-bob@x"]);

    // The fix: to=ALICE returns only the messages delivered to alice.
    const filtered = await ids(await handleApi(sessionGet(`/api/messages?to=${ALICE}`, cookie), env, ctx));
    expect(filtered).toEqual(["out-alice@x"]);
    // The swallow is dead: it is NOT the unfiltered page.
    expect(filtered).not.toEqual(all);
  });

  it("returns an EMPTY page for an address the account never corresponded with", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const none = await ids(
      await handleApi(sessionGet("/api/messages?to=nobody@example.com", cookie), env, ctx),
    );
    expect(none).toEqual([]);
    // Control: the identical request minus the filter is non-empty, so the zero
    // above is the filter working and not an empty store or a dead route.
    expect(await ids(await handleApi(sessionGet("/api/messages", cookie), env, ctx))).not.toEqual([]);
  });

  it("never widens the boundary: to= another account returns nothing of theirs", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const probe = await ids(await handleApi(sessionGet(`/api/messages?to=${OTHER}`, cookie), env, ctx));
    expect(probe).toEqual([]);
    expect(probe).not.toContain("not-mine@x");

    // Control that the row EXISTS and is reachable by someone: an estate token sees
    // it, so the empty answer above is the boundary, not a missing fixture.
    const estate = await ids(await handleApi(tokenGet(`/api/messages?to=${OTHER}`), env, ctx));
    expect(estate).toEqual(["not-mine@x"]);
  });

  it("composes with lens=sent: my sent mail TO that correspondent only", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const sentAll = await ids(await handleApi(sessionGet("/api/messages?lens=sent", cookie), env, ctx));
    expect(sentAll).toEqual(["out-alice@x", "out-bob@x"]);
    const sentToBob = await ids(
      await handleApi(sessionGet(`/api/messages?lens=sent&to=${BOB}`, cookie), env, ctx),
    );
    expect(sentToBob).toEqual(["out-bob@x"]);
  });

  it("composes with lens=inbox: arrivals from that correspondent only", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const inbox = await ids(await handleApi(sessionGet("/api/messages?lens=inbox", cookie), env, ctx));
    expect(inbox).toEqual(["in-alice@x", "in-bob@x"]);
    // to=ME under lens=inbox is the account's own arrivals: still both.
    const mine = await ids(
      await handleApi(sessionGet(`/api/messages?lens=inbox&to=${ME}`, cookie), env, ctx),
    );
    expect(mine).toEqual(["in-alice@x", "in-bob@x"]);
    // to=ALICE under lens=inbox: alice is not a recipient of my arrivals, so empty
    // (the inbox lens is delivered-to-ME by construction).
    expect(
      await ids(await handleApi(sessionGet(`/api/messages?lens=inbox&to=${ALICE}`, cookie), env, ctx)),
    ).toEqual([]);
  });

  it("composes with direction=, which still reports the exact stored fact (#403)", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const outboundToAlice = await ids(
      await handleApi(sessionGet(`/api/messages?direction=outbound&to=${ALICE}`, cookie), env, ctx),
    );
    expect(outboundToAlice).toEqual(["out-alice@x"]);
    // The inbound half of the same correspondent pair is delivered to ME, not to
    // alice, so an inbound+to=ALICE question is honestly empty.
    expect(
      await ids(await handleApi(sessionGet(`/api/messages?direction=inbound&to=${ALICE}`, cookie), env, ctx)),
    ).toEqual([]);
  });
});

describe("#422 search: the same swallow, the same fix, in every mode", () => {
  it("fts honors to= under a session", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const all = await ids(await handleApi(sessionGet("/api/search?q=alpha", cookie), env, ctx));
    expect(all).toEqual(["in-alice@x", "in-bob@x", "out-alice@x", "out-bob@x"]);
    const filtered = await ids(
      await handleApi(sessionGet(`/api/search?q=alpha&to=${ALICE}`, cookie), env, ctx),
    );
    expect(filtered).toEqual(["out-alice@x"]);
    expect(filtered).not.toEqual(all);
    expect(
      await ids(await handleApi(sessionGet(`/api/search?q=alpha&to=${OTHER}`, cookie), env, ctx)),
    ).toEqual([]);
  });

  it("substr honors to= under a session", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const all = await ids(
      await handleApi(sessionGet("/api/search?q=marker&mode=substr&field=body", cookie), env, ctx),
    );
    expect(all).toEqual(["in-alice@x", "in-bob@x", "out-alice@x", "out-bob@x"]);
    const filtered = await ids(
      await handleApi(
        sessionGet(`/api/search?q=marker&mode=substr&field=body&to=${BOB}`, cookie),
        env,
        ctx,
      ),
    );
    expect(filtered).toEqual(["out-bob@x"]);
    expect(filtered).not.toEqual(all);
  });

  it("semantic honors to= under a session (post-hydrate scope, not a pushed WHERE)", async () => {
    // The vector index is external and deliberately DUMB here: it returns every
    // seeded message as a match, so the ONLY thing that can filter the page is the
    // scope predicate under test. The unfiltered control below proves the ranking
    // path really ran (an AI-less env returns an empty page for the wrong reason).
    const seededIds = ["in-alice@x", "in-bob@x", "out-alice@x", "out-bob@x", "not-mine@x"];
    const { env, ctx, raw } = realEnv({
      WEBMAIL_AUTH_BACKEND: "native",
      AI: { async run() { return { data: [[0.1, 0.2, 0.3]] }; } },
      VECTORIZE: {
        async query() {
          return {
            matches: seededIds.map((id, i) => ({
              id: `${id}#0`,
              score: 1 - i / 100,
              metadata: { message_id: id },
            })),
          };
        },
      },
    });
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const all = await ids(
      await handleApi(sessionGet("/api/search?q=alpha&mode=semantic", cookie), env, ctx),
    );
    expect(all).toEqual(["in-alice@x", "in-bob@x", "out-alice@x", "out-bob@x"]);
    expect(all).not.toContain("not-mine@x"); // the boundary, before any to= filter

    const filtered = await ids(
      await handleApi(sessionGet(`/api/search?q=alpha&mode=semantic&to=${ALICE}`, cookie), env, ctx),
    );
    expect(filtered).toEqual(["out-alice@x"]);
    expect(filtered).not.toEqual(all);
    expect(
      await ids(
        await handleApi(sessionGet(`/api/search?q=alpha&mode=semantic&to=${OTHER}`, cookie), env, ctx),
      ),
    ).toEqual([]);
  });
});

describe("#422 composes with the #425 role branch, in that order", () => {
  // The agreed contract: a session to=R where R is a role the session belongs to is
  // rewritten upstream into the ROLE boundary (to=R, lens=inbox, seenFor=session,
  // account viewer DROPPED), so it reaches recipientWhere and never touches the
  // account-boundary filter added here. Every other to= falls through to this fix.
  // Asserted from the outside, through handleApi, because the ordering is the point.
  const ROLE = "abuse@skyphusion.org";

  it("a role read answers with the QUEUE, not the empty page the account filter would give", async () => {
    const { env, ctx, raw } = realEnv({
      WEBMAIL_AUTH_BACKEND: "native",
      POSTERN_VIEWER_ROLES: `${ROLE}=${ME}`,
    });
    resetRoleCache();
    await seedEstate(env, ctx);
    await putInbound(env, ctx, { id: "queue@x", from: "reporter@example.com", to: ROLE, subject: "abuse" });
    const cookie = await sessionCookie(env, raw, ME);

    // Role branch wins: the queue mail comes back even though it is delivered to
    // NEITHER side of my account boundary.
    expect(await ids(await handleApi(sessionGet(`/api/messages?to=${ROLE}`, cookie), env, ctx)))
      .toEqual(["queue@x"]);
  });

  it("the SAME address for a NON-member falls through to this fix (empty, not the queue)", async () => {
    const { env, ctx, raw } = realEnv({
      WEBMAIL_AUTH_BACKEND: "native",
      POSTERN_VIEWER_ROLES: `${ROLE}=${OTHER}`, // configured, but I am not a member
    });
    resetRoleCache();
    await seedEstate(env, ctx);
    await putInbound(env, ctx, { id: "queue@x", from: "reporter@example.com", to: ROLE, subject: "abuse" });
    const cookie = await sessionCookie(env, raw, ME);

    const seen = await ids(await handleApi(sessionGet(`/api/messages?to=${ROLE}`, cookie), env, ctx));
    expect(seen).toEqual([]);
    expect(seen).not.toContain("queue@x");
    // Control on the same env: the member DOES get the queue, so the empty answer
    // above is the membership check plus this filter, not a broken role map.
    const memberCookie = await sessionCookie(env, raw, OTHER);
    expect(await ids(await handleApi(sessionGet(`/api/messages?to=${ROLE}`, memberCookie), env, ctx)))
      .toEqual(["queue@x"]);
  });
});

describe("#422 regression controls: the token path is untouched", () => {
  it("to= with a BYO token still means the viewer, exactly as before", async () => {
    const { env, ctx } = realEnv();
    await seedEstate(env, ctx);

    // No session: to=ME is delivered-set membership for ME (the pre-#422 meaning).
    expect(await ids(await handleApi(tokenGet(`/api/messages?to=${ME}`), env, ctx)))
      .toEqual(["in-alice@x", "in-bob@x"]);
    // And to=ALICE is alice's own delivered set, which on this estate is the copy
    // of what I sent her.
    expect(await ids(await handleApi(tokenGet(`/api/messages?to=${ALICE}`), env, ctx)))
      .toEqual(["out-alice@x"]);
  });

  it("a session with NO to= is byte-identical to before the fix", async () => {
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);

    const viaApi = await ids(await handleApi(sessionGet("/api/messages", cookie), env, ctx));
    const direct = (await store.list(env, { viewer: ME })).items.map((m) => m.messageId).sort();
    expect(viaApi).toEqual(direct);
    expect(viaApi).toEqual(["in-alice@x", "in-bob@x", "out-alice@x", "out-bob@x"]);
  });

  it("seen projection still keys on the SESSION, not the filtered correspondent", async () => {
    // #404 boundary: to= now filters rows, but whose read state is rendered must
    // not move with it. Mark one message read for ME, then filter by correspondent
    // and require the row still reports seen for ME.
    const { env, ctx, raw } = sessionEnv();
    await seedEstate(env, ctx);
    const cookie = await sessionCookie(env, raw, ME);
    await store.setSeen(env, ["out-alice@x"], true, ME, ME);

    const res = await handleApi(sessionGet(`/api/messages?to=${ALICE}`, cookie), env, ctx);
    const body = (await res.json()) as { items: Array<{ messageId: string; seen: boolean }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ messageId: "out-alice@x", seen: true });
  });
});

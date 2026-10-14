// #717: a scoped read returned count:0 (or messages:[], or a 404) and said NOTHING about
// the scope it was answered under, so "not your mail" and "no such mail" were one answer.
//
// #636 fixed this for `GET /api/messages` and `GET /api/search` and stopped there. Five
// more read surfaces kept answering silently, and `GET /api/threads/{id}` was WORSE than
// silent: per the Page contract `cursor: null` is a POSITIVE claim of exhaustion, so a
// narrowed thread was announced as a complete one.
//
// WHAT CHANGED AT #718, because it changed WHO the narrowed caller is and not what this
// file asserts. Conrad ruled that an agent credential reads estate-wide, so a registry
// Bearer is no longer a narrowed reader and cannot drive the narrow arms here. The
// narrowed caller is now a webmail SESSION, which is the door that is still scoped, and
// these arms moved to it. The PROPERTY is untouched and is deliberately value-agnostic:
// every read surface must state the scope it was answered under, whatever that scope is.
//
// WHY THIS SUITE USES realEnv. The subject is the interaction between an access PREDICATE
// and a response envelope. A fake store that pattern-matches SQL would report whatever the
// envelope claimed regardless of which rows the predicate withheld, so it would pass on
// the defect. realEnv runs node:sqlite against the shipped schema.sql, and the session is
// really minted rather than a hand-built resolution.
//
// THE TWO DIRECTIONS, both required and neither sufficient:
//   - POSITIVE: a narrowed read must SAY it was narrowed.
//   - NEGATIVE: it must not say WHAT was withheld. A read that should return nothing still
//     returns nothing, and a withheld object is byte-identical to an absent one, so the new
//     field cannot be used as an existence oracle. Trading the first indistinguishable pair
//     for a disclosure channel would not be a fix.

import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { sha256Hex } from "./src/sendidentity";
import { mintNativeSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { hashSecret } from "./src/smtpcreds";
import { realEnv, putInbound } from "./realdb";

const ESTATE = "test-token";
const AGENT_TOKEN = "agent-registry-token";
const AGENT = "agent@skyphusion.org";
const HUMAN = "human@skyphusion.org";
const OTHER = "conrad@skyphusion.org";
const QUEUE = "abuse@skyphusion.org";
const OUTSIDER = "vendor@example.net";
const PASSWORD = "hunter2hunter2";

// The withheld bytes, distinctive so an assertion can prove they did not travel rather
// than only that a status code came back.
const WITHHELD_BODY = "the invoice nobody outside conrad can read";

async function env(roles = "") {
  const registry = { [await sha256Hex(AGENT_TOKEN)]: { from: AGENT, scopes: ["read"] } };
  return realEnv({
    WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_SEND_IDENTITIES: JSON.stringify(registry),
    POSTERN_VIEWER_ROLES: roles,
  });
}

/** A REAL minted session for `address`, which is the narrowed reader after #718. */
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

function req(path: string, auth: Auth): Request {
  const headers: Record<string, string> =
    "cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` };
  return new Request(`https://postern.example${path}`, { headers });
}

async function body(path: string, auth: Auth, e: Env, ctx: ExecutionContext) {
  const res = await handleApi(req(path, auth), e, ctx);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// --- the coverage gate -------------------------------------------------------------
//
// Derived from ROUTE_TABLE, not from a hand-kept list, because a hand-kept list is how
// five routes came to be missing in the first place. A read route that is neither probed
// below nor exempted WITH A REASON fails this suite, so the next read surface cannot ship
// silent by omission.

/** One live probe path per read route that answers about stored mail. */
const PROBES: Record<string, string> = {
  whoami: "/api/whoami",
  "messages-list": "/api/messages",
  search: "/api/search?q=invoice",
  "recipients-recent": "/api/recipients/recent",
  folders: "/api/folders",
  "message-get": "/api/messages/mine@x",
  "thread-get": "/api/threads/t-1",
};

/** Read routes that answer about something OTHER than stored mail, and why. */
const EXEMPT: Record<string, string> = {
  mobileconfig:
    "serves an Apple .mobileconfig plist built from env, not a row set: nothing is " +
    "narrowed by the reader's authority, so there is no scope to announce",
};

describe("#717 every read surface announces the scope it was answered under", () => {
  it("CONTROL: every read route in ROUTE_TABLE is either probed or exempted with a reason", () => {
    const readRoutes = ROUTE_TABLE.filter((r) => r.scope === "read").map((r) => r.id);
    expect(readRoutes.length, "the table must actually contain read routes").toBeGreaterThan(5);
    const unclassified = readRoutes.filter((id) => !(id in PROBES) && !(id in EXEMPT));
    expect(
      unclassified,
      "a new read route must be probed below or exempted with a reason, never left silent",
    ).toEqual([]);
    for (const [id, reason] of Object.entries(EXEMPT)) {
      expect(readRoutes, `exempt route ${id} must still exist in the table`).toContain(id);
      expect(reason.length, `exempt route ${id} needs a real reason`).toBeGreaterThan(40);
    }
  });

  // --- the positive direction ------------------------------------------------------

  describe("a SESSION, the narrowed reader after #718, is told its reads are narrowed", () => {
    for (const [id, path] of Object.entries(PROBES)) {
      it(`${id} reports identityScope naming the session identity`, async () => {
        const { env: e, ctx, raw } = await env();
        const cookie = await signIn(e, raw, HUMAN);
        await putInbound(e, ctx, { id: "mine@x", from: OUTSIDER, to: HUMAN, subject: "invoice" });

        const { json } = await body(path, { cookie }, e, ctx);
        const scope = json.identityScope as { kind: string; addresses?: string[] } | undefined;
        expect(scope, `${id} answered without naming its scope`).toBeDefined();
        expect(scope?.kind, `${id} must not report a narrowed read as estate-wide`).toBe("member");
        expect(scope?.addresses, `${id} must name the member it was scoped to`).toContain(HUMAN);
      });
    }

    it("a static estate token is told its reads are NOT narrowed", async () => {
      const { env: e, ctx } = await env();
      await putInbound(e, ctx, { id: "mine@x", from: OUTSIDER, to: HUMAN, subject: "invoice" });
      for (const [id, path] of Object.entries(PROBES)) {
        // recipients-recent refuses an unbound caller with no viewer=; name one, which is
        // the caller's OWN filter and so must NOT be reported as an imposed scope.
        const p = id === "recipients-recent" ? `${path}?viewer=${HUMAN}` : path;
        const { json } = await body(p, { token: ESTATE }, e, ctx);
        expect(json.identityScope, `${id} answered an estate token without a scope`).toEqual({
          kind: "estate",
        });
      }
    });

    it("an AGENT credential is told estate on every one of them too (#718)", async () => {
      // The #718 half of the same property: the field must track the scope that actually
      // applied, so an agent must now read `estate` on the routes a session reads `member`.
      // Driven over the SAME probe table, so a route cannot answer one caller and not the
      // other. `recipients-recent` is the deliberate exception and is asserted below.
      const { env: e, ctx } = await env();
      await putInbound(e, ctx, { id: "mine@x", from: OUTSIDER, to: HUMAN, subject: "invoice" });
      for (const [id, path] of Object.entries(PROBES)) {
        if (id === "recipients-recent") continue;
        const { json } = await body(path, { token: AGENT_TOKEN }, e, ctx);
        expect(json.identityScope, `${id} did not report the widened scope`).toEqual({
          kind: "estate",
        });
      }
    });

    it("recipients-recent stays bound to the agent's OWN address, and says so", async () => {
      // NOT widened, deliberately, and the scope report is what makes that legible rather
      // than surprising. This route answers "who have I corresponded with" for composing,
      // so it is keyed to the SENDING identity; an estate-wide contact dump is a different
      // feature nobody asked for. #718 widened whose MAIL an agent may read.
      const { env: e, ctx } = await env();
      await putInbound(e, ctx, { id: "mine@x", from: OUTSIDER, to: AGENT, subject: "invoice" });

      const { json } = await body("/api/recipients/recent", { token: AGENT_TOKEN }, e, ctx);
      expect(json.identityScope).toEqual({ kind: "member", addresses: [AGENT] });
    });

    it("the report is DERIVED from the scope the read used, so it covers role queues too", async () => {
      // The discriminator against a re-derived `[member]`: these routes read under member
      // PLUS queue, and a report that named only the member would understate their reach.
      const { env: e, ctx, raw } = await env(`${QUEUE}=${HUMAN}`);
      const cookie = await signIn(e, raw, HUMAN);
      await putInbound(e, ctx, { id: "q@x", from: OUTSIDER, to: QUEUE, subject: "abuse report" });

      const { status, json } = await body("/api/messages/q@x", { cookie }, e, ctx);
      expect(status, "a queue member may read queue mail").toBe(200);
      const scope = json.identityScope as { kind: string; addresses: string[] };
      expect(scope.addresses, "the queue is part of what this read covered").toContain(QUEUE);
      expect(scope.addresses, "so is the member itself").toContain(HUMAN);
    });

    it("a narrowed THREAD no longer claims exhaustion unqualified", async () => {
      const { env: e, ctx, raw } = await env();
      const cookie = await signIn(e, raw, HUMAN);
      await putInbound(e, ctx, { id: "a@x", from: OUTSIDER, to: HUMAN, subject: "re: invoice" });
      await putInbound(e, ctx, {
        id: "b@x", from: OUTSIDER, to: OTHER, subject: "re: invoice", body: WITHHELD_BODY,
      });
      raw.prepare("UPDATE messages SET thread_id = ?").run("t-1");

      const mine = await body("/api/threads/t-1", { cookie }, e, ctx);
      expect(mine.status).toBe(200);
      // The pre-#717 envelope, intact: a null cursor still positively claims exhaustion.
      expect(mine.json.cursor, "a null cursor is still the exhaustion claim").toBeNull();
      expect((mine.json.messages as unknown[]).length, "one of the two is withheld").toBe(1);
      // What is new is the qualifier that makes that claim readable as "the whole thread
      // YOU may read" instead of "the whole thread".
      expect(mine.json.identityScope).toEqual({ kind: "member", addresses: [HUMAN] });
      expect(JSON.stringify(mine.json), "the withheld body must not travel").not.toContain(
        WITHHELD_BODY,
      );

      // POSITIVE CONTROL: the boundary is real and this instrument can see both sides. If
      // the estate read also returned one message, the arm above would be measuring an
      // empty store rather than a narrowing.
      const all = await body("/api/threads/t-1", { token: ESTATE }, e, ctx);
      expect((all.json.messages as unknown[]).length, "the thread really has two").toBe(2);
      expect(all.json.identityScope).toEqual({ kind: "estate" });
    });
  });

  // --- the negative direction ------------------------------------------------------

  describe("the scope statement is not an existence oracle", () => {
    it("a withheld message and an absent one are the SAME 404, byte for byte", async () => {
      const { env: e, ctx, raw } = await env();
      const cookie = await signIn(e, raw, HUMAN);
      await putInbound(e, ctx, {
        id: "theirs@x", from: OUTSIDER, to: OTHER, subject: "invoice", body: WITHHELD_BODY,
      });

      const withheld = await body("/api/messages/theirs@x", { cookie }, e, ctx);
      const absent = await body("/api/messages/no-such@x", { cookie }, e, ctx);

      expect(withheld.status, "a withheld message is a 404").toBe(404);
      expect(absent.status, "so is an absent one").toBe(404);
      expect(
        JSON.stringify(withheld.json),
        "the two refusals must remain one answer: a difference here is a disclosure channel",
      ).toBe(JSON.stringify(absent.json));
      // And the fact the caller DOES need: this 404 came out of a narrowed read.
      expect(withheld.json.identityScope).toEqual({ kind: "member", addresses: [HUMAN] });
      expect(JSON.stringify(withheld.json)).not.toContain(WITHHELD_BODY);

      // POSITIVE CONTROL: the withheld id is real. Without this the arm above passes
      // against a store where neither id exists, which proves nothing about scoping.
      const asEstate = await body("/api/messages/theirs@x", { token: ESTATE }, e, ctx);
      expect(asEstate.status, "the withheld message exists and an estate read sees it").toBe(200);
    });

    it("a withheld attachment and an absent index are the SAME 404, byte for byte", async () => {
      const { env: e, ctx, raw } = await env();
      const cookie = await signIn(e, raw, HUMAN);
      await putInbound(e, ctx, { id: "mine@x", from: OUTSIDER, to: HUMAN, subject: "no atts" });
      await putInbound(e, ctx, {
        id: "theirs@x", from: OUTSIDER, to: OTHER, subject: "invoice", body: WITHHELD_BODY,
      });

      // Refused on authority.
      const withheld = await body("/api/messages/theirs@x/attachments/0", { cookie }, e, ctx);
      // Reachable message, no such attachment index.
      const noIndex = await body("/api/messages/mine@x/attachments/0", { cookie }, e, ctx);

      expect(withheld.status).toBe(404);
      expect(noIndex.status).toBe(404);
      expect(
        JSON.stringify(withheld.json),
        "which of the two refusals happened must stay invisible",
      ).toBe(JSON.stringify(noIndex.json));
      expect(withheld.json.identityScope).toEqual({ kind: "member", addresses: [HUMAN] });
    });

    it("a read that SHOULD return nothing still returns nothing, and says so plainly", async () => {
      const { env: e, ctx, raw } = await env();
      const cookie = await signIn(e, raw, HUMAN);
      await putInbound(e, ctx, {
        id: "theirs@x", from: OUTSIDER, to: OTHER, subject: "invoice", body: WITHHELD_BODY,
      });

      // The incident query, reproduced against the door that is still scoped: the reader
      // searches for mail that exists and is not theirs. The result stays empty; what
      // changed at #717 is that it is now self-describing.
      const search = await body("/api/search?q=invoice&mode=fts", { cookie }, e, ctx);
      expect((search.json.items as unknown[]).length, "still no rows, correctly").toBe(0);
      expect(search.json.identityScope).toEqual({ kind: "member", addresses: [HUMAN] });
      expect(JSON.stringify(search.json)).not.toContain(WITHHELD_BODY);

      const list = await body("/api/messages", { cookie }, e, ctx);
      expect((list.json.items as unknown[]).length).toBe(0);
      expect(list.json.identityScope).toEqual({ kind: "member", addresses: [HUMAN] });

      // POSITIVE CONTROL on the instrument: the same query under the estate token DOES
      // return the row, so the zeroes above are a narrowing and not an empty store or a
      // broken query. Without this arm every assertion here passes on a no-op.
      const asEstate = await body("/api/search?q=invoice&mode=fts", { token: ESTATE }, e, ctx);
      expect((asEstate.json.items as unknown[]).length, "the mail is there to be found").toBe(1);
    });
  });
});

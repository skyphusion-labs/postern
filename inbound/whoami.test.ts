// #650 (#632 F16, and the caller's side of F7): GET /api/whoami.
//
// Before this, an agent holding a Bearer token could not ask what identity it was or what
// scope its reads were being answered under. `identityScope` was reported only as a SIDE
// EFFECT of spending a /api/messages or /api/search query, so the caller learned its scope
// only AFTER choosing the query, and /api/session resolves the session COOKIE, so a token
// holder got 401 from the one whoami that existed.
//
// The load-bearing property is NOT that the route answers. It is that the route answers
// the SAME fact the gate and the read routes act on. A whoami computed from a second
// derivation could drift, and a caller has no way to discover it was lied to, which is why
// the drift arms below compare whoami against /api/messages for the SAME credential rather
// than against a literal.

import { describe, expect, it, beforeEach } from "vitest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";
import { sha256Hex } from "./src/sendidentity";
import { resetRoleCache } from "./src/roles";
import { ROUTE_SCOPES } from "./src/routes";

const ME = "me@skyphusion.org";
const QUEUE = "support@skyphusion.org";
const OTHER = "someone-else@skyphusion.org";
const ESTATE_TOKEN = "test-token";

beforeEach(() => resetRoleCache());

const get = (path: string, token: string) =>
  new Request(`https://postern.example${path}`, { headers: { authorization: `Bearer ${token}` } });

/** A registry token BOUND to `from` with the given scopes, plus an optional role map. */
async function boundEnv(from: string, scopes: string[], roles?: string) {
  const token = "bound-registry-token";
  const registry = { [await sha256Hex(token)]: { from, scopes } };
  const { env, ctx } = makeFakeEnv({
    POSTERN_SEND_IDENTITIES: JSON.stringify(registry),
    ...(roles ? { POSTERN_VIEWER_ROLES: roles } : {}),
  });
  return { env, ctx, token };
}

/** Every static scope slot wired at once, so one env can present any scope of token. */
function scopedEnv() {
  return makeFakeEnv({
    POSTERN_API_TOKEN: "tok-both",
    POSTERN_API_TOKEN_READ: "tok-read",
    POSTERN_API_TOKEN_SEND: "tok-send",
    POSTERN_API_TOKEN_DELETE: "tok-delete",
    POSTERN_API_TOKEN_IMAP: "tok-imap",
    POSTERN_API_TOKEN_ORGANIZE: "tok-organize",
  });
}

async function whoami(env: Env, ctx: ExecutionContext, token: string) {
  const res = await handleApi(get("/api/whoami", token), env, ctx);
  expect(res.status, "whoami should be reachable over Bearer").toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("#650 an agent can ask its own identity and scope over Bearer", () => {
  it("a bound read token is told WHICH identity it is and that it is scoped to itself", async () => {
    const { env, ctx, token } = await boundEnv(ME, ["read"]);

    const body = await whoami(env, ctx, token);

    expect(body.ok).toBe(true);
    expect(body.identity).toBe(ME);
    expect(body.identityScope).toEqual({ kind: "member", addresses: [ME] });
    expect(body.via).toBe("bearer");
  });

  it("CONTROL: a static estate token is told it is NOT bound, so both fields discriminate", async () => {
    const { env, ctx } = makeFakeEnv({});

    const body = await whoami(env, ctx, ESTATE_TOKEN);

    // `null` is the ANSWER, not a missing key: the caller must never have to read an
    // absent field as a value.
    expect(body).toHaveProperty("identity", null);
    expect(body.identityScope).toEqual({ kind: "estate" });
  });

  // The arm that matters. A literal expectation would pass while whoami answered from its
  // own second derivation; this compares the two surfaces for ONE credential, so they
  // cannot come apart without failing here.
  it("reports the SAME scope /api/messages reports, for the same credential (bound)", async () => {
    const { env, ctx, token } = await boundEnv(ME, ["read"]);

    const mine = await whoami(env, ctx, token);
    const list = (await (await handleApi(get("/api/messages", token), env, ctx)).json()) as Record<
      string,
      unknown
    >;

    expect(list.identityScope).toBeDefined();
    expect(mine.identityScope).toEqual(list.identityScope);
  });

  it("reports the SAME scope /api/messages reports, for the same credential (estate)", async () => {
    const { env, ctx } = makeFakeEnv({});

    const mine = await whoami(env, ctx, ESTATE_TOKEN);
    const list = (await (
      await handleApi(get("/api/messages", ESTATE_TOKEN), env, ctx)
    ).json()) as Record<string, unknown>;

    expect(list.identityScope).toBeDefined();
    expect(mine.identityScope).toEqual(list.identityScope);
  });
});

describe("#650 the capability set comes from the GATE, not from the token's name", () => {
  it("a `both` token is told all six scopes, which no echo of its own name would produce", async () => {
    const { env, ctx } = scopedEnv();

    const body = await whoami(env, ctx, "tok-both");

    expect(body.capabilities).toEqual([...ROUTE_SCOPES]);
    // The discriminator: "both" is NOT one of the reported values, so this cannot be the
    // token's own scope echoed back under a different key.
    expect(body.capabilities as string[]).not.toContain("both");
  });

  it("a `read` token is told read and nothing else, so the set is not a blanket", async () => {
    const { env, ctx } = scopedEnv();

    const body = await whoami(env, ctx, "tok-read");

    expect(body.capabilities).toEqual(["read"]);
    // Pins the #692 ruling from the caller's side: reading mail and filing mail are
    // separate grants, so a read token must never be told it can organize.
    expect(body.capabilities as string[]).not.toContain("organize");
  });

  it("a bound registry token is told its registry scopes, via the capability path", async () => {
    const { env, ctx, token } = await boundEnv(ME, ["read", "send"]);

    const body = await whoami(env, ctx, token);

    expect(body.capabilities).toEqual(["read", "send"]);
  });
});

describe("#650 role queues are reported, because identityScope alone understates reach", () => {
  it("a member is told the queue it may also read by naming to=", async () => {
    const { env, ctx, token } = await boundEnv(ME, ["read"], `${QUEUE}=${ME}`);

    const body = await whoami(env, ctx, token);

    expect(body.roleQueues).toEqual([QUEUE]);
    // identityScope stays the SINGLE member, exactly as a bare read binds it. The queue is
    // reported as the separate fact it is, never folded into the bound scope.
    expect(body.identityScope).toEqual({ kind: "member", addresses: [ME] });
  });

  it("CONTROL: a configured queue the caller is NOT a member of is not reported", async () => {
    const { env, ctx, token } = await boundEnv(ME, ["read"], `${QUEUE}=${OTHER}`);

    const body = await whoami(env, ctx, token);

    // The map is configured and non-empty, so an empty answer here is membership being
    // evaluated, not the map failing to load.
    expect(body.roleQueues).toEqual([]);
  });

  it("an unbound estate token has no queues, because membership needs an identity", async () => {
    const { env, ctx } = makeFakeEnv({ POSTERN_VIEWER_ROLES: `${QUEUE}=${ME}` });

    const body = await whoami(env, ctx, ESTATE_TOKEN);

    expect(body.roleQueues).toEqual([]);
  });
});

describe("#650 the route is `read`-scoped, deliberately", () => {
  // Decided here rather than left open: see the row note in routes.ts. What whoami answers
  // is WHOSE MAIL A READ IS BOUND TO, and for a credential that cannot read, that
  // projection has no truthful value -- a send-only token has no bound READ member, so the
  // honest projection computes `{kind:"estate"}` and would tell a token that is 403 on
  // every read route that it can read the whole estate. A 403 is the better answer.
  for (const scope of ["send", "delete", "imap", "organize"] as const) {
    it(`refuses a ${scope} token at the scope gate`, async () => {
      const { env, ctx } = scopedEnv();

      const res = await handleApi(get("/api/whoami", `tok-${scope}`), env, ctx);

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    });
  }

  it("CONTROL: the same request with a read token is 200, so the refusals are about scope", async () => {
    const { env, ctx } = scopedEnv();

    const res = await handleApi(get("/api/whoami", "tok-read"), env, ctx);

    expect(res.status).toBe(200);
  });

  it("an unknown token is 401, before any identity is disclosed", async () => {
    const { env, ctx } = scopedEnv();

    const res = await handleApi(get("/api/whoami", "nope"), env, ctx);

    expect(res.status).toBe(401);
  });
});

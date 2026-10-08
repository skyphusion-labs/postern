// #417 / #544: viewer-binding call sites, made explicit and pinned.
//
// #417 unified spellings (sessionViewer / boundViewer). #544 decided the open
// semantics: a registry token with scopes including "read" reaches list/search and
// is forced to its bound identity (same as a session). Send-only registry tokens
// stay 403 on read routes (estate operator tokens remain estate-wide).

import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import { sha256Hex } from "./src/sendidentity";
import { mintNativeSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { hashSecret } from "./src/smtpcreds";
import { realEnv, putInbound } from "./realdb";

const IDENTITY = "member@skyphusion.org";
const IDENTITY_TOKEN = "per-identity-secret";
const PASSWORD = "hunter2hunter2";
const READ_ROUTES = ["/api/messages", "/api/search?q=probe", "/api/folders"];

async function identityEnv() {
  const hash = await sha256Hex(IDENTITY_TOKEN);
  return realEnv({
    WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_SEND_IDENTITIES: JSON.stringify({ [hash]: { from: IDENTITY } }),
  });
}

function bearer(path: string, token: string): Request {
  return new Request(`https://postern.example${path}`, { headers: { authorization: `Bearer ${token}` } });
}

function cookied(path: string, cookie: string): Request {
  return new Request(`https://postern.example${path}`, { headers: { cookie } });
}

async function seed(env: Env, ctx: ExecutionContext) {
  await putInbound(env, ctx, { id: "mine@x", from: "out@example.com", to: IDENTITY, subject: "probe one" });
  await putInbound(env, ctx, { id: "theirs@x", from: "out@example.com", to: "other@skyphusion.org", subject: "probe two" });
}

async function session(env: Env, raw: import("node:sqlite").DatabaseSync): Promise<string> {
  const hash = await hashSecret(PASSWORD);
  raw
    .prepare(
      "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
        "VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(IDENTITY, IDENTITY, hash, "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
  const minted = await mintNativeSession(env, IDENTITY, PASSWORD);
  if (!minted) throw new Error("session mint failed: the test would prove nothing");
  return `${SESSION_COOKIE}=${minted.rawId}; ${CSRF_COOKIE}=${minted.csrfToken}`;
}

describe("#544 send-only registry tokens stay out of read routes", () => {
  it("a send-only per-identity token is refused on every read route that needs read scope", async () => {
    const { env, ctx } = await identityEnv();
    await seed(env, ctx);
    for (const path of READ_ROUTES) {
      const res = await handleApi(bearer(path, IDENTITY_TOKEN), env, ctx);
      expect(res.status, `${path} should refuse a send-scoped identity token`).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: "forbidden" });
    }
  });

  it("CONTROL: that same token IS a valid credential, it is only out of scope here", async () => {
    const { env, ctx } = await identityEnv();
    const unknown = await handleApi(bearer("/api/messages", "not-a-real-token"), env, ctx);
    expect(unknown.status).toBe(401);
    const send = await handleApi(
      new Request("https://postern.example/api/send", {
        method: "POST",
        headers: { authorization: `Bearer ${IDENTITY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "no recipients" }),
      }),
      env,
      ctx,
    );
    expect(send.status).not.toBe(401);
    expect(send.status).not.toBe(403);
  });
});

describe("#544 identity-bound read credentials force the viewer", () => {
  async function readIdentityEnv() {
    const hash = await sha256Hex(IDENTITY_TOKEN);
    return realEnv({
      WEBMAIL_AUTH_BACKEND: "native",
      POSTERN_SEND_IDENTITIES: JSON.stringify({
        [hash]: { from: IDENTITY, scopes: ["read"] },
      }),
    });
  }

  // Same bound identity, plus the #685 `organize` grant. The two envs differ in ONE
  // string, which is what makes the pair below evidence: the refusal and the scoped
  // write are the same token and the same routes, separated only by the grant.
  async function organizeIdentityEnv() {
    const hash = await sha256Hex(IDENTITY_TOKEN);
    return realEnv({
      WEBMAIL_AUTH_BACKEND: "native",
      POSTERN_SEND_IDENTITIES: JSON.stringify({
        [hash]: { from: IDENTITY, scopes: ["read", "organize"] },
      }),
    });
  }

  it("list and search return only the bound identity's mail (not the estate)", async () => {
    const { env, ctx } = await readIdentityEnv();
    await seed(env, ctx);

    const list = (await (await handleApi(bearer("/api/messages", IDENTITY_TOKEN), env, ctx)).json()) as {
      ok: boolean;
      items: Array<{ messageId: string }>;
    };
    expect(list.ok).toBe(true);
    expect(list.items.map((m) => m.messageId)).toEqual(["mine@x"]);

    const search = (await (
      await handleApi(bearer("/api/search?q=probe", IDENTITY_TOKEN), env, ctx)
    ).json()) as { ok: boolean; items: Array<{ message: { messageId: string } }> };
    expect(search.ok).toBe(true);
    expect(search.items.map((h) => h.message.messageId)).toEqual(["mine@x"]);
  });

  it("get of another identity's message is not found (not a silent estate read)", async () => {
    const { env, ctx } = await readIdentityEnv();
    await seed(env, ctx);
    const res = await handleApi(bearer("/api/messages/theirs@x", IDENTITY_TOKEN), env, ctx);
    expect(res.status).toBe(404);
  });

  it("CONTROL: estate POSTERN_API_TOKEN still sees both messages", async () => {
    const { env, ctx } = await readIdentityEnv();
    await seed(env, ctx);
    const all = (await (await handleApi(bearer("/api/messages", "test-token"), env, ctx)).json()) as {
      items: Array<{ messageId: string }>;
    };
    expect(all.items.map((m) => m.messageId).sort()).toEqual(["mine@x", "theirs@x"]);
  });

  it("flags/move on a registry organize token only touch own mail (not estate)", async () => {
    // `["read", "organize"]`: the grant decides WHICH ROUTES, the bound viewer decides
    // WHOSE MAIL. This arm is about the second, so the token must clear the first.
    const { env, ctx } = await organizeIdentityEnv();
    await seed(env, ctx);
    // Flag the other person's message: with bound viewer it must be a no-op (0 updated).
    const flag = await handleApi(
      new Request("https://postern.example/api/messages/flags", {
        method: "POST",
        headers: { authorization: `Bearer ${IDENTITY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ids: ["theirs@x"], set: { flagged: true } }),
      }),
      env,
      ctx,
    );
    expect(flag.status).toBe(200);
    const flagBody = (await flag.json()) as { updated: number };
    expect(flagBody.updated, "must not flag another identity's mail").toBe(0);

    const move = await handleApi(
      new Request("https://postern.example/api/messages/move", {
        method: "POST",
        headers: { authorization: `Bearer ${IDENTITY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ids: ["theirs@x"], mailbox: "trash" }),
      }),
      env,
      ctx,
    );
    expect(move.status).toBe(200);
    const moveBody = (await move.json()) as { updated: number };
    expect(moveBody.updated, "must not move another identity's mail").toBe(0);
  });

  it("a registry token granted only read cannot flag or move at all (#685)", async () => {
    const { env, ctx } = await readIdentityEnv();
    await seed(env, ctx);
    // Its OWN message, which the arm above shows an organize-granted token may touch.
    // So the 403 here is the GRANT refusing, not the viewer predicate.
    for (const [path, body] of [
      ["/api/messages/flags", { ids: ["mine@x"], set: { flagged: true } }],
      ["/api/messages/move", { ids: ["mine@x"], mailbox: "trash" }],
    ] as Array<[string, unknown]>) {
      const res = await handleApi(
        new Request(`https://postern.example${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${IDENTITY_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
      expect(res.status, `${path} must refuse a read-only registry token`).toBe(403);
      expect((await res.json() as { message?: string }).message).toContain("organize");
    }
  });

  it("CONTROL: that same read-only token still reads its own mail", async () => {
    const { env, ctx } = await readIdentityEnv();
    await seed(env, ctx);
    const res = await handleApi(bearer("/api/messages", IDENTITY_TOKEN), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ messageId: string }> };
    expect(body.items.map((m) => m.messageId)).toEqual(["mine@x"]);
  });
});

describe("#417 under a SESSION all three routes bind the same viewer", () => {
  it("list, search, and folders all answer as the session identity", async () => {
    const { env, ctx, raw } = await identityEnv();
    await seed(env, ctx);
    const cookie = await session(env, raw);

    const list = (await (await handleApi(cookied("/api/messages", cookie), env, ctx)).json()) as {
      items: Array<{ messageId: string }>;
    };
    expect(list.items.map((m) => m.messageId)).toEqual(["mine@x"]);

    const search = (await (await handleApi(cookied("/api/search?q=probe", cookie), env, ctx)).json()) as {
      items: Array<{ message: { messageId: string } }>;
    };
    expect(search.items.map((h) => h.message.messageId)).toEqual(["mine@x"]);

    const folders = (await (await handleApi(cookied("/api/folders", cookie), env, ctx)).json()) as {
      folders: Array<{ id: string; count: number }>;
    };
    const inbox = folders.folders.find((f) => f.id === "inbox");
    expect(inbox, "no inbox folder in the response").toBeTruthy();
    expect(inbox!.count, "folders counted the other account's mail too").toBe(1);
  });

  it("CONTROL: the other account's message exists and an estate token sees it", async () => {
    // So the 1s above are the viewer binding, not an empty store.
    const { env, ctx } = await identityEnv();
    await seed(env, ctx);
    const all = (await (await handleApi(bearer("/api/messages", "test-token"), env, ctx)).json()) as {
      items: Array<{ messageId: string }>;
    };
    expect(all.items.map((m) => m.messageId).sort()).toEqual(["mine@x", "theirs@x"]);
  });
});

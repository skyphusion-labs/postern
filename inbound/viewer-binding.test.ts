// #417: the three viewer-binding call sites, made explicit and pinned.
//
// The evaluation sweep flagged a latent lens inconsistency: /api/folders bound a
// viewer from ANY resolution.identity, while /api/messages and /api/search bound one
// only under a session, and all three said it in a different expression. They are now
// two NAMED helpers (sessionViewer / boundViewer) with one call site each, which is
// the refactor half.
//
// This file is the interesting half. The difference between the two policies is
// reachable only by a resolution that HAS a bound identity and is NOT a session, which
// today means exactly one thing: a per-identity send-registry token. That token
// resolves to `send` scope, and all three of these routes require `read`, so it is
// refused at the gate before any viewer policy runs. In other words the inconsistency
// is currently UNREACHABLE, which is why unifying the spellings changes nothing and
// why the remaining question (which policy should win if an identity-bound READ
// credential is ever minted) is a semantics decision, not a refactor.
//
// Pinned here so that stops being folklore: if a future change lets an identity-bound
// token reach these routes, these tests fail and the decision gets made deliberately
// instead of being discovered in production.

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

describe("#417 the two viewer policies cannot differ today", () => {
  it("a per-identity token is refused on every route that binds a viewer", async () => {
    const { env, ctx } = await identityEnv();
    await seed(env, ctx);
    for (const path of READ_ROUTES) {
      const res = await handleApi(bearer(path, IDENTITY_TOKEN), env, ctx);
      expect(res.status, `${path} should refuse a send-scoped identity token`).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: "forbidden" });
    }
  });

  it("CONTROL: that same token IS a valid credential, it is only out of scope here", async () => {
    // Without this the 403s above could just mean "unknown token", which would make
    // the unreachability claim vacuous.
    const { env, ctx } = await identityEnv();
    const unknown = await handleApi(bearer("/api/messages", "not-a-real-token"), env, ctx);
    expect(unknown.status).toBe(401);
    // The registry token authenticates: it reaches its OWN route (send) and is
    // rejected there on the request body, not on the credential.
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

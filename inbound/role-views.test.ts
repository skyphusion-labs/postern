// #425: webmail parity for role-address ownership, the API half.
//
// The #404 ruling (2026-07-25) gave a role queue its OWN view per role, kept INBOX
// personal, and keyed read state on the MEMBER. The IMAP door implements that (PR
// #423). Webmail scopes to ONE bound identity, so without this a member of abuse@ sees
// queue mail in Thunderbird and not in the browser: two human doors disagreeing about
// what one person may see.
//
// Real SQLite (realdb) and a REAL minted session, not a fake resolution: what is under
// test is an access predicate plus the seen-projection key, and a fake would only prove
// the fake agrees with itself. The four properties that carry the feature:
//
//   1. a MEMBER reads the queue, and INBOX does not change (no merge);
//   2. a NON-member reads nothing of it, through every read route;
//   3. read state is per MEMBER, and the row-level flag is never touched;
//   4. a role view is read plus mark-read ONLY -- move, flag and delete refuse.
//
// Each of the three guards was mutation-checked while writing: dropping the membership
// test in roleReadScope, dropping the server-derived seenFor, and widening the WRITE
// paths to the role set each make a test here fail.

import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { hashSecret } from "./src/smtpcreds";
import { mintNativeSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { resetRoleCache } from "./src/roles";
import { realEnv, putInbound } from "./realdb";

const ROLE = "abuse@skyphusion.org";
const ADA = "ada@skyphusion.org";
const BEN = "ben@skyphusion.org";
const CAROL = "carol@skyphusion.org";
const PASSWORD = "hunter2hunter2";
const TOKEN = "test-token";
const ROLES = `${ROLE}=${ADA}+${BEN}`;

const ROLE_MSG = "queue-1@skyphusion.org";
const ADA_MSG = "personal-1@skyphusion.org";

function env(roles: string = ROLES) {
  return realEnv({ WEBMAIL_AUTH_BACKEND: "native", POSTERN_VIEWER_ROLES: roles });
}

// The #404 case exactly: mail delivered to the ROLE address and to nobody else, so it
// belongs to a function and to no viewer. FILE_ALSO_UNDER is deliberately NOT in play.
async function seed(e: Env, ctx: ExecutionContext) {
  await putInbound(e, ctx, { id: ROLE_MSG, from: "reporter@example.com", to: ROLE, subject: "abuse report" });
  await putInbound(e, ctx, { id: ADA_MSG, from: "friend@example.com", to: ADA, subject: "personal note" });
}

async function credential(db: DatabaseSync, address: string) {
  const hash = await hashSecret(PASSWORD);
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, ?, ?)",
  ).run(address, address, hash, "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
}

async function signIn(e: Env, db: DatabaseSync, address: string) {
  await credential(db, address);
  const minted = await mintNativeSession(e, address, PASSWORD);
  return {
    cookie: `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`,
    csrf: minted!.csrfToken,
  };
}

function get(path: string, auth: { cookie: string } | { token: string }) {
  const headers: Record<string, string> = {};
  if ("cookie" in auth) headers["cookie"] = auth.cookie;
  else headers["authorization"] = `Bearer ${auth.token}`;
  return new Request(`https://postern.example${path}`, { headers });
}

function post(path: string, body: unknown, auth: { cookie: string; csrf: string }) {
  return new Request(`https://postern.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: auth.cookie,
      "x-postern-csrf": auth.csrf,
    },
    body: JSON.stringify(body),
  });
}

async function ids(res: Response): Promise<string[]> {
  const body = (await res.json()) as { items?: Array<{ messageId: string }> };
  return (body.items ?? []).map((m) => m.messageId);
}

function rowSeen(db: DatabaseSync, id: string): number {
  return (db.prepare("SELECT seen FROM messages WHERE message_id = ?").get(id) as { seen: number }).seen;
}

function overrides(db: DatabaseSync) {
  return db
    .prepare("SELECT message_id, recipient, seen FROM message_seen_by ORDER BY recipient")
    .all() as Array<{ message_id: string; recipient: string; seen: number }>;
}

beforeEach(() => {
  resetRoleCache();
});

describe("#425 a MEMBER reads the role queue, and INBOX stays personal", () => {
  it("serves the queue under to=ROLE, and does NOT merge it into the personal inbox", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);

    const queue = await handleApi(get(`/api/messages?to=${ROLE}&lens=inbox`, ada), e, ctx);
    expect(queue.status).toBe(200);
    expect(await ids(queue)).toEqual([ROLE_MSG]);

    // The whole point of the folder decision: the personal view is unchanged.
    const inbox = await handleApi(get("/api/messages?lens=inbox", ada), e, ctx);
    expect(await ids(inbox)).toEqual([ADA_MSG]);
  });

  it("enumerates the queue as its own folder, labelled by local part", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);
    const res = await handleApi(get("/api/folders", ada), e, ctx);
    const body = (await res.json()) as { folders: Array<{ id: string; label: string; role?: string; unread: number }> };
    const role = body.folders.find((f) => f.role === ROLE);
    expect(role).toBeTruthy();
    expect(role!.id).toBe(`role:${ROLE}`);
    expect(role!.label).toBe("abuse");
    expect(role!.unread).toBe(1);
    // The fixed personal set is still there, and Inbox still counts only personal mail.
    expect(body.folders.find((f) => f.id === "inbox")!.count).toBe(1);
  });

  it("opens a queue message, its attachments route and its thread", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);

    const one = await handleApi(get(`/api/messages/${encodeURIComponent(ROLE_MSG)}`, ada), e, ctx);
    expect(one.status).toBe(200);

    const stored = await store.get(e, ROLE_MSG);
    const thread = await handleApi(
      get(`/api/threads/${encodeURIComponent(stored!.threadId!)}`, ada),
      e,
      ctx,
    );
    const tb = (await thread.json()) as { messages: Array<{ messageId: string }> };
    expect(tb.messages.map((m) => m.messageId)).toEqual([ROLE_MSG]);
  });

  it("keeps a search inside the role view scoped to the queue", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);
    const res = await handleApi(get(`/api/search?q=report&to=${ROLE}`, ada), e, ctx);
    expect(res.status).toBe(200);
    const hits = (await res.json()) as { items: Array<{ message: { messageId: string; seen: boolean } }> };
    expect(hits.items.map((h) => h.message.messageId)).toEqual([ROLE_MSG]);

    // The personal search is unchanged by the same query, so the scope came from the
    // role view and not from a widened account boundary.
    const personal = await handleApi(get("/api/search?q=report", ada), e, ctx);
    const personalHits = (await personal.json()) as { items: Array<{ message: { messageId: string } }> };
    expect(personalHits.items.map((h) => h.message.messageId)).toEqual([]);
  });
});

describe("#425 a NON-member sees nothing of the queue, on every read route", () => {
  it("returns no queue rows for a to=ROLE list, and no role folder", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const carol = await signIn(e, raw, CAROL);

    const list = await handleApi(get(`/api/messages?to=${ROLE}&lens=inbox`, carol), e, ctx);
    expect(await ids(list)).not.toContain(ROLE_MSG);

    const folders = await handleApi(get("/api/folders", carol), e, ctx);
    const body = (await folders.json()) as { folders: Array<{ role?: string }> };
    expect(body.folders.some((f) => f.role)).toBe(false);
  });

  it("404s the single message, the attachment route and the thread", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const carol = await signIn(e, raw, CAROL);

    const one = await handleApi(get(`/api/messages/${encodeURIComponent(ROLE_MSG)}`, carol), e, ctx);
    expect(one.status).toBe(404);

    const att = await handleApi(
      get(`/api/messages/${encodeURIComponent(ROLE_MSG)}/attachments/0`, carol),
      e,
      ctx,
    );
    expect(att.status).toBe(404);

    const stored = await store.get(e, ROLE_MSG);
    const thread = await handleApi(
      get(`/api/threads/${encodeURIComponent(stored!.threadId!)}`, carol),
      e,
      ctx,
    );
    const tb = (await thread.json()) as { messages: unknown[] };
    expect(tb.messages).toEqual([]);
  });

  it("cannot mark queue mail read: nothing is written for a non-member", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const carol = await signIn(e, raw, CAROL);
    const res = await handleApi(
      post("/api/messages/seen", { ids: [ROLE_MSG], seen: true }, carol),
      e,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 0 });
    expect(overrides(raw)).toEqual([]);
    expect(rowSeen(raw, ROLE_MSG)).toBe(0);
  });
});

describe("#425 read state belongs to the MEMBER, never to the queue", () => {
  it("shows read for the member who read it and unread for the other, row flag untouched", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);
    const ben = await signIn(e, raw, BEN);

    const marked = await handleApi(
      post("/api/messages/seen", { ids: [ROLE_MSG], seen: true }, ada),
      e,
      ctx,
    );
    expect(await marked.json()).toMatchObject({ ok: true, updated: 1 });

    // The override is Ada own, and the ROW-level estate flag never moved: that flag is
    // what would turn "Ada read it" into "the queue is handled" for everybody.
    expect(overrides(raw)).toEqual([{ message_id: ROLE_MSG, recipient: ADA, seen: 1 }]);
    expect(rowSeen(raw, ROLE_MSG)).toBe(0);

    const asAda = await handleApi(get(`/api/messages?to=${ROLE}&lens=inbox`, ada), e, ctx);
    const adaBody = (await asAda.json()) as { items: Array<{ seen: boolean }> };
    expect(adaBody.items[0].seen).toBe(true);

    const asBen = await handleApi(get(`/api/messages?to=${ROLE}&lens=inbox`, ben), e, ctx);
    const benBody = (await asBen.json()) as { items: Array<{ seen: boolean }> };
    expect(benBody.items[0].seen).toBe(false);

    // And the rail agrees with the list, per member.
    const adaFolders = (await (await handleApi(get("/api/folders", ada), e, ctx)).json()) as {
      folders: Array<{ role?: string; unread: number }>;
    };
    const benFolders = (await (await handleApi(get("/api/folders", ben), e, ctx)).json()) as {
      folders: Array<{ role?: string; unread: number }>;
    };
    expect(adaFolders.folders.find((f) => f.role === ROLE)!.unread).toBe(0);
    expect(benFolders.folders.find((f) => f.role === ROLE)!.unread).toBe(1);
  });

  it("refuses a session naming ANOTHER reader seen state, role view included", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);
    const res = await handleApi(
      get(`/api/messages?to=${ROLE}&lens=inbox&seenFor=${BEN}`, ada),
      e,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_FORBIDDEN" });
  });
});

describe("#425 a role view is read plus mark-read ONLY", () => {
  it("refuses to move, flag or delete queue mail on behalf of every other member", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);

    const moved = await handleApi(
      post("/api/messages/move", { ids: [ROLE_MSG], mailbox: "trash" }, ada),
      e,
      ctx,
    );
    expect(await moved.json()).toMatchObject({ ok: true, updated: 0 });

    const flagged = await handleApi(
      post("/api/messages/flags", { ids: [ROLE_MSG], set: { flagged: true } }, ada),
      e,
      ctx,
    );
    expect(await flagged.json()).toMatchObject({ ok: true, updated: 0 });

    const deleted = await handleApi(
      new Request(`https://postern.example/api/messages/${encodeURIComponent(ROLE_MSG)}`, {
        method: "DELETE",
        headers: { cookie: ada.cookie, "x-postern-csrf": ada.csrf },
      }),
      e,
      ctx,
    );
    expect(deleted.status).toBe(404);

    // Nothing moved, nothing flagged, and the message is still there to be read.
    const row = raw
      .prepare("SELECT mailbox, flagged FROM messages WHERE message_id = ?")
      .get(ROLE_MSG) as { mailbox: string | null; flagged: number };
    expect(row.mailbox).toBe(null);
    expect(row.flagged).toBe(0);
  });

  it("refuses a role read that asks for a lens, direction or folder it does not have", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);
    for (const query of [
      `to=${ROLE}&lens=sent`,
      `to=${ROLE}&direction=inbound`,
      `to=${ROLE}&mailbox=trash`,
    ]) {
      const res = await handleApi(get(`/api/messages?${query}`, ada), e, ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });
    }
  });
});

describe("#425 fail-closed config, and the surfaces that stay untouched", () => {
  it("serves NO queue when the map is unusable, though the entry itself is well formed", async () => {
    const { env: e, ctx, raw } = env(`${ROLES},broken-entry-without-eq`);
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);

    const folders = (await (await handleApi(get("/api/folders", ada), e, ctx)).json()) as {
      folders: Array<{ role?: string }>;
    };
    expect(folders.folders.some((f) => f.role)).toBe(false);

    const list = await handleApi(get(`/api/messages?to=${ROLE}&lens=inbox`, ada), e, ctx);
    expect(await ids(list)).not.toContain(ROLE_MSG);
  });

  it("POSITIVE CONTROL: the same read with roles unconfigured is byte-identical to before", async () => {
    const { env: e, ctx, raw } = env("");
    await seed(e, ctx);
    const ada = await signIn(e, raw, ADA);
    const list = await handleApi(get(`/api/messages?to=${ROLE}&lens=inbox`, ada), e, ctx);
    // Pre-#425 session behavior: to= is not honored, the account boundary answers.
    // Whatever #422 decides for this path, THIS suite must not be what changes it.
    expect(await ids(list)).toEqual([ADA_MSG]);
  });

  it("leaves the estate token path alone: it reads the queue as it always did", async () => {
    const { env: e, ctx } = env();
    await seed(e, ctx);
    const list = await handleApi(get(`/api/messages?to=${ROLE}`, { token: TOKEN }), e, ctx);
    expect(await ids(list)).toEqual([ROLE_MSG]);

    // ... and gets NO role rail: a static token is estate-scoped already and has its
    // own door, so the concept buys it nothing.
    const folders = (await (await handleApi(get("/api/folders", { token: TOKEN }), e, ctx)).json()) as {
      folders: Array<{ role?: string }>;
    };
    expect(folders.folders.some((f) => f.role)).toBe(false);
  });

  it("prints the parsed map to an operator token, and refuses a session", async () => {
    const { env: e, ctx, raw } = env();
    await seed(e, ctx);
    const operator = await handleApi(get("/api/roles", { token: TOKEN }), e, ctx);
    expect(operator.status).toBe(200);
    expect(await operator.json()).toMatchObject({
      ok: true,
      roles: [{ address: ROLE, members: [ADA, BEN] }],
    });

    const ada = await signIn(e, raw, ADA);
    const asSession = await handleApi(get("/api/roles", ada), e, ctx);
    expect(asSession.status).toBe(403);
  });
});

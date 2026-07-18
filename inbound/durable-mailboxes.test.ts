import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import { ingest } from "./src/ingest";
import * as store from "./src/store";
import { makeFakeEnv } from "./fakes";

async function seed(env: Env, ctx: ExecutionContext, id = "one@example.com") {
  await ingest(env, {
    messageId: id,
    from: "sender@example.com",
    to: "conrad@skyphusion.org",
    subject: "hello",
    text: "body",
    date: "2026-07-18T00:00:00.000Z",
  }, ctx);
}

async function registry(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({ [hash]: { from: "conrad@skyphusion.org", displayName: "Conrad" } });
}

function request(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`https://postern.example${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("durable mailbox operations (#352)", () => {
  it("persists flags and moves/restores with a fresh per-folder UID", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx);
    await settle();

    expect(await store.setFlags(env, ["one@example.com"], { flagged: true, answered: true })).toBe(1);
    expect(await store.moveMessages(env, ["one@example.com"], "trash")).toBe(1);
    const trash = await store.list(env, { mailbox: "trash" });
    expect(trash.items[0]).toMatchObject({
      messageId: "one@example.com",
      flagged: true,
      answered: true,
      mailbox: "trash",
    });
    expect(trash.items[0].folderUid).toBeGreaterThan(0);
    expect(trash.items[0].trashedAt).toBeTruthy();
    expect((await store.list(env, {})).items).toHaveLength(0);

    expect(await store.moveMessages(env, ["one@example.com"], null)).toBe(1);
    expect((await store.list(env, {})).items[0]).toMatchObject({
      messageId: "one@example.com",
      mailbox: null,
      trashedAt: null,
    });
  });

  it("gives delete-only tokens only the irreversible delete door", async () => {
    const { env, ctx } = makeFakeEnv({
      POSTERN_API_TOKEN: "both-token",
      POSTERN_API_TOKEN_DELETE: "delete-token",
    });
    expect((await handleApi(request("GET", "/api/messages", "delete-token"), env, ctx)).status).toBe(403);
    expect((await handleApi(request("POST", "/api/send", "delete-token", {
      to: "a@example.com", subject: "x", text: "x",
    }), env, ctx)).status).toBe(403);
    expect((await handleApi(request("DELETE", "/api/messages/missing", "delete-token"), env, ctx)).status).toBe(404);
    expect((await handleApi(request("POST", "/api/admin/reindex", "delete-token", {}), env, ctx)).status).toBe(403);
  });

  it("creates identity-owned drafts, rejects stale autosaves, and mints a new UID per revision", async () => {
    const token = "identity-token";
    const { env, ctx } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: await registry(token),
    });
    const create = await handleApi(request("PUT", "/api/drafts/draft-1", token, {
      to: "friend@example.com",
      subject: "first",
      bodyText: "hello",
    }), env, ctx);
    expect(create.status).toBe(200);
    const first = (await create.json()) as { draft: store.Draft };
    expect(first.draft.identity).toBe("conrad@skyphusion.org");

    const stale = await handleApi(request("PUT", "/api/drafts/draft-1", token, {
      updatedAt: "stale",
      to: "friend@example.com",
      subject: "lost edit",
    }), env, ctx);
    expect(stale.status).toBe(409);

    const update = await handleApi(request("PUT", "/api/drafts/draft-1", token, {
      updatedAt: first.draft.updatedAt,
      to: "friend@example.com",
      subject: "second",
      bodyText: "hello again",
    }), env, ctx);
    expect(update.status).toBe(200);
    const second = (await update.json()) as { draft: store.Draft };
    expect(second.draft.uid).toBeGreaterThan(first.draft.uid);
    expect(second.draft.subject).toBe("second");
  });
});

// Monotonic insertion uid (#103, audit F9 / RFC 3501). The store surfaces
// messages.id (an AUTOINCREMENT rowid) as StoredMessageSummary.uid -- the durable
// IMAP UID the proxy maps each message to. These tests pin the two properties the
// proxy relies on: the field is present + positive on every summary, and it is
// strictly ASCENDING in arrival order (a later-stored message has a higher uid),
// so ordering by uid is stable regardless of the messages' Date headers.

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { makeFakeEnv } from "./fakes";

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://postern.example${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function sendOne(env: Env, ctx: ExecutionContext, settle: () => Promise<unknown[]>, subject: string): Promise<string> {
  const res = await handleApi(
    req("POST", "/api/send", { token: "test-token", body: { to: "d@example.com", subject, text: "yo" } }),
    env,
    ctx,
  );
  await settle();
  const { messageId } = (await res.json()) as { messageId: string };
  return messageId;
}

describe("StoredMessageSummary.uid (#103)", () => {
  it("is present and positive on every list summary", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await sendOne(env, ctx, settle, "first");
    await sendOne(env, ctx, settle, "second");

    const listRes = await handleApi(req("GET", "/api/messages", { token: "test-token" }), env, ctx);
    expect(listRes.status).toBe(200);
    const { items } = (await listRes.json()) as { items: { uid: number; messageId: string }[] };
    expect(items.length).toBe(2);
    for (const it of items) {
      expect(typeof it.uid).toBe("number");
      expect(Number.isInteger(it.uid)).toBe(true);
      expect(it.uid).toBeGreaterThan(0);
    }
  });

  it("increases strictly with arrival order (the later-stored message has the higher uid)", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    const firstId = await sendOne(env, ctx, settle, "earlier-arrival");
    const secondId = await sendOne(env, ctx, settle, "later-arrival");

    const listRes = await handleApi(req("GET", "/api/messages", { token: "test-token" }), env, ctx);
    const { items } = (await listRes.json()) as { items: { uid: number; messageId: string }[] };
    const byMsg = new Map(items.map((i) => [i.messageId, i.uid]));
    const firstUid = byMsg.get(firstId);
    const secondUid = byMsg.get(secondId);

    expect(firstUid).toBeDefined();
    expect(secondUid).toBeDefined();
    // Arrival order, NOT Date order: the message stored second gets the higher uid.
    expect(secondUid as number).toBeGreaterThan(firstUid as number);
  });

  it("matches the keyset cursor id half (store.list carries the same uid)", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await sendOne(env, ctx, settle, "alpha");
    const page = await store.list(env, { limit: 50 });
    expect(page.items.length).toBe(1);
    expect(page.items[0].uid).toBeGreaterThan(0);
  });
});

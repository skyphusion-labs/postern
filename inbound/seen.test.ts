import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { ingest } from "./src/ingest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// #seen: per-message read state so IMAP/webmail can show which mail is new.

describe("store seen state", () => {
  it("stores inbound mail unread and outbound sent copies read", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(
      env,
      { messageId: "in@example.com", from: "a@example.com", to: "conrad@skyphusion.org", subject: "hi", text: "yo", date: "2026-01-01T00:00:00.000Z" },
      ctx,
    );
    await store.put(
      env,
      { messageId: "out@example.com", direction: "outbound", from: "noreply@skyphusion.org", to: "a@example.com", subject: "re", date: "2026-01-02T00:00:00.000Z", bodyText: "b", auth: { spf: "none", dkim: "none", dmarc: "none" }, trusted: true },
      ctx,
    );
    await settle();

    expect((await store.get(env, "in@example.com"))!.seen).toBe(false);
    expect((await store.get(env, "out@example.com"))!.seen).toBe(true);
    // Summaries carry the same flag (drives the unread view body-free).
    const list = await store.list(env, {});
    const byId = Object.fromEntries(list.items.map((m) => [m.messageId, m.seen]));
    expect(byId["in@example.com"]).toBe(false);
    expect(byId["out@example.com"]).toBe(true);
  });

  it("setSeen flips read state and reports the number of rows changed", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(env, { messageId: "m1@example.com", from: "a@example.com", to: "c@skyphusion.org", subject: "s1", text: "t", date: "2026-01-01T00:00:00.000Z" }, ctx);
    await ingest(env, { messageId: "m2@example.com", from: "a@example.com", to: "c@skyphusion.org", subject: "s2", text: "t", date: "2026-01-02T00:00:00.000Z" }, ctx);
    await settle();

    const n = await store.setSeen(env, ["m1@example.com", "m2@example.com"], true);
    expect(n).toBe(2);
    expect((await store.get(env, "m1@example.com"))!.seen).toBe(true);
    expect((await store.get(env, "m2@example.com"))!.seen).toBe(true);

    // Mark one back to unread.
    expect(await store.setSeen(env, ["m1@example.com"], false)).toBe(1);
    expect((await store.get(env, "m1@example.com"))!.seen).toBe(false);
    expect((await store.get(env, "m2@example.com"))!.seen).toBe(true);
  });

  it("setSeen is a no-op for an empty id list and skips unknown ids", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(env, { messageId: "only@example.com", from: "a@example.com", to: "c@skyphusion.org", subject: "s", text: "t", date: "2026-01-01T00:00:00.000Z" }, ctx);
    await settle();
    expect(await store.setSeen(env, [], true)).toBe(0);
    expect(await store.setSeen(env, ["nope@example.com"], true)).toBe(0);
    expect((await store.get(env, "only@example.com"))!.seen).toBe(false);
  });
});

describe("POST /api/messages/seen", () => {
  function post(body: unknown, token = "test-token"): Request {
    return new Request("https://postern.example/api/messages/seen", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("marks messages read and returns the updated count", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(env, { messageId: "a@example.com", from: "x@example.com", to: "c@skyphusion.org", subject: "s", text: "t", date: "2026-01-01T00:00:00.000Z" }, ctx);
    await settle();
    expect((await store.get(env, "a@example.com"))!.seen).toBe(false);

    const res = await handleApi(post({ ids: ["a@example.com"], seen: true }), env, ctx);
    const body = (await res.json()) as { ok: boolean; updated: number };
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, updated: 1 });
    expect((await store.get(env, "a@example.com"))!.seen).toBe(true);
  });

  it("validates the body shape", async () => {
    const { env, ctx } = makeFakeEnv();
    expect((await handleApi(post({ seen: true }), env, ctx)).status).toBe(400); // ids missing
    expect((await handleApi(post({ ids: [1, 2], seen: true }), env, ctx)).status).toBe(400); // ids not strings
    expect((await handleApi(post({ ids: ["a@example.com"] }), env, ctx)).status).toBe(400); // seen missing
  });

  it("401s without a token", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(
      new Request("https://postern.example/api/messages/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["a@example.com"], seen: true }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

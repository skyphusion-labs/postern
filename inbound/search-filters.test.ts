import { describe, expect, it } from "vitest";
import { makeFakeEnv } from "./fakes";
import { handleApi } from "./src/api";
import * as store from "./src/store";

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function auth(env: Env): HeadersInit {
  return { authorization: `Bearer ${(env as Env & { POSTERN_API_TOKEN: string }).POSTERN_API_TOKEN}` };
}

describe("search filters (#354)", () => {
  it("applies mailbox= and hasAttachment across fts (not just substr)", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await store.put(
      env,
      {
        messageId: "f1@x",
        direction: "inbound",
        from: "a@example.com",
        to: "agent@skyphusion.org",
        subject: "invoice alpha",
        date: "2026-06-10T12:00:00Z",
        bodyText: "please pay invoice",
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
        trusted: true,
        attachments: [{ filename: "a.pdf", mimeType: "application/pdf", content: new Uint8Array([1, 2, 3]).buffer }],
      },
      ctx,
    );
    await store.put(
      env,
      {
        messageId: "f2@x",
        direction: "inbound",
        from: "b@example.com",
        to: "agent@skyphusion.org",
        subject: "invoice beta",
        date: "2026-06-11T12:00:00Z",
        bodyText: "please pay invoice",
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
        trusted: true,
      },
      ctx,
    );
    await settle();
    await store.moveMessages(env, ["f1@x"], "archive");

    const archived = await store.search(env, {
      q: "invoice",
      mode: "fts",
      mailbox: "archive",
      hasAttachment: true,
    });
    expect(archived.items.map((h) => h.message.messageId)).toEqual(["f1@x"]);

    const inboxish = await store.search(env, {
      q: "invoice",
      mode: "fts",
      hasAttachment: false,
    });
    expect(inboxish.items.map((h) => h.message.messageId)).toEqual(["f2@x"]);
  });

  it("filters by after/before and seen", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await store.put(
      env,
      {
        messageId: "d1@x",
        direction: "inbound",
        from: "a@example.com",
        to: "agent@skyphusion.org",
        subject: "dated one",
        date: "2026-01-01T00:00:00Z",
        bodyText: "needle",
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
        trusted: true,
      },
      ctx,
    );
    await store.put(
      env,
      {
        messageId: "d2@x",
        direction: "inbound",
        from: "a@example.com",
        to: "agent@skyphusion.org",
        subject: "dated two",
        date: "2026-06-15T00:00:00Z",
        bodyText: "needle",
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
        trusted: true,
      },
      ctx,
    );
    await settle();
    await store.setSeen(env, ["d2@x"], true);

    const mid = await store.search(env, {
      q: "needle",
      mode: "fts",
      after: "2026-06-01T00:00:00Z",
      before: "2026-06-30T23:59:59Z",
      seen: true,
    });
    expect(mid.items.map((h) => h.message.messageId)).toEqual(["d2@x"]);
  });

  it("GET /api/recipients/recent requires identity and returns outbound recipients", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await store.put(
      env,
      {
        messageId: "out1@x",
        direction: "outbound",
        from: "alice@skyphusion.org",
        to: "bob@example.com",
        cc: "carol@example.com",
        subject: "hi",
        date: "2026-06-18T12:00:00Z",
        bodyText: "hello",
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
        trusted: true,
        deliveredTo: ["bob@example.com", "carol@example.com"],
      },
      ctx,
    );
    await settle();

    const missing = await handleApi(
      new Request("https://x/api/recipients/recent", { headers: auth(env) }),
      env,
      CTX,
    );
    expect(missing.status).toBe(400);

    const ok = await handleApi(
      new Request("https://x/api/recipients/recent?viewer=alice@skyphusion.org", { headers: auth(env) }),
      env,
      CTX,
    );
    expect(ok.status).toBe(200);
    const body = await ok.json() as { recipients: { address: string }[] };
    expect(body.recipients.map((r) => r.address).sort()).toEqual([
      "bob@example.com",
      "carol@example.com",
    ]);
  });
});

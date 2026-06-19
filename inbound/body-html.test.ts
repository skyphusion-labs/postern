import { describe, it, expect } from "vitest";
import { ingest } from "./src/ingest";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// #57: inbound HTML mail keeps its original HTML body (body_html) so the webmail
// can render it in a sandboxed iframe; bodyText stays the FTS source + fallback.
describe("body_html persistence (#57)", () => {
  it("ingest stores the HTML body and store.get returns it", async () => {
    const { env, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "html1@example.com",
        from: "alice@example.com",
        to: "agent@example.com",
        subject: "newsletter",
        html: "<h1>Hello</h1><p>Read <a href='https://example.com'>more</a>.</p>",
        text: "Hello. Read more at https://example.com",
      },
      ctx,
    );
    await settle();

    const msg = await store.get(env, "html1@example.com");
    expect(msg).not.toBeNull();
    expect(msg!.bodyHtml).toContain("<h1>Hello</h1>");
    // bodyText is still populated (FTS + fallback).
    expect(msg!.bodyText.length).toBeGreaterThan(0);
  });

  it("text-only mail leaves body_html null (backward compatible)", async () => {
    const { env, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "text1@example.com",
        from: "bob@example.com",
        to: "agent@example.com",
        subject: "plain",
        text: "just text, no html",
      },
      ctx,
    );
    await settle();

    const msg = await store.get(env, "text1@example.com");
    expect(msg!.bodyHtml).toBeNull();
  });

  it("the read API returns bodyHtml on the full message", async () => {
    const { env, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "html2@example.com",
        from: "alice@example.com",
        to: "agent@example.com",
        subject: "promo",
        html: "<p>Big <b>news</b></p>",
        text: "Big news",
      },
      ctx,
    );
    await settle();

    const res = await handleApi(
      new Request("https://postern.example/api/messages/html2@example.com", {
        headers: { authorization: "Bearer test-token" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { bodyHtml: string | null } };
    expect(body.message.bodyHtml).toContain("<b>news</b>");
  });

  it("caps an oversized HTML body", async () => {
    const { env, settle } = makeFakeEnv();
    const huge = "<p>" + "x".repeat(600_000) + "</p>";
    await ingest(
      env,
      {
        messageId: "big@example.com",
        from: "alice@example.com",
        to: "agent@example.com",
        subject: "big",
        html: huge,
        text: "big",
      },
      ctx,
    );
    await settle();
    const msg = await store.get(env, "big@example.com");
    expect(msg!.bodyHtml!.length).toBeLessThanOrEqual(512_000);
  });
});

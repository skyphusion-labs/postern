import { describe, expect, it } from "vitest";
import { ingest } from "./src/ingest";
import { reply, send } from "./src/mailbox";
import { makeFakeEnv } from "./fakes";

describe("address errors name the field", () => {
  it("does not repeat a stored Reply-To that is not an address", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "orig@example.com",
        from: "alice@example.com",
        to: "conrad@skyphusion.org",
        replyTo: "Person <not-an-address>",
        subject: "Question",
        text: "hello",
      },
      ctx,
    );
    await settle();
    await expect(
      reply(env, { messageId: "orig@example.com", text: "back" }, ctx, undefined, "estate"),
    ).rejects.toMatchObject({
      code: "E_VALIDATION_ERROR",
      message: "invalid to address derived from the stored Reply-To",
    });
  });

  it("names stored From when Reply-To is absent", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "orig@example.com",
        from: "Person <not-an-address>",
        to: "conrad@skyphusion.org",
        subject: "Question",
        text: "hello",
      },
      ctx,
    );
    await settle();
    await expect(
      reply(env, { messageId: "orig@example.com", text: "back" }, ctx, undefined, "estate"),
    ).rejects.toMatchObject({
      code: "E_VALIDATION_ERROR",
      message: "invalid to address derived from the stored From",
    });
  });

  it("does not repeat a from or replyTo value that is not an address", async () => {
    const { env, ctx } = makeFakeEnv();
    await expect(
      send(env, { to: "a@example.com", from: "not-a-from", subject: "s", text: "t" }, ctx, undefined, "estate"),
    ).rejects.toMatchObject({ code: "E_VALIDATION_ERROR", message: "invalid from address" });
    await expect(
      send(env, { to: "a@example.com", replyTo: "not-a-replyto", subject: "s", text: "t" }, ctx, undefined, "estate"),
    ).rejects.toMatchObject({ code: "E_VALIDATION_ERROR", message: "invalid replyTo address" });
    await expect(
      send(env, { to: "not-a-to", subject: "s", text: "t" }, ctx, undefined, "estate"),
    ).rejects.toMatchObject({ code: "E_VALIDATION_ERROR", message: "invalid to address" });
  });

  it("still replies when the stored Reply-To is an address", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "orig@example.com",
        from: "alice@example.com",
        to: "conrad@skyphusion.org",
        replyTo: "List <list@example.com>",
        subject: "Question",
        text: "hello",
      },
      ctx,
    );
    await settle();
    await reply(env, { messageId: "orig@example.com", text: "back" }, ctx, undefined, "estate");
    await settle();
    expect(sent[0].to).toEqual(["list@example.com"]);
  });
});

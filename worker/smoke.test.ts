import { describe, it, expect } from "vitest";
import { sendEmail, EmailError, type EmailRequest } from "./src/email";

// Minimal fake of the Cloudflare Email Sending binding. It records the last
// message it was handed so tests can assert on what sendEmail() built, and
// returns a stable messageId.
function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  let lastMessage: unknown = null;
  const env = {
    DEFAULT_FROM: "noreply@skyphusion.org",
    DEFAULT_FROM_NAME: "Skyphusion",
    ALLOWED_FROM_DOMAIN: "skyphusion.org",
    EMAIL: {
      async send(message: unknown) {
        lastMessage = message;
        return { messageId: "msg-123" };
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env, getLastMessage: () => lastMessage };
}

async function expectReject(env: Env, req: EmailRequest, code: string) {
  await expect(sendEmail(env, req)).rejects.toMatchObject({ code });
}

describe("sendEmail validation", () => {
  it("sends a well-formed request and returns the messageId", async () => {
    const { env, getLastMessage } = makeEnv();
    const result = await sendEmail(env, {
      to: "dev@example.com",
      subject: "hi",
      text: "hello",
    });
    expect(result.messageId).toBe("msg-123");
    expect(getLastMessage()).toMatchObject({
      to: ["dev@example.com"],
      subject: "hi",
      text: "hello",
      // omitted `from` falls back to DEFAULT_FROM + DEFAULT_FROM_NAME.
      from: { email: "noreply@skyphusion.org", name: "Skyphusion" },
    });
  });

  it("requires a subject", async () => {
    const { env } = makeEnv();
    await expectReject(env, { to: "a@b.com", text: "x" } as EmailRequest, "E_FIELD_MISSING");
    await expectReject(env, { to: "a@b.com", subject: "   ", text: "x" }, "E_FIELD_MISSING");
  });

  it("requires at least one of html or text", async () => {
    const { env } = makeEnv();
    await expectReject(env, { to: "a@b.com", subject: "s" }, "E_FIELD_MISSING");
  });

  it("requires at least one to recipient", async () => {
    const { env } = makeEnv();
    await expectReject(env, { to: [], subject: "s", text: "x" }, "E_FIELD_MISSING");
  });

  it("rejects malformed recipient addresses", async () => {
    const { env } = makeEnv();
    await expectReject(env, { to: "not-an-email", subject: "s", text: "x" }, "E_VALIDATION_ERROR");
    await expectReject(env, { to: ["ok@b.com", "bad"], subject: "s", text: "x" }, "E_VALIDATION_ERROR");
  });

  it("enforces the combined recipient cap", async () => {
    const { env } = makeEnv();
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@b.com`);
    await expectReject(env, { to: many, subject: "s", text: "x" }, "E_TOO_MANY_RECIPIENTS");
  });

  it("rejects from addresses off the allowed domain", async () => {
    const { env } = makeEnv();
    await expectReject(
      env,
      { to: "a@b.com", from: "x@evil.com", subject: "s", text: "x" },
      "E_SENDER_NOT_ALLOWED",
    );
  });

  it("accepts a from address on the allowed domain", async () => {
    const { env, getLastMessage } = makeEnv();
    await sendEmail(env, {
      to: "a@b.com",
      from: { email: "renders@skyphusion.org", name: "Vivijure" },
      subject: "s",
      text: "x",
    });
    expect(getLastMessage()).toMatchObject({
      from: { email: "renders@skyphusion.org", name: "Vivijure" },
    });
  });

  it("rejects CRLF injection in the subject", async () => {
    const { env } = makeEnv();
    await expectReject(
      env,
      { to: "a@b.com", subject: "ok\r\nBcc: victim@x.com", text: "x" },
      "E_VALIDATION_ERROR",
    );
  });

  it("rejects CRLF injection in the from display name", async () => {
    const { env } = makeEnv();
    await expectReject(
      env,
      { to: "a@b.com", from: { email: "ok@skyphusion.org", name: "x\nBcc: v@x.com" }, subject: "s", text: "x" },
      "E_VALIDATION_ERROR",
    );
  });

  it("rejects CRLF injection in custom header keys and values", async () => {
    const { env } = makeEnv();
    await expectReject(
      env,
      { to: "a@b.com", subject: "s", text: "x", headers: { "X-Bad": "v\r\nBcc: v@x.com" } },
      "E_VALIDATION_ERROR",
    );
    await expectReject(
      env,
      { to: "a@b.com", subject: "s", text: "x", headers: { "X-Bad\nInjected": "v" } },
      "E_VALIDATION_ERROR",
    );
  });

  it("rejects an invalid replyTo address", async () => {
    const { env } = makeEnv();
    await expectReject(
      env,
      { to: "a@b.com", subject: "s", text: "x", replyTo: "nope" },
      "E_VALIDATION_ERROR",
    );
  });

  it("rejects a non-object request body", async () => {
    const { env } = makeEnv();
    await expectReject(env, null as unknown as EmailRequest, "E_VALIDATION_ERROR");
  });

  it("EmailError carries a code and status", () => {
    const e = new EmailError("E_TEST", "boom", 418);
    expect(e.code).toBe("E_TEST");
    expect(e.status).toBe(418);
    expect(e.message).toBe("boom");
  });
});

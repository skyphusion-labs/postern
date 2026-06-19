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

  // Address-validation parity + ReDoS guard for the hardened EMAIL_RE. The
  // regex is exercised on to/cc/bcc, from, and replyTo; we assert the same
  // accept/reject decisions as before and that a crafted pathological string
  // does not cause catastrophic backtracking (it returns promptly with a clear
  // rejection rather than hanging).
  it("accepts the same well-formed addresses as before", async () => {
    const valid = [
      "dev@example.com",
      "a@b.com",
      "a@b.c",
      "a@b.co.uk",
      "first.last@sub.example.com",
    ];
    for (const addr of valid) {
      const { env } = makeEnv();
      // Should not throw a validation error on the recipient.
      await expect(sendEmail(env, { to: addr, subject: "s", text: "x" })).resolves.toMatchObject({
        messageId: "msg-123",
      });
    }
  });

  it("rejects malformed addresses across to / from / replyTo", async () => {
    const malformed = ["not-an-email", "bad", "a@b", "a@.com", "@b.com", "a b@c.com"];
    for (const addr of malformed) {
      const r1 = makeEnv();
      await expectReject(r1.env, { to: addr, subject: "s", text: "x" }, "E_VALIDATION_ERROR");
      const r2 = makeEnv();
      await expectReject(
        r2.env,
        { to: "a@b.com", subject: "s", text: "x", replyTo: addr },
        "E_VALIDATION_ERROR",
      );
    }
  });

  it("does not hang on a crafted ReDoS-style address (returns promptly)", async () => {
    const { env } = makeEnv();
    // Long run of dot-ambiguous chars that fails the anchor; the old pattern
    // could backtrack polynomially on this, the linear one returns at once.
    const evil = "a@" + "a.".repeat(50_000);
    const start = Date.now();
    await expectReject(env, { to: evil, subject: "s", text: "x" }, "E_VALIDATION_ERROR");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

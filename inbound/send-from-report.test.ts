// Every send path reports the From address it actually used (#804, #632 F13).
// A registry token may discard the caller's from. The success body and the
// stored outbound row both name the address that went out, so a caller can
// see the substitution instead of inferring it.

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ingest } from "./src/ingest";
import { sha256Hex } from "./src/sendidentity";
import { makeFakeEnv, type FakeEnvResult } from "./fakes";

const BOUND = "rollins@skyphusion.org";
const SPOOF = "someone-else@skyphusion.org";
const DEFAULT_FROM = "noreply@skyphusion.org";
const TOKEN = "rollins-secret";

interface Entry {
  token: string;
  from: string;
  displayName?: string;
  scopes?: string[];
}

async function registryEnv(entries: Entry[], overrides: Record<string, unknown> = {}): Promise<FakeEnvResult> {
  const map: Record<string, { from: string; displayName?: string; scopes?: string[] }> = {};
  for (const e of entries) {
    const hash = await sha256Hex(e.token);
    map[hash] = {
      from: e.from,
      ...(e.displayName ? { displayName: e.displayName } : {}),
      ...(e.scopes ? { scopes: e.scopes } : {}),
    };
  }
  return makeFakeEnv({ POSTERN_SEND_IDENTITIES: JSON.stringify(map), ...overrides });
}

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

interface SendBody {
  ok: boolean;
  messageId: string;
  threadId: string;
  from?: string;
}

function wireEmail(from: unknown): string | undefined {
  if (typeof from === "string") return from;
  if (from && typeof from === "object" && "email" in from) {
    const email = (from as { email: unknown }).email;
    if (typeof email === "string") return email;
  }
  return undefined;
}

// The response, the outbound row, and the address handed to the transport are
// one fact. `address` is the one resolveFrom settled on, never the one asked for.
function expectReported(
  body: SendBody,
  env: FakeEnvResult,
  address: string,
): void {
  expect(body.ok).toBe(true);
  expect(body.from).toBe(address);
  expect(body.from).not.toBe(SPOOF);
  const row = env.rows.find((r) => r.message_id === body.messageId);
  expect(row?.direction).toBe("outbound");
  expect(row?.from_addr).toBe(address);
  expect(wireEmail(env.sent.at(-1)?.from)).toBe(address);
}

async function post(
  env: FakeEnvResult,
  path: string,
  token: string,
  body: unknown,
): Promise<SendBody> {
  const res = await handleApi(req("POST", path, { token, body }), env.env, env.ctx);
  await env.settle();
  expect(res.status).toBe(200);
  return (await res.json()) as SendBody;
}

async function seedInbound(env: FakeEnvResult, messageId: string): Promise<void> {
  await ingest(
    env.env,
    { messageId, from: "alice@example.com", to: BOUND, subject: "Question", text: "halp" },
    env.ctx,
  );
  await env.settle();
}

describe("send reports the From it used (#804)", () => {
  it("a registry token that passes someone-else@ is told its own address", async () => {
    const env = await registryEnv([{ token: TOKEN, from: BOUND, displayName: "Rollins" }]);
    const body = await post(env, "/api/send", TOKEN, {
      to: "d@example.com", subject: "hi", text: "yo", from: SPOOF,
    });
    expectReported(body, env, BOUND);
    // The display name rides on the wire. The reported and stored value is the address.
    expect(env.sent[0].from).toEqual({ email: BOUND, name: "Rollins" });

    const got = await handleApi(
      req("GET", `/api/messages/${encodeURIComponent(body.messageId)}`, { token: "test-token" }),
      env.env,
      env.ctx,
    );
    expect(got.status).toBe(200);
    const stored = (await got.json()) as { message: { from: string } };
    expect(stored.message.from).toBe(body.from);
  });

  it("reports the bound address on /send, the back-compat alias", async () => {
    const env = await registryEnv([{ token: TOKEN, from: BOUND }]);
    const body = await post(env, "/send", TOKEN, {
      to: "d@example.com", subject: "hi", text: "yo", from: SPOOF,
    });
    expectReported(body, env, BOUND);
  });

  it("reports the bound address on /api/reply", async () => {
    const env = await registryEnv([{ token: TOKEN, from: BOUND }]);
    await seedInbound(env, "orig@example.com");
    const body = await post(env, "/api/reply", TOKEN, {
      messageId: "orig@example.com", text: "re", from: SPOOF,
    });
    expectReported(body, env, BOUND);
  });

  it("reports the bound address on a forward", async () => {
    const env = await registryEnv([{ token: TOKEN, from: BOUND }]);
    await seedInbound(env, "fwd@example.com");
    const body = await post(env, "/api/send", TOKEN, {
      to: "other@example.com", text: "FYI", forwardMessageId: "fwd@example.com", from: SPOOF,
    });
    expectReported(body, env, BOUND);
    expect(env.sent.at(-1)?.subject).toBe("Fwd: Question");
  });

  it("reports the bound address when a new draft is sent", async () => {
    const env = await registryEnv([{ token: TOKEN, from: BOUND }]);
    const created = await handleApi(req("POST", "/api/drafts", {
      token: TOKEN,
      body: { to: "d@example.com", subject: "draft", bodyText: "yo" },
    }), env.env, env.ctx);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const body = await post(env, `/api/drafts/${id}/send`, TOKEN, {});
    expectReported(body, env, BOUND);
  });

  it("reports the bound address when a reply draft is sent", async () => {
    const env = await registryEnv([{ token: TOKEN, from: BOUND }]);
    await seedInbound(env, "orig@example.com");
    const created = await handleApi(req("POST", "/api/drafts", {
      token: TOKEN,
      body: { composeMode: "reply", sourceMessageId: "orig@example.com", bodyText: "re" },
    }), env.env, env.ctx);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const body = await post(env, `/api/drafts/${id}/send`, TOKEN, {});
    expectReported(body, env, BOUND);
  });

  it("reports the bound address when a forward draft is sent", async () => {
    const env = await registryEnv([{ token: TOKEN, from: BOUND }]);
    await seedInbound(env, "fwd@example.com");
    const created = await handleApi(req("POST", "/api/drafts", {
      token: TOKEN,
      body: {
        composeMode: "forward",
        sourceMessageId: "fwd@example.com",
        to: "other@example.com",
        bodyText: "FYI",
      },
    }), env.env, env.ctx);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const body = await post(env, `/api/drafts/${id}/send`, TOKEN, {});
    expectReported(body, env, BOUND);
  });

  it("an unbound token reports the From it honored, including the default", async () => {
    const env = await registryEnv([{ token: TOKEN, from: BOUND }]);
    const explicit = await post(env, "/api/send", "test-token", {
      to: "d@example.com", subject: "hi", text: "yo", from: "ops@skyphusion.org",
    });
    expectReported(explicit, env, "ops@skyphusion.org");

    const fallback = await post(env, "/api/send", "test-token", {
      to: "d@example.com", subject: "hi", text: "yo",
    });
    expect(fallback.from).toBe(DEFAULT_FROM);
    const row = env.rows.find((r) => r.message_id === fallback.messageId);
    expect(row?.from_addr).toBe(DEFAULT_FROM);
  });
});

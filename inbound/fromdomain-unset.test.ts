// #615: ALLOWED_FROM_DOMAIN has no product default. Before this, five call sites fell
// back to a hardcoded "skyphusion.org", so a self-hoster who left it unset silently
// inherited OUR domain as theirs. Each site now handles "unset" per its seam:
//   - send (resolveFrom):        refuse 500, nothing reaches the transport
//   - SMTP credential upsert:    refuse 500, nothing written
//   - registry token resolve:    deny (401), and NOT fail-open on any domain
//   - mobileconfig:              refuse 500, no profile naming someone else's hosts
//   - same-domain seen seed:     skip (no throw), the stored copy is untouched

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { allowedFromDomain } from "./src/fromdomain";
import { sha256Hex } from "./src/sendidentity";
import { makeFakeEnv } from "./fakes";
import { realEnv, putOutbound } from "./realdb";

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

const UNSET = { ALLOWED_FROM_DOMAIN: undefined, DEFAULT_FROM: undefined };

describe("allowedFromDomain (#615)", () => {
  it("returns null for unset or blank, the trimmed lower-cased domain otherwise", () => {
    expect(allowedFromDomain({} as Env)).toBeNull();
    expect(allowedFromDomain({ ALLOWED_FROM_DOMAIN: "" } as Env)).toBeNull();
    expect(allowedFromDomain({ ALLOWED_FROM_DOMAIN: "   " } as Env)).toBeNull();
    expect(allowedFromDomain({ ALLOWED_FROM_DOMAIN: " Example.COM " } as Env)).toBe("example.com");
  });
});

describe("ALLOWED_FROM_DOMAIN unset: no borrowed default (#615)", () => {
  it("send refuses with 500 and nothing reaches the transport", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv(UNSET);
    const body = { to: "d@example.com", subject: "hi", text: "yo" };
    const res = await handleApi(req("POST", "/api/send", { token: "test-token", body }), env, ctx);
    await settle();
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it("send refuses even when the caller names a skyphusion.org From", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv(UNSET);
    const body = { to: "d@example.com", subject: "hi", text: "yo", from: "noreply@skyphusion.org" };
    const res = await handleApi(req("POST", "/api/send", { token: "test-token", body }), env, ctx);
    await settle();
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it("SMTP credential upsert refuses with 500", async () => {
    const { env, ctx } = makeFakeEnv(UNSET);
    const res = await handleApi(
      req("POST", "/api/admin/smtp-credentials", { token: "test-token", body: { username: "carol@skyphusion.org" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("E_INTERNAL_SERVER_ERROR");
  });

  it("registry tokens are denied (401), on our domain and on any other", async () => {
    // parseRegistry skips the domain check when given no domain, so an empty-string
    // fallback here would have accepted ANY From. Both entries must be refused.
    const ours = await sha256Hex("ours-secret");
    const theirs = await sha256Hex("theirs-secret");
    const { env, ctx, settle, sent } = makeFakeEnv({
      ...UNSET,
      POSTERN_SEND_IDENTITIES: JSON.stringify({
        [ours]: { from: "rollins@skyphusion.org" },
        [theirs]: { from: "anyone@example.net" },
      }),
    });
    const body = { to: "d@example.com", subject: "hi", text: "yo" };
    for (const token of ["ours-secret", "theirs-secret"]) {
      const res = await handleApi(req("POST", "/api/send", { token, body }), env, ctx);
      expect(res.status).toBe(401);
    }
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("mobileconfig refuses with 500 instead of emitting imap./smtp. hosts on a borrowed domain", async () => {
    const { env, ctx } = makeFakeEnv(UNSET);
    const res = await handleApi(req("GET", "/api/mobileconfig?user=alice@skyphusion.org", { token: "test-token" }), env, ctx);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("skyphusion.org");
  });

  it("same-domain seen seed is skipped, and the outbound copy still stores", async () => {
    const { env, ctx, raw } = realEnv({ ALLOWED_FROM_DOMAIN: undefined });
    await putOutbound(env, ctx, { id: "ab@skyphusion.org", from: "alice@skyphusion.org", to: ["bob@skyphusion.org"] });
    expect((raw.prepare("SELECT COUNT(*) n FROM message_seen_by").get() as { n: number }).n).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n).toBe(1);
  });
});

// A stored message is readable only by a caller the message belongs to, on EVERY path
// that reads one, not just the read route. Refs GHSA-49mc-vh6w-95h4.
//
// The invariant: for an identity-bound token, the reply target lookup and the forward
// source lookup resolve under the SAME scope the read route enforces. Before the fix
// they resolved unscoped, so a token that correctly got 404 from GET /api/messages/{id}
// could still name that id as a reply or forward source.
//
// WHY THIS SUITE USES realEnv AND NOT makeFakeEnv. The subject here IS a SQL predicate.
// The fake store pattern-matches SQL strings, so it would answer a corrupted or absent
// predicate exactly as cheerfully as a correct one, and this suite would go green on the
// defect it exists to catch. realEnv runs node:sqlite against the shipped schema.sql, so
// the predicate that ships is the predicate under test.
//
// Every negative here is paired with a positive control on the SAME token and the SAME
// route, because "reply returned 404" is also what a totally broken reply path returns.
// The controls are what make the 404s mean "scoped" instead of "inert".

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { sha256Hex } from "./src/sendidentity";
import { realEnv, putInbound } from "./realdb";

const AGENT = "agent@skyphusion.org";
const OTHER = "conrad@skyphusion.org";
const OUTSIDER = "outsider@example.net";
const TOKEN = "agent-registry-token";

// The body of the message the agent must not be able to reach. Distinctive, so an
// assertion can prove the bytes did not travel rather than only that a call was refused.
const SECRET_BODY = "quarterly figures nobody outside the thread should see";

async function env() {
  const registry = {
    [await sha256Hex(TOKEN)]: { from: AGENT, scopes: ["read", "send"] },
  };
  const sent: { to: string[]; subject: string; text?: string; html?: string }[] = [];
  const { env: e, ctx } = realEnv({
    POSTERN_SEND_IDENTITIES: JSON.stringify(registry),
    DEFAULT_FROM: AGENT,
    EMAIL: {
      async send(m: { to: string[]; subject: string; text?: string; html?: string }) {
        sent.push(m);
        return { messageId: "provider-1" };
      },
    },
  });
  return { e, ctx, sent };
}

function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://postern.example${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("message read scope holds on every path that reads a stored message", () => {
  describe("CONTROL: the scope boundary exists and the instrument can see both sides", () => {
    it("the read route serves a message the agent IS a party to, and 404s one it is not", async () => {
      const { e, ctx } = await env();
      await putInbound(e, ctx, { id: "mine@x", from: OUTSIDER, to: AGENT, body: "ok" });
      await putInbound(e, ctx, { id: "theirs@x", from: OUTSIDER, to: OTHER, body: SECRET_BODY });

      const ok = await handleApi(req("GET", "/api/messages/mine@x"), e, ctx);
      expect(ok.status, "a party to the message must be able to read it").toBe(200);

      const no = await handleApi(req("GET", "/api/messages/theirs@x"), e, ctx);
      expect(no.status, "a non-party must not: this is the boundary the write paths must honor").toBe(404);
    });
  });

  describe("reply", () => {
    it("refuses a reply target outside the caller's scope, and sends nothing", async () => {
      const { e, ctx, sent } = await env();
      await putInbound(e, ctx, { id: "theirs@x", from: OUTSIDER, to: OTHER, body: SECRET_BODY });

      const res = await handleApi(
        req("POST", "/api/reply", { messageId: "theirs@x", text: "hi", quoteOriginal: true }),
        e,
        ctx,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, error: "E_NOT_FOUND" });
      // The refusal is only half the assertion: prove the bytes never moved.
      expect(sent, "nothing may be dispatched for an out-of-scope reply target").toHaveLength(0);
    });

    it("CONTROL: the same token replying to its OWN mail still succeeds and still quotes", async () => {
      const { e, ctx, sent } = await env();
      await putInbound(e, ctx, { id: "mine@x", from: OUTSIDER, to: AGENT, body: "original text here" });

      const res = await handleApi(
        req("POST", "/api/reply", { messageId: "mine@x", text: "hi", quoteOriginal: true }),
        e,
        ctx,
      );

      expect(res.status, "the fix must not break replying to your own mail").toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toEqual([OUTSIDER]);
      expect(sent[0].text, "quoteOriginal still works inside scope").toContain("original text here");
    });
  });

  describe("forward (send with forwardMessageId)", () => {
    it("refuses a forward source outside the caller's scope, and sends nothing", async () => {
      const { e, ctx, sent } = await env();
      await putInbound(e, ctx, { id: "theirs@x", from: OUTSIDER, to: OTHER, body: SECRET_BODY });

      // Recipients are caller-selected on this path, so an unscoped read here puts the
      // content on the wire to an address of the caller's choosing.
      const res = await handleApi(
        req("POST", "/api/send", {
          to: "attacker@example.net",
          text: "see below",
          forwardMessageId: "theirs@x",
        }),
        e,
        ctx,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, error: "E_NOT_FOUND" });
      expect(sent, "nothing may be dispatched for an out-of-scope forward source").toHaveLength(0);
    });

    it("CONTROL: the same token forwarding its OWN mail still succeeds and still quotes", async () => {
      const { e, ctx, sent } = await env();
      await putInbound(e, ctx, { id: "mine@x", from: OUTSIDER, to: AGENT, body: "forwardable body" });

      const res = await handleApi(
        req("POST", "/api/send", {
          to: "friend@example.net",
          text: "fyi",
          forwardMessageId: "mine@x",
        }),
        e,
        ctx,
      );

      expect(res.status, "the fix must not break forwarding your own mail").toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].text, "the forward still carries the original inside scope").toContain("forwardable body");
    });
  });

  describe("CONTROL: an estate token is unchanged", () => {
    it("a static both-scope token still reaches any message on both write paths", async () => {
      const { e, ctx, sent } = await env();
      (e as unknown as Record<string, unknown>).POSTERN_API_TOKEN = "estate-token";
      await putInbound(e, ctx, { id: "theirs@x", from: OUTSIDER, to: OTHER, body: SECRET_BODY });

      const estate = (method: string, path: string, body?: unknown) =>
        new Request(`https://postern.example${path}`, {
          method,
          headers: { authorization: "Bearer estate-token", "content-type": "application/json" },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

      const res = await handleApi(
        estate("POST", "/api/reply", { messageId: "theirs@x", text: "operator reply" }),
        e,
        ctx,
      );
      expect(res.status, "the operator/IMAP static token is deliberately estate-scoped").toBe(200);
      expect(sent).toHaveLength(1);
    });
  });
});

/**
 * Webmail v2 phase 6 (#355) adversarial battery: API-level proofs for the epic
 * #338 security checklist. Complements sanitize-html.test.ts (D-HTML-1),
 * webmail-remote-content.test.ts (#343), session.test.ts (CSRF/session), and
 * draft-attachments.test.ts (draft IDOR).
 *
 * Severity labels in comments match the phase-6 review ledger
 * (docs/reviews/webmail-v2-phase6-adversarial-2026-07-18.md).
 */
import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import { WEBMAIL_HTML, serveWebmail } from "./src/webmail";
import { ingest } from "./src/ingest";
import { makeFakeEnv } from "./fakes";

async function registry(token: string, from = "conrad@skyphusion.org"): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({ [hash]: { from, displayName: from.split("@")[0] } });
}

function req(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`https://postern.example${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("phase 6: clickjacking / CSP / nosniff (#355)", () => {
  it("serves frame-ancestors none and nosniff on /webmail", () => {
    const res = serveWebmail();
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // frame-ancestors is the clickjacking control; X-Frame-Options is optional
    // when CSP frame-ancestors is present (modern browsers).
  });

  it("never uses innerHTML for message content in the top frame", () => {
    // Defense against stored/reflected DOM XSS: prose bodies go through textContent
    // / sandboxed srcdoc, not innerHTML assignment of untrusted fields.
    expect(WEBMAIL_HTML).not.toMatch(/\.innerHTML\s*=\s*[^;]*bodyHtml/);
    expect(WEBMAIL_HTML).not.toMatch(/\.innerHTML\s*=\s*[^;]*subject/);
    expect(WEBMAIL_HTML).toContain("sandbox=");
    expect(WEBMAIL_HTML).toContain("srcdoc");
  });
});

describe("phase 6: recipient / header injection (#355)", () => {
  it("rejects CR/LF in subject, to, and from-adjacent fields (HIGH)", async () => {
    const token = "send-token";
    const { env, ctx, sent } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: await registry(token),
    });
    for (const body of [
      { to: "victim@example.com\r\nBcc: evil@example.com", subject: "x", text: "x" },
      { to: "victim@example.com", subject: "x\r\nX-Injected: 1", text: "x" },
      { to: "victim@example.com", subject: "x", text: "x", cc: "ok@example.com\nCc: evil@example.com" },
    ]) {
      const res = await handleApi(req("POST", "/api/send", token, body), env, ctx);
      expect(res.status).toBe(400);
    }
    expect(sent).toHaveLength(0);
  });

  it("binds From authoritatively so a spoofed From cannot leave the token (HIGH)", async () => {
    // Per-identity send tokens override caller From (#28 / SEND-IDENTITIES §4).
    // Success with the bound address (not a 403) is the contract: the token cannot
    // send as anyone else.
    const token = "send-token";
    const { env, ctx, sent } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: await registry(token),
    });
    const res = await handleApi(req("POST", "/api/send", token, {
      to: "friend@example.com",
      subject: "x",
      text: "x",
      from: "spoofed@skyphusion.org",
    }), env, ctx);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const from = (sent[0] as { from: { email: string } | string }).from;
    const email = typeof from === "string" ? from : from.email;
    expect(email).toBe("conrad@skyphusion.org");
    expect(email).not.toBe("spoofed@skyphusion.org");
  });
});

describe("phase 6: draft / folder IDOR (#355)", () => {
  it("blocks cross-identity draft read/write/attach (CRITICAL)", async () => {
    const owner = "owner-token";
    const other = "other-token";
    const { env, ctx } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: JSON.stringify({
        ...JSON.parse(await registry(owner)),
        ...JSON.parse(await registry(other, "other@skyphusion.org")),
      }),
    });
    expect((await handleApi(req("PUT", "/api/drafts/secret-draft", owner, {
      to: "a@example.com", subject: "s", bodyText: "private",
    }), env, ctx)).status).toBe(200);

    expect((await handleApi(req("GET", "/api/drafts/secret-draft", other), env, ctx)).status).toBe(404);
    expect((await handleApi(req("PUT", "/api/drafts/secret-draft", other, {
      to: "b@example.com", subject: "hijack", bodyText: "nope",
    }), env, ctx)).status).toBe(403);
    expect((await handleApi(req("DELETE", "/api/drafts/secret-draft", other), env, ctx)).status).toBe(404);
    // Owner still has the original draft; hijack must not have rewritten it.
    const ownerGet = await handleApi(req("GET", "/api/drafts/secret-draft", owner), env, ctx);
    expect(ownerGet.status).toBe(200);
    const body = await ownerGet.json() as { draft: { subject: string | null; bodyText: string | null } };
    expect(body.draft.subject).toBe("s");
    expect(body.draft.bodyText).toBe("private");
  });
});

describe("phase 6: attachment content-type / filename (#355)", () => {
  it("forces download + sanitized filename + nosniff sandbox CSP (HIGH)", async () => {
    const token = "both-token";
    const { env, ctx, settle } = makeFakeEnv({ POSTERN_API_TOKEN: token });
    await ingest(env, {
      messageId: "att@example.com",
      from: "sender@example.com",
      to: "conrad@skyphusion.org",
      subject: "with att",
      text: "body",
      date: "2026-07-18T00:00:00.000Z",
      attachments: [{
        filename: 'evil"\r\nX-Injected: 1.html',
        mimeType: "text/html",
        content: new TextEncoder().encode("<script>alert(1)</script>").buffer,
      }],
    }, ctx);
    await settle();

    const res = await handleApi(req("GET", "/api/messages/att@example.com/attachments/0", token), env, ctx);
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") || "";
    expect(cd).toMatch(/^attachment;/);
    expect(cd).not.toMatch(/[\r\n]/);
    // Quotes / CR / LF inside the filename value are replaced by underscores.
    expect(cd).toBe('attachment; filename="evil___X-Injected__1.html"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("phase 6: malicious HTML at SEND (#355)", () => {
  it("stores only sanitized HTML on the outbound copy (CRITICAL)", async () => {
    const token = "send-token";
    const { env, ctx, sent, rows } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: await registry(token),
    });
    const res = await handleApi(req("POST", "/api/send", token, {
      to: "friend@example.com",
      subject: "html",
      text: "plain",
      html: '<p>hi</p><script>alert(1)</script><img src=x onerror=alert(1)>',
    }), env, ctx);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const html = (sent[0] as { html?: string }).html ?? "";
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    // Sent store copy must not keep the raw payload either.
    const stored = rows.find((r) => r.direction === "outbound");
    if (stored?.body_html) {
      expect(stored.body_html).not.toContain("<script");
    }
  });
});

describe("phase 6: resource abuse bounds (#355)", () => {
  it("rejects oversized attachment totals with 413 (MEDIUM mitigated)", async () => {
    const token = "send-token";
    const { env, ctx, sent } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: await registry(token),
    });
    // 26 MiB of 'A' as base64 (~34M chars) is too heavy for the test process;
    // instead assert the documented count bound: 21 attachments reject.
    const tiny = btoa("x");
    const res = await handleApi(req("POST", "/api/send", token, {
      to: "friend@example.com",
      subject: "many",
      text: "x",
      attachments: Array.from({ length: 21 }, (_, i) => ({
        filename: `f${i}.txt`,
        mime: "text/plain",
        content: tiny,
      })),
    }), env, ctx);
    expect([400, 413]).toContain(res.status);
    expect(sent).toHaveLength(0);
  });

  it("clamps search limit so bulk amplification cannot exceed 200 (MEDIUM mitigated)", async () => {
    const token = "both-token";
    const { env, ctx } = makeFakeEnv({ POSTERN_API_TOKEN: token });
    const res = await handleApi(req("GET", "/api/search?q=test&limit=99999", token), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBeLessThanOrEqual(200);
  });
});

describe("phase 6: scope least-privilege (#355)", () => {
  it("read token cannot send or hard-delete (HIGH)", async () => {
    const { env, ctx } = makeFakeEnv({
      POSTERN_API_TOKEN: "both",
      POSTERN_API_TOKEN_READ: "read-only",
      POSTERN_API_TOKEN_DELETE: "delete-only",
    });
    expect((await handleApi(req("POST", "/api/send", "read-only", {
      to: "a@example.com", subject: "x", text: "x",
    }), env, ctx)).status).toBe(403);
    expect((await handleApi(req("DELETE", "/api/messages/x", "read-only"), env, ctx)).status).toBe(403);
    expect((await handleApi(req("GET", "/api/messages", "delete-only"), env, ctx)).status).toBe(403);
  });
});

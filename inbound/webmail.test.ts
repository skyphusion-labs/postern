import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEBMAIL_HTML, serveWebmail } from "./src/webmail";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// The worker embeds the page (it cannot read a file at request time), but the
// canonical editable source is webmail/index.html at the repo root. Regenerate
// the embed with `npm run sync-webmail`; this guard fails if the two drift.
describe("webmail embed stays in sync with the source file", () => {
  it("WEBMAIL_HTML equals webmail/index.html byte for byte", () => {
    const file = readFileSync(resolve(__dirname, "../webmail/index.html"), "utf8");
    expect(WEBMAIL_HTML).toBe(file);
  });
});

describe("serveWebmail", () => {
  it("returns the HTML page with a locked-down CSP and nosniff", () => {
    const res = serveWebmail();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") || "";
    // Assert the COMPLETE served policy, not just the strict directives (#343/D4).
    // The docs must match this string exactly; the two 'unsafe-inline' directives
    // are unavoidable (one inline script + one inline style) and are NOT hidden.
    expect(csp).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; frame-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    // connect-src 'self' is the anti-exfiltration control: a hijacked page
    // cannot ship the pasted token to another host.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    // frame-src 'self' permits the sandboxed srcdoc iframe the body view uses.
    expect(csp).toContain("frame-src 'self'");
    // The inline app forces 'unsafe-inline' for script and style; assert it so the
    // security docs cannot drift from the truth (#343/D4).
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    // img-src 'self' data: is why remote images are always blocked: the srcdoc
    // reading pane inherits this policy, so no https remote image can load.
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain("img-src 'self' data: https:");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("remote images are always blocked (no inert opt-in) (#343)", () => {
  it("has no \"Load remote images\" opt-in that the served CSP would silently defeat", () => {
    // The srcdoc reading pane inherits the served img-src 'self' data:, so a
    // per-message opt-in could never load remote images without relaxing the
    // top-frame CSP. The honest fix removed it: remote content is always
    // neutralized and the banner is a non-actionable notice.
    expect(WEBMAIL_HTML).not.toContain("Load remote images");
    // no code path that re-mounts the body with raw (un-neutralized) HTML
    expect(WEBMAIL_HTML).not.toContain("mount(true)");
    // the neutralizer is still the single render path for HTML bodies
    expect(WEBMAIL_HTML).toContain("neutralizeRemoteHtml");
    // the informational (non-actionable) blocked-content notice survives
    expect(WEBMAIL_HTML).toContain("Images are not loaded in webmail.");
  });
});

describe("the page is XSS-conscious by construction", () => {
  it("supports optional send token and compose UI when configured", () => {
    expect(WEBMAIL_HTML).toContain('id="sendToken"');
    expect(WEBMAIL_HTML).toContain("postern_send_token");
    expect(WEBMAIL_HTML).toContain('id="composeBtn"');
    expect(WEBMAIL_HTML).toContain("function apiWrite");
  });
  it("defaults search to hybrid mode with a mode selector (parity with MCP)", () => {
    // Search params are built via searchFilterParams() then sp.mode = mode (#354).
    expect(WEBMAIL_HTML).toContain("sp.mode = mode");
    expect(WEBMAIL_HTML).toContain('id="searchMode"');
    expect(WEBMAIL_HTML).toContain("postern_search_mode");
  });
  it("exposes search filter chips, recent recipients, and settings (#354)", () => {
    expect(WEBMAIL_HTML).toContain('id="filterAfter"');
    expect(WEBMAIL_HTML).toContain('id="filterBefore"');
    expect(WEBMAIL_HTML).toContain("hasAttachment");
    expect(WEBMAIL_HTML).toContain("/api/recipients/recent");
    expect(WEBMAIL_HTML).toContain('id="settingsBtn"');
    expect(WEBMAIL_HTML).toContain("postern_theme");
    expect(WEBMAIL_HTML).toContain("postern_density");
    expect(WEBMAIL_HTML).toContain("blocked by CSP");
  });
  it("exposes folder rail + organize API client for durable mailbox ops (#352)", () => {
    expect(WEBMAIL_HTML).toContain('id="folders"');
    expect(WEBMAIL_HTML).toContain("function apiOrganize");
    expect(WEBMAIL_HTML).toContain('"/api/folders"');
    expect(WEBMAIL_HTML).toContain('"/api/messages/flags"');
    expect(WEBMAIL_HTML).toContain('"/api/messages/move"');
    expect(WEBMAIL_HTML).toContain('"/api/messages/seen"');
    expect(WEBMAIL_HTML).toContain("p.mailbox");
  });
  it("loads drafts with the send credential in BYO token mode (#352)", () => {
    // Drafts are send-scoped + identity-bound; generic api() uses the read Bearer.
    expect(WEBMAIL_HTML).toContain("function apiSendGet");
    expect(WEBMAIL_HTML).toContain('apiSendGet("/api/drafts")');
    expect(WEBMAIL_HTML).toContain('Bearer " + state.sendToken');
    // Must not list drafts via the read-token api() helper.
    expect(WEBMAIL_HTML).not.toContain('api("/api/drafts")');
  });
  it("offers compose parity through durable drafts (#353)", () => {
    expect(WEBMAIL_HTML).toContain('id: "cmpCc"');
    expect(WEBMAIL_HTML).toContain('id: "cmpBcc"');
    expect(WEBMAIL_HTML).toContain('contenteditable: "true"');
    expect(WEBMAIL_HTML).toContain("document.execCommand");
    expect(WEBMAIL_HTML).toContain('id: "cmpFiles"');
    expect(WEBMAIL_HTML).toContain("xhr.upload.onprogress");
    expect(WEBMAIL_HTML).toContain('composeFromMessage("Reply all", "replyAll")');
    expect(WEBMAIL_HTML).toContain('composeFromMessage("Forward", "forward")');
    expect(WEBMAIL_HTML).toContain('apiWrite("/api/drafts/" + encodeURIComponent(draftId) + "/send"');
    expect(WEBMAIL_HTML).toContain("Draft preserved for retry.");
    expect(WEBMAIL_HTML).toContain("function scheduleSave");
  });
  it("never assigns innerHTML (all message content goes through text nodes)", () => {
    // A blunt but effective guard: the page script must not use innerHTML, which
    // is the one sink that would let stored message bytes execute. If a future
    // edit introduces it, this test forces a deliberate review.
    expect(WEBMAIL_HTML).not.toMatch(/\.innerHTML\s*=/);
  });
  it("gates compose/reply on a PROBED send capability, not just a pasted token (#277)", () => {
    // A read-only token pasted into the send field must not get a compose UI. The page
    // probes POST /api/send with an empty body (no mail sent) and enables compose only
    // when the scope gate is cleared; a later 403 degrades the UI honestly.
    expect(WEBMAIL_HTML).toContain("function probeSendCapability");
    expect(WEBMAIL_HTML).toContain("state.sendCapable");
    // the probe is a non-mutating empty-body POST to /api/send
    expect(WEBMAIL_HTML).toContain('body: "{}"');
    // compose + reply gate on the PROBED fact (=== true), never on token presence
    expect(WEBMAIL_HTML).toContain("state.sendCapable === true");
    // reactive degrade: a 403 from a real send flips capability off
    expect(WEBMAIL_HTML).toContain("state.sendCapable = false; updateComposeUI();");
    // the old presence-only gate is gone
    expect(WEBMAIL_HTML).not.toContain('state.sendToken ? "" : "none"');
  });
  it("requests the token as a Bearer header, never places it in a URL", () => {
    expect(WEBMAIL_HTML).toContain('"authorization": "Bearer "');
  });
  it("renders the message body in a sandbox=\"\" iframe (no scripts, no same-origin)", () => {
    // The body iframe must be sandboxed with an EMPTY sandbox (no allow-scripts,
    // no allow-same-origin), so stored body content cannot execute or reach the
    // token/API even though it is rendered as HTML via srcdoc.
    expect(WEBMAIL_HTML).toContain('f.setAttribute("sandbox", "")');
    expect(WEBMAIL_HTML).not.toContain("allow-scripts");
    expect(WEBMAIL_HTML).not.toContain("allow-same-origin");
  });
  it("renders bodyHtml when present, into the sandboxed iframe via srcdoc", () => {
    // The body iframe prefers the stored HTML body; it is placed into srcdoc
    // (sandboxed), never via innerHTML, so it cannot execute or reach the API.
    expect(WEBMAIL_HTML).toContain("m.bodyHtml");
    expect(WEBMAIL_HTML).toContain('f.setAttribute("srcdoc"');
  });
  it("downloads attachments via a Bearer fetch, not a tokenized URL", () => {
    // The attachment download fetches with the Authorization header and builds an
    // object URL; the token must never be placed into the attachment URL.
    expect(WEBMAIL_HTML).toContain("function downloadAttachment");
    expect(WEBMAIL_HTML).toContain("URL.createObjectURL");
    expect(WEBMAIL_HTML).not.toMatch(/attachments\/[^"'`]*\+\s*state\.token/);
  });
});

describe("the inbound worker serves the webmail route", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  it("GET /webmail returns the HTML page without requiring a token", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(new Request("https://postern.example/webmail"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("Postern webmail");
  });

  it("GET /webmail/ (trailing slash) also serves the page", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(new Request("https://postern.example/webmail/"), env, ctx);
    expect(res.status).toBe(200);
  });

  it("does not change the health route", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(new Request("https://postern.example/"), env, ctx);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body).toEqual({ ok: true, service: "postern" });
  });

  it("still gates /api behind the token", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(new Request("https://postern.example/api/messages"), env, ctx);
    expect(res.status).toBe(401);
  });
});

describe("send scope is enforced before body validation (honest-probe contract, #277)", () => {
  const req = (token: string) =>
    new Request("https://postern.example/api/send", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: "{}",
    });

  it("read-only token -> 403 before send() runs, and dispatches no mail", async () => {
    const { env, ctx, sent } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_API_TOKEN_READ: "read-tok",
      POSTERN_API_TOKEN_SEND: "send-tok",
    });
    const res = await handleApi(req("read-tok"), env, ctx);
    expect(res.status).toBe(403);
    expect(sent.length).toBe(0);
  });

  it("send token + empty body -> 400 validation (NOT 403), and dispatches no mail", async () => {
    // Exactly what probeSendCapability() issues: the scope gate passes, then body
    // validation rejects the empty body BEFORE any dispatch. A non-403 with zero mail
    // sent is the signal the webmail reads as "send-capable".
    const { env, ctx, sent } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_API_TOKEN_READ: "read-tok",
      POSTERN_API_TOKEN_SEND: "send-tok",
    });
    const res = await handleApi(req("send-tok"), env, ctx);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
    expect(sent.length).toBe(0);
  });
});

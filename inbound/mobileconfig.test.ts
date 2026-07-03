// Per-user Apple .mobileconfig generator (#187, follow-up to #180). Proves the
// pure plist builder emits a well-formed, correctly-escaped profile and that the
// GET /api/mobileconfig route honors the read scope, the 405-on-non-GET rule, and
// input validation (api.ts conventions).

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { buildMobileconfig, xmlEscape, type MobileconfigParams } from "./src/mobileconfig";
import { makeFakeEnv } from "./fakes";

const BASE: MobileconfigParams = {
  emailAddress: "alice@skyphusion.org",
  username: "alice@skyphusion.org",
  displayName: "Alice Example",
  imapHost: "imap.skyphusion.org",
  smtpHost: "smtp.skyphusion.org",
  organization: "Postern",
  identifierPrefix: "org.skyphusion.postern",
  profileUUID: "AAAAAAAA-0000-0000-0000-000000000001",
  emailPayloadUUID: "BBBBBBBB-0000-0000-0000-000000000002",
};

// A no-unescaped-ampersand check: every `&` in the output must open a known XML
// entity. A raw `&` (or an injected `<`) means an escaping bug that would make the
// profile unparseable / injectable.
function hasNoRawAmpersand(xml: string): boolean {
  return !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml);
}

function req(method: string, path: string, opts: { token?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  return new Request(`https://postern.example${path}`, { method, headers });
}

describe("buildMobileconfig (pure plist builder)", () => {
  it("emits a well-formed plist skeleton with both payloads", () => {
    const xml = buildMobileconfig(BASE);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<!DOCTYPE plist PUBLIC");
    expect(xml).toContain('<plist version="1.0">');
    expect(xml.trimEnd().endsWith("</plist>")).toBe(true);
    // One top-level Configuration payload wrapping one mail payload.
    expect(xml).toContain("<string>Configuration</string>");
    expect(xml).toContain("<string>com.apple.mail.managed</string>");
    // Balanced plist/array tags.
    expect((xml.match(/<plist /g) || []).length).toBe(1);
    expect((xml.match(/<\/plist>/g) || []).length).toBe(1);
    expect((xml.match(/<array>/g) || []).length).toBe((xml.match(/<\/array>/g) || []).length);
    expect((xml.match(/<dict>/g) || []).length).toBe((xml.match(/<\/dict>/g) || []).length);
  });

  it("lands the account fields where iOS expects them", () => {
    const xml = buildMobileconfig(BASE);
    expect(xml).toContain("<key>EmailAddress</key>\n\t\t\t<string>alice@skyphusion.org</string>");
    expect(xml).toContain("<key>EmailAccountType</key>\n\t\t\t<string>EmailTypeIMAP</string>");
    expect(xml).toContain("<key>IncomingMailServerHostName</key>\n\t\t\t<string>imap.skyphusion.org</string>");
    expect(xml).toContain("<key>IncomingMailServerPortNumber</key>\n\t\t\t<integer>993</integer>");
    expect(xml).toContain("<key>OutgoingMailServerHostName</key>\n\t\t\t<string>smtp.skyphusion.org</string>");
    expect(xml).toContain("<key>OutgoingMailServerPortNumber</key>\n\t\t\t<integer>587</integer>");
    // 993 SSL + 587 STARTTLS are BOTH expressed as UseSSL=true (Apple picks the
    // mechanism by port); assert both UseSSL keys are present and true.
    expect((xml.match(/<key>IncomingMailServerUseSSL<\/key>\n\t\t\t<true\/>/g) || []).length).toBe(1);
    expect((xml.match(/<key>OutgoingMailServerUseSSL<\/key>\n\t\t\t<true\/>/g) || []).length).toBe(1);
    expect(xml).toContain("<key>IncomingMailServerUsername</key>\n\t\t\t<string>alice@skyphusion.org</string>");
  });

  it("bakes in NO password (iOS prompts on install)", () => {
    const xml = buildMobileconfig(BASE);
    expect(xml).not.toContain("<key>IncomingPassword</key>");
    expect(xml).not.toContain("<key>OutgoingPassword</key>");
    expect(xml).toContain("<key>OutgoingPasswordSameAsIncomingPassword</key>\n\t\t\t<true/>");
  });

  it("uses the injected UUIDs and stable per-user identifiers", () => {
    const xml = buildMobileconfig(BASE);
    expect(xml).toContain("<string>AAAAAAAA-0000-0000-0000-000000000001</string>");
    expect(xml).toContain("<string>BBBBBBBB-0000-0000-0000-000000000002</string>");
    // Identifier is a stable slug of the address (reinstall REPLACES, not dupes).
    expect(xml).toContain("<string>org.skyphusion.postern.alice-skyphusion-org</string>");
    expect(xml).toContain("<string>org.skyphusion.postern.alice-skyphusion-org.email</string>");
  });

  it("XML-escapes user-supplied fields (no injection)", () => {
    const xml = buildMobileconfig({
      ...BASE,
      displayName: 'Ann & "Bob" <evil></string><key>x</key>',
      username: "a&b<c>",
    });
    expect(hasNoRawAmpersand(xml)).toBe(true);
    // The injection attempt is neutralized: no raw closing </string> from input.
    expect(xml).toContain("&lt;/string&gt;");
    expect(xml).toContain("Ann &amp; &quot;Bob&quot;");
    expect(xml).toContain("a&amp;b&lt;c&gt;");
  });
});

describe("xmlEscape", () => {
  it("escapes the five metacharacters, ampersand first", () => {
    expect(xmlEscape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });
  it("strips XML-illegal control characters but keeps tab/newline", () => {
    expect(xmlEscape("a\x00b\x07c\x7f")).toBe("abc");
    expect(xmlEscape("a\tb\nc")).toBe("a\tb\nc");
  });
});

describe("GET /api/mobileconfig route (#187)", () => {
  it("returns the profile with the Apple config MIME type for a valid read", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("GET", "/api/mobileconfig?user=alice@skyphusion.org", { token: "test-token" }), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-apple-aspen-config; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain(".mobileconfig");
    const body = await res.text();
    expect(body).toContain("<string>alice@skyphusion.org</string>");
    expect(body).toContain("imap.skyphusion.org");
    expect(body).toContain("smtp.skyphusion.org");
    expect(hasNoRawAmpersand(body)).toBe(true);
  });

  it("mints a fresh UUID per generation (two calls differ)", async () => {
    const { env, ctx } = makeFakeEnv();
    const a = await (await handleApi(req("GET", "/api/mobileconfig?user=alice@skyphusion.org", { token: "test-token" }), env, ctx)).text();
    const b = await (await handleApi(req("GET", "/api/mobileconfig?user=alice@skyphusion.org", { token: "test-token" }), env, ctx)).text();
    const uuidOf = (s: string) => /<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(s)?.[1];
    expect(uuidOf(a)).toBeTruthy();
    expect(uuidOf(a)).not.toBe(uuidOf(b));
  });

  it("honors username and name overrides", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(
      req("GET", "/api/mobileconfig?user=alice@skyphusion.org&username=alice.login&name=Alice%20Q", { token: "test-token" }),
      env,
      ctx,
    );
    const body = await res.text();
    expect(body).toContain("<key>IncomingMailServerUsername</key>\n\t\t\t<string>alice.login</string>");
    expect(body).toContain("<key>EmailAccountName</key>\n\t\t\t<string>Alice Q</string>");
  });

  it("reflects MOBILECONFIG_* host overrides from env", async () => {
    const { env, ctx } = makeFakeEnv({ MOBILECONFIG_IMAP_HOST: "mail.example.net", MOBILECONFIG_SMTP_HOST: "send.example.net" });
    // ALLOWED_FROM_DOMAIN in the fake is skyphusion.org, so the address must be on it.
    const res = await handleApi(req("GET", "/api/mobileconfig?user=bob@skyphusion.org", { token: "test-token" }), env, ctx);
    const body = await res.text();
    expect(body).toContain("mail.example.net");
    expect(body).toContain("send.example.net");
  });

  it("401s without a token", async () => {
    const { env, ctx } = makeFakeEnv();
    expect((await handleApi(req("GET", "/api/mobileconfig?user=alice@skyphusion.org"), env, ctx)).status).toBe(401);
  });

  it("405s a non-GET (with a valid token)", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("POST", "/api/mobileconfig?user=alice@skyphusion.org", { token: "test-token" }), env, ctx);
    expect(res.status).toBe(405);
    expect((await res.json() as { error: string }).error).toBe("method_not_allowed");
  });

  it("400 E_FIELD_MISSING when user is absent", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("GET", "/api/mobileconfig", { token: "test-token" }), env, ctx);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("E_FIELD_MISSING");
  });

  it("400 E_VALIDATION_ERROR for a malformed address or wrong domain", async () => {
    const { env, ctx } = makeFakeEnv();
    const bad = await handleApi(req("GET", "/api/mobileconfig?user=not-an-email", { token: "test-token" }), env, ctx);
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe("E_VALIDATION_ERROR");
    // Well-formed but off the allowed domain (fake ALLOWED_FROM_DOMAIN=skyphusion.org).
    const offDomain = await handleApi(req("GET", "/api/mobileconfig?user=alice@elsewhere.com", { token: "test-token" }), env, ctx);
    expect(offDomain.status).toBe(400);
    expect((await offDomain.json() as { error: string }).error).toBe("E_VALIDATION_ERROR");
  });

  it("read-scoped token is accepted; a send-only token is 403", async () => {
    const scoped = () => makeFakeEnv({ POSTERN_API_TOKEN: "both-token", POSTERN_API_TOKEN_READ: "read-token", POSTERN_API_TOKEN_SEND: "send-token" });
    const ok = scoped();
    expect((await handleApi(req("GET", "/api/mobileconfig?user=alice@skyphusion.org", { token: "read-token" }), ok.env, ok.ctx)).status).toBe(200);
    const no = scoped();
    expect((await handleApi(req("GET", "/api/mobileconfig?user=alice@skyphusion.org", { token: "send-token" }), no.env, no.ctx)).status).toBe(403);
  });
});

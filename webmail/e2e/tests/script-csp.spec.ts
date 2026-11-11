/**
 * The page under the CSP the worker actually serves (WEBMAIL_CSP, generated into
 * inbound/src/webmail.ts by sync-webmail). script-src allows the page's one inline
 * script by its sha256, not by 'unsafe-inline'. The page must boot and work under that
 * header with no CSP violation, a script injected into the page must not run, and a CSP
 * with a wrong hash must stop the page (the control that shows this harness enforces
 * the header at all).
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const GENERATED = readFileSync(resolve(__dirname, "../../../inbound/src/webmail.ts"), "utf8");
const CSP = (GENERATED.match(/^export const WEBMAIL_CSP = "([^"]+)";$/m) || [])[1];

const LIST = {
  ok: true,
  items: [{
    messageId: "m1@example.com", from: "alice@example.com", to: "conrad@skyphusion.org", subject: "Hello under CSP",
    date: "2026-07-18T12:00:00.000Z", direction: "inbound", seen: true, flagged: false, trusted: true,
    attachmentCount: 0, mailbox: null, bodyText: "plain body", hasHtml: true,
  }],
  cursor: null,
};
const MESSAGE = { ok: true, message: { ...LIST.items[0], bodyHtml: "<p>body text here</p>", attachments: [], auth: { spf: "pass", dkim: "pass", dmarc: "pass" }, threadId: null } };
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function serve(page: Page, opts: { csp: string; html?: string }) {
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.route("https://postern.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/webmail") {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": opts.csp },
        body: opts.html ?? HTML,
      });
    }
    if (path === "/api/session") return json(route, { ok: true, identity: { from: "conrad@skyphusion.org" }, capabilities: ["read"], csrfToken: "t", authBackend: "native" });
    if (path === "/api/folders") return json(route, { ok: true, folders: [{ id: "inbox", label: "Inbox", count: 1, unread: 0 }] });
    if (path === "/api/messages") return json(route, LIST);
    if (path.startsWith("/api/messages/")) return json(route, MESSAGE);
    return json(route, { ok: true });
  });
  await page.goto("https://postern.test/webmail");
  return violations;
}

test.describe("script CSP", () => {
  test("the served CSP allows scripts by hash only", () => {
    expect(CSP, "WEBMAIL_CSP not found in inbound/src/webmail.ts").toBeTruthy();
    expect(CSP).toMatch(/script-src 'sha256-[A-Za-z0-9+/]{43}='/);
    expect(CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  test("the page boots and works under the served CSP, with no violation", async ({ page }) => {
    const violations = await serve(page, { csp: CSP! });
    await expect(page.locator("#app")).toBeVisible();
    await page.getByText("Hello under CSP").first().click();
    await expect(page.locator("iframe.msg-body-frame")).toHaveCount(1);
    expect(violations).toEqual([]);
  });

  test("a script injected into the page does not run", async ({ page }) => {
    // Before the LAST </body>: the page's own script also contains "</body>" (it builds
    // the reading pane's srcdoc), and editing the script would change its hash.
    const at = HTML.lastIndexOf("</body>");
    const injected = HTML.slice(0, at) + "<script>window.__injected = 1;</script>" + HTML.slice(at);
    const violations = await serve(page, { csp: CSP!, html: injected });
    await expect(page.locator("#app")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();
    expect(violations.length).toBeGreaterThan(0);
  });

  test("control: a CSP with a wrong hash stops the page", async ({ page }) => {
    const wrong = CSP!.replace(/sha256-([A-Za-z0-9+/])/, (_m, c: string) => "sha256-" + (c === "A" ? "B" : "A"));
    expect(wrong).not.toBe(CSP);
    const violations = await serve(page, { csp: wrong });
    await page.waitForTimeout(500);
    await expect(page.locator("#app")).toBeHidden();
    expect(violations.length).toBeGreaterThan(0);
  });
});

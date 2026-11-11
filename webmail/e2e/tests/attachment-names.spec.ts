/**
 * Attachment filenames in the reading pane: control and invisible format characters
 * (bidi overrides and isolates, zero-width characters, C0/C1 controls) are shown as a
 * visible [U+XXXX] marker, and the name given to the download replaces each with "_".
 * An ordinary name, including one in a right-to-left script, is unchanged.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

const NAMES = [
  { raw: "invoice‮fdp.exe", shown: "invoice[U+202E]fdp.exe", saved: "invoice_fdp.exe" },
  { raw: "report⁧gpj.scr⁩", shown: "report[U+2067]gpj.scr[U+2069]", saved: "report_gpj.scr_" },
  { raw: "a​b‎c﻿d\u0007.txt", shown: "a[U+200B]b[U+200E]c[U+FEFF]d[U+0007].txt", saved: "a_b_c_d_.txt" },
  { raw: "quarterly report.pdf", shown: "quarterly report.pdf", saved: "quarterly report.pdf" },
  { raw: "דוח.pdf", shown: "דוח.pdf", saved: "דוח.pdf" },
];

const LIST = {
  ok: true,
  items: [{
    messageId: "att-1@example.com", from: "alice@example.com", to: "conrad@skyphusion.org",
    subject: "Files for you", date: "2026-07-18T12:00:00.000Z", direction: "inbound",
    seen: false, flagged: false, trusted: false, attachmentCount: NAMES.length, mailbox: null,
    bodyText: "see attached", hasHtml: false,
  }],
  cursor: null,
};
const MESSAGE = {
  ok: true,
  message: {
    ...LIST.items[0], seen: true, bodyHtml: null, auth: { spf: "none", dkim: "none", dmarc: "none" },
    threadId: null,
    attachments: NAMES.map((n) => ({ filename: n.raw, mime: "application/pdf", size: 2 })),
  },
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function open(page: Page) {
  // Record the name the page hands to the download, before the browser applies its own
  // filename rules.
  await page.addInitScript(() => {
    const w = window as unknown as { __downloads: string[] };
    w.__downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { w.__downloads.push(this.download); return; }
      return click.call(this);
    };
  });
  await page.route("https://postern.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/webmail") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML });
    if (path === "/api/session") return json(route, { ok: true, identity: { from: "conrad@skyphusion.org" }, capabilities: ["read"], csrfToken: "t", authBackend: "native" });
    if (path === "/api/folders") return json(route, { ok: true, folders: [{ id: "inbox", label: "Inbox", count: 1, unread: 1 }] });
    if (path === "/api/messages") return json(route, LIST);
    if (/\/attachments\/\d+$/.test(path)) return route.fulfill({ status: 200, contentType: "application/octet-stream", body: "ok" });
    if (path.startsWith("/api/messages/")) return json(route, MESSAGE);
    return json(route, { ok: true });
  });
  await page.goto("https://postern.test/webmail");
  await page.getByText("Files for you").first().click();
  await expect(page.locator(".attachments li")).toHaveCount(NAMES.length);
}

test.describe("attachment filenames", () => {
  test("each name is shown with control and format characters made visible", async ({ page }) => {
    await open(page);
    const shown = await page.locator(".attachments li .att-name").allTextContents();
    expect(shown).toEqual(NAMES.map((n) => n.shown));
  });

  test("no control or format character reaches the reading pane", async ({ page }) => {
    await open(page);
    const text = await page.locator(".attachments").textContent();
    expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  test("the name is isolated left-to-right, so it cannot reorder its neighbours", async ({ page }) => {
    await open(page);
    const first = page.locator(".attachments li .att-name").first();
    await expect(first).toHaveAttribute("dir", "ltr");
    expect(await first.evaluate((e) => getComputedStyle(e).unicodeBidi)).toBe("isolate");
  });

  test("the download name replaces each such character with an underscore", async ({ page }) => {
    await open(page);
    const buttons = page.locator(".attachments li button.dl");
    for (let i = 0; i < NAMES.length; i++) {
      await buttons.nth(i).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __downloads: string[] }).__downloads.length)).toBe(i + 1);
    }
    const saved = await page.evaluate(() => (window as unknown as { __downloads: string[] }).__downloads);
    expect(saved).toEqual(NAMES.map((n) => n.saved));
  });
});

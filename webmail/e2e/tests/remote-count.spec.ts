/**
 * The reading pane's "Remote content blocked (N items)" notice counts every remote
 * reference in the message: SVG image/use/feImage href and xlink:href, url() written
 * with CSS escapes, @import of a plain string, and image-set() strings, as well as the
 * img/style cases it already counted. Each one is also removed from the frame's
 * document. A message with no remote content shows no notice.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

const REMOTE_BODY = [
  "<p>hello</p>",
  '<svg width="1" height="1"><image href="https://e.example/a.png" width="1" height="1"/></svg>',
  '<svg width="1" height="1"><image xlink:href="https://e.example/b.png" width="1" height="1"/></svg>',
  '<svg width="1" height="1"><use href="https://e.example/s.svg#i"/></svg>',
  '<svg width="1" height="1"><filter id="f"><feImage href="https://e.example/g.png"/></filter></svg>',
  '<div style="background:url(\\68ttps://e.example/c.png)">x</div>',
  '<style>@import "https://e.example/d.css"; p{background:image-set("https://e.example/e.png" 1x)}</style>',
  '<img src="https://e.example/f.png" alt="">',
].join("");
const REMOTE_COUNT = 8;
const LOCAL_BODY = '<p>plain</p><img src="data:image/png;base64,AAAA" alt=""><div style="color:red;background:url(cid:x)">y</div>';

function message(id: string, subject: string, bodyHtml: string) {
  return {
    messageId: id, from: "alice@example.com", to: "conrad@skyphusion.org", subject,
    date: "2026-07-18T12:00:00.000Z", direction: "inbound", seen: true, flagged: false, trusted: false,
    attachmentCount: 0, mailbox: null, bodyText: "x", hasHtml: true, bodyHtml, attachments: [],
    auth: { spf: "none", dkim: "none", dmarc: "none" }, threadId: null,
  };
}
const MESSAGES = [message("remote@example.com", "Remote things", REMOTE_BODY), message("local@example.com", "Local things", LOCAL_BODY)];

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function open(page: Page, subject: string, hits: string[]) {
  await page.route("https://e.example/**", (route) => { hits.push(route.request().url()); return route.abort(); });
  await page.route("https://postern.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/webmail") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML });
    if (path === "/api/session") return json(route, { ok: true, identity: { from: "conrad@skyphusion.org" }, capabilities: ["read"], csrfToken: "t", authBackend: "native" });
    if (path === "/api/folders") return json(route, { ok: true, folders: [{ id: "inbox", label: "Inbox", count: 2, unread: 0 }] });
    if (path === "/api/messages") return json(route, { ok: true, items: MESSAGES, cursor: null });
    const m = MESSAGES.find((x) => decodeURIComponent(path).endsWith(x.messageId));
    if (m) return json(route, { ok: true, message: m });
    return json(route, { ok: true });
  });
  await page.goto("https://postern.test/webmail");
  await page.getByText(subject).first().click();
  await expect(page.locator("iframe.msg-body-frame")).toHaveCount(1);
}

test.describe("remote content notice", () => {
  test("counts every remote reference", async ({ page }) => {
    const hits: string[] = [];
    await open(page, "Remote things", hits);
    await expect(page.getByText(`(${REMOTE_COUNT} items)`)).toBeVisible();
  });

  test("leaves no remote reference in the frame document", async ({ page }) => {
    const hits: string[] = [];
    await open(page, "Remote things", hits);
    const leftover = await page.locator("iframe.msg-body-frame").evaluate((f) => {
      const doc = new DOMParser().parseFromString((f as HTMLIFrameElement).srcdoc, "text/html");
      const out: string[] = [];
      for (const n of Array.from(doc.querySelectorAll("*"))) {
        for (const a of Array.from(n.attributes)) {
          if (a.name.startsWith("data-blocked")) continue;
          if (/e\.example/.test(a.value)) out.push(n.tagName + " " + a.name);
        }
      }
      for (const s of Array.from(doc.querySelectorAll("style"))) if (/e\.example|\\68/.test(s.textContent || "")) out.push("style " + s.textContent);
      return out;
    });
    expect(leftover).toEqual([]);
    expect(hits).toEqual([]);
  });

  test("control: a message with only local content shows no notice", async ({ page }) => {
    const hits: string[] = [];
    await open(page, "Local things", hits);
    await expect(page.getByText(/Remote content blocked/)).toHaveCount(0);
  });
});

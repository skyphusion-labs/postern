/**
 * Human-only conversations (#853), session mode only: the owner marks a whole
 * conversation human-only from the message view, sees and unmarks it in Settings, and
 * reads the marks in the activity list. Served under the real CSP. Server values
 * render as text only.
 */
import { test, expect, type Page, type Route, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const CSP = (readFileSync(resolve(__dirname, "../../../inbound/src/webmail.ts"), "utf8")
  .match(/^export const WEBMAIL_CSP = "([^"]+)";$/m) || [])[1];
const CSRF = "csrf-853";
const HOSTILE = "<img src=x onerror=\"window.__pwn=1\">";

type Exc = { id: string; threadId: string; subject: string | null; createdAt: string };

function server(opts: { mode?: "session" | "token"; exclusions?: "present" | "absent"; markFails?: boolean } = {}) {
  const mode = opts.mode ?? "session";
  const messages = [
    { messageId: "m1@x.example", threadId: "t1@x.example", subject: "Lawyer call notes", from: "counsel@law.example" },
    { messageId: "m2@x.example", threadId: "t2@x.example", subject: HOSTILE, from: "someone@x.example" },
  ];
  const exclusions: Exc[] = [];
  const audit: unknown[] = [];
  let seq = 0;
  const writes: Array<{ method: string; path: string; body: unknown; csrf?: string }> = [];
  const excRequests: string[] = [];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const row = (m: (typeof messages)[number]) => ({
    messageId: m.messageId, threadId: m.threadId, subject: m.subject, from: m.from, to: "me@skyphusion.org",
    date: "2026-11-10T10:00:00.000Z", direction: "inbound", seen: true, flagged: false, trusted: true,
    attachmentCount: 0, mailbox: null, bodyText: "body", hasHtml: false,
  });
  async function handle(route: Route, req: Request) {
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname);
    const method = req.method();
    if (path === "/webmail") return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP! }, body: HTML });
    if (path === "/api/session" && method === "GET") {
      return mode === "session"
        ? json(route, { ok: true, identity: { from: "me@skyphusion.org", displayName: "Me" }, capabilities: ["read", "send", "organize"], csrfToken: CSRF, authBackend: "native" })
        : json(route, { ok: false, authBackend: "off" }, 401);
    }
    if (path.startsWith("/api/delegations/mine/exclusions")) {
      excRequests.push(method + " " + path);
      if (opts.exclusions === "absent") return json(route, { ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
      if (method === "GET") return json(route, { ok: true, items: [...exclusions].reverse() });
      if (method === "POST") {
        const body = JSON.parse(req.postData() || "{}");
        writes.push({ method, path, body, csrf: req.headers()["x-postern-csrf"] });
        if (opts.markFails) return json(route, { ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
        const m = messages.find((x) => x.threadId === body.threadId)!;
        const item = { id: "exc_" + (++seq), threadId: m.threadId, subject: m.subject, createdAt: "2026-11-10T12:00:00.000Z" };
        exclusions.push(item);
        audit.unshift({ id: "a" + seq, at: item.createdAt, actor: { kind: "human", id: "prn_me" }, action: "delegation.exclude", target: { kind: "thread", id: m.threadId }, outcome: "ok", detail: { address: "me@skyphusion.org", exclusionId: item.id } });
        return json(route, { ok: true, item, created: true }, 201);
      }
      const del = path.match(/\/exclusions\/(exc_\d+)$/);
      if (del && method === "DELETE") {
        writes.push({ method, path, body: null, csrf: req.headers()["x-postern-csrf"] });
        const i = exclusions.findIndex((x) => x.id === del[1]);
        if (i === -1) return json(route, { ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
        const [x] = exclusions.splice(i, 1);
        audit.unshift({ id: "u" + seq, at: "2026-11-10T13:00:00.000Z", actor: { kind: "human", id: "prn_me" }, action: "delegation.unexclude", target: { kind: "thread", id: x.threadId }, outcome: "ok", detail: { address: "me@skyphusion.org", exclusionId: x.id } });
        return json(route, { ok: true });
      }
    }
    if (path === "/api/delegations/mine/grantees" || path === "/api/delegations/mine") return json(route, { ok: true, items: [] });
    if (path === "/api/audit/mine") return json(route, { ok: true, items: audit, cursor: null });
    if (path === "/api/folders") return json(route, { ok: true, folders: [{ id: "inbox", label: "Inbox", count: 2, unread: 0 }] });
    if (path === "/api/messages") return json(route, { ok: true, items: messages.map(row), cursor: null });
    if (path.startsWith("/api/messages/")) {
      const m = messages.find((x) => path.endsWith(x.messageId));
      if (m) return json(route, { ok: true, message: { ...row(m), attachments: [], auth: { spf: "pass", dkim: "pass", dmarc: "pass" } } });
    }
    if (path.startsWith("/api/threads/")) return json(route, { ok: true, items: [] });
    return json(route, { ok: true });
  }
  return { handle, writes, excRequests };
}

async function open(page: Page, s: ReturnType<typeof server>) {
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.context().addCookies([{ name: "__Host-postern_csrf", value: CSRF, url: "https://postern.test/" }]);
  await page.route("https://postern.test/**", (route) => s.handle(route, route.request()));
  await page.goto("https://postern.test/webmail");
  await expect(page.locator("#app")).toBeVisible();
  return violations;
}
const openMessage = async (page: Page, subject: string) => {
  await page.locator("#list").getByText(subject, { exact: true }).first().click();
  await expect(page.locator("#reading h2")).toHaveText(subject);
};
const toggle = (page: Page) => page.locator("#reading button[aria-pressed]");
const chip = (page: Page) => page.locator("#reading .tag.human-only");

test.describe("human-only conversations (#853)", () => {
  test("marks a conversation from the message view, with the thread id and the CSRF header", async ({ page }) => {
    const s = server();
    const violations = await open(page, s);
    await openMessage(page, "Lawyer call notes");
    await expect(toggle(page)).toHaveText("Make human-only");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(chip(page)).toHaveCount(0);
    await toggle(page).click();
    await expect(toggle(page)).toHaveText("Let agents see it");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(chip(page)).toHaveText("Human only");
    expect(s.writes).toEqual([{ method: "POST", path: "/api/delegations/mine/exclusions", body: { threadId: "t1@x.example" }, csrf: CSRF }]);
    expect(violations).toEqual([]);
  });

  test("Settings lists the conversation by subject, and the activity names it while marked", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openMessage(page, "Lawyer call notes");
    await toggle(page).click();
    await expect(chip(page)).toBeVisible();
    await page.locator("#settingsBtn").click();
    await expect(page.locator("#excList li")).toHaveCount(1);
    await expect(page.locator("#excList li")).toContainText("Lawyer call notes");
    await expect(page.locator("#excEmpty")).toBeHidden();
    await expect(page.locator("#auditList li").first()).toContainText("You marked a conversation human-only: Lawyer call notes");
  });

  test("unmarking from the message view takes two clicks", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openMessage(page, "Lawyer call notes");
    await toggle(page).click();
    await expect(toggle(page)).toHaveText("Let agents see it");
    await toggle(page).click();
    await expect(toggle(page)).toHaveText("Confirm: let agents see it");
    expect(s.writes.filter((w) => w.method === "DELETE")).toEqual([]);
    await toggle(page).click();
    await expect(toggle(page)).toHaveText("Make human-only");
    await expect(chip(page)).toHaveCount(0);
    expect(s.writes.filter((w) => w.method === "DELETE")).toEqual([{ method: "DELETE", path: "/api/delegations/mine/exclusions/exc_1", body: null, csrf: CSRF }]);
  });

  test("unmarking from Settings takes two clicks, and the activity row carries no subject after it", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openMessage(page, "Lawyer call notes");
    await toggle(page).click();
    await expect(chip(page)).toBeVisible();
    await page.locator("#settingsBtn").click();
    const btn = page.locator("#excList li button");
    await btn.click();
    await expect(btn).toHaveText("Confirm: let agents see it");
    await btn.click();
    await expect(page.locator("#excList li")).toHaveCount(0);
    await expect(page.locator("#excEmpty")).toBeVisible();
    await page.locator("#settingsBtn").click();
    await page.locator("#settingsBtn").click();
    await expect(page.locator("#auditList li").first()).toHaveText(/You made a conversation visible to agents again$/);
    await expect(chip(page)).toHaveCount(0);
  });

  test("a refused mark shows one wording that says nothing about other people", async ({ page }) => {
    const s = server({ markFails: true });
    await open(page, s);
    await openMessage(page, "Lawyer call notes");
    await toggle(page).click();
    await expect(page.getByText("That conversation is not in your mailbox.")).toBeVisible();
    await expect(toggle(page)).toHaveText("Make human-only");
  });

  test("a subject from the server renders as text in Settings", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openMessage(page, HOSTILE);
    await toggle(page).click();
    await expect(chip(page)).toBeVisible();
    await page.locator("#settingsBtn").click();
    await expect(page.locator("#excList li .grant-who")).toHaveText(HOSTILE);
    expect(await page.locator("#settingsPanel img, #reading img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
  });

  test("token mode offers no human-only control and makes no exclusion request", async ({ page }) => {
    const s = server({ mode: "token" });
    await page.route("https://postern.test/**", (route) => s.handle(route, route.request()));
    await page.goto("https://postern.test/webmail");
    await page.locator("#toTokenFromOff").click();
    await page.locator("#token").fill("read-token");
    await page.locator("#connect").click();
    await expect(page.locator("#app")).toBeVisible();
    await openMessage(page, "Lawyer call notes");
    await expect(toggle(page)).toHaveCount(0);
    expect(s.excRequests).toEqual([]);
  });

  test("an older server without the route shows no human-only control", async ({ page }) => {
    const s = server({ exclusions: "absent" });
    await open(page, s);
    await openMessage(page, "Lawyer call notes");
    await expect(toggle(page)).toHaveCount(0);
    await page.locator("#settingsBtn").click();
    await expect(page.locator("#excSection")).toBeHidden();
    await expect(page.locator("#accessSection")).toBeVisible();
  });
});

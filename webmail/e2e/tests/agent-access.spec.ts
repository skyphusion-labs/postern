/**
 * Settings: agent access to my mail, and activity on my mail (#740 S5). Session mode
 * only. The page lists the agents with access to the signed-in human's own address,
 * gives and removes access (cookie + CSRF), and shows the audit rows about that
 * address. Served under the real CSP. Server values render as text only.
 */
import { test, expect, type Page, type Route, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const CSP = (readFileSync(resolve(__dirname, "../../../inbound/src/webmail.ts"), "utf8")
  .match(/^export const WEBMAIL_CSP = "([^"]+)";$/m) || [])[1];
const CSRF = "csrf-abc";
const HOSTILE = "<img src=x onerror=\"window.__pwn=1\">";

type Grant = { id: string; granteeId: string; granteeName: string | null; granteeFrom: string; powers: string[]; label: string | null; createdBy: string; createdAt: string };

function server(opts: { mode?: "session" | "token"; routes?: "present" | "absent"; conflict?: boolean } = {}) {
  const mode = opts.mode ?? "session";
  const grantees = [
    { id: "agt_a", displayName: "Helper", from: "helper@agents.example" },
    { id: "agt_b", displayName: null, from: "bot@agents.example" },
    { id: "agt_x", displayName: HOSTILE, from: "x@agents.example" },
  ];
  const grants: Grant[] = [
    { id: "grt_1", granteeId: "agt_a", granteeName: "Helper", granteeFrom: "helper@agents.example", powers: ["read", "organize"], label: "inbox triage", createdBy: "operator", createdAt: "2026-11-10T10:00:00.000Z" },
  ];
  const pages = [
    { items: [
      { id: "aud_3", at: "2026-11-10T12:00:00.000Z", actor: { kind: "agent", id: "agt_a" }, action: "delegation.organize", target: { kind: "message", id: "m1" }, outcome: "ok", detail: { op: "move", granted: true } },
      { id: "aud_2", at: "2026-11-10T11:00:00.000Z", actor: { kind: "human", id: "prn_me" }, action: "delegation.revoke", target: null, outcome: "ok", detail: { granteeId: "agt_b" } },
    ], cursor: "c2" },
    { items: [
      { id: "aud_1", at: "2026-11-10T10:00:00.000Z", actor: { kind: "service", id: "svc_admin" }, action: "delegation.grant", target: null, outcome: "ok", detail: { granteeId: "agt_a", address: "me@x", powers: ["read", "organize"] } },
    ], cursor: null },
  ];
  const writes: Array<{ method: string; path: string; body: unknown; csrf?: string }> = [];
  const accessRequests: string[] = [];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  async function handle(route: Route, req: Request) {
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (path === "/webmail") {
      return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP! }, body: HTML });
    }
    if (path === "/api/session" && method === "GET") {
      return mode === "session"
        ? json(route, { ok: true, identity: { from: "me@skyphusion.org", displayName: "Me" }, capabilities: ["read", "send"], csrfToken: CSRF, authBackend: "native" })
        : json(route, { ok: false, authBackend: "off" }, 401);
    }
    if (path.startsWith("/api/delegations/") || path.startsWith("/api/audit/")) {
      accessRequests.push(method + " " + path + url.search);
      if (opts.routes === "absent") return json(route, { ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
      if (path === "/api/delegations/mine/grantees") return json(route, { ok: true, items: grantees });
      if (path === "/api/delegations/mine" && method === "GET") return json(route, { ok: true, items: grants });
      if (path === "/api/delegations/mine" && method === "POST") {
        const body = JSON.parse(req.postData() || "{}");
        writes.push({ method, path, body, csrf: req.headers()["x-postern-csrf"] });
        if (opts.conflict) return json(route, { ok: false, error: "E_CONFLICT", message: "an active grant exists" }, 409);
        const g = grantees.find((x) => x.id === body.granteeId)!;
        grants.unshift({ id: "grt_new", granteeId: g.id, granteeName: g.displayName, granteeFrom: g.from, powers: body.powers, label: body.label ?? null, createdBy: "prn_me", createdAt: "2026-11-10T13:00:00.000Z" });
        return json(route, { ok: true, id: "grt_new" }, 201);
      }
      const del = path.match(/^\/api\/delegations\/mine\/([^/]+)$/);
      if (del && method === "DELETE") {
        writes.push({ method, path, body: null, csrf: req.headers()["x-postern-csrf"] });
        const i = grants.findIndex((g) => g.id === decodeURIComponent(del[1]));
        if (i !== -1) grants.splice(i, 1);
        return json(route, { ok: true, id: del[1], revoked: 1, alreadyRevoked: false });
      }
      if (path === "/api/audit/mine") return json(route, { ok: true, ...(url.searchParams.get("cursor") === "c2" ? pages[1] : pages[0]) });
    }
    if (path === "/api/folders") return json(route, { ok: true, folders: [{ id: "inbox", label: "Inbox", count: 0, unread: 0 }] });
    if (path === "/api/messages") return json(route, { ok: true, items: [], cursor: null });
    return json(route, { ok: true });
  }
  return { handle, writes, accessRequests };
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
async function openSettings(page: Page) {
  await page.locator("#settingsBtn").click();
  await expect(page.locator("#settingsPanel")).toBeVisible();
}

test.describe("agent access and activity (#740 S5)", () => {
  test("lists current access and the agents that can be chosen", async ({ page }) => {
    const s = server();
    const violations = await open(page, s);
    await openSettings(page);
    const item = page.locator("#grantList li");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("Helper (helper@agents.example)");
    await expect(item).toContainText("May: read, organize");
    await expect(item).toContainText("Note: inbox triage");
    await expect(item).toContainText("Given by the admin");
    await expect(page.locator("#grantEmpty")).toBeHidden();
    const options = page.locator("#grantAgent option");
    await expect(options).toHaveText(["Choose an agent", "Helper (helper@agents.example) (has access)", "bot@agents.example", HOSTILE + " (x@agents.example)"]);
    await expect(page.locator('#grantAgent option[value="agt_a"]')).toBeDisabled();
    expect(violations).toEqual([]);
  });

  test("gives access with the chosen powers, the CSRF header and a note", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openSettings(page);
    await page.locator("#grantAgent").selectOption("agt_b");
    await page.locator("#grantPower_quote").check();
    await page.locator("#grantPower_send_as").check();
    await page.locator("#grantLabel").fill("drafts only");
    await page.locator("#grantSubmit").click();
    await expect(page.locator("#grantNote")).toHaveText("Access given to bot@agents.example.");
    expect(s.writes).toEqual([{ method: "POST", path: "/api/delegations/mine", body: { granteeId: "agt_b", powers: ["read", "quote", "send_as"], label: "drafts only" }, csrf: CSRF }]);
    await expect(page.locator("#grantList li")).toHaveCount(2);
    await expect(page.locator("#grantList li").first()).toContainText("May: read, quote, send as you");
    await expect(page.locator("#grantList li").first()).toContainText("Given by you");
    await expect(page.locator("#grantPower_quote")).not.toBeChecked();
  });

  test("an existing grant is refused with plain wording", async ({ page }) => {
    const s = server({ conflict: true });
    await open(page, s);
    await openSettings(page);
    await page.locator("#grantAgent").selectOption("agt_b");
    await page.locator("#grantSubmit").click();
    await expect(page.locator("#grantErr")).toHaveText("That agent already has access. Remove it first to change what it may do.");
  });

  test("choosing no agent is caught before any request", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openSettings(page);
    await page.locator("#grantSubmit").click();
    await expect(page.locator("#grantErr")).toHaveText("Choose an agent.");
    expect(s.writes).toEqual([]);
  });

  test("removing access takes two clicks and sends DELETE with the CSRF header", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openSettings(page);
    const btn = page.locator("#grantList li button.revoke");
    await btn.click();
    await expect(btn).toHaveText("Confirm: remove access");
    expect(s.writes).toEqual([]);
    await btn.click();
    await expect(page.locator("#grantNote")).toHaveText("Access removed for Helper (helper@agents.example).");
    expect(s.writes).toEqual([{ method: "DELETE", path: "/api/delegations/mine/grt_1", body: null, csrf: CSRF }]);
    await expect(page.locator("#grantList li")).toHaveCount(0);
    await expect(page.locator("#grantEmpty")).toBeVisible();
  });

  test("activity lists the rows about my address and pages with the cursor", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openSettings(page);
    const rows = page.locator("#auditList li");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Helper (helper@agents.example) organized your mail (move)");
    await expect(rows.nth(1)).toContainText("You removed access from bot@agents.example");
    await page.locator("#auditMore").click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText("The admin gave access to Helper (helper@agents.example) (read, organize)");
    await expect(page.locator("#auditMore")).toBeHidden();
    expect(s.accessRequests).toContain("GET /api/audit/mine?limit=25&cursor=c2");
  });

  test("names from the server render as text, never markup", async ({ page }) => {
    const s = server();
    await open(page, s);
    await openSettings(page);
    await expect(page.locator("#grantAgent option").nth(3)).toHaveText(HOSTILE + " (x@agents.example)");
    expect(await page.locator("#settingsPanel img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
  });

  test("token mode shows no access sections and makes no access requests", async ({ page }) => {
    const s = server({ mode: "token" });
    await page.route("https://postern.test/**", (route) => s.handle(route, route.request()));
    await page.goto("https://postern.test/webmail");
    await page.locator("#toTokenFromOff").click();
    await page.locator("#token").fill("read-token");
    await page.locator("#connect").click();
    await expect(page.locator("#app")).toBeVisible();
    await openSettings(page);
    await expect(page.locator("#accessSection")).toBeHidden();
    await expect(page.locator("#auditSection")).toBeHidden();
    expect(s.accessRequests).toEqual([]);
  });

  test("an older server without the routes hides the sections", async ({ page }) => {
    const s = server({ routes: "absent" });
    await open(page, s);
    await openSettings(page);
    await expect(page.locator("#accessSection")).toBeHidden();
    await expect(page.locator("#auditSection")).toBeHidden();
    await expect(page.locator("#grantErr")).toHaveText("");
  });
});

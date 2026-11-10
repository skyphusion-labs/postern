/**
 * Webmail v2 phase 6 (#355) browser E2E: critical journeys against mocked /api.
 * Serves webmail/index.html under https://postern.test so same-origin session
 * boot and BYO-token origin calls both hit Playwright routes.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

const SAMPLE_LIST = {
  ok: true,
  items: [
    {
      messageId: "msg-1@example.com",
      from: "alice@example.com",
      to: "conrad@skyphusion.org",
      subject: "Hello from Alice",
      date: "2026-07-18T12:00:00.000Z",
      direction: "inbound",
      seen: false,
      flagged: false,
      trusted: true,
      attachmentCount: 0,
      mailbox: null,
      bodyText: "plain body",
      hasHtml: true,
    },
  ],
  cursor: null,
};

const SAMPLE_MESSAGE = {
  ok: true,
  message: {
    messageId: "msg-1@example.com",
    from: "alice@example.com",
    to: "conrad@skyphusion.org",
    subject: "Hello from Alice",
    date: "2026-07-18T12:00:00.000Z",
    direction: "inbound",
    seen: true,
    flagged: false,
    trusted: true,
    bodyText: "plain body",
    bodyHtml: '<p>hi</p><script>alert(1)</script><img src="https://evil.example/t.gif">',
    attachments: [],
    auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    threadId: "t1",
    mailbox: null,
  },
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// An unset or "off" WEBMAIL_AUTH_BACKEND shows the "not enabled" notice first (#798);
// the BYO-token gate is one click away from it.
async function openTokenGate(page: Page) {
  await expect(page.locator("#disabled")).toBeVisible();
  await page.locator("#toTokenFromOff").click();
  await expect(page.locator("#gate")).toBeVisible();
}

async function installMocks(page: Page, mode: "token" | "session") {
  await page.route("https://postern.test/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === "/webmail" || path === "/webmail/") {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML });
      return;
    }

    if (path === "/api/session" && method === "GET") {
      if (mode === "session") {
        await fulfillJson(route, {
          ok: true,
          identity: { from: "conrad@skyphusion.org", displayName: "Conrad" },
          capabilities: ["read", "send"],
          csrfToken: "test-csrf",
          authBackend: "native",
        });
      } else {
        await fulfillJson(route, { ok: false, authBackend: "off" }, 401);
      }
      return;
    }

    if (path === "/api/session" && method === "POST") {
      await fulfillJson(route, {
        ok: true,
        identity: { from: "conrad@skyphusion.org", displayName: "Conrad" },
        capabilities: ["read", "send"],
        csrfToken: "test-csrf",
      });
      return;
    }

    if (path === "/api/folders") {
      await fulfillJson(route, {
        ok: true,
        folders: [
          { id: "inbox", label: "Inbox", count: 1, unread: 1 },
          { id: "sent", label: "Sent", count: 0, unread: 0 },
          { id: "drafts", label: "Drafts", count: 0, unread: 0 },
        ],
      });
      return;
    }

    if (path === "/api/messages" && method === "GET" && !path.includes("@")) {
      await fulfillJson(route, SAMPLE_LIST);
      return;
    }

    if (path === "/api/messages/msg-1@example.com" || path.endsWith("/messages/msg-1%40example.com")) {
      await fulfillJson(route, SAMPLE_MESSAGE);
      return;
    }

    if (path.startsWith("/api/messages/") && method === "GET") {
      await fulfillJson(route, SAMPLE_MESSAGE);
      return;
    }

    if (path === "/api/send" && method === "POST") {
      // Empty-body probe (#277) and real sends both land here; 400 means scope OK.
      const raw = req.postData() || "";
      if (!raw || raw === "{}" || raw === "null") {
        await fulfillJson(route, { ok: false, error: "E_FIELD_MISSING", message: "to is required" }, 400);
      } else {
        await fulfillJson(route, { ok: true, messageId: "sent-1@example.com" });
      }
      return;
    }

    if (path === "/api/messages/seen" || path === "/api/messages/flags" || path === "/api/messages/move") {
      await fulfillJson(route, { ok: true });
      return;
    }

    if (path === "/api/recipients/recent") {
      await fulfillJson(route, { ok: true, recipients: [] });
      return;
    }

    if (path === "/api/drafts" || path.startsWith("/api/drafts/")) {
      if (method === "PUT" || method === "POST") {
        await fulfillJson(route, {
          ok: true,
          id: "draft-1",
          draft: {
            id: "draft-1",
            identity: "conrad@skyphusion.org",
            to: "",
            subject: "",
            bodyText: "",
            updatedAt: "2026-07-18T12:00:00.000Z",
            composeMode: "new",
          },
        });
      } else {
        await fulfillJson(route, { ok: true, drafts: [] });
      }
      return;
    }

    await fulfillJson(route, { ok: false, error: "unmocked", path, method }, 404);
  });
}

test.describe("webmail critical journeys (#355)", () => {
  test("BYO token: the API origin is prefilled with the page's own origin", async ({ page }) => {
    // Served by the worker, CSP connect-src 'self' makes this the only origin that can
    // work, so a new user should not have to retype the URL they are already on.
    await installMocks(page, "token");
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);

    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#origin")).toHaveValue("https://postern.test");
    await page.locator("#token").fill("read-token");
    await page.locator("#connect").click();

    await expect(page.locator("#app")).toBeVisible();
    await expect(page.getByText("Hello from Alice")).toBeVisible();
  });

  test("BYO token: connect, list, open sandboxed HTML body", async ({ page }) => {
    await installMocks(page, "token");
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);

    await expect(page.locator("#gate")).toBeVisible();
    await page.locator("#origin").fill("https://postern.test");
    await page.locator("#token").fill("read-token");
    await page.locator("#sendToken").fill("send-token");
    await page.locator("#connect").click();

    await expect(page.locator("#app")).toBeVisible();
    await expect(page.getByText("Hello from Alice")).toBeVisible();

    await page.getByText("Hello from Alice").click();
    await expect(page.locator("#reading h2")).toHaveText("Hello from Alice");

    const frame = page.frameLocator("#reading iframe");
    await expect(frame.locator("body")).toContainText("hi");
    // Sandbox must not execute the injected script as top-frame JS; iframe exists
    // with sandbox attribute (empty sandbox = max restriction).
    const sandbox = await page.locator("#reading iframe").getAttribute("sandbox");
    expect(sandbox).not.toBeNull();
  });

  test("native session boot restores mailbox without token gate", async ({ page }) => {
    await installMocks(page, "session");
    await page.goto("https://postern.test/webmail");

    await expect(page.locator("#app")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#gate")).toBeHidden();
    await expect(page.getByText("Hello from Alice")).toBeVisible();
  });

  // #410: a mark-read must be scoped to the viewer, never the estate write that
  // realigns every other recipient override (A opening a shared message would show it
  // read in B mailbox). Session mode knows its bound identity and must send it; BYO
  // token mode has no bound identity in the page and must keep the estate behavior.
  async function markReadBody(page: Page, mode: "token" | "session"): Promise<Record<string, unknown> | null> {
    await installMocks(page, mode);
    // The shared single-message mock returns seen: true, which never triggers a
    // mark-read; override it (a later route wins in Playwright) so the write fires.
    await page.route("https://postern.test/api/messages/msg-1%40example.com", async (route) => {
      await fulfillJson(route, {
        ...SAMPLE_MESSAGE,
        message: { ...SAMPLE_MESSAGE.message, seen: false },
      });
    });
    let captured: Record<string, unknown> | null = null;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/messages/seen" && req.method() === "POST") {
        captured = JSON.parse(req.postData() || "null");
      }
    });

    await page.goto("https://postern.test/webmail");
    if (mode === "token") await openTokenGate(page);
    if (mode === "token") {
      await page.locator("#origin").fill("https://postern.test");
      await page.locator("#token").fill("read-token");
      await page.locator("#sendToken").fill("send-token");
      await page.locator("#connect").click();
    }
    await expect(page.locator("#app")).toBeVisible({ timeout: 10_000 });
    await page.getByText("Hello from Alice").click();
    await expect(page.locator("#reading h2")).toHaveText("Hello from Alice");
    await expect.poll(() => captured).not.toBeNull();
    return captured;
  }

  test("session mark-read is scoped to the viewer (#410), never the estate write", async ({ page }) => {
    const body = await markReadBody(page, "session");
    expect(body).toMatchObject({
      ids: ["msg-1@example.com"],
      seen: true,
      for: "conrad@skyphusion.org",
    });
  });

  test("BYO token mark-read still sends NO viewer (estate behavior unchanged)", async ({ page }) => {
    const body = await markReadBody(page, "token");
    expect(body).toMatchObject({ ids: ["msg-1@example.com"], seen: true });
    expect(body).not.toHaveProperty("for");
  });

  test("compose opens when send token is present", async ({ page }) => {
    await installMocks(page, "token");
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);
    await page.locator("#origin").fill("https://postern.test");
    await page.locator("#token").fill("read-token");
    await page.locator("#sendToken").fill("send-token");
    await page.locator("#connect").click();
    await expect(page.locator("#app")).toBeVisible();

    const compose = page.locator("#composeBtn");
    await expect(compose).toBeVisible({ timeout: 10_000 });
    await compose.click();
    await expect(page.locator("#cmpTo")).toBeVisible();
    await expect(page.locator("#cmpSend")).toBeVisible();
  });
  // --- role queues (#425): webmail parity with the IMAP door -------------------
  // The #404 ruling gives a role address its OWN view per role, keeps INBOX personal,
  // and makes a role view read plus mark-read only. These journeys assert the page
  // asks the server the way the door does, and offers nothing the server refuses.
  const ROLE = "abuse@skyphusion.org";
  const QUEUE_LIST = {
    ok: true,
    items: [
      {
        messageId: "queue-1@skyphusion.org",
        from: "reporter@example.com",
        to: ROLE,
        subject: "Abuse report",
        date: "2026-07-25T09:00:00.000Z",
        direction: "inbound",
        seen: true,
        flagged: false,
        trusted: false,
        attachmentCount: 0,
        mailbox: null,
        bodyText: "queue body",
        hasHtml: false,
      },
    ],
    cursor: null,
  };

  async function installRoleMocks(page: Page): Promise<URL[]> {
    await installMocks(page, "session");
    const listUrls: URL[] = [];
    // Later routes win, so these override the shared session mocks above.
    await page.route("https://postern.test/api/folders", async (route) => {
      await fulfillJson(route, {
        ok: true,
        folders: [
          { id: "inbox", label: "Inbox", count: 1, unread: 1 },
          { id: "sent", label: "Sent", count: 0, unread: 0 },
          { id: "drafts", label: "Drafts", count: 0, unread: 0 },
          { id: `role:${ROLE}`, label: "abuse", role: ROLE, count: 1, unread: 1 },
        ],
      });
    });
    await page.route("https://postern.test/api/messages?**", async (route) => {
      const url = new URL(route.request().url());
      listUrls.push(url);
      await fulfillJson(route, url.searchParams.get("to") === ROLE ? QUEUE_LIST : SAMPLE_LIST);
    });
    await page.route("https://postern.test/api/messages/queue-1%40skyphusion.org", async (route) => {
      await fulfillJson(route, {
        ok: true,
        message: {
          ...QUEUE_LIST.items[0],
          bodyHtml: null,
          attachments: [],
          auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
          threadId: "tq",
        },
      });
    });
    return listUrls;
  }

  test("role queue is its own view: to=R with the inbox lens, never merged into Inbox", async ({ page }) => {
    const listUrls = await installRoleMocks(page);
    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#app")).toBeVisible({ timeout: 10_000 });

    // The personal Inbox load must carry NO to=: the queue is not merged into it.
    await expect.poll(() => listUrls.length).toBeGreaterThan(0);
    expect(listUrls[0].searchParams.get("to")).toBeNull();
    await expect(page.getByText("Hello from Alice")).toBeVisible();

    // The queue appears under its own group heading, labelled by local part.
    await expect(page.locator("#folders .fgroup")).toHaveText("Roles");
    const queueBtn = page.locator("#folders button[data-folder=\"role:" + ROLE + "\"]");
    await expect(queueBtn).toBeVisible();

    await queueBtn.click();
    await expect(page.getByText("Abuse report")).toBeVisible();
    const queueLoad = listUrls[listUrls.length - 1];
    expect(queueLoad.searchParams.get("to")).toBe(ROLE);
    expect(queueLoad.searchParams.get("lens")).toBe("inbox");
    // seenFor is derived SERVER-side from the session; the page never asserts it.
    expect(queueLoad.searchParams.get("seenFor")).toBeNull();
  });

  test("a role view offers no star, file or delete, and says what it is", async ({ page }) => {
    await installRoleMocks(page);
    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#app")).toBeVisible({ timeout: 10_000 });
    await page.locator("#folders button[data-folder=\"role:" + ROLE + "\"]").click();
    await page.getByText("Abuse report").click();
    await expect(page.locator("#reading h2")).toHaveText("Abuse report");

    const actions = page.locator("#reading .msg-actions");
    await expect(actions.getByRole("button", { name: "Star" })).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Archive" })).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Trash" })).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Junk" })).toHaveCount(0);
    await expect(page.locator("#reading .queue-note")).toContainText("Shared queue");

    // The personal view still has them: the absence above is the role view, not a
    // page-wide regression (POSITIVE CONTROL).
    await page.locator("#folders button[data-folder=\"inbox\"]").click();
    await page.getByText("Hello from Alice").click();
    await expect(page.locator("#reading h2")).toHaveText("Hello from Alice");
    await expect(page.locator("#reading .msg-actions").getByRole("button", { name: "Archive" }))
      .toHaveCount(1);
  });

  test("theme follows the OS by default and the toggle overrides it, plain-text body included (#794)", async ({ page }) => {
    await installMocks(page, "token");
    // A plain-text-only message: its frame is the one that follows the app theme.
    await page.route("https://postern.test/api/messages/msg-1%40example.com", (route) =>
      fulfillJson(route, { ...SAMPLE_MESSAGE, message: { ...SAMPLE_MESSAGE.message, bodyHtml: null } }));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);
    await page.locator("#token").fill("read-token");
    await page.locator("#connect").click();
    await page.getByText("Hello from Alice").click();

    const html = page.locator("html");
    const frameBody = page.frameLocator("#reading iframe").locator("body");
    const pageBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect(html).toHaveAttribute("data-theme", "system");
    await expect(frameBody).toContainText("plain body");
    await expect(frameBody).toHaveCSS("background-color", "rgb(24, 27, 34)");
    expect(await pageBg()).toBe("rgb(17, 19, 24)");

    // OS flips to light: the system theme follows, and the open frame is retinted.
    await page.emulateMedia({ colorScheme: "light" });
    await expect(frameBody).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect(await pageBg()).toBe("rgb(246, 247, 249)");

    // Toggle: system -> light -> dark. Dark wins over a light OS.
    await page.locator("#themeBtn").click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.locator("#themeBtn").click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#themeBtn")).toHaveAttribute("aria-label", "Theme: dark");
    await expect(frameBody).toHaveCSS("background-color", "rgb(24, 27, 34)");
    expect(await pageBg()).toBe("rgb(17, 19, 24)");
    expect(await page.evaluate(() => localStorage.getItem("postern_theme"))).toBe("dark");
  });

  test("phone width: list and reading are stacked views with Back, and folders open as a drawer (#795)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installMocks(page, "token");
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);
    await page.locator("#token").fill("read-token");
    await page.locator("#connect").click();

    const row = page.getByText("Hello from Alice");
    await expect(row).toBeVisible();
    await expect(page.locator("#folders")).toBeHidden();
    // Nothing in the header may be pushed off-screen at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await row.click();
    await expect(page.locator("#reading h2")).toBeVisible();
    await expect(page.locator("#reading h2")).toHaveText("Hello from Alice");
    await expect(page.locator("#list")).toBeHidden();

    await page.locator("#backBtn").click();
    await expect(page.locator("#list")).toBeVisible();
    await expect(page.locator("#reading h2")).toBeHidden();

    await page.locator("#railBtn").click();
    await expect(page.locator("#railBtn")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#folders")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#folders")).toBeHidden();
    await expect(page.locator("#railBtn")).toHaveAttribute("aria-expanded", "false");

    // Sign out stays reachable at phone width, via Settings.
    await page.locator("#settingsBtn").click();
    await expect(page.locator("#settingsSignout")).toBeVisible();
  });

  test("list rows, filters toggle, empty search and the Cc/Bcc toggle (#796)", async ({ page }) => {
    await installMocks(page, "token");
    await page.route("https://postern.test/api/search**", (route) => fulfillJson(route, { ok: true, items: [], cursor: null }));
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);
    await page.locator("#token").fill("read-token");
    await page.locator("#sendToken").fill("send-token");
    await page.locator("#connect").click();

    // Row: avatar initial, unread dot for an unseen message, and no loud "trusted" tag.
    const row = page.locator(".row-item").first();
    await expect(row.locator(".avatar")).toHaveText("A");
    await expect(row.locator(".dot")).toBeVisible();
    await expect(row.locator(".tag.trusted")).toHaveCount(0);

    // Filters stay folded until asked for; the badge counts active ones.
    await expect(page.locator("#filters")).toBeHidden();
    await page.locator("#filtersBtn").click();
    await expect(page.locator("#filtersBtn")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#filters")).toBeVisible();
    await page.locator("#chipHasAtt").click();
    await expect(page.locator("#chipHasAtt")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#filtersCount")).toHaveText("1");

    // A search with no hits says so, with the query, instead of a bare "No messages."
    await page.locator("#search").fill("zebra");
    await page.locator("#search").press("Enter");
    await expect(page.locator("#list .empty-state .es-title")).toHaveText("No results for “zebra”");

    // Compose: Cc/Bcc folded by default, one click opens and focuses Cc.
    await page.locator("#composeBtn").click();
    await expect(page.locator("#cmpTo")).toBeVisible();
    await expect(page.locator("#cmpCc")).toBeHidden();
    await page.getByRole("button", { name: "Cc / Bcc" }).click();
    await expect(page.locator("#cmpCc")).toBeVisible();
    await expect(page.locator("#cmpCc")).toBeFocused();
    await expect(page.locator("#cmpSend")).toBeVisible();
  });

  test("keyboard and landmarks: skip link, arrow keys, j/k, focus ring, one main (#797)", async ({ page }) => {
    await installMocks(page, "token");
    const second = { ...SAMPLE_LIST.items[0], messageId: "msg-2@example.com", subject: "Second note", from: "bob@example.com", seen: true };
    await page.route("https://postern.test/api/messages?**", (route) =>
      fulfillJson(route, { ok: true, items: [SAMPLE_LIST.items[0], second], cursor: null }));
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);
    await page.locator("#token").fill("read-token");
    await page.locator("#connect").click();
    await expect(page.locator(".row-item")).toHaveCount(2);

    // Landmarks: exactly one banner, one nav, one main, and a labelled list region.
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Folders" })).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Message list" })).toHaveCount(1);
    // The active folder is marked for assistive tech.
    await expect(page.locator('#folders button[data-folder="inbox"]')).toHaveAttribute("aria-current", "page");
    // The load is announced.
    await expect(page.locator("#announce")).toHaveText("2 messages in Inbox.");

    // First Tab lands on the skip link, which takes focus to the list.
    // After Connect, focus is moved off the hidden gate into the list, not stranded.
    await expect(page.locator("#list")).toBeFocused();
    // On a fresh load of a restored mailbox, the first Tab reaches the skip link.
    await page.reload();
    await expect(page.locator(".row-item")).toHaveCount(2);
    await page.keyboard.press("Tab");
    await expect(page.locator("#skipLink")).toBeFocused();
    await page.keyboard.press("Enter");
    const rows = page.locator(".row-item");
    await expect(rows.nth(0)).toBeFocused();
    // A keyboard focus ring is drawn (2px solid), not suppressed.
    const ring = await rows.nth(0).evaluate((n) => { const c = getComputedStyle(n); return c.outlineStyle + " " + c.outlineWidth; });
    expect(ring).toBe("solid 2px");

    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(rows.nth(0)).toBeFocused();

    // j opens the next message and marks it current; k goes back.
    await page.keyboard.press("j");
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#reading h2")).toHaveText("Hello from Alice");
    await page.keyboard.press("j");
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(rows.nth(0)).not.toHaveAttribute("aria-current", "true");
    await page.keyboard.press("k");
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

    // The body frame has an accessible name.
    await expect(page.locator("#reading iframe")).toHaveAttribute("title", "Message body");

    // "/" goes to search; typing there is not hijacked by the j/k shortcuts.
    await page.keyboard.press("/");
    await expect(page.locator("#search")).toBeFocused();
    await page.keyboard.type("jk");
    await expect(page.locator("#search")).toHaveValue("jk");
  });

  // First run, mocked to the #793 contract (docs/design/webmail-v2-contracts.md 1.10.6 and 1.10.7):
  // GET /api/session 401 carries setupRequired; POST /api/setup answers 201 with a session.
  test("first run: setupRequired shows setup; client checks, a wrong token, then 201 signs in (#798)", async ({ page }) => {
    await installMocks(page, "token");
    await page.route("https://postern.test/api/session", (route) => route.request().method() === "GET"
      ? fulfillJson(route, { ok: false, authBackend: "native", setupRequired: true }, 401)
      : route.fallback());
    const posts: Array<Record<string, unknown>> = [];
    await page.route("https://postern.test/api/setup", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posts.push(body);
      if (body.setupToken !== "right-token-right-token-right-token") {
        await fulfillJson(route, { ok: false, error: "E_AUTH_FAILED" }, 401);
        return;
      }
      await fulfillJson(route, {
        ok: true, setup: true,
        user: { username: "alice@example.com", from: "alice@example.com", displayName: "Alice", disabled: false },
        identity: { from: "alice@example.com", displayName: "Alice" },
        capabilities: ["read", "send", "delete", "organize"],
        expiresAt: "2026-11-11T00:00:00Z", csrfToken: "setup-csrf",
      }, 201);
    });
    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#setup")).toBeVisible();
    await expect(page.locator("#signin")).toBeHidden();
    await expect(page.locator("#gate")).toBeHidden();
    await expect(page.locator("#suToken")).toBeFocused();

    await page.locator("#suToken").fill("wrong-token");
    await page.locator("#suUser").fill("Alice@Example.com");
    await page.locator("#suName").fill("Alice");
    await page.locator("#suPass").fill("short");
    await page.locator("#suPass2").fill("short");
    await page.locator("#suSubmit").click();
    await expect(page.locator("#setupErr")).toHaveText("The password must be at least 12 characters.");
    await page.locator("#suPass").fill("a long enough passphrase");
    await page.locator("#suPass2").fill("a long enough passphrase!");
    await page.locator("#suSubmit").click();
    await expect(page.locator("#setupErr")).toHaveText("The two passwords do not match.");
    expect(posts).toHaveLength(0); // obvious slips never reach the server

    await page.locator("#suPass2").fill("a long enough passphrase");
    await page.locator("#suSubmit").click();
    await expect(page.locator("#setupErr")).toHaveText("That setup token is not correct.");
    await expect(page.locator("#suToken")).toBeFocused();

    await page.locator("#suToken").fill("right-token-right-token-right-token");
    await page.locator("#suSubmit").click();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#identity")).toHaveText("Sending as alice@example.com");
    expect(posts).toHaveLength(2);
    // Exactly the contract fields; the username is normalized; no "from" (it defaults server-side).
    expect(posts[1]).toEqual({
      setupToken: "right-token-right-token-right-token", username: "alice@example.com",
      password: "a long enough passphrase", displayName: "Alice",
    });
    // The secret fields are cleared once used.
    await expect(page.locator("#suToken")).toHaveValue("");
    await expect(page.locator("#suPass")).toHaveValue("");
  });

  test("first run already completed (409) falls back to sign-in with a note (#798)", async ({ page }) => {
    await installMocks(page, "token");
    await page.route("https://postern.test/api/session", (route) => route.request().method() === "GET"
      ? fulfillJson(route, { ok: false, authBackend: "native", setupRequired: true }, 401)
      : route.fallback());
    await page.route("https://postern.test/api/setup", (route) =>
      fulfillJson(route, { ok: false, error: "E_SETUP_COMPLETE" }, 409));
    await page.goto("https://postern.test/webmail");
    await page.locator("#suToken").fill("any-token");
    await page.locator("#suUser").fill("bob@example.com");
    await page.locator("#suPass").fill("another long passphrase");
    await page.locator("#suPass2").fill("another long passphrase");
    await page.locator("#suSubmit").click();
    await expect(page.locator("#signin")).toBeVisible();
    await expect(page.locator("#signinNote")).toHaveText("This mailbox is already set up. Sign in with your account.");
    await expect(page.locator("#signinErr")).toHaveText("");
  });

  test("sign-in: throttled answer names the wait; show password toggles (#798)", async ({ page }) => {
    await installMocks(page, "token");
    await page.route("https://postern.test/api/session", (route) => route.request().method() === "GET"
      ? fulfillJson(route, { ok: false, authBackend: "native", setupRequired: false }, 401)
      : fulfillJson(route, { ok: false, error: "E_RATE_LIMITED", retryAfter: 120 }, 429));
    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#signin")).toBeVisible();
    await expect(page.locator("#setup")).toBeHidden();
    await page.locator("#siUser").fill("alice@example.com");
    await page.locator("#siPass").fill("whatever-it-is");
    const toggle = page.locator('.pw-toggle[data-toggle-for="siPass"]');
    await toggle.click();
    await expect(page.locator("#siPass")).toHaveAttribute("type", "text");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(page.locator("#siPass")).toHaveAttribute("type", "password");
    await page.locator("#siSubmit").click();
    await expect(page.locator("#signinErr")).toHaveText("Too many attempts. Try again in 2 minutes.");
    await expect(page.locator("#siSubmit")).toHaveText("Sign in");
    await expect(page.locator("#siSubmit")).toBeEnabled();
  });

  test("sign-in off: a plain not-enabled notice, no form; the token gate is one click away (#798)", async ({ page }) => {
    await installMocks(page, "token");  // GET /api/session -> 401 { authBackend: "off" }
    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#disabled")).toBeVisible();
    await expect(page.locator("#disabledTitle")).toHaveText("Webmail sign-in is not enabled on this server");
    await expect(page.locator("#signin")).toBeHidden();
    await expect(page.locator("#setup")).toBeHidden();
    await expect(page.locator("#gate")).toBeHidden();
    // Nothing to type: no visible text or password field on the notice.
    await expect(page.locator("input:visible")).toHaveCount(0);
    await page.locator("#toTokenFromOff").click();
    await expect(page.locator("#gate")).toBeVisible();
  });

  test("first run, backend unset: the not-enabled page, no sign-in form, no setup form (#798)", async ({ page }) => {
    await installMocks(page, "token");
    // An unset WEBMAIL_AUTH_BACKEND resolves to off (lead ruling, #793 amended). The server never
    // answers setupRequired:true unless the backend is explicitly native, so neither does this mock.
    await page.route("https://postern.test/api/session", (route) => route.request().method() === "GET"
      ? fulfillJson(route, { ok: false, authBackend: "off", setupRequired: false }, 401)
      : route.fallback());
    let setupCalls = 0;
    await page.route("https://postern.test/api/setup", (route) => { setupCalls++; return fulfillJson(route, { ok: false, error: "E_NOT_FOUND" }, 404); });
    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#disabled")).toBeVisible();
    await expect(page.locator("#disabledTitle")).toHaveText("Webmail sign-in is not enabled on this server");
    // No sign-in form and no setup form: neither card is shown, and none of their fields are reachable.
    await expect(page.locator("#signin")).toBeHidden();
    await expect(page.locator("#setup")).toBeHidden();
    for (const id of ["#siUser", "#siPass", "#suToken", "#suUser", "#suPass"]) await expect(page.locator(id)).toBeHidden();
    await expect(page.locator("input[type=password]:visible")).toHaveCount(0);
    expect(setupCalls).toBe(0);
  });

  test("discovery unreachable is not reported as off: token gate with a reachability note (#798)", async ({ page }) => {
    await installMocks(page, "token");
    await page.route("https://postern.test/api/session", (route) => route.abort("connectionrefused"));
    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#disabled")).toBeHidden();
    await expect(page.locator("#gateErr")).toHaveText("Could not reach the server to check sign-in. Try again, or connect with an API token.");
  });

  // Change password, mocked to the #793 contract 1.10.5 (handler: #810).
  test("change password: session-only, client checks, wrong current, then success keeps the session (#819)", async ({ page }) => {
    await installMocks(page, "session");
    let sessionAlive = true;
    await page.route("https://postern.test/api/session", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return sessionAlive
        ? fulfillJson(route, { ok: true, identity: { from: "alice@example.com" }, capabilities: ["read", "send"], csrfToken: "c1", authBackend: "native" })
        : fulfillJson(route, { ok: false, authBackend: "native", setupRequired: false }, 401);
    });
    const posts: Array<{ body: Record<string, unknown>; csrf: string | undefined }> = [];
    await page.route("https://postern.test/api/session/password", async (route) => {
      const req = route.request();
      const body = req.postDataJSON() as Record<string, unknown>;
      posts.push({ body, csrf: req.headers()["x-postern-csrf"] });
      if (body.currentPassword !== "the current one!") { await fulfillJson(route, { ok: false, error: "E_AUTH_FAILED" }, 401); return; }
      await fulfillJson(route, {
        ok: true, identity: { from: "alice@example.com" }, capabilities: ["read", "send"],
        expiresAt: "2026-11-11T00:00:00Z", csrfToken: "c2", sessionsEnded: 3,
      });
    });
    await page.context().addCookies([{ name: "__Host-postern_csrf", value: "c1", url: "https://postern.test/" }]);
    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#app")).toBeVisible();
    await page.locator("#settingsBtn").click();
    await expect(page.locator("#pwSection")).toBeVisible();

    await page.locator("#pwCur").fill("the current one!");
    await page.locator("#pwNew").fill("short");
    await page.locator("#pwNew2").fill("short");
    await page.locator("#pwSubmit").click();
    await expect(page.locator("#pwErr")).toHaveText("The new password must be at least 12 characters.");
    expect(posts).toHaveLength(0);

    await page.locator("#pwCur").fill("not the current one");
    await page.locator("#pwNew").fill("a brand new passphrase");
    await page.locator("#pwNew2").fill("a brand new passphrase");
    await page.locator("#pwSubmit").click();
    // 401 is disambiguated with GET /api/session: the session is alive, so it is the password.
    await expect(page.locator("#pwErr")).toHaveText("The current password is not correct.");
    await expect(page.locator("#app")).toBeVisible();

    await page.locator("#pwCur").fill("the current one!");
    await page.locator("#pwSubmit").click();
    await expect(page.locator("#pwNote")).toHaveText("Password changed. Any other devices were signed out.");
    await expect(page.locator("#pwErr")).toHaveText("");
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#pwCur")).toHaveValue("");
    expect(posts[1].body).toEqual({ currentPassword: "the current one!", newPassword: "a brand new passphrase" });
    expect(posts[1].csrf).toBe("c1"); // double-submit header from the companion cookie

    // A 401 with the session gone signs out instead of blaming the password.
    sessionAlive = false;
    await page.locator("#pwCur").fill("not the current one");
    await page.locator("#pwNew").fill("a brand new passphrase");
    await page.locator("#pwNew2").fill("a brand new passphrase");
    await page.locator("#pwSubmit").click();
    await expect(page.locator("#signin")).toBeVisible();
    await expect(page.locator("#signinNote")).toHaveText("Your session ended. Sign in again.");
  });

  test("change password is not offered in token mode (#819)", async ({ page }) => {
    await installMocks(page, "token");
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);
    await page.locator("#token").fill("read-token");
    await page.locator("#connect").click();
    await expect(page.locator("#app")).toBeVisible();
    await page.locator("#settingsBtn").click();
    await expect(page.locator("#settingsPanel")).toBeVisible();
    // Present in the page (so this is not vacuous) but not offered: a token has no password.
    await expect(page.locator("#pwSection")).toHaveCount(1);
    await expect(page.locator("#pwSection")).toBeHidden();
  });

  test("reading-pane trust line stays one row: no auth-card styles leak onto it (#832)", async ({ page }) => {
    await installMocks(page, "token");
    await page.goto("https://postern.test/webmail");
    await openTokenGate(page);
    await page.locator("#token").fill("read-token");
    await page.locator("#connect").click();
    await page.getByText("Hello from Alice").click();
    const trust = page.locator("#reading .msg-head .trust");
    await expect(trust.locator("details summary")).toHaveText("Authentication");
    const m = await trust.evaluate((t) => {
      const d = t.querySelector("details") as HTMLElement;
      const c = getComputedStyle(d);
      return { trustH: t.getBoundingClientRect().height, padTop: c.paddingTop, marginLeft: c.marginLeft,
               gap: d.getBoundingClientRect().left - (t.querySelector(".tag") as HTMLElement).getBoundingClientRect().right };
    });
    expect(m.trustH).toBeLessThan(40);      // one row; the leaked card rule made it 84px
    expect(m.padTop).toBe("0px");           // the card rule padded it 32px
    expect(m.marginLeft).toBe("0px");       // the card rule centered it with auto margins
    expect(m.gap).toBeLessThan(24);         // the disclosure sits next to the trust tag
  });

  // #814: a deploy with no AI or Vectorize answers semantic/hybrid as HTTP 200
  // with degraded "semantic search unavailable...", not an error. The keyword
  // fallback page can carry an fts cursor. Load more must send mode=fts with
  // that cursor. mode=semantic or hybrid with the same cursor is the #803 400.
  test("semantic unavailable: Load more pages the fts fallback with mode=fts (#814)", async ({ page }) => {
    await installMocks(page, "session");
    const searches: { mode: string | null; cursor: string | null }[] = [];
    function hit(messageId: string, subject: string, date: string) {
      return {
        message: {
          messageId,
          from: "bob@example.com",
          to: "conrad@skyphusion.org",
          subject,
          date,
          direction: "inbound",
          seen: true,
          flagged: false,
          trusted: true,
          attachmentCount: 0,
          mailbox: null,
          bodyText: subject,
        },
      };
    }
    await page.route("https://postern.test/api/search**", async (route) => {
      const url = new URL(route.request().url());
      const mode = url.searchParams.get("mode");
      const cursor = url.searchParams.get("cursor");
      searches.push({ mode, cursor });
      if (mode === "fts" && cursor === "cur-2") {
        await fulfillJson(route, {
          ok: true,
          items: [hit("p2@example.com", "Keyword page two", "2026-07-17T12:00:00.000Z")],
          cursor: null,
        });
        return;
      }
      if (mode === "fts") {
        await fulfillJson(route, {
          ok: true,
          items: [hit("p1@example.com", "Keyword page one", "2026-07-18T12:00:00.000Z")],
          cursor: "cur-2",
        });
        return;
      }
      if (cursor) {
        await fulfillJson(route, {
          ok: false,
          error: "E_VALIDATION_ERROR",
          message: "cursor paginates mode fts and substr only; semantic and hybrid are score-ranked and refuse a cursor",
        }, 400);
        return;
      }
      await fulfillJson(route, {
        ok: true,
        items: [],
        complete: false,
        degraded: "semantic search unavailable: no AI binding is configured, so no query was run",
      });
    });

    await page.goto("https://postern.test/webmail");
    await expect(page.locator("#app")).toBeVisible({ timeout: 10_000 });
    await page.locator("#searchMode").selectOption("semantic");
    await page.locator("#search").fill("invoice");
    await page.locator("#search").press("Enter");

    await expect(page.getByText("Keyword page one")).toBeVisible();
    await expect(page.getByText("Semantic search unavailable; showing keyword results.")).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByText("Keyword page two")).toBeVisible();

    const continued = searches.filter((s) => s.cursor === "cur-2");
    expect(continued).toEqual([{ mode: "fts", cursor: "cur-2" }]);
  });
});

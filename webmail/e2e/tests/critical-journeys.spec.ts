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
  test("BYO token: connect, list, open sandboxed HTML body", async ({ page }) => {
    await installMocks(page, "token");
    await page.goto("https://postern.test/webmail");

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
});

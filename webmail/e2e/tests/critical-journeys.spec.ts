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
});

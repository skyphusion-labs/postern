import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { READ_TOOLS } from "../src/tools.js";

function tool(name: string) {
  const t = READ_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no such tool ${name}`);
  return t;
}

const MESSAGE = {
  messageId: "m1",
  from: "Ada <ada@example.com>",
  subject: "Hello",
  bodyText: "the body",
  trusted: false,
  auth: { spf: "pass" },
  attachments: [{ filename: "note.txt", mime: "text/plain", size: 3 }],
};

describe("message-derived fields", () => {
  it("marks them on mailbox_get and keeps the message fields", async () => {
    const client: any = { get: async () => ({ message: MESSAGE, identityScope: { kind: "estate" } }) };
    const out: any = await tool("mailbox_get").handler(client, { message_id: "m1" });
    expect(out.found).toBe(true);
    expect(out.message.subject).toBe("Hello");
    expect(out.message.bodyText).toBe("the body");
    expect(out.message.trusted).toBe(false);
    expect(typeof out.contentNotice).toBe("string");
    expect(out.contentNotice.length).toBeGreaterThan(20);
    expect(out.untrustedFields).toEqual([
      "messageId",
      "date",
      "subject",
      "from",
      "sender",
      "to",
      "cc",
      "bcc",
      "replyTo",
      "inReplyTo",
      "deliveredTo",
      "bodyText",
      "bodyHtml",
      "attachments.filename",
      "attachments.mime",
    ]);
  });

  it("marks a list, a search page, and a thread the same way", async () => {
    const listClient: any = { list: async () => ({ items: [MESSAGE], cursor: null }) };
    const listed: any = await tool("mailbox_list").handler(listClient, {});
    expect(listed.messages[0].subject).toBe("Hello");
    expect(listed.contentNotice).toBeTruthy();
    expect(listed.untrustedFields).toContain("subject");

    const searchClient: any = {
      search: async () => ({ items: [{ message: MESSAGE }], cursor: null }),
    };
    const found: any = await tool("mailbox_search").handler(searchClient, { query: "hello" });
    expect(found.results[0].message.subject).toBe("Hello");
    expect(found.contentNotice).toBeTruthy();

    const threadClient: any = { thread: async () => ({ items: [MESSAGE], cursor: null }) };
    const thread: any = await tool("mailbox_thread").handler(threadClient, { thread_id: "t1" });
    expect(thread.messages[0].bodyText).toBe("the body");
    expect(thread.contentNotice).toBe(listed.contentNotice);
    expect(thread.untrustedFields).toEqual(listed.untrustedFields);
  });

  it("documents the mark, and what trusted and auth mean, on the read tools and in the README", () => {
    for (const name of ["mailbox_get", "mailbox_list", "mailbox_search", "mailbox_thread"]) {
      const description = tool(name).description;
      expect(description).toMatch(/untrustedFields/);
      expect(description).toMatch(/trusted/);
      expect(description).toMatch(/\bauth\b/);
    }
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/untrustedFields/);
    expect(readme).toMatch(/trusted/);
    expect(readme).toMatch(/\bauth\b/);
    for (const text of [tool("mailbox_get").description, readme]) {
      expect(text).toMatch(/allowlist/);
      expect(text).toMatch(/aligned DMARC or aligned DKIM/);
      expect(text).toMatch(/Even when trusted is true/);
      expect(text).toMatch(/still sender-written/);
    }
  });

  it("marks filename, mimeType, and content on mailbox_get_attachment", async () => {
    const client: any = {
      get: async () => ({
        message: { attachments: [{ filename: "note.txt", mime: "text/plain", size: 4 }] },
      }),
      getAttachmentBytes: async () => ({ base64: "YQ==", contentType: "text/plain", size: 1 }),
    };
    const out: any = await tool("mailbox_get_attachment").handler(client, { message_id: "m1", index: 0 });
    expect(out.filename).toBe("note.txt");
    expect(out.content).toBe("YQ==");
    expect(out.untrustedFields).toEqual(["filename", "mimeType", "content"]);
    expect(out.contentNotice).toMatch(/untrustedFields/);
    expect(tool("mailbox_get_attachment").description).toMatch(/untrustedFields/);
    expect(tool("mailbox_get_attachment").description).toMatch(/filename, mimeType, and content/);
  });
});

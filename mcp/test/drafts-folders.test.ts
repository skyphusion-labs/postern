// #644: the folders rail and the draft surface at the MCP seam.
//
// The contract arms in worker-contract.test.ts already prove these tools emit only what the
// worker declares and that every declared parameter changes the request. What they cannot see
// is what a caller LEARNS from a refusal, and that is the whole reason these tools are shaped
// the way they are: the draft routes are identity-owned, so a static operator token is refused,
// and an agent that cannot tell "refused" from "empty" reports the wrong thing to its user.
//
// So each case here asserts the SHAPE OF THE ANSWER on a known server response, and the
// negative cases are paired with the positive one on the same tool, because "returned an error"
// is also what a completely broken tool returns.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosternClient } from "../src/client.js";
import { READ_TOOLS, SEND_TOOLS } from "../src/tools.js";

function mockFetch(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
) {
  const calls: { url: string; init: any }[] = [];
  const status = init.status ?? 200;
  const fn = vi.fn(async (url: string, reqInit: any) => {
    calls.push({ url, init: reqInit });
    return {
      ok: init.ok ?? status < 400,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new PosternClient("https://api.example", "tok-123");
const readTool = (name: string) => READ_TOOLS.find((t) => t.name === name)!;
const sendTool = (name: string) => SEND_TOOLS.find((t) => t.name === name)!;

const FOLDERS = [
  { id: "inbox", label: "Inbox", count: 9, unread: 2, uidValidity: 1 },
  { id: "role:abuse@skyphusion.org", label: "Abuse", count: 3, unread: 3, role: "abuse@skyphusion.org" },
];

describe("mailbox_folders", () => {
  it("GETs /api/folders, forwards `to`, and passes the projection through", async () => {
    const calls = mockFetch({ ok: true, folders: FOLDERS });
    const out = (await readTool("mailbox_folders").handler(client(), {
      to: "conrad@skyphusion.org",
    })) as { count: number; folders: typeof FOLDERS };

    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/api/folders");
    expect(u.searchParams.get("to")).toBe("conrad@skyphusion.org");
    expect(out.count).toBe(2);
    // The role entry keeps its `role` field, which is the ONLY signal that an entry is a
    // shared queue. Dropping it would force a caller to parse the id, which is exactly what
    // the worker's contract says never to do.
    expect(out.folders[1].role).toBe("abuse@skyphusion.org");
  });

  it("omits `to` entirely when it was not asked for, rather than sending an empty one", async () => {
    const calls = mockFetch({ ok: true, folders: [] });
    await readTool("mailbox_folders").handler(client(), {});
    expect(new URL(calls[0].url).searchParams.has("to")).toBe(false);
  });
});

describe("the draft surface refuses honestly", () => {
  // The positive control for both refusals below: on a normal response the tool answers with
  // the draft, so an error result means refused and not merely broken.
  it("CONTROL: a draft read returns the draft on a 200", async () => {
    mockFetch({ ok: true, draft: { id: "d1", subject: "hello", updatedAt: "2026-01-01T00:00:00.000Z" } });
    const out = (await sendTool("mailbox_draft_get").handler(client(), { draft_id: "d1" })) as {
      found: boolean;
      draft: { id: string };
    };
    expect(out.found).toBe(true);
    expect(out.draft.id).toBe("d1");
  });

  it("E_IDENTITY_REQUIRED reaches the caller verbatim, NOT as an empty list", async () => {
    mockFetch(
      { ok: false, error: "E_IDENTITY_REQUIRED", message: "drafts require a bound identity" },
      { status: 403 },
    );
    // A static operator token holding `send` still cannot own a draft. The tool must say that
    // out loud: an empty `drafts: []` would read as "you have no drafts", which is a different
    // and wrong fact, and the caller would stop instead of fixing its credential.
    await expect(sendTool("mailbox_drafts_list").handler(client(), {})).rejects.toThrow(
      /drafts require a bound identity/,
    );
  });

  it("a stale updatedAt surfaces E_CONFLICT, not a bare HTTP 409", async () => {
    mockFetch({ ok: false, error: "E_CONFLICT" }, { status: 409 });
    // Before #644 this fell through to the generic non-2xx arm and arrived as
    // "Postern API error (HTTP 409)", which does not tell an agent that the answer is to
    // re-read the draft and retry. The error code is the actionable part.
    await expect(
      sendTool("mailbox_draft_update").handler(client(), {
        draft_id: "d1",
        updated_at: "2020-01-01T00:00:00.000Z",
        subject: "s",
      }),
    ).rejects.toThrow(/E_CONFLICT/);
  });

  it("a missing draft is found:false, and a missing DELETE is deleted:false, not an error", async () => {
    mockFetch({ ok: false, error: "E_NOT_FOUND" }, { status: 404 });
    const got = (await sendTool("mailbox_draft_get").handler(client(), { draft_id: "gone" })) as {
      found: boolean;
    };
    expect(got.found).toBe(false);

    mockFetch({ ok: false, error: "E_NOT_FOUND" }, { status: 404 });
    const del = (await sendTool("mailbox_draft_delete").handler(client(), { draft_id: "gone" })) as {
      deleted: boolean;
    };
    expect(del.deleted).toBe(false);
  });
});

describe("a draft write sends only what the caller supplied", () => {
  // The worker reads an ABSENT key as a CLEARED field, so what these tools do NOT send is as
  // load-bearing as what they do, and asserting the body's KEY SET is the only way to see it.
  //
  // Be exact about what this can and cannot catch, because the obvious reading is wrong.
  // Sending an unsupplied field as `undefined` cannot blank anything: JSON.stringify omits
  // an undefined value, so the key never reaches the wire and no assertion here can go red on
  // it. I measured that rather than assuming it. What IS reachable, and what these cases do
  // gate, is a mapper that DEFAULTS an unsupplied field (`?? null` or `?? ""`), because that
  // serializes and the worker would read it as a clear, and a mapper that sends a field under
  // the wrong wire name.
  it("update sends exactly the supplied fields plus updatedAt, and nothing else", async () => {
    const calls = mockFetch({ ok: true, draft: { id: "d1" } });
    await sendTool("mailbox_draft_update").handler(client(), {
      draft_id: "d1",
      updated_at: "2026-01-01T00:00:00.000Z",
      subject: "new subject",
      body_text: "new body",
    });

    expect(calls[0].init.method).toBe("PUT");
    expect(new URL(calls[0].url).pathname).toBe("/api/drafts/d1");
    expect(Object.keys(JSON.parse(calls[0].init.body)).sort()).toEqual(
      ["bodyText", "subject", "updatedAt"],
    );
  });

  it("create maps every snake_case argument to its wire name", async () => {
    const calls = mockFetch({ ok: true, draft: { id: "d2" } });
    await sendTool("mailbox_draft_create").handler(client(), {
      to: "a@x.com",
      subject: "s",
      body_text: "t",
      body_html: "<p>t</p>",
      in_reply_to: "<p@x.com>",
      thread_id: "t1",
      compose_mode: "reply",
      source_message_id: "m1",
    });

    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      to: "a@x.com",
      subject: "s",
      bodyText: "t",
      bodyHtml: "<p>t</p>",
      inReplyTo: "<p@x.com>",
      threadId: "t1",
      composeMode: "reply",
      sourceMessageId: "m1",
    });
  });

  it("send POSTs the /send child of the draft and reports the sent ids", async () => {
    const calls = mockFetch({ ok: true, messageId: "m9", threadId: "t9" });
    const out = (await sendTool("mailbox_draft_send").handler(client(), { draft_id: "d1" })) as {
      sent: boolean;
      messageId: string;
      draftId: string;
    };
    expect(calls[0].init.method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/api/drafts/d1/send");
    expect(out.sent).toBe(true);
    expect(out.messageId).toBe("m9");
    expect(out.draftId).toBe("d1");
  });
});

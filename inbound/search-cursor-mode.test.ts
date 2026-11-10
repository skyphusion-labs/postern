// #803 (#632 S3): a cursor on semantic or hybrid used to be accepted and then
// never read, so the caller was told a page continued when the same first page
// came back. Those modes are score-ranked and have no keyset, so the honest
// answer is the existing validation error. fts and substr still page on the
// same cursor.
import { describe, expect, it } from "vitest";
import { makeFakeEnv } from "./fakes";
import { handleApi } from "./src/api";
import * as store from "./src/store";

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function auth(env: Env): HeadersInit {
  return { authorization: `Bearer ${(env as Env & { POSTERN_API_TOKEN: string }).POSTERN_API_TOKEN}` };
}

function req(env: Env, path: string): Request {
  return new Request(`https://postern.example${path}`, { headers: auth(env) });
}

async function seed(env: Env, ctx: ExecutionContext): Promise<void> {
  // Newest first on the (date, id) keyset: new, then mid, then old. The word
  // "invoice" is a whole token, so fts and substr (default field=text) match
  // the same three rows in the same order.
  const rows: Array<[string, string]> = [
    ["old@x", "2026-01-01T00:00:00.000Z"],
    ["mid@x", "2026-02-01T00:00:00.000Z"],
    ["new@x", "2026-03-01T00:00:00.000Z"],
  ];
  for (const [id, date] of rows) {
    await store.put(
      env,
      {
        messageId: id,
        direction: "inbound",
        from: "a@example.com",
        to: "b@example.com",
        subject: "invoice",
        date,
        bodyText: "please pay invoice",
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
        trusted: true,
      },
      ctx,
    );
  }
}

async function hitId(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ message: { messageId: string } }> };
  expect(body.items).toHaveLength(1);
  return body.items[0].message.messageId;
}

describe("search cursor on score-ranked modes is refused (#803)", () => {
  it("replays an fts cursor: hybrid and semantic are 400, fts and substr still page", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    await seed(env, ctx);
    await settle();

    const first = await handleApi(req(env, "/api/search?q=invoice&mode=fts&limit=1"), env, ctx);
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      items: Array<{ message: { messageId: string } }>;
      cursor: string | null;
    };
    expect(page1.items[0].message.messageId).toBe("new@x");
    expect(page1.cursor, "no cursor: the replay would be vacuous").toBeTruthy();
    const cursor = encodeURIComponent(page1.cursor as string);

    for (const mode of ["hybrid", "semantic"] as const) {
      const res = await handleApi(
        req(env, `/api/search?q=invoice&mode=${mode}&limit=1&cursor=${cursor}`),
        env,
        ctx,
      );
      expect(res.status, mode).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string; message: string; items?: unknown };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("E_VALIDATION_ERROR");
      expect(body.message).toBe(store.SCORE_RANKED_CURSOR_MESSAGE);
      expect(body.items, "a refusal must not look like a page").toBeUndefined();
    }

    // Negative controls. The same cursor, on the modes that page. Dropping it
    // would repeat new@x, which is the bug this refusal exists to stop.
    const fts = await handleApi(
      req(env, `/api/search?q=invoice&mode=fts&limit=1&cursor=${cursor}`),
      env,
      ctx,
    );
    expect(await hitId(fts)).toBe("mid@x");

    const omitted = await handleApi(
      req(env, `/api/search?q=invoice&limit=1&cursor=${cursor}`),
      env,
      ctx,
    );
    expect(await hitId(omitted), "omitted mode is fts and still pages").toBe("mid@x");

    const substr = await handleApi(
      req(env, `/api/search?q=invoice&mode=substr&limit=1&cursor=${cursor}`),
      env,
      ctx,
    );
    expect(await hitId(substr)).toBe("mid@x");
  });

  it("store.search refuses the same combination, so the RPC door cannot drop it", async () => {
    const { env } = makeFakeEnv();
    for (const mode of ["hybrid", "semantic"] as const) {
      await expect(
        store.search(env, { q: "invoice", mode, cursor: "from-an-fts-page" }),
      ).rejects.toMatchObject({
        name: "SearchCursorRefused",
        code: "E_VALIDATION_ERROR",
        message: store.SCORE_RANKED_CURSOR_MESSAGE,
      });
    }
  });
});

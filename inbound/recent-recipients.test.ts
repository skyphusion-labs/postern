// #805: recent correspondents are an aggregate over outbound headers, and the
// aggregate has to say what it actually measured. address and lastUsedAt were
// already produced. displayName and messageCount were not, so a caller that
// wanted "who, named what, seen when, how often" had to guess. scanLimited is
// the same honesty rule as `complete` on a search page: the scan stops at 200
// outbound rows, and a count that quietly ignores everything older is a lie.
import { describe, expect, it } from "vitest";
import { makeFakeEnv } from "./fakes";
import { handleApi } from "./src/api";
import * as store from "./src/store";

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ALICE = "alice@skyphusion.org";

function auth(env: Env): HeadersInit {
  return { authorization: `Bearer ${(env as Env & { POSTERN_API_TOKEN: string }).POSTERN_API_TOKEN}` };
}

async function putOut(
  env: Env,
  ctx: ExecutionContext,
  row: { id: string; to: string; cc?: string; bcc?: string; date: string; direction?: "inbound" | "outbound"; from?: string },
) {
  await store.put(
    env,
    {
      messageId: row.id,
      direction: row.direction ?? "outbound",
      from: row.from ?? ALICE,
      to: row.to,
      cc: row.cc,
      bcc: row.bcc,
      subject: "hi",
      date: row.date,
      bodyText: "hello",
      auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      trusted: true,
    },
    ctx,
  );
}

interface Recipient {
  address: string;
  displayName: string | null;
  lastUsedAt: string;
  messageCount: number;
}

describe("recent correspondents (#805)", () => {
  it("returns address, display name, last use, and a per-address message count", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    // Newest first in the scan. Bob is named twice in this one message (to and cc)
    // and that is still ONE message. Dana carries a quoted display name.
    await putOut(env, ctx, {
      id: "new@x",
      date: "2026-06-18T12:00:00Z",
      to: "bob@example.com",
      cc: "bob@example.com, \"Dana Q\" <dana@example.com>",
      bcc: ALICE,
    });
    // Older message is where Bob's display name lives. A bare later header must
    // not wipe it, and it must not move lastUsedAt off the newer message.
    await putOut(env, ctx, {
      id: "old@x",
      date: "2026-06-01T12:00:00Z",
      to: "Bob Example <bob@example.com>",
      cc: "carol@example.com",
    });
    // Inbound mail to Alice is not a correspondent of Alice's outbound mail.
    await putOut(env, ctx, {
      id: "in@x",
      date: "2026-06-20T12:00:00Z",
      direction: "inbound",
      from: "spy@example.com",
      to: ALICE,
    });
    await settle();

    const res = await handleApi(
      new Request(`https://x/api/recipients/recent?viewer=${ALICE}`, { headers: auth(env) }),
      env,
      CTX,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { recipients: Recipient[]; scanLimited?: boolean };
    expect(body.scanLimited, "two messages are inside the scan, so the cap must not be claimed").toBeUndefined();
    expect(body.recipients).toEqual([
      { address: "bob@example.com", displayName: "Bob Example", lastUsedAt: "2026-06-18T12:00:00Z", messageCount: 2 },
      { address: "dana@example.com", displayName: "Dana Q", lastUsedAt: "2026-06-18T12:00:00Z", messageCount: 1 },
      { address: "carol@example.com", displayName: null, lastUsedAt: "2026-06-01T12:00:00Z", messageCount: 1 },
    ]);
  });

  it("sets scanLimited when the 200-row scan dropped older mail, and does not count that mail", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    // Index 0 is the newest. Index 200 is the one past the scan. The duplicate
    // sits inside the window so its count is measurable without the dropped row.
    await putOut(env, ctx, {
      id: "dup-a@x",
      date: "2026-06-18T00:00:00Z",
      to: "dup@example.com",
    });
    await putOut(env, ctx, {
      id: "dup-b@x",
      date: "2026-06-17T00:00:00Z",
      to: "Dup Person <dup@example.com>",
    });
    for (let i = 0; i < 198; i++) {
      await putOut(env, ctx, {
        id: `mid-${i}@x`,
        date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:${String(i % 60).padStart(2, "0")}Z`,
        to: `mid-${i}@example.com`,
      });
    }
    await putOut(env, ctx, {
      id: "oldest@x",
      date: "2020-01-01T00:00:00Z",
      to: "Oldest Person <oldest@example.com>",
    });
    await settle();

    const res = await handleApi(
      new Request(`https://x/api/recipients/recent?viewer=${ALICE}&limit=50`, { headers: auth(env) }),
      env,
      CTX,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { recipients: Recipient[]; scanLimited?: boolean };
    const addresses = body.recipients.map((r) => r.address);
    expect(body.scanLimited).toBe(true);
    expect(addresses).not.toContain("oldest@example.com");
    const dup = body.recipients.find((r) => r.address === "dup@example.com");
    expect(dup).toEqual({
      address: "dup@example.com",
      displayName: "Dup Person",
      lastUsedAt: "2026-06-18T00:00:00Z",
      messageCount: 2,
    });
  });
});

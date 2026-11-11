import { describe, it, expect } from "vitest";
import { ingest } from "./src/ingest";
import { send } from "./src/mailbox";
import * as store from "./src/store";
import { realEnv } from "./realdb";

// "Authored by V" means a message postern SENT as V: direction 'outbound' and from_addr
// equal to V. An inbound message whose From header names V is not authored by V; V
// reaches it only by being on its delivered set. The SQL read paths (get, list, fts,
// folders) and the JS mirror used by semantic search must agree on this.

const ALICE = "alice@skyphusion.org";
const BOB = "bob@skyphusion.org";

async function fixture() {
  const { env, ctx } = realEnv();
  (env as unknown as { EMAIL: unknown }).EMAIL = { send: async () => ({ messageId: "p" }) };
  const ids: Record<string, string> = {};
  ids.bareFrom = (await ingest(env, { messageId: "bare@example.net", from: ALICE, to: BOB, subject: "a", text: "fixture word one" }, ctx)).messageId;
  ids.namedFrom = (await ingest(env, { messageId: "named@example.net", from: `"Alice" <${ALICE}>`, to: BOB, subject: "b", text: "fixture word two" }, ctx)).messageId;
  ids.toAlice = (await ingest(env, { messageId: "to-alice@example.net", from: "ext@example.net", to: ALICE, subject: "c", text: "fixture word three" }, ctx)).messageId;
  ids.sentToBob = (await send(env, { to: BOB, from: ALICE, subject: "d", text: "fixture word four" }, ctx, undefined, "estate")).messageId;
  ids.sentOut = (await send(env, { to: "ext@example.net", from: ALICE, subject: "e", text: "fixture word five" }, ctx, undefined, "estate")).messageId;
  const all = Object.values(ids);
  (env as unknown as { AI: unknown }).AI = { run: async () => ({ data: [[0.1, 0.2]] }) };
  (env as unknown as { VECTORIZE: unknown }).VECTORIZE = {
    query: async () => ({ matches: all.map((id, i) => ({ id: `v${i}`, score: 0.9 - i / 100, metadata: { message_id: id } })) }),
  };
  return { env, ids };
}
const sorted = (xs: string[]) => [...xs].sort();

describe("authored by V means sent by postern as V", () => {
  it("get: the From header alone gives no read", async () => {
    const { env, ids } = await fixture();
    expect(await store.get(env, ids.bareFrom, [ALICE])).toBeNull();
    expect(await store.get(env, ids.namedFrom, [ALICE])).toBeNull();
    // Controls: the recipient reads both; the author reads what she sent.
    expect(await store.get(env, ids.bareFrom, [BOB])).not.toBeNull();
    expect(await store.get(env, ids.sentToBob, [ALICE])).not.toBeNull();
    expect(await store.get(env, ids.sentOut, [ALICE])).not.toBeNull();
    expect(await store.get(env, ids.sentToBob, [BOB])).not.toBeNull();
  });

  it("Sent holds only what was sent, on the account and token paths", async () => {
    const { env, ids } = await fixture();
    const want = sorted([ids.sentToBob, ids.sentOut]);
    expect(sorted((await store.list(env, { viewer: ALICE, lens: "sent" })).items.map((m) => m.messageId))).toEqual(want);
    expect(sorted((await store.list(env, { to: ALICE, lens: "sent" })).items.map((m) => m.messageId))).toEqual(want);
    expect((await store.list(env, { viewer: BOB, lens: "sent" })).items).toEqual([]);
  });

  it("the account view holds what was delivered to or sent by V", async () => {
    const { env, ids } = await fixture();
    expect(sorted((await store.list(env, { viewer: ALICE })).items.map((m) => m.messageId)))
      .toEqual(sorted([ids.toAlice, ids.sentToBob, ids.sentOut]));
  });

  it("the folder rail counts the same Sent", async () => {
    const { env } = await fixture();
    const rail = await store.folders(env, ALICE);
    expect(rail.find((f) => f.id === "sent")?.count).toBe(2);
    expect(rail.find((f) => f.id === "all")?.count).toBe(3);
  });

  it("full-text search gives no hit through the From header alone", async () => {
    const { env, ids } = await fixture();
    const hits = (await store.search(env, { q: "fixture", mode: "fts", viewer: ALICE })).items.map((h) => h.message.messageId);
    expect(sorted(hits)).toEqual(sorted([ids.toAlice, ids.sentToBob, ids.sentOut]));
  });
});

describe("semantic search scope matches the SQL scope", () => {
  const lenses = [undefined, "inbox", "sent"] as const;
  for (const viewer of [ALICE, BOB]) {
    for (const lens of lenses) {
      for (const path of ["viewer", "to"] as const) {
        it(`${path}=${viewer.split("@")[0]} lens=${lens ?? "none"}`, async () => {
          const { env } = await fixture();
          const scope = path === "viewer" ? { viewer } : { to: viewer };
          const sql = (await store.list(env, { ...scope, ...(lens ? { lens } : {}) })).items.map((m) => m.messageId);
          const sem = (await store.search(env, { q: "fixture", mode: "semantic", ...scope, ...(lens ? { lens } : {}) })).items.map((h) => h.message.messageId);
          expect(sorted(sem)).toEqual(sorted(sql));
        });
      }
    }
  }
});

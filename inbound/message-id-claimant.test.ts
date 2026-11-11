import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ingest, type ParsedInbound } from "./src/ingest";
import * as store from "./src/store";
import { realEnv } from "./realdb";

// A Message-ID is held by the first message stored under it (CONTRACT 10.x). A later,
// different message with the same id is stored under a derived id and records the id
// it arrived with in claimed_id. Thread resolution then prefers a trusted message for
// an id: the holder when it is trusted, else a trusted claimant, else the holder.

const ID = "acme/widgets/issues/7@github.com";
const env0 = () => realEnv({ TRUSTED_SENDER_DOMAINS: "github.com" });
const authed = { spf: "pass", dkim: "pass", dmarc: "pass", dkimDomains: ["github.com"], dmarcFrom: "github.com" };
const mail = (over: Partial<ParsedInbound> & { trusted?: boolean } = {}): ParsedInbound => {
  const { trusted = true, ...rest } = over;
  return {
    messageId: ID, from: "GitHub <notifications@github.com>", to: "agent@skyphusion.org",
    subject: "[acme/widgets] Issue 7", text: "issue body",
    ...(trusted ? { auth: authed } : {}), ...rest,
  };
};
const claimedId = (raw: DatabaseSync, messageId: string) =>
  (raw.prepare("SELECT claimed_id FROM messages WHERE message_id = ?").get(messageId) as { claimed_id: string | null } | undefined)?.claimed_id;
const trustedOf = (raw: DatabaseSync, messageId: string) =>
  (raw.prepare("SELECT trusted FROM messages WHERE message_id = ?").get(messageId) as { trusted: number } | undefined)?.trusted;

describe("Message-ID claimants", () => {
  it("control: a trusted message alone holds its id, and replies thread to it", async () => {
    const { env, ctx, raw } = env0();
    const r = await ingest(env, mail(), ctx);
    expect(r.messageId).toBe(ID);
    expect(trustedOf(raw, ID)).toBe(1);
    expect(claimedId(raw, ID)).toBeNull();
    const reply = await ingest(env, mail({ messageId: "c1@github.com", inReplyTo: `<${ID}>`, text: "comment" }), ctx);
    expect(reply.threadId).toBe(ID);
  });

  it("an untrusted holder: the trusted message records its claim and replies thread to it", async () => {
    const { env, ctx, raw } = env0();
    await ingest(env, mail({ trusted: false, subject: "other", text: "other body" }), ctx);
    const r = await ingest(env, mail(), ctx);
    expect(r.messageId).not.toBe(ID);
    // The by-id read is unchanged: the id belongs to the first message stored under it.
    expect((await store.getUnscoped(env, ID))?.subject).toBe("other");
    const viaIrt = await ingest(env, mail({ messageId: "c2@github.com", inReplyTo: `<${ID}>`, text: "comment" }), ctx);
    expect(viaIrt.threadId).toBe(r.threadId);
    const viaRefs = await ingest(env, mail({ messageId: "c3@github.com", references: [ID], text: "comment 2" }), ctx);
    expect(viaRefs.threadId).toBe(r.threadId);
    expect(claimedId(raw, r.messageId)).toBe(ID);
    expect(trustedOf(raw, r.messageId)).toBe(1);
  });

  it("a trusted holder keeps the thread when an untrusted message later claims the id", async () => {
    const { env, ctx, raw } = env0();
    await ingest(env, mail(), ctx);
    const late = await ingest(env, mail({ trusted: false, subject: "other", text: "other body" }), ctx);
    expect(claimedId(raw, late.messageId)).toBe(ID);
    const reply = await ingest(env, mail({ messageId: "c4@github.com", inReplyTo: `<${ID}>`, text: "comment" }), ctx);
    expect(reply.threadId).toBe(ID);
  });

  it("two trusted messages: replies thread to the holder", async () => {
    const { env, ctx, raw } = env0();
    await ingest(env, mail(), ctx);
    const second = await ingest(env, mail({ subject: "[acme/widgets] Issue 7 (edited)", text: "edited body" }), ctx);
    expect(claimedId(raw, second.messageId)).toBe(ID);
    expect(trustedOf(raw, second.messageId)).toBe(1);
    const reply = await ingest(env, mail({ messageId: "c6@github.com", inReplyTo: `<${ID}>`, text: "comment" }), ctx);
    expect(reply.threadId).toBe(ID);
  });

  it("two untrusted messages: replies thread to the holder, as before", async () => {
    const { env, ctx } = env0();
    await ingest(env, mail({ trusted: false }), ctx);
    await ingest(env, mail({ trusted: false, subject: "other", text: "other body" }), ctx);
    const reply = await ingest(env, mail({ trusted: false, messageId: "c5@example.net", inReplyTo: `<${ID}>`, text: "x" }), ctx);
    expect(reply.threadId).toBe(ID);
  });

  it("a redelivery of the trusted claimant is a dedup, not a third row", async () => {
    const { env, ctx, raw } = env0();
    await ingest(env, mail({ trusted: false, subject: "other", text: "other body" }), ctx);
    const a = await ingest(env, mail(), ctx);
    const b = await ingest(env, mail(), ctx);
    expect(b.messageId).toBe(a.messageId);
    expect(b.stored).toBe(false);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE message_id = ? OR claimed_id = ?").get(ID, ID) as { n: number }).n).toBe(2);
  });

  it("the thread lookup is still one query, within D1's 100 bound values", async () => {
    const { env, ctx } = env0();
    const db = env.DB as unknown as { prepare: (sql: string) => { bind: (...v: unknown[]) => unknown } };
    const orig = db.prepare.bind(db);
    let lookups = 0;
    let bound = 0;
    db.prepare = (sql: string) => {
      const stmt = orig(sql);
      if (!/thread_id[\s\S]*FROM messages WHERE message_id IN/.test(sql)) return stmt;
      lookups++;
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...v: unknown[]) => { bound = v.length; return bind(...v); };
      return stmt;
    };
    const refs = Array.from({ length: 2000 }, (_, i) => `r${i}é@example.net`);
    await ingest(env, mail({ messageId: "big@github.com", inReplyTo: "irté@example.net", references: refs, text: "x" }), ctx);
    expect(lookups).toBe(1);
    expect(bound).toBe(2 * 2 * (1 + store.MAX_THREAD_REFERENCES));
    expect(bound).toBeLessThanOrEqual(100);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));

describe("migration 0018 matches schema.sql", () => {
  const MIGRATION = readFileSync(join(HERE, "migrations", "0018_claimed_id.sql"), "utf8");
  const SCHEMA = readFileSync(join(HERE, "schema.sql"), "utf8");
  // The schema before 0018: the same file without the claimed_id column and its index.
  const BEFORE = SCHEMA.replace(/,\n(?:\s*--[^\n]*\n)*\s*claimed_id\s+TEXT\n\);/, "\n);").replace(/^CREATE INDEX IF NOT EXISTS idx_claimed_id[^\n]*\n/m, "");
  const shape = (db: DatabaseSync) => [
    db.prepare("PRAGMA table_info(messages)").all(),
    db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'messages' AND type = 'index' ORDER BY name").all(),
  ];

  it("the pre-0018 schema differs, so this comparison can fail", () => {
    expect(BEFORE).not.toBe(SCHEMA);
    const before = new DatabaseSync(":memory:");
    before.exec(BEFORE);
    const sch = new DatabaseSync(":memory:");
    sch.exec(SCHEMA);
    expect(shape(before)).not.toEqual(shape(sch));
  });

  it("applied to the pre-0018 schema yields the column and index schema.sql declares", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(BEFORE);
    db.exec(MIGRATION);
    const sch = new DatabaseSync(":memory:");
    sch.exec(SCHEMA);
    expect(shape(db)).toEqual(shape(sch));
  });
});

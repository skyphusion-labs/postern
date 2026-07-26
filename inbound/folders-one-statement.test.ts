// #477: GET /api/folders cost ~2.2s p50 in production, an order of magnitude above every
// other read the IMAP door makes, with a max/p50 of 1.21 over 80 samples -- a fixed
// amount of work, not jitter. The work was fifteen D1 statements per call (one aggregate
// scan of `messages` per folder, one more per role queue, a drafts count, and an
// INSERT-then-SELECT UID-counter init for each of the four durable folders), every one of
// them awaited in series, so the route paid a network round trip fifteen times over. It
// is now ONE statement.
//
// A perf change to a counting query is only safe if the counts do not move, so this suite
// carries the PRE-#477 algorithm as an oracle -- the per-folder SQL exactly as it was
// written, run against the same real SQLite engine -- and asserts the new single-statement
// answer equals it, entry for entry, over a store seeded with every shape that separates
// the predicates: durable-box placement, a same-domain send (in the recipient INBOX and
// the sender Sent at once), a per-recipient seen override that disagrees with the
// row-level flag, mail addressed only to a role queue, and drafts.
//
// The cost claim is asserted too, not just described: a recording proxy over
// env.DB.prepare counts the statements the route actually issues. Without that, the
// answer tests would pass just as happily against the fifteen-statement version, which is
// the whole defect.
import { describe, it, expect } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import type { FolderSummary } from "./src/store";
import { realEnv, putInbound, putOutbound } from "./realdb";

const VIEWER = "conrad@skyphusion.org";
const OTHER = "ada@skyphusion.org";
const ROLE_A = "alerts@skyphusion.org";
const ROLE_B = "support@skyphusion.org";
const TOKEN = "test-token";

/** Records every statement the code under test prepares, so the cost of a route is a
 *  fact the suite can assert instead of a claim in a commit message. */
function recording(env: Env): string[] {
  const calls: string[] = [];
  const inner = (env.DB as { prepare(sql: string): unknown }).prepare.bind(env.DB);
  (env.DB as { prepare(sql: string): unknown }).prepare = (sql: string) => {
    calls.push(sql);
    return inner(sql);
  };
  return calls;
}

// ---------------------------------------------------------------------------
// The oracle: store.folders() as it was BEFORE #477, transcribed. One statement per
// folder, the effective-seen flag as a correlated subquery, the drafts count separate,
// and the UIDVALIDITY read per durable folder.
// ---------------------------------------------------------------------------
function oldFolders(db: DatabaseSync, viewer?: string, roles: readonly string[] = []): FolderSummary[] {
  const identity = viewer?.trim().toLowerCase() || undefined;
  const access = identity
    ? "(COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE '%,' || ? || ',%' OR lower(m.from_addr) = ?)"
    : "1=1";
  const seenExpr = identity
    ? "COALESCE((SELECT sb.seen FROM message_seen_by sb WHERE sb.message_id = m.message_id AND sb.recipient = ?), m.seen)"
    : "m.seen";
  const seenBinds: unknown[] = identity ? [identity] : [];
  const definitions: Array<[FolderSummary["id"], string, string]> = [
    ["inbox", "Inbox", identity
      ? "m.mailbox IS NULL AND " + access +
        " AND (m.direction='inbound' OR (m.direction='outbound' AND lower(m.from_addr) <> ?))"
      : "m.mailbox IS NULL AND m.direction='inbound'"],
    ["sent", "Sent", identity
      ? "m.mailbox IS NULL AND lower(m.from_addr) = ?"
      : "m.mailbox IS NULL AND m.direction='outbound'"],
    ["all", "All", access],
    ["trash", "Trash", `m.mailbox='trash' AND ${access}`],
    ["junk", "Junk", `m.mailbox='junk' AND ${access}`],
    ["archive", "Archive", `m.mailbox='archive' AND ${access}`],
  ];
  const uidvalidity = (folder: string): number | undefined => {
    const row = db.prepare("SELECT uidvalidity FROM mailbox_uid_counter WHERE folder = ?").get(folder) as
      | { uidvalidity: number }
      | undefined;
    return row?.uidvalidity;
  };
  const result: FolderSummary[] = [];
  for (const [id, label, predicate] of definitions) {
    const binds: unknown[] = [];
    if (identity) {
      if (id === "sent") binds.push(identity);
      else if (id === "inbox") binds.push(identity, identity, identity);
      else binds.push(identity, identity);
    }
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count, SUM(CASE WHEN ${seenExpr}=0 THEN 1 ELSE 0 END) AS unread ` +
          `FROM messages m WHERE ${predicate}`,
      )
      .get(...([...seenBinds, ...binds] as never[])) as { count: number; unread: number | null };
    const durable = id === "trash" || id === "junk" || id === "archive" ? uidvalidity(id) : undefined;
    result.push({
      id,
      label,
      count: Number(row?.count ?? 0),
      unread: Number(row?.unread ?? 0),
      ...(durable !== undefined ? { uidValidity: durable } : {}),
    });
  }
  const draftRow = identity
    ? (db.prepare("SELECT COUNT(*) AS count FROM drafts WHERE identity = ?").get(identity) as { count: number })
    : { count: 0 };
  result.splice(3, 0, {
    id: "drafts",
    label: "Drafts",
    count: Number(draftRow?.count ?? 0),
    unread: 0,
    uidValidity: uidvalidity("drafts")!,
  });
  for (const raw of identity ? roles : []) {
    const role = raw.trim().toLowerCase();
    if (!role) continue;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count, SUM(CASE WHEN ${seenExpr}=0 THEN 1 ELSE 0 END) AS unread
           FROM messages m
          WHERE m.mailbox IS NULL
            AND COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE '%,' || ? || ',%'
            AND (m.direction='inbound' OR (m.direction='outbound' AND lower(m.from_addr) <> ?))`,
      )
      .get(...([...seenBinds, role, role] as never[])) as { count: number; unread: number | null };
    const at = role.indexOf("@");
    result.push({
      id: `role:${role}`,
      label: at > 0 ? role.slice(0, at) : role,
      role,
      count: Number(row?.count ?? 0),
      unread: Number(row?.unread ?? 0),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// A store with every shape that separates two folder predicates from each other.
// ---------------------------------------------------------------------------
async function seed(env: Env, ctx: ExecutionContext, db: DatabaseSync) {
  // Plain arrivals for the viewer, one already read at the row level.
  await putInbound(env, ctx, { id: "in-1@x", from: "friend@example.com", to: VIEWER, subject: "one" });
  await putInbound(env, ctx, { id: "in-2@x", from: "friend@example.com", to: VIEWER, subject: "two" });
  await putInbound(env, ctx, { id: "in-3@x", from: "friend@example.com", to: VIEWER, subject: "three" });
  await putInbound(env, ctx, { id: "in-5@x", from: "friend@example.com", to: VIEWER, subject: "five" });
  // Arrivals for somebody else: inside All for nobody, inside the estate view.
  await putInbound(env, ctx, { id: "in-4@x", from: "friend@example.com", to: OTHER, subject: "not yours" });
  // Role-queue mail, addressed to the queue and to no person.
  await putInbound(env, ctx, { id: "role-1@x", from: "reporter@example.com", to: ROLE_A, subject: "alert" });
  await putInbound(env, ctx, { id: "role-2@x", from: "reporter@example.com", to: ROLE_A, subject: "alert 2" });
  await putInbound(env, ctx, { id: "role-3@x", from: "asker@example.com", to: ROLE_B, subject: "question" });
  // The viewer's own outbound: Sent for them, and NOT their INBOX.
  await putOutbound(env, ctx, { id: "out-1@x", from: VIEWER, to: ["someone@example.com"], subject: "sent" });
  // A same-domain send: the recipient's INBOX AND the sender's Sent at once.
  await putOutbound(env, ctx, { id: "out-2@x", from: OTHER, to: [VIEWER], subject: "same domain" });
  // An outbound addressed to a role queue: the queue lens must NOT count the queue's own
  // outbound, and must count somebody else's.
  await putOutbound(env, ctx, { id: "out-3@x", from: OTHER, to: [ROLE_A], subject: "to the queue" });

  db.prepare("UPDATE messages SET seen = 1 WHERE message_id = ?").run("in-2@x");
  // Durable placement: one message in each re-populated box.
  db.prepare("UPDATE messages SET mailbox = 'trash', trashed_at = ? WHERE message_id = ?")
    .run("2026-07-26T00:00:00Z", "in-3@x");
  db.prepare("UPDATE messages SET mailbox = 'junk' WHERE message_id = ?").run("in-4@x");
  db.prepare("UPDATE messages SET mailbox = 'archive' WHERE message_id = ?").run("role-3@x");
  // A per-recipient override that DISAGREES with the row flag in both directions, which
  // is the only thing that separates the joined seen projection from a plain m.seen.
  db.prepare("INSERT OR REPLACE INTO message_seen_by (message_id, recipient, seen) VALUES (?, ?, 1)")
    .run("in-1@x", VIEWER);
  // in-5 and in-3 are read for this viewer ONLY through the override, with nothing
  // unread to cancel them out, so a projection that ignored the override (or looked it
  // up under the wrong key) moves the INBOX and Trash unread totals. Checked by
  // mutation: replacing the joined projection with a bare m.seen fails this suite.
  db.prepare("INSERT OR REPLACE INTO message_seen_by (message_id, recipient, seen) VALUES (?, ?, 1)")
    .run("in-5@x", VIEWER);
  db.prepare("INSERT OR REPLACE INTO message_seen_by (message_id, recipient, seen) VALUES (?, ?, 1)")
    .run("in-3@x", VIEWER);
  db.prepare("INSERT OR REPLACE INTO message_seen_by (message_id, recipient, seen) VALUES (?, ?, 0)")
    .run("out-2@x", VIEWER);
  db.prepare("INSERT OR REPLACE INTO message_seen_by (message_id, recipient, seen) VALUES (?, ?, 0)")
    .run("role-1@x", VIEWER);
  // Somebody else's read state, which must never leak into the viewer's unread counts.
  db.prepare("INSERT OR REPLACE INTO message_seen_by (message_id, recipient, seen) VALUES (?, ?, 1)")
    .run("role-2@x", OTHER);
  // Drafts belong to a bound identity, and only that identity counts them.
  for (const [id, owner] of [["d1", VIEWER], ["d2", VIEWER], ["d3", OTHER]]) {
    db.prepare(
      "INSERT INTO drafts (id, identity, subject, uid, created_at, updated_at, compose_mode)" +
        " VALUES (?, ?, ?, 1, ?, ?, 'new')",
    ).run(id, owner, "draft", "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
  }
}

describe("#477 /api/folders is one statement and the same answer", () => {
  it("matches the pre-#477 per-folder algorithm for every viewer shape", async () => {
    const { env, ctx, raw } = realEnv();
    await seed(env, ctx, raw);
    // Mint the UID counters first so the oracle, which only reads them, is comparing
    // against the same values; the mint itself is covered by its own case below.
    await store.folders(env, VIEWER);

    for (const [name, viewer, roles] of [
      ["no viewer (estate lens)", undefined, []],
      ["bound viewer", VIEWER, []],
      ["bound viewer with role queues", VIEWER, [ROLE_A, ROLE_B]],
      ["a viewer with no mail at all", "nobody@skyphusion.org", [ROLE_A]],
      ["role list with an empty entry", VIEWER, ["", ROLE_B]],
    ] as Array<[string, string | undefined, string[]]>) {
      const actual = await store.folders(env, viewer, roles);
      expect(actual, name).toEqual(oldFolders(raw, viewer, roles));
    }
  });

  it("counts what is really there, so an oracle that agreed on zeroes would not pass", async () => {
    const { env, ctx, raw } = realEnv();
    await seed(env, ctx, raw);
    const byId = new Map((await store.folders(env, VIEWER, [ROLE_A, ROLE_B])).map((f) => [f.id, f]));
    // INBOX: in-1, in-2, in-5 (in-3 is in Trash, in-4 is not theirs) plus the
    // same-domain out-2; their own out-1 is Sent-only. Unread is 1: in-1 and in-5 are
    // read by override even though their rows say unread, in-2 is read at the row level,
    // and out-2 is unread by override even though an outbound row is stored read.
    expect(byId.get("inbox")).toMatchObject({ count: 4, unread: 1 });
    expect(byId.get("sent")).toMatchObject({ count: 1 });
    // Trashed and read by override, so the box is non-empty and its unread is zero.
    expect(byId.get("trash")).toMatchObject({ count: 1, unread: 0 });
    expect(byId.get("junk")).toMatchObject({ count: 0 });
    expect(byId.get("archive")).toMatchObject({ count: 0 });
    expect(byId.get("drafts")).toMatchObject({ count: 2, unread: 0 });
    // The queue counts its two arrivals plus the same-domain send TO it (out-3), and the
    // MEMBER's own read state decides unread: role-1 is unread by override, role-2 is
    // read only by OTHER so it stays unread for VIEWER, and out-3 is an outbound copy
    // stored read with no override for VIEWER. Two unread, not three -- if the member key
    // were dropped, OTHER's read of role-2 would leak in and this would read 1.
    expect(byId.get(`role:${ROLE_A}`)).toMatchObject({ count: 3, unread: 2, role: ROLE_A });
    expect(byId.get(`role:${ROLE_B}`)).toMatchObject({ count: 0, unread: 0, role: ROLE_B });
  });

  it("answers an empty estate without a message row to aggregate over", async () => {
    const { env, raw } = realEnv();
    const actual = await store.folders(env, VIEWER, [ROLE_A]);
    expect(actual.every((f) => f.count === 0 && f.unread === 0)).toBe(true);
    // The durable folders still carry a minted UIDVALIDITY: an IMAP client that SELECTs
    // Trash on a brand new estate must get one, and it must be stable.
    for (const id of ["drafts", "trash", "junk", "archive"]) {
      const entry = actual.find((f) => f.id === id)!;
      expect(entry.uidValidity, id).toBeGreaterThan(0);
    }
    expect(actual).toEqual(oldFolders(raw, VIEWER, [ROLE_A]));
    // Stable across calls, which is the property UIDVALIDITY exists to have.
    expect(await store.folders(env, VIEWER, [ROLE_A])).toEqual(actual);
  });

  it("issues ONE statement once the UID counters exist, and mints them exactly once", async () => {
    const { env, ctx, raw } = realEnv();
    await seed(env, ctx, raw);
    const calls = recording(env);

    // Control: the proxy really does record, so a zero below would mean zero.
    await env.DB.prepare("SELECT 1").first();
    expect(calls.length).toBe(1);
    calls.length = 0;

    // First call on a virgin estate: the one aggregate, plus the lazy INSERT+SELECT mint
    // for each of the four durable folders. That mint is once in the life of an estate.
    await store.folders(env, VIEWER, [ROLE_A, ROLE_B]);
    expect(calls.length).toBe(1 + 4 * 2);
    calls.length = 0;

    // Steady state, which is every call production makes: exactly one statement, and no
    // write on the read path.
    await store.folders(env, VIEWER, [ROLE_A, ROLE_B]);
    expect(calls.length).toBe(1);
    expect(calls[0].startsWith("SELECT ")).toBe(true);
    calls.length = 0;

    // The role queues are extra COLUMNS, not extra statements: the statement count does
    // not move with the size of the operator role map. This is the property that made the
    // old shape scale with configuration.
    await store.folders(env, VIEWER, []);
    await store.folders(env, VIEWER, [ROLE_A]);
    await store.folders(env, VIEWER, [ROLE_A, ROLE_B]);
    expect(calls.length).toBe(3);

    // And no viewer at all is still one statement (no seen join, no drafts subquery).
    calls.length = 0;
    await store.folders(env);
    expect(calls.length).toBe(1);
  });

  it("serves the same answer through the real GET /api/folders handler", async () => {
    const { env, ctx, raw } = realEnv();
    await seed(env, ctx, raw);
    await store.folders(env, VIEWER);
    const calls = recording(env);

    const res = await handleApi(
      new Request(`https://postern.example/api/folders?to=${encodeURIComponent(VIEWER)}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; folders: FolderSummary[] };
    expect(body.ok).toBe(true);
    expect(body.folders).toEqual(oldFolders(raw, VIEWER, []));
    // The route itself, end to end, is one statement against the store.
    expect(calls.length).toBe(1);
  });
});

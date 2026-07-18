// Shared in-memory test doubles for the storage + send bindings. The D1 fake
// keeps real rows and supports the prepare/bind/run/first/all surface the store
// uses (including INSERT OR IGNORE dedup, thread-id SELECTs, attachment + thread
// reads), so threading and store-back can be asserted against actual state, not
// a recording of calls.

interface Row {
  id: number;
  message_id: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  date: string;
  in_reply_to: string | null;
  body_text: string;
  body_html: string | null;
  spf: string;
  dkim: string;
  dmarc: string;
  trusted: number;
  received_at: string;
  seen: number;
  direction: string;
  thread_id: string | null;
  delivered_to: string | null;
  cc_addr: string | null;
  bcc_addr: string | null;
  sender_addr: string | null;
  reply_to_addr: string | null;
  wire_size: number | null;
  flagged: number;
  answered: number;
  mailbox: string | null;
  trashed_at: string | null;
}

interface AttRow {
  id: number;
  message_id: string;
  filename: string | null;
  mime: string | null;
  size: number;
  r2_key: string;
  created_at: string;
}

interface LedgerRow {
  vector_id: string;
  message_id: string;
  chunk: number;
  indexed_at: string;
}

// #350 per-recipient read overrides (message_seen_by): sparse, keyed by
// (message_id, recipient); absent = fall back to the row-level messages.seen.
interface SeenByRow {
  message_id: string;
  recipient: string;
  seen: number;
}

interface DraftRow {
  id: string;
  identity: string;
  to_addr: string | null;
  cc_addr: string | null;
  bcc_addr: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  uid: number;
  created_at: string;
  updated_at: string;
}

interface PlacementRow {
  message_id: string;
  folder: string;
  folder_uid: number;
  added_at: string;
}

export interface FakeEnvResult {
  env: Env;
  ctx: ExecutionContext;
  settle: () => Promise<unknown[]>;
  rows: Row[];
  atts: AttRow[];
  r2: { key: string; bytes: ArrayBuffer }[];
  vectors: unknown[];
  vectorLedger: LedgerRow[];
  messageSeenBy: SeenByRow[];
  sent: SentMessage[];
}

interface SentMessage {
  to: string | string[];
  from: unknown;
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: unknown;
  headers?: Record<string, string>;
  // #70: attachments the binding receives (content already decoded to bytes by
  // the transport). disposition is "attachment" for v1.
  attachments?: {
    filename: string;
    type: string;
    disposition: string;
    content: ArrayBuffer | ArrayBufferView;
  }[];
}

export function makeFakeEnv(overrides: Partial<Record<string, unknown>> = {}): FakeEnvResult {
  const rows: Row[] = [];
  const atts: AttRow[] = [];
  const r2: { key: string; bytes: ArrayBuffer }[] = [];
  const vectors: unknown[] = [];
  const vectorLedger: LedgerRow[] = [];
  const messageSeenBy: SeenByRow[] = [];
  const sent: SentMessage[] = [];
  const drafts: DraftRow[] = [];
  const placements: PlacementRow[] = [];
  const counters = new Map<string, { next_uid: number; uidvalidity: number }>();
  // #350 effective seen: a viewer's per-recipient override wins over messages.seen;
  // no override (or no viewer) = the row-level flag.
  const effSeen = (r: Row, viewer: string | null): number => {
    if (viewer) {
      const o = messageSeenBy.find((x) => x.message_id === r.message_id && x.recipient === viewer);
      if (o) return o.seen;
    }
    return r.seen;
  };
  let seq = 1;
  let attSeq = 1;

  function makeStmt(sql: string) {
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async run() {
        if (/INSERT OR IGNORE INTO messages/i.test(sql)) {
          const [
            message_id, from_addr, to_addr, subject, date, in_reply_to, body_text, body_html,
            spf, dkim, dmarc, trusted, received_at, direction, thread_id,
          ] = bound as [string, string, string, string, string, string | null, string, string | null, string, string, string, number, string, string, string];
          if (rows.some((r) => r.message_id === message_id)) {
            return { meta: { changes: 0 } };
          }
          rows.push({
            id: seq++, message_id, from_addr, to_addr, subject, date, in_reply_to,
            body_text, body_html, spf, dkim, dmarc, trusted, received_at, seen: 1, direction, thread_id,
            flagged: 0, answered: 0, mailbox: null, trashed_at: null,
          } as Row);
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO attachments/i.test(sql)) {
          const [message_id, filename, mime, size, r2_key, created_at] = bound as [string, string | null, string | null, number, string, string];
          atts.push({ id: attSeq++, message_id, filename, mime, size, r2_key, created_at });
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM vector_ledger WHERE message_id/i.test(sql)) {
          const message_id = String(bound[0]);
          let changes = 0;
          for (let i = vectorLedger.length - 1; i >= 0; i--) {
            if (vectorLedger[i].message_id === message_id) {
              vectorLedger.splice(i, 1);
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (/INSERT INTO vector_ledger/i.test(sql)) {
          const [vector_id, message_id, chunk] = bound as [string, string, number];
          vectorLedger.push({
            vector_id,
            message_id,
            chunk,
            indexed_at: new Date().toISOString(),
          });
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM attachments WHERE message_id/i.test(sql)) {
          const message_id = String(bound[0]);
          let changes = 0;
          for (let i = atts.length - 1; i >= 0; i--) {
            if (atts[i].message_id === message_id) {
              atts.splice(i, 1);
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (/DELETE FROM messages WHERE message_id/i.test(sql)) {
          const message_id = String(bound[0]);
          let changes = 0;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i].message_id === message_id) {
              rows.splice(i, 1);
              changes++;
            }
          }
          return { meta: { changes } };
        }
        // #350: seed (VALUES (?, ?, 0) ON CONFLICT DO NOTHING) or scoped upsert
        // (VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET seen = excluded.seen).
        if (/INSERT INTO message_seen_by/i.test(sql)) {
          const message_id = String(bound[0]);
          const recipient = String(bound[1]);
          const existing = messageSeenBy.find((x) => x.message_id === message_id && x.recipient === recipient);
          if (/DO NOTHING/i.test(sql)) {
            if (!existing) messageSeenBy.push({ message_id, recipient, seen: 0 });
          } else {
            const val = Number(bound[2]);
            if (existing) existing.seen = val;
            else messageSeenBy.push({ message_id, recipient, seen: val });
          }
          return { meta: { changes: 1 } };
        }
        // #350 legacy realign: UPDATE message_seen_by SET seen = ? WHERE message_id IN (...).
        if (/UPDATE message_seen_by SET seen/i.test(sql)) {
          const value = Number(bound[0]);
          const ids = bound.slice(1).map((b) => String(b));
          let changes = 0;
          for (const x of messageSeenBy) {
            if (ids.includes(x.message_id)) {
              x.seen = value;
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (/DELETE FROM message_seen_by WHERE message_id/i.test(sql)) {
          const message_id = String(bound[0]);
          let changes = 0;
          for (let i = messageSeenBy.length - 1; i >= 0; i--) {
            if (messageSeenBy[i].message_id === message_id) {
              messageSeenBy.splice(i, 1);
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (/INSERT OR IGNORE INTO mailbox_uid_counter/i.test(sql)) {
          const folder = String(bound[0]);
          if (!counters.has(folder)) counters.set(folder, { next_uid: 1, uidvalidity: Number(bound[1]) });
          return { meta: { changes: 1 } };
        }
        if (/UPDATE messages SET mailbox = \?, trashed_at = \?/i.test(sql)) {
          const row = rows.find((r) => r.message_id === String(bound[2]));
          if (!row) return { meta: { changes: 0 } };
          row.mailbox = bound[0] === null ? null : String(bound[0]);
          row.trashed_at = bound[1] === null ? null : String(bound[1]);
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM mailbox_placement WHERE message_id/i.test(sql)) {
          const id = String(bound[0]);
          let changes = 0;
          for (let i = placements.length - 1; i >= 0; i--) {
            if (placements[i].message_id === id) {
              placements.splice(i, 1);
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (/INSERT INTO mailbox_placement/i.test(sql)) {
          placements.push({
            message_id: String(bound[0]), folder: String(bound[1]),
            folder_uid: Number(bound[2]), added_at: String(bound[3]),
          });
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO drafts/i.test(sql)) {
          const [id, identity, to_addr, cc_addr, bcc_addr, subject, body_text, body_html,
            in_reply_to, thread_id, uid, created_at, updated_at] = bound;
          drafts.push({
            id: String(id), identity: String(identity), to_addr: to_addr as string | null,
            cc_addr: cc_addr as string | null, bcc_addr: bcc_addr as string | null,
            subject: subject as string | null, body_text: body_text as string | null,
            body_html: body_html as string | null, in_reply_to: in_reply_to as string | null,
            thread_id: thread_id as string | null, uid: Number(uid),
            created_at: String(created_at), updated_at: String(updated_at),
          });
          return { meta: { changes: 1 } };
        }
        if (/UPDATE drafts SET/i.test(sql)) {
          const row = drafts.find((d) => d.id === String(bound[10]) && d.identity === String(bound[11]));
          if (!row) return { meta: { changes: 0 } };
          [row.to_addr, row.cc_addr, row.bcc_addr, row.subject, row.body_text, row.body_html,
            row.in_reply_to, row.thread_id] = bound.slice(0, 8) as (string | null)[];
          row.uid = Number(bound[8]);
          row.updated_at = String(bound[9]);
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM drafts WHERE id/i.test(sql)) {
          const i = drafts.findIndex((d) => d.id === String(bound[0]) && d.identity === String(bound[1]));
          if (i < 0) return { meta: { changes: 0 } };
          drafts.splice(i, 1);
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      async first<T>() {
        if (/UPDATE mailbox_uid_counter SET next_uid/i.test(sql)) {
          const row = counters.get(String(bound[0]));
          if (!row) return null as T | null;
          const uid = row.next_uid++;
          return { uid, uidvalidity: row.uidvalidity } as T;
        }
        if (/SELECT next_uid, uidvalidity FROM mailbox_uid_counter/i.test(sql)) {
          const row = counters.get(String(bound[0]));
          return (row ? { next_uid: row.next_uid, uidvalidity: row.uidvalidity } : null) as T | null;
        }
        if (/SELECT mailbox FROM messages WHERE message_id/i.test(sql)) {
          const row = rows.find((r) => r.message_id === String(bound[0]));
          return (row ? { mailbox: row.mailbox } : null) as T | null;
        }
        if (/FROM drafts WHERE id = \? AND identity = \?/i.test(sql)) {
          return (drafts.find((d) => d.id === String(bound[0]) && d.identity === String(bound[1])) ?? null) as T | null;
        }
        if (/SELECT message_id FROM messages WHERE message_id = \?/i.test(sql)) {
          const row = rows.find((r) => r.message_id === String(bound[0]));
          return (row ? { message_id: row.message_id } : null) as T | null;
        }
        if (/SELECT COUNT\(\*\) AS n FROM messages/i.test(sql)) {
          return { n: rows.length } as unknown as T;
        }
        if (/SELECT thread_id FROM messages WHERE message_id/i.test(sql)) {
          const id = bound[0] as string;
          const row = rows.find((r) => r.message_id === id);
          return (row ? { thread_id: row.thread_id } : null) as T | null;
        }
        if (/FROM messages WHERE message_id = \? LIMIT 1/i.test(sql)) {
          const id = bound[0] as string;
          const row = rows.find((r) => r.message_id === id);
          return (row ?? null) as T | null;
        }
        // getAttachment: i-th attachment row, ORDER BY id, LIMIT 1 OFFSET ?.
        if (/FROM attachments\s+WHERE message_id = \? ORDER BY id LIMIT 1 OFFSET/i.test(sql)) {
          const id = bound[0] as string;
          const offset = Number(bound[1]);
          const matched = atts.filter((a) => a.message_id === id).sort((a, b) => a.id - b.id);
          return ((matched[offset] ?? null) as unknown) as T | null;
        }
        return null as T | null;
      },
      async all<T>() {
        // #350 scoped setSeen existence check: SELECT message_id FROM messages WHERE
        // message_id IN (...). Distinct from summariesByIds (that uses the `m` alias).
        if (/SELECT message_id FROM messages WHERE message_id IN/i.test(sql)) {
          const ids = bound.map((b) => String(b));
          return {
            results: rows.filter((r) => ids.includes(r.message_id)).map((r) => ({ message_id: r.message_id })) as unknown as T[],
          };
        }
        // setSeen(): UPDATE messages SET seen = ? WHERE message_id IN (?, ...) RETURNING
        // message_id. Bind[0] is the new seen value, the rest are ids. RETURNING yields
        // one row per matched message row (mirrors the real query's count semantics).
        if (/UPDATE messages SET seen = \? WHERE message_id IN/i.test(sql)) {
          const value = Number(bound[0]);
          const ids = bound.slice(1).map((b) => String(b));
          const matched = rows.filter((r) => ids.includes(r.message_id));
          for (const r of matched) r.seen = value;
          return { results: matched.map((r) => ({ message_id: r.message_id })) as unknown as T[] };
        }
        if (/UPDATE messages SET .* WHERE message_id IN/i.test(sql) && /RETURNING message_id/i.test(sql)) {
          let i = 0;
          const flagged = /flagged = \?/i.test(sql) ? Number(bound[i++]) : undefined;
          const answered = /answered = \?/i.test(sql) ? Number(bound[i++]) : undefined;
          const idCount = (sql.match(/\?/g) ?? []).length - i;
          const ids = bound.slice(i, i + idCount).map(String);
          const matched = rows.filter((r) => ids.includes(r.message_id));
          for (const row of matched) {
            if (flagged !== undefined) row.flagged = flagged;
            if (answered !== undefined) row.answered = answered;
          }
          return { results: matched.map((r) => ({ message_id: r.message_id })) as unknown as T[] };
        }
        if (/FROM drafts WHERE identity = \?/i.test(sql)) {
          return {
            results: drafts.filter((d) => d.identity === String(bound[0]))
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at)) as unknown as T[],
          };
        }
        // M8 upsert (#178): INSERT ... ON CONFLICT(message_id) DO UPDATE ...
        // RETURNING thread_id, is_fresh. Faithful to store.put()'s single atomic
        // statement -- fresh insert (is_fresh=1), merge-append (is_fresh=0), or a
        // true-dedup no-op (recipient already a member -> WHERE false -> no row).
        // Bind order: 15 insert cols, then delivered_set(15), cc(16), bcc(17),
        // sender(18), reply_to(19), wire_size(20), seen(21), merge_rcpt(22),
        // where-rcpt(23), is_fresh cmp = delivered_set(24).
        if (/INSERT INTO messages/i.test(sql) && /ON CONFLICT/i.test(sql)) {
          const b = bound as unknown[];
          const message_id = b[0] as string;
          const delivered_set = b[15] as string;
          const merge_rcpt = b[22] as string;
          const existing = rows.find((r) => r.message_id === message_id);
          if (!existing) {
            rows.push({
              id: seq++,
              message_id,
              from_addr: b[1] as string,
              to_addr: b[2] as string,
              subject: b[3] as string,
              date: b[4] as string,
              in_reply_to: b[5] as string | null,
              body_text: b[6] as string,
              body_html: b[7] as string | null,
              spf: b[8] as string,
              dkim: b[9] as string,
              dmarc: b[10] as string,
              trusted: b[11] as number,
              received_at: b[12] as string,
              direction: b[13] as string,
              thread_id: b[14] as string | null,
              delivered_to: delivered_set,
              cc_addr: b[16] as string | null,
              bcc_addr: b[17] as string | null,
              sender_addr: b[18] as string | null,
              reply_to_addr: b[19] as string | null,
              wire_size: b[20] as number | null,
              seen: b[21] as number,
              flagged: 0,
              answered: 0,
              mailbox: null,
              trashed_at: null,
            });
            return { results: [{ thread_id: b[14] as string | null, is_fresh: 1 }] as unknown as T[] };
          }
          // Conflict: SQLite LIKE is case-insensitive, so compare lower-cased.
          const current = existing.delivered_to ?? `,${existing.to_addr},`;
          if (current.toLowerCase().includes(`,${merge_rcpt.toLowerCase()},`)) {
            return { results: [] as unknown as T[] }; // already a member: no-op
          }
          existing.delivered_to = `${current}${merge_rcpt},`;
          const is_fresh = existing.delivered_to === delivered_set ? 1 : 0;
          return { results: [{ thread_id: existing.thread_id, is_fresh }] as unknown as T[] };
        }
        if (/FROM attachments WHERE message_id/i.test(sql)) {
          const id = bound[0] as string;
          if (/SELECT r2_key FROM attachments/i.test(sql)) {
            return {
              results: atts.filter((a) => a.message_id === id).map((a) => ({ r2_key: a.r2_key })) as unknown as T[],
            };
          }
          return { results: atts.filter((a) => a.message_id === id) as unknown as T[] };
        }
        if (/FROM vector_ledger WHERE message_id/i.test(sql)) {
          const message_id = String(bound[0]);
          return {
            results: vectorLedger
              .filter((r) => r.message_id === message_id)
              .sort((a, b) => a.chunk - b.chunk)
              .map((r) => ({ vector_id: r.vector_id })) as unknown as T[],
          };
        }
        if (/FROM vector_ledger/i.test(sql)) {
          let work = vectorLedger.slice().sort((a, b) => a.vector_id.localeCompare(b.vector_id));
          let i = 0;
          if (/vector_id > \?/i.test(sql)) {
            const after = String(bound[i++]);
            work = work.filter((r) => r.vector_id > after);
          }
          const limit = /LIMIT \?/i.test(sql) ? Number(bound[i++]) : work.length;
          return {
            results: work.slice(0, limit).map((r) => ({ vector_id: r.vector_id })) as unknown as T[],
          };
        }
        // reindex page (#116 ws4): SELECT ... body_text FROM messages [WHERE keyset]
        // ORDER BY date DESC, id DESC LIMIT ?. Walks the same keyset the live list
        // uses, returning the body so the backfill can re-embed without an N+1.
        if (/body_text\s+FROM messages/i.test(sql) && /ORDER BY date DESC, id DESC/i.test(sql)) {
          let i = 0;
          let work = rows.slice();
          if (/date < \?/i.test(sql)) {
            const d = String(bound[i++]);
            const d2 = String(bound[i++]);
            const cid = Number(bound[i++]);
            void d2;
            work = work.filter((r) => r.date < d || (r.date === d && r.id < cid));
          }
          const limit = Number(bound[i++]);
          work.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
          const limited = work.slice(0, limit);
          const results = limited.map((r) => ({
            id: r.id,
            message_id: r.message_id,
            direction: r.direction,
            from_addr: r.from_addr,
            to_addr: r.to_addr,
            subject: r.subject,
            date: r.date,
            body_text: r.body_text,
          }));
          return { results: results as unknown as T[] };
        }
        if (/FROM messages WHERE thread_id = \?/i.test(sql)) {
          const id = bound[0] as string;
          const matched = rows
            .filter((r) => r.thread_id === id)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
          return { results: matched as unknown as T[] };
        }
        // summariesByIds(): FROM messages m WHERE m.message_id IN (?, ?, ...).
        // All binds are message ids; no ordering guarantee (caller re-orders).
        if (/FROM messages m WHERE m\.message_id IN \(/i.test(sql)) {
          let j = 0;
          let seenViewer: string | null = null;
          if (/COALESCE\(\(SELECT sb\.seen FROM message_seen_by/i.test(sql)) {
            seenViewer = String(bound[j++]).toLowerCase();
          }
          const ids = bound.slice(j).map((b) => String(b));
          const matched = rows.filter((r) => ids.includes(r.message_id));
          const results = matched.map((r) => ({
            id: r.id,
            message_id: r.message_id,
            direction: r.direction,
            thread_id: r.thread_id,
            from_addr: r.from_addr,
            to_addr: r.to_addr,
            subject: r.subject,
            date: r.date,
            in_reply_to: r.in_reply_to,
            trusted: r.trusted,
            received_at: r.received_at,
            seen: effSeen(r, seenViewer),
            delivered_to: r.delivered_to,
            cc_addr: r.cc_addr,
            bcc_addr: r.bcc_addr,
            sender_addr: r.sender_addr,
            reply_to_addr: r.reply_to_addr,
            wire_size: r.wire_size,
            has_html: r.body_html && String(r.body_html).trim() ? 1 : 0,
            attachment_count: atts.filter((a) => a.message_id === r.message_id).length,
            flagged: r.flagged,
            answered: r.answered,
            mailbox: r.mailbox,
            trashed_at: r.trashed_at,
            folder_uid: placements.find((p) => p.message_id === r.message_id && p.folder === r.mailbox)?.folder_uid ?? null,
          }));
          return { results: results as unknown as T[] };
        }
        // list() / search(): FROM messages m with optional WHERE fragments. We
        // walk the bound params in the SAME order store.ts appends them (fts, to,
        // from, thread, direction, cursor tuple, then limit+1) so the fake stays
        // a faithful interpreter of the two query shapes the store emits.
        if (/FROM messages m/i.test(sql)) {
          let i = 0;
          let work = rows.slice();
          // #350: the effective-seen subquery binds the viewer recipient FIRST (it
          // lives in the SELECT column list, ahead of every WHERE bind).
          let seenViewer: string | null = null;
          if (/COALESCE\(\(SELECT sb\.seen FROM message_seen_by/i.test(sql)) {
            seenViewer = String(bound[i++]).toLowerCase();
          }
          // substr search (#212): COALESCE(m.col,'') LIKE ? ESCAPE '\' OR ... .
          // Detect by the ESCAPE clause (the list from= filter is a bare LIKE ?,
          // never ESCAPE), pull the OR'd columns in order, consume one identical
          // pattern bind per column, then filter by case-insensitive substring
          // (LIKE folds ASCII case). Unescape the pattern to the raw needle.
          const likeCols = [...sql.matchAll(/COALESCE\(m\.(\w+),''\) LIKE \? ESCAPE/gi)].map((mm) => mm[1]);
          if (likeCols.length) {
            const pat = String(bound[i]);
            i += likeCols.length;
            const needle = pat
              .replace(/^%/, "")
              .replace(/%$/, "")
              .replace(/\\%/g, "%")
              .replace(/\\_/g, "_")
              .replace(/\\\\/g, "\\")
              .toLowerCase();
            work = work.filter((r) =>
              likeCols.some((c) => String((r as Record<string, unknown>)[c] ?? "").toLowerCase().includes(needle)),
            );
          }
          if (/messages_fts MATCH \?/i.test(sql)) {
            const expr = String(bound[i++]); // phrase OR expression: "a" OR "b"
            const terms = (expr.match(/"([^"]+)"/g) ?? []).map((t) => t.replace(/"/g, "").toLowerCase());
            work = work.filter((r) =>
              terms.some(
                (t) => r.subject.toLowerCase().includes(t) || r.body_text.toLowerCase().includes(t),
              ),
            );
          }
          // M8 (#178/#189): COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE
          // '%,' || ? || ',%'. Bind is the bare lower-cased address; match the
          // delivered set (falling back to a v1 row's to_addr), delimiter-safe.
          if (/COALESCE\(m\.delivered_to/i.test(sql)) {
            const v = String(bound[i++]).toLowerCase();
            if (/OR lower\(m\.from_addr\) = \?/i.test(sql)) {
              const from = String(bound[i++]).toLowerCase();
              work = work.filter((r) =>
                (r.delivered_to ?? `,${r.to_addr},`).toLowerCase().includes(`,${v},`) ||
                r.from_addr.toLowerCase() === from,
              );
            } else {
              work = work.filter((r) => (r.delivered_to ?? `,${r.to_addr},`).toLowerCase().includes(`,${v},`));
            }
          }
          if (/lower\(m\.from_addr\) LIKE \?/i.test(sql)) {
            const v = String(bound[i++]).replace(/%/g, "").toLowerCase();
            work = work.filter((r) => r.from_addr.toLowerCase().includes(v));
          }
          if (/m\.thread_id = \?/i.test(sql)) {
            const v = String(bound[i++]);
            work = work.filter((r) => r.thread_id === v);
          }
          if (/m\.direction = 'inbound' OR/i.test(sql)) {
            // #350 viewer-relative INBOX: inbound OR (outbound AND from != viewer).
            const notFrom = String(bound[i++]).toLowerCase();
            work = work.filter(
              (r) => r.direction === "inbound" || (r.direction === "outbound" && r.from_addr.toLowerCase() !== notFrom),
            );
          } else if (/m\.direction = \?/i.test(sql)) {
            const v = String(bound[i++]);
            work = work.filter((r) => r.direction === v);
          } else if (/(?:WHERE|AND) lower\(m\.from_addr\) = \?/i.test(sql)) {
            const v = String(bound[i++]).toLowerCase();
            work = work.filter((r) => r.from_addr.toLowerCase() === v);
          }
          if (/m\.mailbox IS NULL/i.test(sql)) work = work.filter((r) => r.mailbox === null);
          else if (/m\.mailbox = \?/i.test(sql)) {
            const mailbox = String(bound[i++]);
            work = work.filter((r) => r.mailbox === mailbox);
          }
          if (/m\.date < \?/i.test(sql)) {
            const d = String(bound[i++]);
            const d2 = String(bound[i++]);
            const cid = Number(bound[i++]);
            void d2;
            work = work.filter((r) => r.date < d || (r.date === d && r.id < cid));
          }
          const limit = Number(bound[i++]);
          work.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
          const limited = work.slice(0, limit);
          const results = limited.map((r) => ({
            id: r.id,
            message_id: r.message_id,
            direction: r.direction,
            thread_id: r.thread_id,
            from_addr: r.from_addr,
            to_addr: r.to_addr,
            subject: r.subject,
            date: r.date,
            in_reply_to: r.in_reply_to,
            trusted: r.trusted,
            received_at: r.received_at,
            seen: effSeen(r, seenViewer),
            delivered_to: r.delivered_to,
            cc_addr: r.cc_addr,
            bcc_addr: r.bcc_addr,
            sender_addr: r.sender_addr,
            reply_to_addr: r.reply_to_addr,
            wire_size: r.wire_size,
            has_html: r.body_html && String(r.body_html).trim() ? 1 : 0,
            attachment_count: atts.filter((a) => a.message_id === r.message_id).length,
            flagged: r.flagged,
            answered: r.answered,
            mailbox: r.mailbox,
            trashed_at: r.trashed_at,
            folder_uid: placements.find((p) => p.message_id === r.message_id && p.folder === r.mailbox)?.folder_uid ?? null,
          }));
          return { results: results as unknown as T[] };
        }
        return { results: [] as T[] };
      },
    };
  }

  const env = {
    TRUSTED_SENDER_DOMAINS: "skyphusion.org,example.com",
    VECTORIZE_FOR: "",
    ALLOWED_FROM_DOMAIN: "skyphusion.org",
    DEFAULT_FROM: "noreply@skyphusion.org",
    DEFAULT_FROM_NAME: "Skyphusion",
    POSTERN_API_TOKEN: "test-token",
    DB: {
      prepare: (sql: string) => makeStmt(sql),
      batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((s) => s.run())),
    },
    ATTACHMENTS: {
      async put(key: string, bytes: ArrayBuffer) {
        r2.push({ key, bytes });
      },
      async get(key: string) {
        const obj = r2.find((o) => o.key === key);
        if (!obj) return null;
        // Minimal R2ObjectBody shape: getAttachment only reads .body (a stream).
        return {
          body: new Response(obj.bytes).body,
          async arrayBuffer() {
            return obj.bytes;
          },
        };
      },
      async delete(key: string) {
        const i = r2.findIndex((o) => o.key === key);
        if (i >= 0) r2.splice(i, 1);
      },
    },
    VECTORIZE: {
      async upsert(v: unknown[]) {
        vectors.push(...v);
      },
      // Cosine-similarity nearest-neighbour over whatever upsert() stored, so
      // semantic-search tests rank by real vector closeness (paired with the
      // deterministic embedder in AI.run below).
      async query(vec: number[], opts?: { topK?: number }) {
        const topK = opts?.topK ?? 10;
        const scored = (vectors as { id: string; values: number[]; metadata?: unknown }[])
          .map((v) => ({ id: v.id, score: cosine(vec, v.values), metadata: v.metadata }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        return { matches: scored };
      },
      // #134 reconcile: report the live vector total (legacy binding field name).
      async describe() {
        return { vectorsCount: vectors.length };
      },
      // #134 reconcile: fetch raw vectors (with values + metadata) by id, the only
      // way to confirm an expected id is present and to pull probe values for sampling.
      // Enforces the live Vectorize cap (max 20 ids/call, VECTOR_GET_ERROR 40007 above)
      // so the batching in store.getByIdsBatched is pinned by the test suite.
      async getByIds(ids: string[]) {
        if (ids.length > 20) throw new Error("too many ids in payload; max id count is 20");
        const want = new Set(ids);
        return (vectors as { id: string; values: number[]; metadata?: unknown }[]).filter((v) =>
          want.has(v.id),
        );
      },
      async deleteByIds(ids: string[]) {
        if (ids.length > 20) throw new Error("too many ids in payload; max id count is 20");
        const drop = new Set(ids);
        for (let i = vectors.length - 1; i >= 0; i--) {
          const v = vectors[i] as { id: string };
          if (drop.has(v.id)) vectors.splice(i, 1);
        }
      },
    },
    AI: {
      // Deterministic bag-of-words embedding over a tiny fixed vocabulary, so the
      // same words map to the same vector in both ingest and query -- enough for
      // tests to assert that semantically-overlapping text ranks higher.
      async run(_model: string, input: { text: string[] }) {
        return { data: input.text.map((t) => embedText(t)) };
      },
    },
    EMAIL: {
      async send(message: SentMessage) {
        sent.push(message);
        return { messageId: "provider-123" };
      },
    },
    ...overrides,
  } as unknown as Env;

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
  } as unknown as ExecutionContext;

  return { env, ctx, settle: () => Promise.all(pending), rows, atts, r2, vectors, vectorLedger, messageSeenBy, sent };
}


// --- Deterministic embedding helpers for the fakes (test-only) ---

const VOCAB = [
  "invoice", "payment", "money", "billing", "lunch", "tacos", "food",
  "deploy", "release", "green", "build", "meeting", "schedule", "calendar",
  "bug", "error", "crash", "fix", "render", "video", "gpu",
];

function embedText(text: string): number[] {
  const words = (text.toLowerCase().match(/[a-z]+/g) ?? []);
  const vec = new Array(VOCAB.length).fill(0) as number[];
  for (const w of words) {
    const i = VOCAB.indexOf(w);
    if (i >= 0) vec[i] += 1;
  }
  // Add a tiny constant so all-zero vectors still have a defined direction.
  for (let i = 0; i < vec.length; i++) vec[i] += 0.01;
  return vec;
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

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
  spf: string;
  dkim: string;
  dmarc: string;
  trusted: number;
  received_at: string;
  direction: string;
  thread_id: string | null;
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

export interface FakeEnvResult {
  env: Env;
  ctx: ExecutionContext;
  settle: () => Promise<unknown[]>;
  rows: Row[];
  atts: AttRow[];
  r2: { key: string; bytes: ArrayBuffer }[];
  vectors: unknown[];
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
}

export function makeFakeEnv(overrides: Partial<Record<string, unknown>> = {}): FakeEnvResult {
  const rows: Row[] = [];
  const atts: AttRow[] = [];
  const r2: { key: string; bytes: ArrayBuffer }[] = [];
  const vectors: unknown[] = [];
  const sent: SentMessage[] = [];
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
            message_id, from_addr, to_addr, subject, date, in_reply_to, body_text,
            spf, dkim, dmarc, trusted, received_at, direction, thread_id,
          ] = bound as [string, string, string, string, string, string | null, string, string, string, string, number, string, string, string];
          if (rows.some((r) => r.message_id === message_id)) {
            return { meta: { changes: 0 } };
          }
          rows.push({
            id: seq++, message_id, from_addr, to_addr, subject, date, in_reply_to,
            body_text, spf, dkim, dmarc, trusted, received_at, direction, thread_id,
          });
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO attachments/i.test(sql)) {
          const [message_id, filename, mime, size, r2_key, created_at] = bound as [string, string | null, string | null, number, string, string];
          atts.push({ id: attSeq++, message_id, filename, mime, size, r2_key, created_at });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      async first<T>() {
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
        return null as T | null;
      },
      async all<T>() {
        if (/FROM attachments WHERE message_id/i.test(sql)) {
          const id = bound[0] as string;
          return { results: atts.filter((a) => a.message_id === id) as unknown as T[] };
        }
        if (/FROM messages WHERE thread_id = \?/i.test(sql)) {
          const id = bound[0] as string;
          const matched = rows
            .filter((r) => r.thread_id === id)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
          return { results: matched as unknown as T[] };
        }
        // list() / search(): FROM messages m with optional WHERE fragments. We
        // walk the bound params in the SAME order store.ts appends them (fts, to,
        // from, thread, direction, cursor tuple, then limit+1) so the fake stays
        // a faithful interpreter of the two query shapes the store emits.
        if (/FROM messages m/i.test(sql)) {
          let i = 0;
          let work = rows.slice();
          if (/messages_fts MATCH \?/i.test(sql)) {
            const expr = String(bound[i++]); // phrase OR expression: "a" OR "b"
            const terms = (expr.match(/"([^"]+)"/g) ?? []).map((t) => t.replace(/"/g, "").toLowerCase());
            work = work.filter((r) =>
              terms.some(
                (t) => r.subject.toLowerCase().includes(t) || r.body_text.toLowerCase().includes(t),
              ),
            );
          }
          if (/lower\(m\.to_addr\) LIKE \?/i.test(sql)) {
            const v = String(bound[i++]).replace(/%/g, "").toLowerCase();
            work = work.filter((r) => r.to_addr.toLowerCase().includes(v));
          }
          if (/lower\(m\.from_addr\) LIKE \?/i.test(sql)) {
            const v = String(bound[i++]).replace(/%/g, "").toLowerCase();
            work = work.filter((r) => r.from_addr.toLowerCase().includes(v));
          }
          if (/m\.thread_id = \?/i.test(sql)) {
            const v = String(bound[i++]);
            work = work.filter((r) => r.thread_id === v);
          }
          if (/m\.direction = \?/i.test(sql)) {
            const v = String(bound[i++]);
            work = work.filter((r) => r.direction === v);
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
            attachment_count: atts.filter((a) => a.message_id === r.message_id).length,
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
    DB: { prepare: (sql: string) => makeStmt(sql) },
    ATTACHMENTS: {
      async put(key: string, bytes: ArrayBuffer) {
        r2.push({ key, bytes });
      },
    },
    VECTORIZE: {
      async upsert(v: unknown[]) {
        vectors.push(...v);
      },
    },
    AI: {
      async run() {
        return { data: [[0.1, 0.2, 0.3]] };
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

  return { env, ctx, settle: () => Promise.all(pending), rows, atts, r2, vectors, sent };
}

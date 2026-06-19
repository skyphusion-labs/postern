import { describe, it, expect } from "vitest";
import { ingest, type ParsedInbound } from "./src/ingest";

// Fakes for the storage bindings. The D1 fake records bound rows per statement
// and reports changes so dedup behaviour is observable; R2/Vectorize/AI just
// record calls. ingest() runs attachments + vectorize via ctx.waitUntil, so the
// fake ctx awaits them inline, letting tests assert on the side effects.
function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  const inserts: { sql: string; args: unknown[] }[] = [];
  const r2: { key: string; bytes: ArrayBuffer }[] = [];
  const vectors: unknown[] = [];
  // message_id is UNIQUE: a second INSERT of a seen id yields changes:0.
  const seenMessageIds = new Set<string>();

  const env = {
    TRUSTED_SENDER_DOMAINS: "skyphusion.org,example.com",
    VECTORIZE_FOR: "",
    DB: {
      prepare(sql: string) {
        const stmt = {
          _args: [] as unknown[],
          bind(...args: unknown[]) {
            this._args = args;
            return this;
          },
          async run() {
            inserts.push({ sql, args: this._args });
            if (sql.includes("INTO messages\n")) {
              const id = this._args[0] as string;
              if (seenMessageIds.has(id)) return { meta: { changes: 0 } };
              seenMessageIds.add(id);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    },
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
    ...overrides,
  } as unknown as Env;

  // ctx.waitUntil awaits inline so best-effort work completes within the test.
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
  } as unknown as ExecutionContext;

  const settle = () => Promise.all(pending);
  return { env, ctx, settle, inserts, r2, vectors };
}

function baseMsg(over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    messageId: "abc@example.com",
    from: "alice@example.com",
    to: "conrad@skyphusion.org",
    subject: "hello",
    text: "this is the body",
    ...over,
  };
}

describe("ingest", () => {
  it("stores a new message and reports stored=true", async () => {
    const { env, ctx, settle } = makeEnv();
    const res = await ingest(env, baseMsg(), ctx);
    await settle();
    expect(res).toMatchObject({ messageId: "abc@example.com", stored: true });
  });

  it("dedups on a repeated message_id (stored=false)", async () => {
    const { env, ctx, settle } = makeEnv();
    await ingest(env, baseMsg(), ctx);
    const res = await ingest(env, baseMsg(), ctx);
    await settle();
    expect(res.stored).toBe(false);
  });

  it("hashes a Message-ID longer than 64 chars so it fits Vectorize's id limit", async () => {
    const { env, ctx, settle } = makeEnv();
    const long = "x".repeat(80) + "@example.com";
    const res = await ingest(env, baseMsg({ messageId: long }), ctx);
    await settle();
    expect(res.messageId).toHaveLength(64);
    expect(res.messageId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("strips quoted lines and the signature block from the body", async () => {
    const { env, ctx, settle, inserts } = makeEnv();
    await ingest(
      env,
      baseMsg({ text: "real reply\n> quoted line\n-- \nsig block" }),
      ctx,
    );
    await settle();
    const msgInsert = inserts.find((i) => i.sql.includes("INTO messages\n"));
    const bodyText = msgInsert!.args[6] as string;
    expect(bodyText).toBe("real reply");
  });

  it("marks an allowlisted sender with a passing verdict as trusted", async () => {
    const { env, ctx, settle, inserts } = makeEnv();
    await ingest(env, baseMsg({ auth: { spf: "pass", dkim: "pass", dmarc: "pass" } }), ctx);
    await settle();
    const msgInsert = inserts.find((i) => i.sql.includes("INTO messages\n"));
    expect(msgInsert!.args[10]).toBe(1); // trusted column
  });

  it("does not trust a sender off the allowlist", async () => {
    const { env, ctx, settle, inserts } = makeEnv();
    await ingest(
      env,
      baseMsg({ from: "mallory@evil.com", auth: { spf: "pass", dkim: "pass" } }),
      ctx,
    );
    await settle();
    const msgInsert = inserts.find((i) => i.sql.includes("INTO messages\n"));
    expect(msgInsert!.args[10]).toBe(0);
  });

  it("stores attachment bytes to R2 and metadata to D1", async () => {
    const { env, ctx, settle, r2, inserts } = makeEnv();
    const content = new TextEncoder().encode("file data").buffer;
    await ingest(env, baseMsg({ attachments: [{ filename: "a.txt", mimeType: "text/plain", content }] }), ctx);
    await settle();
    expect(r2).toHaveLength(1);
    expect(r2[0].key).toContain("att/");
    expect(inserts.some((i) => i.sql.includes("INTO attachments"))).toBe(true);
  });

  it("only vectorizes recipients on the VECTORIZE_FOR allowlist", async () => {
    const off = makeEnv({ VECTORIZE_FOR: "someone-else@skyphusion.org" });
    await ingest(off.env, baseMsg(), off.ctx);
    await off.settle();
    expect(off.vectors).toHaveLength(0);

    const on = makeEnv({ VECTORIZE_FOR: "conrad@skyphusion.org" });
    await ingest(on.env, baseMsg(), on.ctx);
    await on.settle();
    expect(on.vectors.length).toBeGreaterThan(0);
  });

  it("indexes everything when VECTORIZE_FOR is empty", async () => {
    const { env, ctx, settle, vectors } = makeEnv({ VECTORIZE_FOR: "" });
    await ingest(env, baseMsg(), ctx);
    await settle();
    expect(vectors.length).toBeGreaterThan(0);
  });
});

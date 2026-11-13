// #963 (a): when an upserted vector is QUERYABLE. Vectorize mutations are asynchronous, so the
// ledger now records the upsert's mutationId and when it returned (migration 0025), and the
// operator debug route gives "not-yet-queryable" while describe() says the index has not
// processed past it. Real sqlite store and real handleApi; Vectorize is an in-memory fake whose
// processing point the test moves by hand.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { realEnv, AUTH } from "./realdb";

type Json = Record<string, any>;
const HERE = dirname(fileURLToPath(import.meta.url));
const sql = (f: string) => readFileSync(join(HERE, "migrations", f), "utf8");
const ORIGIN = "https://postern.example";
const OPERATOR = "test-token"; // realdb's static both token
const TO = "conrad@skyphusion.org";
const DIM = 32;
function embed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

/** A V2-like Vectorize: upsert returns { mutationId }; a vector is QUERYABLE only after
 *  processed() moves the processing point past its mutation. `legacy` returns no mutationId. */
function fakeVectorize(o: { legacy?: boolean; seconds?: boolean } = {}) {
  const stored = new Map<string, { id: string; values: number[]; metadata: Json; mutation: number; at: number }>();
  let next = 0;
  let processedUpTo = { mutation: 0, at: 0 };
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const api = {
    async upsert(vs: Array<{ id: string; values: number[]; metadata: Json }>) {
      next += 1;
      for (const v of vs) stored.set(v.id, { ...v, mutation: next, at: Date.now() });
      return o.legacy ? { ids: vs.map((v) => v.id), count: vs.length } : { mutationId: uuid(next) };
    },
    async query(q: number[], opts: { topK: number }) {
      const matches = [...stored.values()]
        .filter((v) => v.mutation <= processedUpTo.mutation)
        .map((v) => ({ id: v.id, score: cos(q, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.topK);
      return { matches };
    },
    async deleteByIds() { return {}; },
    async describe() {
      if (o.legacy) return { vectorsCount: stored.size };
      const at = processedUpTo.at;
      return { vectorCount: stored.size, dimensions: DIM, processedUpToDatetime: o.seconds ? at / 1000 : at, processedUpToMutation: uuid(processedUpTo.mutation) };
    },
    async getByIds(ids: string[]) {
      return ids.filter((id) => stored.has(id)).map((id) => stored.get(id)!);
    },
  };
  return {
    api,
    /** The index processes every mutation so far, at a time after all of them. */
    processAll() { processedUpTo = { mutation: next, at: Date.now() + 1 }; },
    /** The index has processed nothing yet (its point is in the past). */
    processNone() { processedUpTo = { mutation: 0, at: 1 }; },
  };
}

async function setup(o: { legacy?: boolean; seconds?: boolean } = {}) {
  const v = fakeVectorize(o);
  const AI = { async run(_m: string, i: { text: string[] }) { return { data: i.text.map(embed) }; } };
  const r = realEnv({ AI, VECTORIZE: v.api, SEARCH_DEBUG: "1" });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
  const put = async (id: string, subject: string, body: string) => {
    await store.put(r.env, { messageId: id, direction: "inbound", from: "a@x.example", to: TO, subject, date: new Date().toISOString(), bodyText: body, auth: AUTH, trusted: false, deliveredTo: [TO], vectorize: true }, ctx);
    await Promise.all(pending.splice(0));
  };
  const debug = async (q: string, gold: string) => {
    const path = `/api/admin/search-debug?${new URLSearchParams({ q, gold, mode: "semantic", limit: "10" })}`;
    const res = await handleApi(new Request(ORIGIN + path, { headers: { authorization: `Bearer ${OPERATOR}` } }), r.env, r.ctx);
    return (await res.json()) as Json;
  };
  return { ...r, v, put, debug };
}

describe("#963 migration 0025: additive, on a fresh DB and an existing one", () => {
  const cols = (db: DatabaseSync) => (db.prepare("PRAGMA table_info(vector_ledger)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>);
  it("an existing ledger gains two nullable columns, and its old rows read NULL", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of ["0008_vector_ledger.sql", "0024_embed_version.sql"]) db.exec(sql(f));
    db.prepare("INSERT INTO vector_ledger (vector_id, message_id, chunk, embed_version) VALUES ('v.0', 'old@x', 0, 2)").run();
    db.exec(sql("0025_vector_mutation.sql"));
    const c = cols(db);
    for (const name of ["mutation_id", "upserted_ms"]) {
      const col = c.find((x) => x.name === name);
      expect(col, name).toBeDefined();
      expect(col!.notnull).toBe(0);
      expect(col!.dflt_value).toBeNull();
    }
    expect(db.prepare("SELECT mutation_id, upserted_ms, embed_version FROM vector_ledger WHERE vector_id = 'v.0'").get()).toEqual({ mutation_id: null, upserted_ms: null, embed_version: 2 });
  });
  it("schema.sql (a fresh DB) has the same columns as the migrated one", () => {
    const fresh = new DatabaseSync(":memory:");
    fresh.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));
    const migrated = new DatabaseSync(":memory:");
    for (const f of ["0008_vector_ledger.sql", "0024_embed_version.sql", "0025_vector_mutation.sql"]) migrated.exec(sql(f));
    const names = (db: DatabaseSync) => cols(db).map((c) => c.name).sort();
    expect(names(fresh)).toEqual(names(migrated));
  });
  it("the #112 deploy gate classifies 0025 as additive (it would auto-apply)", () => {
    const gate = join(HERE, "..", ".github", "scripts", "d1-migration-gate.mjs");
    const dir = join(HERE, "migrations");
    const ok = spawnSync(process.execPath, [gate, dir], { input: "Migrations to be applied:\n| 0025_vector_mutation.sql |\n", encoding: "utf8" });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout + ok.stderr).toContain("0025_vector_mutation.sql -- additive");
    // CONTROL: the same gate refuses the destructive 0005 (a table rebuild), so the 0 above means something.
    const bad = spawnSync(process.execPath, [gate, dir], { input: "| 0005_messages_autoincrement_uid.sql |\n", encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain("REFUSING");
  });
});

describe("#963 the ledger records the upsert's mutation and time", () => {
  it("a V2 binding: mutation_id is the upsert's mutationId, upserted_ms is the time it returned", async () => {
    const s = await setup();
    const before = Date.now();
    await s.put("fresh@x", "Quarterly report draft", "The quarterly report draft is attached for review");
    const after = Date.now();
    const rows = s.raw.prepare("SELECT mutation_id, upserted_ms FROM vector_ledger WHERE message_id = 'fresh@x'").all() as Json[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.mutation_id).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
      expect(r.upserted_ms).toBeGreaterThanOrEqual(before);
      expect(r.upserted_ms).toBeLessThanOrEqual(after);
    }
  });
  it("a binding that returns no mutationId: mutation_id NULL, upserted_ms still set", async () => {
    const s = await setup({ legacy: true });
    await s.put("legacy@x", "Legacy index mail", "Body of a message on the legacy binding");
    const r = s.raw.prepare("SELECT mutation_id, upserted_ms FROM vector_ledger WHERE message_id = 'legacy@x'").get() as Json;
    expect(r.mutation_id).toBeNull();
    expect(typeof r.upserted_ms).toBe("number");
  });
});

describe("#963 indexProgress", () => {
  it("reads processedUpToDatetime as ms, and seconds as ms too", async () => {
    for (const seconds of [false, true]) {
      const s = await setup({ seconds });
      await s.put("p@x", "Progress mail", "Some body text here");
      s.v.processAll();
      const p = await store.indexProgress(s.env);
      expect(p).not.toBeNull();
      expect(Math.abs(p!.processedUpToMs! - Date.now())).toBeLessThan(5000);
      expect(p!.processedUpToMutation).toMatch(/^00000000-/);
    }
  });
  it("a binding with no processing point gives null (nothing is concluded from it)", async () => {
    const s = await setup({ legacy: true });
    expect(await store.indexProgress(s.env)).toBeNull();
  });
});

describe("#963 the debug route: not-yet-queryable, and only then", () => {
  const Q = "quarterly report draft";
  it("THE #963 CASE: an upsert the index has not processed reads not-yet-queryable, not a miss", async () => {
    const s = await setup();
    await s.put("fresh@x", "Quarterly report draft", "The quarterly report draft is attached for review");
    s.v.processNone();
    const b = await s.debug(Q, "fresh@x");
    expect(b.gold.verdict).toBe("not-yet-queryable");
    expect(b.gold.pending).toBe(true);
    expect(typeof b.gold.upsertedMs).toBe("number");
    expect(b.index.processedUpToMs).toBeLessThan(b.gold.upsertedMs);
    expect(b.serverNowMs).toBeGreaterThanOrEqual(b.gold.upsertedMs);
  });
  it("control: once the index has processed it, the same gold is found (in-raw)", async () => {
    const s = await setup();
    await s.put("fresh@x", "Quarterly report draft", "The quarterly report draft is attached for review");
    s.v.processAll();
    const b = await s.debug(Q, "fresh@x");
    expect(b.gold.verdict).toBe("in-raw");
    expect(b.gold.pending).toBe(false);
    expect(b.gold.mutationIsLatest).toBe(true);
  });
  it("in-raw wins over the clock: a vector the query returned is queryable whatever describe() says", async () => {
    const s = await setup();
    await s.put("fresh@x", "Quarterly report draft", "The quarterly report draft is attached for review");
    s.v.processAll();
    // Move the reported point back, but leave the vector served: the query is the stronger evidence.
    const real = s.v.api.describe;
    (s.v.api as { describe: () => Promise<Json> }).describe = async () => ({ ...(await real()), processedUpToDatetime: 1 });
    const b = await s.debug(Q, "fresh@x");
    expect(b.gold.verdict).toBe("in-raw");
  });
  it("a ledger row from before 0025 (NULL upserted_ms) concludes nothing from the clock", async () => {
    const s = await setup();
    await s.put("old@x", "Quarterly report draft", "The quarterly report draft is attached for review");
    s.raw.prepare("UPDATE vector_ledger SET upserted_ms = NULL, mutation_id = NULL WHERE message_id = 'old@x'").run();
    s.v.processNone();
    const b = await s.debug(Q, "old@x");
    expect(b.gold.pending).toBeNull();
    expect(b.gold.verdict).not.toBe("not-yet-queryable");
  });
  it("a binding with no processing point (legacy) never reads not-yet-queryable", async () => {
    const s = await setup({ legacy: true });
    await s.put("leg@x", "Quarterly report draft", "The quarterly report draft is attached for review");
    const b = await s.debug(Q, "leg@x");
    expect(b.index).toBeNull();
    expect(b.gold.pending).toBeNull();
    expect(b.gold.verdict).not.toBe("not-yet-queryable");
  });
  it("the index block carries no content: numbers and an opaque mutation id only", async () => {
    const s = await setup();
    await s.put("fresh@x", "Quarterly report draft", "The quarterly report draft is attached for review");
    s.v.processAll();
    const b = await s.debug(Q, "fresh@x");
    expect(Object.keys(b.index).sort()).toEqual(["processedUpToMs", "processedUpToMutation", "vectorCount"]);
    expect(JSON.stringify(b.index)).not.toMatch(/quarterly|report|fresh@x/i);
  });
});

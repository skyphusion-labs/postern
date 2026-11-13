import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { EMBED_VERSION } from "./src/embedtext";
import { realEnv, AUTH } from "./realdb";

// #950: GET /api/admin/search-debug, the raw Vectorize ranking behind one search. Real
// sqlite store, real handleApi; Vectorize is an exact in-memory index that can be told to
// DROP chosen ids, which is how an approximate index loses a neighbour.

const OPERATOR = "test-token"; // realdb's static both token
const ADMIN = "admin-slot-token-0123456789abcdef";
const READ = "read-token-0123456789abcdef";
const ORIGIN = "https://postern.example";
const TO = "conrad@skyphusion.org";
type Json = Record<string, any>;

const DIM = 64;
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

async function setup(opts: { debug?: string | null; filler?: number; approxOffset?: number } = {}) {
  const index = new Map<string, { id: string; values: number[]; metadata: Json }>();
  const dropped = new Set<string>();
  const queries: number[] = [];
  const AI = { async run(_m: string, i: { text: string[] }) { return { data: i.text.map(embed) }; } };
  const VECTORIZE = {
    async upsert(vs: Array<{ id: string; values: number[]; metadata: Json }>) { for (const v of vs) index.set(v.id, v); return {}; },
    async query(q: number[], o: { topK: number }) {
      queries.push(o.topK);
      const matches = [...index.values()]
        .filter((v) => !dropped.has(v.id))
        .map((v) => ({ id: v.id, score: cos(q, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, o.topK)
        // Production queries without returnValues, so Vectorize scores APPROXIMATELY
        // (developers.cloudflare.com/vectorize/best-practices/query-vectors, read
        // 2026-11-13). approxOffset models that: the order is exact, the score is not.
        .map((m) => ({ ...m, score: m.score + (opts.approxOffset ?? 0) }));
      return { matches };
    },
    async deleteByIds() { return {}; },
    async describe() { return { vectorCount: index.size }; },
    async getByIds(ids: string[]) {
      if (ids.length > 20) throw new Error("VECTOR_GET_ERROR (40007)");
      return ids.filter((id) => index.has(id)).map((id) => index.get(id)!);
    },
  };
  const debug = opts.debug === undefined ? "1" : opts.debug;
  const r = realEnv({
    AI, VECTORIZE,
    POSTERN_API_TOKEN_ADMIN: ADMIN,
    POSTERN_API_TOKEN_READ: READ,
    ...(debug === null ? {} : { SEARCH_DEBUG: debug }),
  });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
  const put = async (id: string, subject: string, body: string, date: string) => {
    await store.put(r.env, { messageId: id, direction: "inbound", from: "ci@builds.example", to: TO, subject, date, bodyText: body, auth: AUTH, trusted: false, deliveredTo: [TO], vectorize: true }, ctx);
    await Promise.all(pending.splice(0));
  };
  await put("deploy-1@ci", "Deploy failed: inbound worker", "The inbound worker deploy failed at the wrangler step.", "2026-11-01T00:00:00.000Z");
  await put("deploy-2@ci", "Deploy failed: inbound worker", "The inbound worker deploy failed at the typecheck step.", "2026-11-02T00:00:00.000Z");
  await put("lunch@x", "Lunch on friday", "Shall we get lunch on friday near the office", "2026-11-03T00:00:00.000Z");
  await put("invoice@x", "Invoice 2211 overdue", "Your invoice 2211 is overdue, please pay by monday", "2026-11-04T00:00:00.000Z");
  // Filler pushes the index past the 50-vector topK, so the raw list is FULL and a
  // floor score exists (the ann-miss / outranked split needs one).
  for (let i = 0; i < (opts.filler ?? 0); i++) {
    await put(`fill-${i}@x`, `Newsletter ${i} deploy notes`, `Weekly deploy notes number ${i} for the worker team`, `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`);
  }
  const call = async (path: string, token: string | null) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await handleApi(new Request(ORIGIN + path, { method: "GET", headers }), r.env, r.ctx);
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Json };
  };
  return { ...r, call, put, index, dropped, queries };
}

const Q = "/api/admin/search-debug?q=" + encodeURIComponent("inbound worker deploy failed");

describe("#950 search-debug is OFF by default", () => {
  it("unset SEARCH_DEBUG: the operator gets 404, and no Vectorize query runs", async () => {
    const s = await setup({ debug: null });
    const res = await s.call(Q, OPERATOR);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("E_NOT_FOUND");
    expect(s.queries).toEqual([]);
  });
  for (const v of ["", "0", "yes", "on", "false"]) {
    it(`SEARCH_DEBUG=${JSON.stringify(v)} is off`, async () => {
      const s = await setup({ debug: v });
      expect((await s.call(Q, OPERATOR)).status).toBe(404);
    });
  }
  it("CONTROL: SEARCH_DEBUG=1 and =true turn it on for the same request", async () => {
    for (const v of ["1", "true", " TRUE "]) {
      const s = await setup({ debug: v });
      const res = await s.call(Q, OPERATOR);
      expect(res.status, res.text).toBe(200);
    }
  });
});

describe("#950 search-debug is admin only", () => {
  it("no token is 401", async () => {
    const s = await setup();
    expect((await s.call(Q, null)).status).toBe(401);
  });
  it("a read token is refused at the gate (403 forbidden), even with the flag on", async () => {
    const s = await setup();
    const res = await s.call(Q, READ);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    expect(s.queries).toEqual([]);
  });
  it("CONTROL: the same read token CAN search, so the refusal is the route, not the token", async () => {
    const s = await setup();
    expect((await s.call("/api/search?mode=semantic&q=deploy", READ)).status).toBe(200);
  });
  it("the admin-only slot is refused (403 E_FORBIDDEN): it cannot read mail, so no rank oracle", async () => {
    const s = await setup();
    const res = await s.call(Q, ADMIN);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("E_FORBIDDEN");
    expect(res.text).not.toContain("vectorId");
    expect(s.queries).toEqual([]);
    // The refusal is audited as the slot itself.
    const rows = s.raw.prepare("SELECT actor_id, outcome FROM audit_log WHERE action = 'search.debug'").all() as Json[];
    expect(rows).toEqual([{ actor_id: "svc_admin", outcome: "refused" }]);
    // CONTROL: the operator clears the same request on the same deploy.
    expect((await s.call(Q, OPERATOR)).status).toBe(200);
  });
  it("the admin slot is refused before the flag check: it cannot learn whether the route is armed", async () => {
    const s = await setup({ debug: null });
    expect((await s.call(Q, ADMIN)).status).toBe(403);
    expect((await s.call(Q, OPERATOR)).status).toBe(404);
  });
  it("the webmail page never names the route", async () => {
    const page = readFileSync(resolve(__dirname, "../webmail/index.html"), "utf8");
    expect(page).not.toContain("search-debug");
    // CONTROL: the scan reads the real page.
    expect(page).toContain("/api/search");
  });
});

describe("#950 search-debug output", () => {
  it("raw: Vectorize order, every field present, before the collapse to messages", async () => {
    const s = await setup();
    const res = await s.call(Q, OPERATOR);
    expect(res.status).toBe(200);
    const raw = res.body.raw as Json[];
    // Every stored chunk vector of this small index comes back (fewer than topK).
    expect(raw.length).toBe(s.index.size);
    expect(res.body.exhausted).toBe(true);
    expect(res.body.floorScore).toBeNull();
    expect(res.body.topK).toBe(50);
    raw.forEach((r, i) => {
      expect(Object.keys(r).sort()).toEqual(["chunk", "exact", "messageId", "rank", "score", "vectorId"]);
      expect(r.exact).toBeCloseTo(r.score, 9); // the stub scores exactly unless told not to
      expect(r.rank).toBe(i + 1);
      expect(typeof r.score).toBe("number");
      expect(typeof r.chunk).toBe("number");
      expect(s.index.get(r.vectorId)?.metadata.message_id).toBe(r.messageId);
      if (i > 0) expect(raw[i - 1].score).toBeGreaterThanOrEqual(r.score);
    });
  });

  it("fused: the same page /api/search returns, each row pointing at its raw rank", async () => {
    const s = await setup();
    const dbg = await s.call(Q + "&limit=3", OPERATOR);
    const live = await s.call("/api/search?mode=semantic&limit=3&q=" + encodeURIComponent("inbound worker deploy failed"), OPERATOR);
    const fused = dbg.body.fused as Json[];
    expect(fused.map((f) => f.messageId)).toEqual((live.body.items as Json[]).map((h) => h.message.messageId));
    expect(fused.length).toBe(3);
    for (const f of fused) {
      expect(Object.keys(f).sort()).toEqual(["messageId", "rank", "rawRank", "score", "similarCount", "threadHitsCount"]);
      const firstRaw = (dbg.body.raw as Json[]).find((r) => r.messageId === f.messageId);
      expect(firstRaw).toBeDefined();
      expect(f.rawRank).toBe(firstRaw!.rank);
    }
  });

  it("hybrid fused: the same page /api/search returns (family cap default applied)", async () => {
    const s = await setup();
    const dbg = await s.call(Q + "&mode=hybrid&limit=4", OPERATOR);
    const live = await s.call("/api/search?mode=hybrid&limit=4&q=" + encodeURIComponent("inbound worker deploy failed"), OPERATOR);
    expect((dbg.body.fused as Json[]).map((f) => f.messageId)).toEqual((live.body.items as Json[]).map((h) => h.message.messageId));
    expect(dbg.body.query.familyCap).toBe(2);
  });

  it("hybrid: the semantic half's raw call is traced too", async () => {
    const s = await setup();
    const res = await s.call(Q + "&mode=hybrid", OPERATOR);
    expect(res.status).toBe(200);
    expect((res.body.raw as Json[]).length).toBeGreaterThan(0);
    expect((res.body.fused as Json[]).length).toBeGreaterThan(0);
  });

  it("ids and scores only: no subject, sender, recipient, date or body in the response", async () => {
    const s = await setup();
    const res = await s.call(Q + "&gold=lunch@x", OPERATOR);
    expect(res.status).toBe(200);
    for (const leak of ["Deploy failed", "Lunch on friday", "ci@builds.example", TO, "2026-11-0", "wrangler step", "friday"]) {
      expect(res.text).not.toContain(leak);
    }
    // CONTROL: the index metadata DOES carry these, so the absence is the route stripping them.
    expect(JSON.stringify([...s.index.values()].map((v) => v.metadata))).toContain("Lunch on friday");
  });

  it("scoreCheck: the recomputed rank-1 cosine matches the Vectorize score", async () => {
    const s = await setup();
    const res = await s.call(Q, OPERATOR);
    expect(res.body.scoreCheck.vectorId).toBe(res.body.raw[0].vectorId);
    expect(res.body.scoreCheck.delta).toBeLessThan(1e-9);
  });

  it("audit: one search.debug row with the query length, never the query", async () => {
    const s = await setup();
    await s.call(Q, OPERATOR);
    const rows = s.raw.prepare("SELECT actor_id, action, outcome, detail FROM audit_log WHERE action = 'search.debug'").all() as Json[];
    expect(rows.length).toBe(1);
    expect(rows[0].actor_id).toBe("svc_both");
    expect(JSON.parse(rows[0].detail)).toEqual({ mode: "semantic", limit: 10, qLength: "inbound worker deploy failed".length, gold: false });
    expect(rows[0].detail).not.toContain("inbound");
  });

  for (const [qs, why] of [
    ["?mode=semantic", "q missing"],
    ["?q=x&mode=fts", "mode not score-ranked"],
    ["?q=x&limit=0", "limit 0"],
    ["?q=x&limit=51", "limit over 50"],
    ["?q=x&limit=abc", "limit not a number"],
    ["?q=x&gold=", "empty gold"],
  ]) {
    it(`400 on ${why}`, async () => {
      const s = await setup();
      expect((await s.call("/api/admin/search-debug" + qs, OPERATOR)).status).toBe(400);
    });
  }
});

describe("#950 gold: where the expected message sits in the raw list", () => {
  const goldQ = (id: string) => Q + "&gold=" + encodeURIComponent(id);

  it("in-raw: a gold vector Vectorize returned, with its raw and fused rank", async () => {
    const s = await setup();
    const res = await s.call(goldQ("<deploy-2@ci>"), OPERATOR);
    const g = res.body.gold;
    expect(g.messageId).toBe("deploy-2@ci");
    expect(g.verdict).toBe("in-raw");
    expect(g.chunks.length).toBeGreaterThan(0);
    expect(g.chunks[0].rawRank).not.toBeNull();
    expect(g.chunks[0].embedVersion).toBe(EMBED_VERSION);
    expect(g.fusedRank).not.toBeNull();
  });

  it("not-indexed: a message with no ledger rows", async () => {
    const s = await setup();
    expect((await s.call(goldQ("nobody@x"), OPERATOR)).body.gold.verdict).toBe("not-indexed");
  });

  it("ann-miss: Vectorize drops a vector whose exact cosine beats the floor", async () => {
    const s = await setup({ filler: 60 });
    const before = await s.call(goldQ("deploy-2@ci"), OPERATOR);
    expect(before.body.gold.verdict).toBe("in-raw"); // CONTROL: same index, nothing dropped
    for (const c of before.body.gold.chunks) s.dropped.add(c.vectorId);
    const res = await s.call(goldQ("deploy-2@ci"), OPERATOR);
    expect(res.body.exhausted).toBe(false);
    expect(typeof res.body.floorScore).toBe("number");
    expect(res.body.gold.verdict).toBe("ann-miss");
    expect(res.body.gold.bestCosine).toBeGreaterThan(res.body.floorScore);
    expect(res.body.gold.fusedRank).toBeNull();
  });

  it("outranked: an exact cosine below the floor, crowded out of a full topK", async () => {
    const s = await setup({ filler: 60 });
    const res = await s.call(goldQ("invoice@x"), OPERATOR);
    expect(res.body.exhausted).toBe(false);
    expect(res.body.gold.verdict).toBe("outranked");
    expect(res.body.gold.bestCosine).toBeLessThanOrEqual(res.body.floorScore);
  });

  it("vectors-missing: ledger rows whose vectors the index no longer holds", async () => {
    const s = await setup();
    for (const [id, v] of s.index) if (v.metadata.message_id === "lunch@x") s.index.delete(id);
    expect((await s.call(goldQ("lunch@x"), OPERATOR)).body.gold.verdict).toBe("vectors-missing");
  });
});

describe("#950 approximate scoring: verdicts on the exact scale", () => {
  const goldQ = (id: string) => Q + "&gold=" + encodeURIComponent(id);

  it("every raw match carries its exact cosine, and floorExact is the lowest exact score of a full list", async () => {
    const s = await setup({ filler: 60, approxOffset: 0.1 });
    const res = await s.call(goldQ("deploy-2@ci"), OPERATOR);
    const raw = res.body.raw as Json[];
    expect(raw.length).toBe(50);
    for (const r of raw) {
      expect(typeof r.exact).toBe("number");
      expect(r.score - r.exact).toBeCloseTo(0.1, 9);
    }
    expect(res.body.floorExact).toBeCloseTo(Math.min(...raw.map((r) => r.exact)), 12);
    expect(res.body.approxError.n).toBe(50);
    expect(res.body.approxError.max).toBeCloseTo(0.1, 9);
    expect(res.body.approxError.median).toBeCloseTo(0.1, 9);
  });

  it("scoreCheck reports the approximate-scoring gap instead of hiding it", async () => {
    const s = await setup({ approxOffset: 0.1 });
    const res = await s.call(Q, OPERATOR);
    expect(res.body.scoreCheck.delta).toBeCloseTo(0.1, 9);
  });

  it("ann-miss on the exact scale: the gold beats the exact floor though it is below the approximate one", async () => {
    // 0.5, not production's 0.1: in this small corpus the gold sits about 0.35 above the exact
    // floor, and the case needs it BETWEEN the exact floor and the approximate one.
    const s = await setup({ filler: 60, approxOffset: 0.5 });
    const before = await s.call(goldQ("deploy-2@ci"), OPERATOR);
    expect(before.body.gold.verdict).toBe("in-raw"); // CONTROL: nothing dropped yet
    for (const c of before.body.gold.chunks) s.dropped.add(c.vectorId);
    const res = await s.call(goldQ("deploy-2@ci"), OPERATOR);
    const g = res.body.gold;
    // The premise of this case: the mixed-scale comparison would call it outranked.
    expect(g.bestCosine).toBeLessThanOrEqual(res.body.floorScore);
    expect(g.bestCosine).toBeGreaterThan(res.body.floorExact);
    expect(g.verdict).toBe("ann-miss");
  });

  it("outranked on the exact scale stays outranked", async () => {
    const s = await setup({ filler: 60, approxOffset: 0.1 });
    const res = await s.call(goldQ("invoice@x"), OPERATOR);
    expect(res.body.gold.verdict).toBe("outranked");
    expect(res.body.gold.bestCosine).toBeLessThanOrEqual(res.body.floorExact);
  });

  it("exactRankInRaw: where exact scores would place the gold among the returned messages", async () => {
    const s = await setup({ approxOffset: 0.1 });
    const res = await s.call(goldQ("deploy-2@ci"), OPERATOR);
    const raw = res.body.raw as Json[];
    const best = new Map<string, number>();
    for (const r of raw) best.set(r.messageId, Math.max(best.get(r.messageId) ?? -2, r.exact));
    const g = best.get("deploy-2@ci")!;
    const above = [...best.entries()].filter(([id, v]) => id !== "deploy-2@ci" && v > g).length;
    expect(res.body.gold.exactRankInRaw).toBe(above + 1);
  });
});

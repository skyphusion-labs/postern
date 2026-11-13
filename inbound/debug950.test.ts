// #950: eval/debug950.mjs, the live-measurement driver for the operator debug route (#952).
// A stubbed fetch stands in for the deploy. Each window-1 finding has a test here:
//   (1) the class is found by a literal CONTAINS match over an FTS listing (any age), so a
//       "[owner/repo] PR run failed:" subject counts, and "." is never a pattern;
//   (2) controls need in-raw + found on the EXACT scale, not raw rank 1 and not a score delta;
//       a route without the exact scale is NOT TRUSTED;
//   (3) semantic always reads the topK-50 pool, so there is one semantic debug call, not two;
// plus the raw message rank, every reading, and that no subject, sender, Message-ID or vector
// id reaches the output. The live ranking itself is proven only by the operator window.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- eval/ is plain ESM with no type declarations
import { classify, controlOk, readDebug, run, selectClass, selectControls, familyCounts, summarize, parseGoldFile, goldFileModeOk, routeOf, readGoldFile, GOLD_MAX_IDS } from "./eval/debug950.mjs";

const SENDER = "notifications@github.example";
const SECRET_WORD = "zanzibar";
const cls = (n: number, sha: string) => ({
  messageId: `actions-${n}-${SECRET_WORD}@mail.example`,
  subject: `[skyphusion-labs/${SECRET_WORD}] PR run failed: CI - ${SECRET_WORD} widget (${sha})`,
  from: `GitHub <${SENDER}>`,
  date: `2026-11-12T00:${String(n).padStart(2, "0")}:00Z`,
});
const uniq = (n: number) => ({
  messageId: `unique-${n}-${SECRET_WORD}@mail.example`,
  subject: `Invoice ${SECRET_WORD} for client ${"abcdefgh"[n]}`,
  from: `Person${"abcdefgh"[n]} <p${n}@example.org>`,
  date: `2026-11-11T00:0${n}:00Z`,
});
const OPTS = { classMatch: "PR run failed:", min: 8, controls: 3, window: 80, classLimit: 200 };

const rawOf = (ids: string[], offset = 0.1) =>
  ids.map((messageId, i) => ({ rank: i + 1, vectorId: `vec-${SECRET_WORD}-${i}`, score: 0.9 - i * 0.001 + offset, exact: 0.9 - i * 0.001, chunk: 0, messageId }));
type B = { verdict: string; exactRankInRaw?: number | null; exactScale?: boolean };
const debugBody = (ids: string[], o: B) => {
  const raw = rawOf(ids);
  const body: Record<string, unknown> = {
    ok: true,
    topK: 50,
    exhausted: false,
    floorScore: raw[raw.length - 1]?.score ?? null,
    raw,
    fused: [],
    scoreCheck: { delta: 0.1 },
    gold: { verdict: o.verdict, bestCosine: 0.88, exactRankInRaw: o.exactRankInRaw ?? null, fusedRank: null, chunks: [] },
  };
  if (o.exactScale === false) {
    // A route from before this change: no exact scores, no floorExact.
    for (const r of raw as Array<Record<string, unknown>>) delete r.exact;
  } else {
    body.floorExact = raw[raw.length - 1]?.exact ?? null;
    body.approxError = { n: raw.length, max: 0.1, median: 0.1 };
  }
  return body;
};

describe("(1) the class: a literal CONTAINS match, at any age", () => {
  it("a bracket-prefixed GitHub subject is in the class (window 1 matched none with a prefix)", () => {
    expect(selectClass([cls(1, "aaaaaaa"), uniq(1)], OPTS).map((m: { messageId: string }) => m.messageId)).toEqual([cls(1, "a").messageId]);
  });
  it("the match is literal text, never a regular expression", () => {
    expect(selectClass([cls(1, "aaaaaaa"), uniq(1)], { ...OPTS, classMatch: "." })).toHaveLength(0);
    expect(selectClass([cls(1, "aaaaaaa")], { ...OPTS, classMatch: "PR.run" })).toHaveLength(0);
  });
  it("takes the newest --min", () => {
    const many = Array.from({ length: 12 }, (_, i) => cls(i + 1, "abcdef" + i));
    expect(selectClass(many, OPTS)).toHaveLength(8);
  });
  it("controls: unique shape in the window, never a class message, never a repeated family", () => {
    const twin = { ...uniq(1), messageId: "twin@mail.example" };
    const listed = [cls(1, "aaaaaaa"), uniq(1), twin, uniq(2), uniq(3), uniq(4)];
    const out = selectControls(listed, familyCounts(listed), OPTS).map((m: { messageId: string }) => m.messageId);
    expect(out).toEqual([uniq(2), uniq(3), uniq(4)].map((m) => m.messageId));
  });
  it("familyCounts counts a message once even when both listings carry it", () => {
    const a = cls(1, "aaaaaaa");
    expect([...familyCounts([a, a, cls(2, "bbbbbbb")]).values()]).toEqual([2]);
  });
});

describe("readDebug", () => {
  const fam = (id: string) => (id.startsWith("actions") ? "F" : "other");
  it("raw MESSAGE rank counts distinct messages before the gold, not vectors", () => {
    const r = readDebug(debugBody(["m1", "m1", "m2", "m1", "gold"], { verdict: "in-raw" }), "gold", "F", fam);
    expect(r.rawVectorRank).toBe(5);
    expect(r.rawMessageRank).toBe(3);
  });
  it("counts the gold family members in raw", () => {
    expect(readDebug(debugBody(["actions-1", "u", "actions-2", "actions-2", "gold"], { verdict: "in-raw" }), "gold", "F", fam).familyInRaw).toBe(2);
  });
  it("(2) exactScored only when the route gives floorExact and an exact score on every raw match", () => {
    expect(readDebug(debugBody(["gold"], { verdict: "in-raw" }), "gold", "F", fam).exactScored).toBe(true);
    expect(readDebug(debugBody(["gold"], { verdict: "in-raw", exactScale: false }), "gold", "F", fam).exactScored).toBe(false);
  });
  it("carries the exact rank and the approximate gap through", () => {
    const r = readDebug(debugBody(["a", "gold"], { verdict: "in-raw", exactRankInRaw: 1 }), "gold", "F", fam);
    expect(r.exactRankInRaw).toBe(1);
    expect(r.approxErrorMax).toBe(0.1);
    expect(r.floorExact).toBe(0.899);
  });
  it("a refused or failed response is an error row, never a verdict", () => {
    expect(readDebug({ ok: false, error: "E_NOT_FOUND" }, "gold", "F", fam)).toEqual({ error: "E_NOT_FOUND" });
  });
});

describe("classify and controlOk", () => {
  const sem = (verdict: string, exactScored = true) => ({ verdict, exactScored, rawMessageRank: 1 });
  it("found wins", () => expect(classify({ sem10: sem("in-raw"), found: true })).toBe("found"));
  it("in-raw and not found is a loss after retrieval", () => expect(classify({ sem10: sem("in-raw"), found: false })).toBe("in-raw-not-found"));
  it("ann-miss, outranked and the index verdicts pass through", () => {
    for (const v of ["ann-miss", "outranked", "not-indexed", "vectors-missing", "unscored"]) expect(classify({ sem10: sem(v), found: false })).toBe(v);
  });
  it("(2) no verdict is read without the exact scale", () => {
    expect(classify({ sem10: sem("outranked", false), found: false })).toBe("no-exact-scale");
  });
  it("(2) a control is in-raw and found on the exact scale; raw rank 2 is fine", () => {
    expect(controlOk({ sem10: { verdict: "in-raw", exactScored: true, rawMessageRank: 2 }, found: true })).toBe(true);
    expect(controlOk({ sem10: { verdict: "in-raw", exactScored: true, rawMessageRank: 1 }, found: false })).toBe(false);
    expect(controlOk({ sem10: { verdict: "in-raw", exactScored: false, rawMessageRank: 1 }, found: true })).toBe(false);
    expect(controlOk({ sem10: { verdict: "outranked", exactScored: true, rawMessageRank: null }, found: true })).toBe(false);
  });
});

/** A stubbed deploy: 12 re-runs of one workflow on one PR (older than the window), 3 uniques. */
function deploy(o: { lostEvery?: number; exactScale?: boolean } = {}) {
  const actions = Array.from({ length: 12 }, (_, i) => cls(i + 1, (i + 1).toString(16).padStart(7, "e")));
  const uniques = [uniq(1), uniq(2), uniq(3)];
  const window = uniques; // window 1's shape: no class message among the newest
  const calls: string[] = [];
  const get = async (path: string) => {
    const url = new URL("https://x" + path);
    calls.push(url.pathname + (url.searchParams.get("mode") ? `:${url.searchParams.get("mode")}` : "") + (url.searchParams.get("q") && url.pathname === "/api/messages" ? ":fts" : ""));
    if (url.pathname === "/api/messages") return { items: url.searchParams.get("q") ? actions : window };
    const gold = url.searchParams.get("gold");
    const q = url.searchParams.get("q") ?? "";
    const lost = (i: number) => o.lostEvery !== undefined && i % o.lostEvery === 0;
    if (url.pathname === "/api/admin/search-debug") {
      const others = [...actions, ...uniques].map((m) => m.messageId).filter((id) => id !== gold);
      return debugBody([others[0], gold!, ...others.slice(1)], { verdict: "in-raw", exactRankInRaw: 2, exactScale: o.exactScale });
    }
    if (url.pathname === "/api/search") {
      const target = [...actions, ...uniques].find((m) => m.subject === q)!;
      const ai = actions.indexOf(target);
      if (ai >= 0 && lost(ai)) return { items: [{ message: { messageId: "sibling" }, similar: { ids: ["other"] } }] };
      return { items: [{ message: { messageId: "first" } }, { message: { messageId: target.messageId }, similar: { ids: [] } }] };
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  return { get, calls };
}

describe("run: end to end on a stubbed deploy", () => {
  it("finds the class outside the window via FTS, reads every probe, trusts the controls", async () => {
    const { get, calls } = deploy({ lostEvery: 2 });
    const res = await run(get, OPTS);
    expect(res.classProbes).toBe(8);
    const readings = res.rows.filter((r: { kind: string }) => r.kind === "class").map((r: { reading: string }) => r.reading);
    expect(readings.filter((x: string) => x === "in-raw-not-found")).toHaveLength(4);
    expect(readings.filter((x: string) => x === "found")).toHaveLength(4);
    expect(res.rows.filter((r: { kind: string }) => r.kind === "control").every((r: { reading: string }) => r.reading === "control-ok")).toBe(true);
    // (3) one FTS class listing, one window listing; then 1 semantic + 1 hybrid debug call and 1 search per probe.
    expect(calls.filter((c) => c === "/api/messages:fts")).toHaveLength(1);
    expect(calls.filter((c) => c === "/api/admin/search-debug:semantic")).toHaveLength(11);
    expect(calls.filter((c) => c === "/api/admin/search-debug:hybrid")).toHaveLength(11);
    expect(calls.filter((c) => c === "/api/search:semantic")).toHaveLength(11);
    const text = summarize(res);
    expect(text).toContain("controls ok: 3 of 3");
    expect(text).toContain("in-raw-not-found 4");
    expect(text).toContain("semantic pool topK seen: 50 (expected 50)");
    expect(text).toContain("approximate-scoring gap (max per probe): 0.1 to 0.1");
  });

  it("(2) a deploy whose route predates the exact scale is NOT TRUSTED and gives no readings", async () => {
    const { get } = deploy({ exactScale: false });
    const res = await run(get, OPTS);
    expect(res.rows.filter((r: { kind: string }) => r.kind === "class").every((r: { reading: string }) => r.reading === "no-exact-scale")).toBe(true);
    const text = summarize(res);
    expect(text).toContain("INSTRUMENT NOT TRUSTED");
    expect(text).toContain("predates floorExact");
  });

  it("(1) no class match is said out loud, not read as a clean run", async () => {
    const get = async (path: string) => {
      if (path.startsWith("/api/messages")) return { items: [uniq(1)] };
      if (path.startsWith("/api/admin/search-debug")) return debugBody(["x", uniq(1).messageId], { verdict: "in-raw" });
      return { items: [{ message: { messageId: uniq(1).messageId } }] };
    };
    const text = summarize(await run(get, OPTS));
    expect(text).toContain("class probes: none matched");
  });

  it("PRIVACY: no subject, sender, Message-ID or vector id reaches the summary or the JSON rows", async () => {
    const { get } = deploy({ lostEvery: 3 });
    const res = await run(get, OPTS);
    const out = summarize(res) + "\n" + JSON.stringify(res.rows);
    // CONTROL: the stub really carries the planted word, so its absence below means something.
    expect(JSON.stringify(await get("/api/messages?direction=inbound&q=PR&limit=200"))).toContain(SECRET_WORD);
    expect(out).not.toContain(SECRET_WORD);
    expect(out).not.toContain(SENDER);
    expect(out).not.toMatch(/@mail\.example|vec-|PR run failed|skyphusion-labs/);
  });

  it("an armed-off deploy (404) gives error rows and an untrusted instrument, never verdicts", async () => {
    const get = async (path: string) => {
      if (path.startsWith("/api/messages")) return { items: [cls(1, "aaaaaaa"), uniq(1)] };
      if (path.startsWith("/api/admin/search-debug")) throw new Error("GET /api/admin/search-debug failed: HTTP 404");
      return { items: [] };
    };
    const res = await run(get, { ...OPTS, min: 1, controls: 1 });
    expect(res.rows[0].reading).toBe("error");
    expect(summarize(res)).toContain("INSTRUMENT NOT TRUSTED");
  });
});

// #963: --gold-file. Named messages (from an operator-private file) instead of a class.
describe("#963 --gold-file", () => {
  it("parses Message-IDs, as strings or { messageId }, strips angle brackets, drops repeats", () => {
    const a = cls(1, "aaaaaaa").messageId;
    const b = uniq(1).messageId;
    expect(parseGoldFile(JSON.stringify([`<${a}>`, { messageId: b }, a]))).toEqual([a, b]);
  });
  it("refuses a bad file without echoing its content", () => {
    for (const bad of [`not json ${SECRET_WORD}`, "[]", "{}", JSON.stringify([1]), JSON.stringify([""]), JSON.stringify(Array(GOLD_MAX_IDS + 1).fill(`x-${SECRET_WORD}`))]) {
      let msg = "";
      try {
        parseGoldFile(bad);
      } catch (e) {
        msg = String((e as Error).message);
      }
      expect(msg).toMatch(/^gold file: /);
      expect(msg).not.toContain(SECRET_WORD);
    }
  });
  it("the file must be owner-only (600 or 400); group or other read is refused", () => {
    expect(goldFileModeOk(0o100600)).toBe(true);
    expect(goldFileModeOk(0o100400)).toBe(true);
    expect(goldFileModeOk(0o100640)).toBe(false);
    expect(goldFileModeOk(0o100644)).toBe(false);
    expect(goldFileModeOk(0o100604)).toBe(false);
  });
  it("the file is checked and read through ONE descriptor (no check-then-read race on the path)", () => {
    const calls: string[] = [];
    const body = JSON.stringify([cls(1, "a").messageId]);
    const fake = (mode: number) => ({
      openSync: (p: string) => { calls.push(`open ${p === "/g.json" ? "path" : "?"}`); return 7; },
      fstatSync: (fd: number) => { calls.push(`fstat ${fd}`); return { mode }; },
      readFileSync: (fd: number | string) => { calls.push(`read ${typeof fd === "number" ? fd : "path"}`); return body; },
      closeSync: (fd: number) => { calls.push(`close ${fd}`); },
      statSync: () => { calls.push("stat path"); return { mode }; },
    });
    expect(readGoldFile("/g.json", fake(0o100600))).toEqual([cls(1, "a").messageId]);
    expect(calls).toEqual(["open path", "fstat 7", "read 7", "close 7"]);
    // A file others can read is refused, and the descriptor is still closed.
    calls.length = 0;
    expect(() => readGoldFile("/g.json", fake(0o100644))).toThrow(/^gold file: group or others/);
    expect(calls).toEqual(["open path", "fstat 7", "close 7"]);
  });
  it("on a real file: mode 600 reads, mode 644 is refused", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g963-"));
    try {
      const f = path.join(dir, "gold.json");
      fs.writeFileSync(f, JSON.stringify([uniq(1).messageId]), { mode: 0o600 });
      fs.chmodSync(f, 0o600);
      expect(readGoldFile(f, fs)).toEqual([uniq(1).messageId]);
      fs.chmodSync(f, 0o644);
      expect(() => readGoldFile(f, fs)).toThrow(/^gold file: /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("an error names a message lookup as /api/messages/<id>, never its Message-ID", () => {
    expect(routeOf(`/api/messages/${encodeURIComponent(cls(1, "a").messageId)}`)).toBe("/api/messages/<id>");
    expect(routeOf("/api/messages?direction=inbound&q=x")).toBe("/api/messages");
    expect(routeOf("/api/search?q=secret")).toBe("/api/search");
  });

  /** The stubbed deploy, plus GET /api/messages/<id> and search collapse=0 (a gold lost with collapse on, found with it off). */
  function goldDeploy() {
    const d = deploy({ lostEvery: 2 });
    const all = [...Array.from({ length: 12 }, (_, i) => cls(i + 1, (i + 1).toString(16).padStart(7, "e"))), uniq(1), uniq(2), uniq(3)];
    const calls: string[] = [];
    const get = async (path: string) => {
      const url = new URL("https://x" + path);
      if (url.pathname.startsWith("/api/messages/")) {
        calls.push("/api/messages/<id>");
        const id = decodeURIComponent(url.pathname.slice("/api/messages/".length));
        const m = all.find((x) => x.messageId === id);
        if (!m) throw new Error(`GET ${routeOf(path)} failed: HTTP 404`);
        return { ok: true, message: { subject: m.subject, from: m.from, date: m.date } };
      }
      if (url.pathname === "/api/search" && url.searchParams.get("collapse") === "0") {
        calls.push("/api/search:semantic:c0");
        const m = all.find((x) => x.subject === url.searchParams.get("q"))!;
        return { items: [{ message: { messageId: m.messageId } }] };
      }
      if (url.pathname === "/api/messages") calls.push(url.searchParams.get("q") ? "/api/messages:fts" : "/api/messages");
      else calls.push(url.pathname + ":" + (url.searchParams.get("mode") ?? ""));
      return d.get(path);
    };
    return { get, calls };
  }

  it("reads each gold by its Message-ID, makes the class calls plus collapse=0, and never runs the FTS class listing", async () => {
    const { get, calls } = goldDeploy();
    // cls(2, ...): its Message-ID does not depend on the sha. The second gold is not in the mailbox.
    const golds = [cls(2, "a").messageId, "absent-" + SECRET_WORD + "@mail.example"];
    const res = await run(get, { ...OPTS, golds });
    expect(res.probeKind).toBe("gold");
    expect(res.classProbes).toBe(1);
    expect(res.goldMissing).toBe(1);
    expect(calls.filter((c) => c === "/api/messages:fts")).toHaveLength(0);
    expect(calls.filter((c) => c === "/api/messages/<id>")).toHaveLength(2);
    expect(calls.filter((c) => c === "/api/search:semantic:c0")).toHaveLength(1);
    const g = res.rows.find((r: { kind: string }) => r.kind === "gold");
    // cls(2) is actions index 1: lostEvery 2 loses even indices only, so it is found.
    expect(g.reading).toBe("found");
    expect(g.found0).toBe(true);
    expect(g.strict0).toBe(1);
    const text = summarize(res);
    expect(text).toContain("#963 debug: 1 gold probes from the gold file (1 not readable)");
    expect(text).toContain("gold readings: found 1");
    expect(text).toContain("found0 strict0");
  });

  it("a gold lost with collapse on is read as such, and its collapse=0 reading is separate", async () => {
    const { get } = goldDeploy();
    const res = await run(get, { ...OPTS, golds: [cls(1, "a").messageId] }); // actions index 0: lost (0 % 2 == 0)
    const g = res.rows.find((r: { kind: string }) => r.kind === "gold");
    expect(g.reading).toBe("in-raw-not-found");
    expect(g.found0).toBe(true);
  });

  it("a gold is never also a control", async () => {
    const { get } = goldDeploy();
    const res = await run(get, { ...OPTS, golds: [uniq(1).messageId] });
    const controls = res.rows.filter((r: { kind: string }) => r.kind === "control").length;
    expect(controls).toBe(2); // uniq(2) and uniq(3); uniq(1) is the gold
    expect(res.rows.filter((r: { kind: string }) => r.kind === "gold")).toHaveLength(1);
  });

  it("PRIVACY: no gold Message-ID, subject or sender reaches the summary or the JSON rows", async () => {
    const { get } = goldDeploy();
    const res = await run(get, { ...OPTS, golds: [cls(3, "a").messageId, uniq(2).messageId] });
    const out = summarize(res) + "\n" + JSON.stringify(res.rows);
    expect(out).not.toContain(SECRET_WORD);
    expect(out).not.toContain(SENDER);
    expect(out).not.toMatch(/@mail\.example|vec-|PR run failed|skyphusion-labs/);
  });
});

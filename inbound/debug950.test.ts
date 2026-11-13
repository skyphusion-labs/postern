// #950: eval/debug950.mjs, the live-measurement driver for the operator debug route (#952).
// A stubbed fetch stands in for the deploy. Proves: the probe selection (the class from the
// newest 80, the newest-200 fallback, unique-shape controls); the raw MESSAGE rank (distinct
// messages before the gold, the position the slice to `limit` cuts on); every row of the
// decision table fixed on #950 before the window; the control and scoreCheck guards; and that
// no subject, sender, Message-ID or vector id reaches the output. The live ranking itself is
// proven only by the operator window.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- eval/ is plain ESM with no type declarations
import { classify, controlOk, readDebug, run, selectProbes, summarize } from "./eval/debug950.mjs";

const SENDER = "notifications@github.example";
const SECRET_WORD = "zanzibar";
const cls = (n: number, sha: string) => ({
  messageId: `actions-${n}-${SECRET_WORD}@mail.example`,
  subject: `PR run failed: CI - ${SECRET_WORD} widget (${sha})`,
  from: `GitHub <${SENDER}>`,
  date: `2026-11-12T00:${String(n).padStart(2, "0")}:00Z`,
});
const uniq = (n: number) => ({
  messageId: `unique-${n}-${SECRET_WORD}@mail.example`,
  subject: `Invoice ${SECRET_WORD} for client ${"abcdefgh"[n]}`,
  from: `Person${"abcdefgh"[n]} <p${n}@example.org>`,
  date: `2026-11-11T00:0${n}:00Z`,
});

/** raw list: one vector per message id, in order; a message may repeat (more chunks). */
const rawOf = (ids: string[]) => ids.map((messageId, i) => ({ rank: i + 1, vectorId: `vec-${SECRET_WORD}-${i}`, score: 0.9 - i * 0.001, chunk: 0, messageId }));
const debugBody = (ids: string[], verdict: string, opts: { delta?: number; fusedRank?: number | null; topK?: number } = {}) => ({
  ok: true,
  topK: opts.topK ?? 30,
  exhausted: false,
  floorScore: 0.85,
  raw: rawOf(ids),
  fused: [],
  scoreCheck: { vectorId: `vec-${SECRET_WORD}-0`, vectorizeScore: 0.9, recomputed: 0.9, delta: opts.delta ?? 0 },
  gold: { messageId: "x", verdict, bestCosine: 0.88, fusedRank: opts.fusedRank ?? null, chunks: [] },
});

describe("selectProbes", () => {
  it("takes the class from the window, and controls of a unique shape that are not in the class", () => {
    const listed = [cls(1, "aaaaaaa"), uniq(1), cls(2, "bbbbbbb"), uniq(2), uniq(3), uniq(4)];
    const { cls: c, controls, source } = selectProbes(listed, listed, { classPrefix: "PR run failed:", min: 2, controls: 3 });
    expect(source).toBe("window");
    expect(c.map((m: { messageId: string }) => m.messageId)).toEqual([cls(1, "a").messageId, cls(2, "b").messageId]);
    expect(controls.map((m: { messageId: string }) => m.messageId)).toEqual([uniq(1), uniq(2), uniq(3)].map((m) => m.messageId));
  });
  it("falls back to the newest --min from the wide listing when the window has too few", () => {
    const listed = [cls(1, "aaaaaaa"), uniq(1)];
    const wide = [...listed, cls(2, "bbbbbbb"), cls(3, "ccccccc"), cls(4, "ddddddd")];
    const r = selectProbes(listed, wide, { classPrefix: "PR run failed:", min: 3, controls: 1 });
    expect(r.source).toBe("wide");
    expect(r.cls).toHaveLength(3);
  });
  it("the class prefix is literal text, never a regular expression", () => {
    const listed = [cls(1, "aaaaaaa"), uniq(1)];
    // "." as a pattern would match every subject; as a literal prefix it matches none.
    expect(selectProbes(listed, listed, { classPrefix: ".", min: 0, controls: 0 }).cls).toHaveLength(0);
    expect(selectProbes(listed, listed, { classPrefix: "PR run", min: 0, controls: 0 }).cls).toHaveLength(1);
  });
  it("a message whose family repeats in the listing is never a control", () => {
    const twin = { ...uniq(1), messageId: "twin@mail.example" };
    const r = selectProbes([uniq(1), twin, uniq(2)], undefined, { classPrefix: "PR run failed:", min: 1, controls: 3 });
    expect(r.controls.map((m: { messageId: string }) => m.messageId)).toEqual([uniq(2).messageId]);
  });
});

describe("readDebug: the raw MESSAGE rank", () => {
  const fam = (id: string) => (id.startsWith("actions") ? "F" : "other");
  it("counts distinct messages before the gold, not vectors", () => {
    // m1 has three chunks ahead of the gold: vector rank 5, message rank 3.
    const r = readDebug(debugBody(["m1", "m1", "m2", "m1", "gold"], "in-raw"), "gold", "F", fam);
    expect(r.rawVectorRank).toBe(5);
    expect(r.rawMessageRank).toBe(3);
  });
  it("counts the gold family members in raw", () => {
    const r = readDebug(debugBody(["actions-1", "u", "actions-2", "actions-2", "gold"], "in-raw"), "gold", "F", fam);
    expect(r.familyInRaw).toBe(2);
  });
  it("a gold absent from raw has no rank", () => {
    expect(readDebug(debugBody(["a", "b"], "outranked"), "gold", "F", fam).rawMessageRank).toBeNull();
  });
  it("trusts a cosine only under the scoreCheck delta bound", () => {
    expect(readDebug(debugBody(["gold"], "in-raw", { delta: 0 }), "gold", "F", fam).scoreTrusted).toBe(true);
    expect(readDebug(debugBody(["gold"], "in-raw", { delta: 0.01 }), "gold", "F", fam).scoreTrusted).toBe(false);
  });
  it("a refused or failed response is an error row, never a verdict", () => {
    expect(readDebug({ ok: false, error: "E_NOT_FOUND" }, "gold", "F", fam)).toEqual({ error: "E_NOT_FOUND" });
  });
});

describe("classify: the #950 decision table", () => {
  const at = (verdict: string, rawMessageRank: number | null) => ({ verdict, rawMessageRank });
  it("in-raw past the limit and not found is H1 (cut before the family tiebreak)", () => {
    expect(classify({ sem10: at("in-raw", 12), sem50: at("in-raw", 12), found: false })).toBe("H1-cut-before-tiebreak");
  });
  it("CONTROL: the same gold at message rank 1 and found is not H1", () => {
    expect(classify({ sem10: at("in-raw", 1), sem50: at("in-raw", 1), found: true })).toBe("found");
  });
  it("in-raw inside the limit and still not found is a post-retrieval defect", () => {
    expect(classify({ sem10: at("in-raw", 3), sem50: at("in-raw", 3), found: false })).toBe("post-retrieval-defect");
  });
  it("outranked at limit 10 but in-raw at limit 50 is H1 with a shallow pool", () => {
    expect(classify({ sem10: at("outranked", null), sem50: at("in-raw", 40), found: false })).toBe("H1-shallow-pool");
  });
  it("outranked at 50 too is past the ceiling", () => {
    expect(classify({ sem10: at("outranked", null), sem50: at("outranked", null), found: false })).toBe("outranked-at-50");
  });
  it("ann-miss and the index verdicts pass through", () => {
    expect(classify({ sem10: at("ann-miss", null), found: false })).toBe("ann-miss");
    expect(classify({ sem10: at("not-indexed", null), found: false })).toBe("not-indexed");
  });
  it("a control must be in-raw at message rank 1 with a trusted score", () => {
    expect(controlOk({ sem10: { verdict: "in-raw", rawMessageRank: 1, scoreTrusted: true } })).toBe(true);
    expect(controlOk({ sem10: { verdict: "in-raw", rawMessageRank: 2, scoreTrusted: true } })).toBe(false);
    expect(controlOk({ sem10: { verdict: "in-raw", rawMessageRank: 1, scoreTrusted: false } })).toBe(false);
  });
});

/** A stubbed deploy: 12 re-runs of one workflow on one PR, and 3 unique messages. */
function deploy(goldRankOf: (goldIndex: number) => number) {
  const actions = Array.from({ length: 12 }, (_, i) => cls(i + 1, (i + 1).toString(16).padStart(7, "e")));
  const uniques = [uniq(1), uniq(2), uniq(3)];
  const listing = [...actions, ...uniques];
  const calls: string[] = [];
  const get = async (path: string) => {
    calls.push(path.split("?")[0]);
    const url = new URL("https://x" + path);
    if (url.pathname === "/api/messages") return { items: listing };
    const gold = url.searchParams.get("gold");
    const q = url.searchParams.get("q") ?? "";
    if (url.pathname === "/api/admin/search-debug") {
      const ui = uniques.findIndex((m) => m.messageId === gold);
      if (ui >= 0) return debugBody([gold!, ...actions.map((m) => m.messageId)], "in-raw");
      const gi = actions.findIndex((m) => m.messageId === gold);
      const rank = goldRankOf(gi);
      const others = actions.filter((m) => m.messageId !== gold).map((m) => m.messageId);
      const ids = [...others.slice(0, rank - 1), gold!, ...others.slice(rank - 1)];
      return debugBody(ids, "in-raw");
    }
    if (url.pathname === "/api/search") {
      const target = [...actions, ...uniques].find((m) => m.subject === q)!;
      const ui = uniques.indexOf(target);
      if (ui >= 0) return { items: [{ message: { messageId: target.messageId } }] };
      const rank = goldRankOf(actions.indexOf(target));
      // Today's code: the gold is visible only when its raw message rank is inside the slice.
      return { items: rank <= 10 ? [{ message: { messageId: target.messageId }, similar: { ids: [] } }] : [{ message: { messageId: "sibling" }, similar: { ids: ["other"] } }] };
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  return { get, calls };
}

describe("run: end to end on a stubbed deploy", () => {
  const opts = { classPrefix: "PR run failed:", min: 8, controls: 3, window: 80, wideWindow: 200 };
  it("reads H1 for the golds cut past rank 10, found for the rest, and trusts the controls", async () => {
    const { get, calls } = deploy((i) => (i % 2 === 0 ? 12 : 2));
    const res = await run(get, opts);
    expect(res.classProbes).toBe(12);
    const readings = res.rows.filter((r: { kind: string }) => r.kind === "class").map((r: { reading: string }) => r.reading);
    expect(readings.filter((x: string) => x === "H1-cut-before-tiebreak")).toHaveLength(6);
    expect(readings.filter((x: string) => x === "found")).toHaveLength(6);
    expect(res.rows.filter((r: { kind: string }) => r.kind === "control").every((r: { reading: string }) => r.reading === "control-ok")).toBe(true);
    // 2 listings, then 3 debug calls and 1 search per probe.
    expect(calls.filter((c) => c === "/api/admin/search-debug")).toHaveLength(15 * 3);
    expect(calls.filter((c) => c === "/api/search")).toHaveLength(15);
    const text = summarize(res);
    expect(text).toContain("controls ok: 3 of 3");
    expect(text).toContain("H1-cut-before-tiebreak 6");
  });

  it("PRIVACY: no subject, sender, Message-ID or vector id reaches the summary or the JSON rows", async () => {
    const { get } = deploy(() => 12);
    const res = await run(get, opts);
    const out = summarize(res) + "\n" + JSON.stringify(res.rows);
    // CONTROL: the stub really carries the planted word, so its absence below means something.
    expect(JSON.stringify(await get("/api/messages?direction=inbound&limit=80"))).toContain(SECRET_WORD);
    expect(out).not.toContain(SECRET_WORD);
    expect(out).not.toContain(SENDER);
    expect(out).not.toMatch(/@mail\.example|vec-|PR run failed/);
  });

  it("an armed-off deploy (404) gives error rows and an untrusted instrument, never verdicts", async () => {
    const get = async (path: string) => {
      if (path.startsWith("/api/messages")) return { items: [cls(1, "aaaaaaa"), uniq(1)] };
      if (path.startsWith("/api/admin/search-debug")) throw new Error("GET /api/admin/search-debug failed: HTTP 404");
      return { items: [] };
    };
    const res = await run(get, { ...opts, min: 1, controls: 1 });
    expect(res.rows[0].reading).toBe("error");
    expect(summarize(res)).toContain("INSTRUMENT NOT TRUSTED");
  });
});

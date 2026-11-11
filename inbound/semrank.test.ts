import { describe, it, expect } from "vitest";
import { templateKey, queryTokens, overlap, rankFamilies, foldThreads, NEAR_TIE, SIMILAR_IDS_CAP, type RankInput } from "./src/semrank";
import { embedChunks, EMBED_VERSION, SUBJECT_CAP, CHUNK_SIZE } from "./src/embedtext";

// #813: the pure halves, so the recall eval and the store run the same code.

describe("#813 templateKey: one key per notification family", () => {
  it("masks hashes, #ids and digit runs, drops reply prefixes, keys on the bare sender", () => {
    const a = templateKey("CI <ci@example.com>", "Run failed: corpus-sync #4821 (3f9c2ab)");
    const b = templateKey("ci@example.com", "Re: Run failed: corpus-sync #4822 (77aa01f)");
    expect(a).toBe(b);
    expect(a).toBe("ci@example.com|run failed: corpus-sync # (#)");
  });
  it("different senders or different words are different families", () => {
    expect(templateKey("ci@example.com", "Run failed: ci")).not.toBe(templateKey("bot@example.com", "Run failed: ci"));
    expect(templateKey("ci@example.com", "Run failed: ci")).not.toBe(templateKey("ci@example.com", "Run passed: ci"));
  });
});

describe("#813 query tokens and overlap", () => {
  it("tokens are distinct, lower-cased, 3+ characters", () => {
    expect(queryTokens("Run FAILED: ci 3f9c2ab a ci")).toEqual(["run", "failed", "3f9c2ab"]);
  });
  it("overlap counts whole tokens only", () => {
    expect(overlap(["3f9c2ab", "run"], "commit 3f9c2abX run")).toBe(1);
    expect(overlap(["3f9c2ab", "run"], "commit 3f9c2ab, run")).toBe(2);
    expect(overlap([], "anything")).toBe(0);
  });
});

const fam = "ci@x|run failed: corpus-sync";
const item = (id: string, key: string, score: number, date: string): RankInput => ({ id, key, score, date });

describe("#813 rankFamilies", () => {
  const items = [
    item("old", fam, 0.90, "2026-11-01"),
    item("other", "a@x|lunch", 0.89, "2026-11-05"),
    item("mid", fam, 0.89, "2026-11-05"),
    item("new", fam, 0.88, "2026-11-09"),
    item("far", fam, 0.80, "2026-11-10"), // outside the tie window: untouched
  ];
  const texts: Record<string, string> = { old: "commit aaaaaaa", mid: "commit 3f9c2ab", new: "commit bbbbbbb", far: "commit 3f9c2ab", other: "lunch" };
  const lexical = (id: string) => texts[id];

  it("CONTROL: the window constant is what the fixture assumes", () => {
    expect(NEAR_TIE).toBeGreaterThanOrEqual(0.02);
    expect(0.9 - 0.8).toBeGreaterThan(NEAR_TIE);
  });
  it("a distinguishing token in the query wins its family's slot; other families keep theirs", () => {
    const out = rankFamilies(items, queryTokens("corpus-sync 3f9c2ab"), lexical, { collapse: false }).map((o) => o.id);
    expect(out).toEqual(["mid", "other", "new", "old", "far"]);
  });
  it("with no distinguishing token, newest wins among the ties", () => {
    const out = rankFamilies(items, queryTokens("run failed corpus-sync"), lexical, { collapse: false }).map((o) => o.id);
    expect(out).toEqual(["new", "other", "mid", "old", "far"]);
  });
  it("collapse keeps the winner at the family's first slot with every other member in similar", () => {
    const out = rankFamilies(items, queryTokens("corpus-sync 3f9c2ab"), lexical, { collapse: true });
    expect(out).toEqual([
      { id: "mid", similar: { count: 3, ids: ["old", "new", "far"] } },
      { id: "other" },
    ]);
  });
  it("a family of one and unrelated items are never touched", () => {
    const solo = [item("a", "k1", 0.9, "2026-01-01"), item("b", "k2", 0.89, "2026-12-01")];
    expect(rankFamilies(solo, ["x"], () => "", { collapse: true })).toEqual([{ id: "a" }, { id: "b" }]);
  });
  it("similar ids are capped, the count is exact", () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`m${i}`, fam, 0.9 - i * 0.01, `2026-01-${String(30 - i).padStart(2, "0")}`));
    const out = rankFamilies(many, [], () => "", { collapse: true });
    expect(out).toHaveLength(1);
    expect(out[0].similar?.count).toBe(29);
    expect(out[0].similar?.ids).toHaveLength(SIMILAR_IDS_CAP);
  });
  it("only the lexical text of TIED members of multi-member families is read", () => {
    const read: string[] = [];
    rankFamilies(items, ["x"], (id) => (read.push(id), ""), { collapse: false });
    expect(read.sort()).toEqual(["mid", "new", "old"]);
  });
});

describe("#813 embedChunks: the embed recipe", () => {
  it("the current recipe is 2 and prefixes the subject to chunk 0 only", () => {
    expect(EMBED_VERSION).toBe(2);
    const body = "x ".repeat(CHUNK_SIZE);
    const v2 = embedChunks("Run failed: ci", body);
    const v1 = embedChunks("Run failed: ci", body, 1);
    expect(v2.length).toBe(v1.length);
    expect(v2[0]).toBe(`Subject: Run failed: ci\n\n${v1[0]}`);
    expect(v2.slice(1)).toEqual(v1.slice(1));
  });
  it("an empty body with a subject is one subject chunk; recipe 1 gave none", () => {
    expect(embedChunks("Lunch?", "")).toEqual(["Subject: Lunch?"]);
    expect(embedChunks("Lunch?", "", 1)).toEqual([]);
    expect(embedChunks("", "")).toEqual([]);
  });
  it("the subject is whitespace-normalized and capped", () => {
    expect(embedChunks("  a\n\tb  ", "body")[0]).toBe("Subject: a b\n\nbody");
    expect(embedChunks("s".repeat(500), "body")[0]).toBe(`Subject: ${"s".repeat(SUBJECT_CAP)}\n\nbody`);
  });
});

describe("#926 foldThreads", () => {
  it("keeps each thread's first hit in place with the rest in threadHits; single-hit threads untouched", () => {
    const out = foldThreads([
      { id: "a1", thread: "A" }, { id: "b1", thread: "B" }, { id: "a2", thread: "A" }, { id: "c1", thread: "C" }, { id: "a3", thread: "A" },
    ]);
    expect(out).toEqual([{ id: "a1", threadHits: { count: 2, ids: ["a2", "a3"] } }, { id: "b1" }, { id: "c1" }]);
  });
  it("caps ids, counts exactly", () => {
    const out = foldThreads(Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, thread: "T" })));
    expect(out).toHaveLength(1);
    expect(out[0].threadHits?.count).toBe(29);
    expect(out[0].threadHits?.ids).toHaveLength(SIMILAR_IDS_CAP);
  });
});

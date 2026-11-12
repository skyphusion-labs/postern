// #950 step 0, NO TOKEN NEEDED: how much of each Actions notification's chunk 0 is the shared
// template, per candidate recipe. A line of chunk 0 is "shared" when the same line, with digits and
// hex runs normalized, occurs in chunk 0 of at least 3 other messages in the block. The rest is the
// message's own signal. This is a structural measure, not recall: it shows WHY an embedding can
// carry so little of the message, and how much each recipe changes that. Recall needs the real
// embeddings (embed813.mjs, then recall813.eval.mjs). Run from inbound/:  node eval/template950.mjs
import { buildCorpus } from "./corpus813.mjs";
import { RECIPES950 } from "./recipes950.mjs";
import { shapeKey } from "./shape813.mjs";

const norm = (l) => l.trim().replace(/\b[0-9a-f]{7,}\b/g, "#h").replace(/\d+/g, "#");
const { messages } = buildCorpus();
// The 48 probe messages only: the older re-runs (gha-old-) repeat each subject, which would count the subject line itself as shared template.
const block = messages.filter((m) => m.id.startsWith("gha-") && !m.id.startsWith("gha-old-"));
const shapes = new Map();
for (const m of messages) shapes.set(shapeKey(m.from, m.subject), (shapes.get(shapeKey(m.from, m.subject)) ?? 0) + 1);
const unique = block.filter((m) => shapes.get(shapeKey(m.from, m.subject)) === 1).length;
console.log(`Actions block: ${block.length} messages, ${unique} of them a unique shape (shape813 key), as production's #6 and #36.`);
console.log("| recipe | chunks per message | chunk 0 chars | shared template share of chunk 0 (median, min, max) | subject share of chunk 0 (median) |");
console.log("|---|---|---|---|---|");
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
for (const [name, recipe] of Object.entries(RECIPES950)) {
  const c0 = block.map((m) => ({ m, chunks: recipe(m.subject, m.body) }));
  const lineCount = new Map();
  for (const { chunks } of c0) for (const l of new Set(chunks[0].split("\n").map(norm).filter(Boolean))) lineCount.set(l, (lineCount.get(l) ?? 0) + 1);
  const shares = [], subj = [];
  for (const { m, chunks } of c0) {
    const lines = chunks[0].split("\n").filter((l) => l.trim());
    const total = lines.reduce((n, l) => n + l.length, 0);
    const shared = lines.filter((l) => (lineCount.get(norm(l)) ?? 0) >= 4).reduce((n, l) => n + l.length, 0);
    shares.push(shared / total);
    subj.push(Math.min(1, (m.subject.length + 9) / chunks[0].length));
  }
  const pct = (x) => `${Math.round(x * 100)}%`;
  console.log(`| ${name} | ${median(c0.map((x) => x.chunks.length))} | ${median(c0.map((x) => x.chunks[0].length))} | ${pct(median(shares))} (${pct(Math.min(...shares))}, ${pct(Math.max(...shares))}) | ${pct(median(subj))} |`);
}

// #813 recall eval, step 1: embed every text the eval needs with the REAL model
// (@cf/baai/bge-base-en-v1.5, Workers AI REST), into a JSON cache keyed by sha256(text).
// Re-runs fetch only what is missing. Run from inbound/:
//
//   CLOUDFLARE_ACCOUNT_ID=... CF_WORKERS_AI_TOKEN=... EVAL_CACHE=<path.json> node eval/embed813.mjs
//
// The token is read from the environment and never printed. The texts are the corpus
// chunks under BOTH recipes (embedtext.ts, the same function the store uses) plus the
// query strings.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildCorpus } from "./corpus813.mjs";
import { embedChunks } from "../src/embedtext.ts";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CF_WORKERS_AI_TOKEN;
const cachePath = process.env.EVAL_CACHE;
if (!account || !token || !cachePath) {
  console.error("need CLOUDFLARE_ACCOUNT_ID, CF_WORKERS_AI_TOKEN and EVAL_CACHE (the token is never printed)");
  process.exit(2);
}
const sha = (t) => createHash("sha256").update(t).digest("hex");
const { messages, queries } = buildCorpus();
const texts = new Set();
for (const m of messages) for (const v of [1, 2]) for (const t of embedChunks(m.subject, m.body, v)) texts.add(t);
for (const q of queries) texts.add(q.q);
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
const missing = [...texts].filter((t) => !cache[sha(t)]);
const chars = missing.reduce((n, t) => n + t.length, 0);
console.log(`texts ${texts.size}, cached ${texts.size - missing.length}, to embed ${missing.length} (${chars} chars, about ${Math.ceil(chars / 4)} tokens)`);

const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/baai/bge-base-en-v1.5`;
for (let i = 0; i < missing.length; i += 50) {
  const batch = missing.slice(i, i + 50);
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: batch }) });
  const body = await res.json().catch(() => ({}));
  const data = body?.result?.data;
  if (!res.ok || !Array.isArray(data) || data.length !== batch.length) {
    console.error(`embed batch ${i / 50} failed: HTTP ${res.status} ${JSON.stringify(body?.errors ?? []).slice(0, 300)}`);
    process.exit(1);
  }
  batch.forEach((t, k) => (cache[sha(t)] = data[k]));
  writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`embedded ${Math.min(i + 50, missing.length)}/${missing.length}`);
}
console.log(`cache ${Object.keys(cache).length} vectors at ${cachePath}`);

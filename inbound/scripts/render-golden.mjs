// Cross-engine golden renderer (#529). Renders ONE ProjectInput through the real
// worker-side rfc822Project.ts and prints the resulting bytes as base64 on stdout,
// nothing else. Exists so imap/posternimap/tests/test_projection_cross_engine.py
// can drive BOTH engines from the SAME logical input in ONE test run and assert
// byte equality directly, instead of two suites separately asserting against
// hand-copied magic numbers (which is exactly how #529 -- a one-byte Date
// day-of-month skew -- reached production with both suites green: nothing ever
// executed both renderers against the same input and compared the actual bytes).
//
// rfc822Project.ts has zero imports of its own (no Workers bindings, nothing
// Cloudflare-specific), so this needs nothing beyond a plain Node process -- no
// `npm ci`, no wrangler, no vitest-pool-workers. Node >= 22 strips the TypeScript
// types natively (see scripts/emit-route-table.mjs for the established precedent
// of importing straight from a .ts source file this same way).
//
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/render-golden.mjs '<JSON ProjectInput>'

import { renderRfc822Projection } from "../src/rfc822Project.ts";

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    process.stderr.write("usage: render-golden.mjs '<JSON ProjectInput>'\n");
    process.exit(2);
  }
  const input = JSON.parse(raw);
  const bytes = await renderRfc822Projection(input);
  process.stdout.write(Buffer.from(bytes).toString("base64"));
}

main().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + "\n");
  process.exit(1);
});

#!/usr/bin/env node
// CHANGELOG placement gate: a change must not add lines inside an already-released
// "## vX.Y.Z" section of CHANGELOG.md. New entries belong under "## Unreleased".
//
// Why a check: when a release renames "## Unreleased" to "## vX.Y.Z", a branch cut
// before the release still has its entry under the old Unreleased, and git merges the
// two CLEANLY with the entry now inside the released section. No conflict, no reviewer
// signal, and the release notes of a shipped version change after the fact.
//
// Usage: node .github/scripts/changelog-placement.mjs <base-rev> <head-rev> [path]
//   In CI on a pull_request, HEAD is the merge commit and HEAD^1 the base tip, so
//   "HEAD^1 HEAD" checks exactly what the merge would add to main.
//
// "Released" means a "## vX.Y.Z" heading that already exists at <base-rev>. A release
// change (one that renames Unreleased to a new version) therefore passes: its version
// is not in the base yet. Blank lines are ignored.
//
// A deliberate edit to released notes (a correction, a pointer added to an old entry)
// is allowed when a commit in <base>..<head> carries the trailer
//   Changelog-History-Edit: <reason>
// The lines are then reported as warnings with the reason, and the check passes.
//
// Exit 0: no added line sits in a released section, or the trailer allows it. Exit 1:
// at least one does (each is printed with its section). Exit 2: could not measure (a rev
// or the diff is unreadable).
import { execFileSync } from "node:child_process";

const [base, head, path = "CHANGELOG.md"] = process.argv.slice(2);
if (!base || !head) {
  console.error("usage: changelog-placement.mjs <base-rev> <head-rev> [path]");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let baseText, headText, diff;
try {
  git("rev-parse", "--verify", "--quiet", base + "^{commit}");
  git("rev-parse", "--verify", "--quiet", head + "^{commit}");
} catch {
  console.error(`changelog-placement: could not resolve ${base} or ${head}; NOT measured`);
  process.exit(2);
}
try { baseText = git("show", `${base}:${path}`); } catch { baseText = null; }
try { headText = git("show", `${head}:${path}`); } catch { headText = null; }
if (headText === null) {
  console.log(`changelog-placement: ${path} absent at ${head}; nothing to check`);
  process.exit(0);
}
try {
  diff = git("diff", "--unified=0", "--no-color", "--no-ext-diff", base, head, "--", path);
} catch (e) {
  console.error(`changelog-placement: git diff failed; NOT measured: ${e.message}`);
  process.exit(2);
}

const VERSION = /^## v(\d+\.\d+\.\d+)\b/;
const released = new Set();
for (const line of (baseText ?? "").split("\n")) {
  const m = line.match(VERSION);
  if (m) released.add(m[1]);
}

// The section of each head line: the nearest "## " heading at or above it.
const headLines = headText.split("\n");
const sectionOf = new Array(headLines.length + 1);
let current = null;
for (let i = 0; i < headLines.length; i++) {
  if (headLines[i].startsWith("## ")) current = headLines[i];
  sectionOf[i + 1] = current;
}

const problems = [];
for (const line of diff.split("\n")) {
  const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (!h) continue;
  const start = Number(h[1]);
  const count = h[2] === undefined ? 1 : Number(h[2]);
  for (let n = start; n < start + count; n++) {
    const text = headLines[n - 1] ?? "";
    if (text.trim() === "") continue;
    const section = sectionOf[n];
    const m = section && section.match(VERSION);
    if (m && released.has(m[1])) problems.push({ n, section, text });
  }
}

if (problems.length === 0) {
  console.log(`changelog-placement: ok (${released.size} released section(s) at ${base} untouched)`);
  process.exit(0);
}
let reason = "";
try {
  const log = git("log", "--format=%B", `${base}..${head}`);
  const m = log.match(/^Changelog-History-Edit:[ \t]*(\S.*)$/m);
  if (m) reason = m[1].trim();
} catch {
  reason = "";
}
if (reason) {
  for (const p of problems) {
    console.log(`::warning file=${path},line=${p.n}::edit inside released section "${p.section}" (allowed: ${reason})`);
  }
  console.log(`changelog-placement: ${problems.length} line(s) in released section(s), allowed by Changelog-History-Edit: ${reason}`);
  process.exit(0);
}
for (const p of problems) {
  console.log(`::error file=${path},line=${p.n}::added inside released section "${p.section}": ${p.text.slice(0, 120)}`);
}
console.log(
  `changelog-placement: ${problems.length} added line(s) inside already-released section(s). ` +
    `Move the entry under "## Unreleased" (create it above the newest release if it is missing). ` +
    `A clean merge after a release puts an entry here without any conflict. ` +
    `For a deliberate edit to released notes, add the commit trailer "Changelog-History-Edit: <reason>".`,
);
process.exit(1);

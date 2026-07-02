#!/usr/bin/env node
// d1-migration-gate.mjs -- refuse to auto-apply dangerous D1 migrations (#112).
//
// Why: deploy.yml runs `wrangler d1 migrations apply DB --remote` on every push
// to main, against the operator's LIVE mail store. That is the design intent for
// ADDITIVE migrations (schema ships with code), but it means merging a PR that
// carries a core-table rebuild (0005-style), a DROP, or a bulk DELETE/UPDATE
// would mutate the live mailbox online, with no backup and no review gate. This
// script closes that footgun: it classifies every PENDING migration and fails
// the deploy, BEFORE the apply, when a migration is not recognizably additive.
//
// Usage (deploy.yml):
//   npx wrangler d1 migrations list DB --remote -c "$CFG" > pending.txt
//   node ../.github/scripts/d1-migration-gate.mjs migrations < pending.txt
//
// stdin  = raw `wrangler d1 migrations list` output (pending migrations only).
// argv[2] = the migrations directory. Pending names are matched to files by
// their NNNN_ numeric prefix, so table truncation in wrangler output is fine.
//
// Classification (case-insensitive, on comment-stripped SQL with CREATE TRIGGER
// BEGIN...END bodies excluded; trigger bodies run per-row later, they are not a
// bulk mutation at apply time):
//   ADDITIVE (auto-apply, zero friction): CREATE TABLE / INDEX / VIRTUAL TABLE /
//   TRIGGER / VIEW, ALTER TABLE ... ADD COLUMN, INSERT ... VALUES seeds.
//   DANGEROUS (deploy fails): DROP TABLE/TRIGGER/INDEX/VIEW, RENAME TO,
//   DROP/RENAME COLUMN, DELETE FROM, UPDATE ... SET, INSERT INTO ... SELECT
//   (copy-rebuild), FTS5 special-command inserts (INSERT INTO f(f) VALUES
//   ('rebuild') etc.), and ANY top-level statement this script does not
//   recognize (deny by default).
//
// Override: a migration file containing the exact marker line
//
//   -- postern:allow-destructive
//
// is allowed through (logged loudly). Adding the marker is a REVIEWED, deliberate
// statement that auto-applying this migration online against a live store is
// acceptable. For anything that is NOT (core-table rebuilds, backups-first
// operations), do NOT add the marker: apply it manually offline per the operator
// runbook (backup -> quiesce -> apply -> verify), then baseline-seed
// d1_migrations so the pipeline sees it as already applied and no-ops. The
// 0001-0003 drift fix (PR #67) and the 0005 offline apply are the precedents.
//
// Zero dependencies; self-tests run on every invocation before gating.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = 'postern:allow-destructive';

// [pattern, human reason] -- scanned on stripped SQL (comments + trigger bodies removed).
const DANGEROUS = [
  [/\bDROP\s+TABLE\b/i, 'DROP TABLE (table removal / rebuild swap)'],
  [/\bDROP\s+TRIGGER\b/i, 'DROP TRIGGER (rebuild choreography)'],
  [/\bDROP\s+INDEX\b/i, 'DROP INDEX'],
  [/\bDROP\s+VIEW\b/i, 'DROP VIEW'],
  [/\bDROP\s+COLUMN\b/i, 'ALTER ... DROP COLUMN'],
  [/\bRENAME\s+TO\b/i, 'RENAME TO (rebuild swap)'],
  [/\bRENAME\s+COLUMN\b/i, 'RENAME COLUMN'],
  [/\bDELETE\s+FROM\b/i, 'DELETE FROM (bulk data mutation)'],
  [/\bUPDATE\s+\S+\s+SET\b/i, 'UPDATE ... SET (bulk data mutation)'],
  [/\bINSERT\s+INTO\s+\S+\s*(\([^)]*\))?\s*SELECT\b/i, 'INSERT INTO ... SELECT (copy-rebuild)'],
  [/\bINSERT\s+INTO\s+(\w+)\s*\(\s*\1\s*[,)]/i, "FTS5 special-command INSERT (e.g. VALUES ('rebuild'))"],
  [/\bPRAGMA\s+writable_schema\b/i, 'PRAGMA writable_schema'],
];

// Top-level statement verbs that CAN be additive. Anything else is denied by
// default (VACUUM, REINDEX, REPLACE, ATTACH, unknown future shapes).
const KNOWN_VERBS = new Set(['CREATE', 'ALTER', 'INSERT']);

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function stripTriggerBodies(sql) {
  // Remove BEGIN ... END trigger bodies (non-nested in SQLite triggers). Their
  // statements fire per-row later; they are not a bulk mutation at apply time.
  return sql.replace(/\bBEGIN\b[\s\S]*?\bEND\b/gi, ' ');
}

// Returns { marker: bool, findings: string[] } -- empty findings = additive.
export function classify(rawSql) {
  if (rawSql.includes(MARKER)) return { marker: true, findings: [] };
  const sql = stripTriggerBodies(stripComments(rawSql));
  const findings = [];
  for (const [re, reason] of DANGEROUS) {
    if (re.test(sql)) findings.push(reason);
  }
  for (const stmt of sql.split(';')) {
    const first = (stmt.trim().split(/\s+/)[0] || '').toUpperCase();
    if (first && !KNOWN_VERBS.has(first)) {
      findings.push(`unrecognized top-level statement: ${first} (deny by default)`);
    }
  }
  return { marker: false, findings };
}

function selfTest() {
  const cases = [
    // [name, sql, expectAdditive]
    ['create table + index', 'CREATE TABLE IF NOT EXISTS t (id INTEGER);\nCREATE INDEX IF NOT EXISTS i ON t(id);', true],
    ['alter add column', 'ALTER TABLE messages ADD COLUMN x TEXT;', true],
    ['seed insert values', "INSERT INTO t(name, v) VALUES ('a', 1);", true],
    ['fts trigger body is exempt', "CREATE TRIGGER t_ad AFTER DELETE ON t BEGIN\n  INSERT INTO t_fts(t_fts, rowid) VALUES ('delete', old.id);\nEND;", true],
    ['comments do not trip patterns', '-- do not DROP TABLE anything\nCREATE TABLE t (id INTEGER);', true],
    ['drop table', 'DROP TABLE messages;', false],
    ['rename to', 'ALTER TABLE m_new RENAME TO messages;', false],
    ['drop column', 'ALTER TABLE messages DROP COLUMN spf;', false],
    ["delete from", "DELETE FROM sqlite_sequence WHERE name = 'messages';", false],
    ['update backfill', 'UPDATE messages SET thread_id = message_id WHERE thread_id IS NULL;', false],
    ['insert select copy', 'INSERT INTO m_new (id, s) SELECT id, s FROM messages;', false],
    ["fts rebuild", "INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');", false],
    ['unrecognized verb', 'VACUUM;', false],
    ['marker overrides', `-- ${MARKER}\nDROP TABLE messages;`, true],
  ];
  for (const [name, sql, expectAdditive] of cases) {
    const r = classify(sql);
    const additive = r.marker || r.findings.length === 0;
    if (additive !== expectAdditive) {
      console.error(`gate SELF-TEST FAILED: "${name}" expected additive=${expectAdditive}, got findings: ${JSON.stringify(r.findings)}`);
      process.exit(2);
    }
  }
}

function main() {
  selfTest();

  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: d1-migration-gate.mjs <migrations-dir> < wrangler-migrations-list-output');
    process.exit(2);
  }
  const listOutput = readFileSync(0, 'utf8');

  // Pending migrations are matched by their NNNN_ prefix (immune to table truncation).
  const pendingPrefixes = [...new Set([...listOutput.matchAll(/\b(\d{4})_/g)].map((m) => m[1]))];
  if (pendingPrefixes.length === 0) {
    console.log('gate: no pending migrations; nothing to classify.');
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  let blocked = false;
  for (const prefix of pendingPrefixes) {
    const file = files.find((f) => f.startsWith(`${prefix}_`));
    if (!file) {
      console.error(`gate: BLOCKED -- pending migration ${prefix}_* is not in ${dir}/; cannot classify what is not in the checkout.`);
      blocked = true;
      continue;
    }
    const { marker, findings } = classify(readFileSync(join(dir, file), 'utf8'));
    if (marker) {
      console.log(`gate: ${file} -- carries "-- ${MARKER}"; auto-apply explicitly allowed. Proceeding.`);
    } else if (findings.length === 0) {
      console.log(`gate: ${file} -- additive; auto-apply OK.`);
    } else {
      console.error(`gate: BLOCKED -- ${file} is not recognizably additive:`);
      for (const f of findings) console.error(`gate:   - ${f}`);
      blocked = true;
    }
  }

  if (blocked) {
    console.error('');
    console.error('gate: REFUSING to auto-apply the migration(s) above to the live store.');
    console.error('gate: Two sanctioned paths:');
    console.error(`gate:   1. If auto-applying online is genuinely safe, add the marker line "-- ${MARKER}" to the migration in a reviewed PR.`);
    console.error('gate:   2. Otherwise apply it MANUALLY offline per the operator runbook (backup -> quiesce -> apply -> verify), then baseline-seed d1_migrations so this pipeline sees it as applied and no-ops (the PR #67 / 0005 pattern).');
    process.exit(1);
  }
}

main();

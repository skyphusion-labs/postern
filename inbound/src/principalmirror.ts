// #854 M2: dual-write. Every write to the OLD people tables (smtp_credentials,
// agent_identities) carries these statements in the SAME D1 batch, so the principal
// tables change with them or not at all. They are pure SQL over the old row as it stands
// after the write, so they need nothing the caller does not already have, and they encode
// exactly the converge rules backfillPrincipals() applies (principals.ts):
//
//   - a human's live `password` credential is keyed on the username; a missing one is
//     created with a fresh prn_ principal; its secret, its principal's disabled state and
//     display name follow the row; a deleted row revokes the credential and disables
//     the principal (nothing is ever deleted);
//   - an agent's principal keeps its idn_ id, its credential is crd_ + the same hex; the
//     revoke, scopes and display name follow the row;
//   - the primary address is claimed once (INSERT OR IGNORE); an address another
//     principal owns is left with its owner.
//
// Reads do not consult the new tables in this slice: the old tables stay the only
// authority. GET /api/admin/principals/parity measures whether the two agree.

import { generateId } from "./adminkit";
import { NATIVE_SESSION_CAPS } from "./caps";

const LIVE_PASSWORD = "SELECT 1 FROM credentials WHERE type = 'password' AND lookup = ?1 AND revoked_at IS NULL";
const PRINCIPAL_OF = "(SELECT principal_id FROM credentials WHERE type = 'password' AND lookup = ?1 AND revoked_at IS NULL)";

/** The principal-table statements that make one human's principal match its
 *  smtp_credentials row (or its absence). `username` is already normalized. */
export function mirrorHuman(env: Env, username: string, now: string): D1PreparedStatement[] {
  const principalId = generateId("prn_");
  const credentialId = generateId("crd_");
  const caps = JSON.stringify(NATIVE_SESSION_CAPS);
  return [
    // A row with no live credential gets a principal and a credential, together.
    env.DB.prepare(
      "INSERT INTO principals (id, kind, display_name, label, created_by, created_at, disabled_at) " +
        "SELECT ?2, 'human', display_name, NULL, 'dual-write', COALESCE(created_at, ?3), " +
        "CASE WHEN disabled THEN COALESCE(updated_at, ?3) ELSE NULL END " +
        `FROM smtp_credentials WHERE username = ?1 AND NOT EXISTS (${LIVE_PASSWORD})`,
    ).bind(username, principalId, now),
    env.DB.prepare(
      "INSERT INTO credentials (id, principal_id, type, lookup, secret, caps, protocols, label, created_at) " +
        "SELECT ?2, ?3, 'password', username, secret_hash, ?4, NULL, NULL, COALESCE(created_at, ?5) " +
        `FROM smtp_credentials WHERE username = ?1 AND NOT EXISTS (${LIVE_PASSWORD}) ` +
        "AND EXISTS (SELECT 1 FROM principals WHERE id = ?3)",
    ).bind(username, credentialId, principalId, caps, now),
    // An existing credential follows the row's secret.
    env.DB.prepare(
      "UPDATE credentials SET secret = (SELECT secret_hash FROM smtp_credentials WHERE username = ?1) " +
        "WHERE type = 'password' AND lookup = ?1 AND revoked_at IS NULL " +
        "AND EXISTS (SELECT 1 FROM smtp_credentials WHERE username = ?1) " +
        "AND secret IS NOT (SELECT secret_hash FROM smtp_credentials WHERE username = ?1)",
    ).bind(username),
    // Its principal follows the row's disabled state (presence only) and display name.
    env.DB.prepare(
      "UPDATE principals SET " +
        "disabled_at = CASE WHEN (SELECT disabled FROM smtp_credentials WHERE username = ?1) " +
        "THEN COALESCE(disabled_at, (SELECT COALESCE(updated_at, ?2) FROM smtp_credentials WHERE username = ?1)) ELSE NULL END, " +
        "display_name = (SELECT display_name FROM smtp_credentials WHERE username = ?1) " +
        `WHERE id = ${PRINCIPAL_OF} AND EXISTS (SELECT 1 FROM smtp_credentials WHERE username = ?1)`,
    ).bind(username, now),
    // The primary address, claimed once.
    env.DB.prepare(
      "INSERT OR IGNORE INTO principal_addresses (address, principal_id, is_primary) " +
        `SELECT lower(from_addr), ${PRINCIPAL_OF}, 1 FROM smtp_credentials WHERE username = ?1 AND ${PRINCIPAL_OF} IS NOT NULL`,
    ).bind(username),
    // A deleted row: the principal is disabled first, while the credential still names it,
    // then the credential is revoked.
    env.DB.prepare(
      `UPDATE principals SET disabled_at = ?2 WHERE id = ${PRINCIPAL_OF} AND disabled_at IS NULL ` +
        "AND NOT EXISTS (SELECT 1 FROM smtp_credentials WHERE username = ?1)",
    ).bind(username, now),
    env.DB.prepare(
      "UPDATE credentials SET revoked_at = ?2 WHERE type = 'password' AND lookup = ?1 AND revoked_at IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM smtp_credentials WHERE username = ?1)",
    ).bind(username, now),
  ];
}

/** The principal-table statements that make one agent's principal match its
 *  agent_identities row. */
export function mirrorAgent(env: Env, id: string): D1PreparedStatement[] {
  const credentialId = "crd_" + id.slice("idn_".length);
  return [
    env.DB.prepare(
      "INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at, disabled_at) " +
        "SELECT id, 'agent', display_name, label, 'dual-write', created_at, revoked_at FROM agent_identities WHERE id = ?1",
    ).bind(id),
    env.DB.prepare(
      "INSERT OR IGNORE INTO credentials (id, principal_id, type, lookup, secret, caps, protocols, label, created_at, revoked_at) " +
        "SELECT ?2, id, 'api_token', token_hash, NULL, scopes, NULL, label, created_at, revoked_at FROM agent_identities WHERE id = ?1",
    ).bind(id, credentialId),
    env.DB.prepare(
      "UPDATE principals SET disabled_at = (SELECT revoked_at FROM agent_identities WHERE id = ?1), " +
        "display_name = (SELECT display_name FROM agent_identities WHERE id = ?1) " +
        "WHERE id = ?1 AND EXISTS (SELECT 1 FROM agent_identities WHERE id = ?1)",
    ).bind(id),
    env.DB.prepare(
      "UPDATE credentials SET revoked_at = (SELECT revoked_at FROM agent_identities WHERE id = ?1), " +
        "caps = (SELECT scopes FROM agent_identities WHERE id = ?1) WHERE id = ?2 " +
        "AND EXISTS (SELECT 1 FROM agent_identities WHERE id = ?1)",
    ).bind(id, credentialId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO principal_addresses (address, principal_id, is_primary) " +
        "SELECT lower(from_addr), id, 1 FROM agent_identities WHERE id = ?1",
    ).bind(id),
  ];
}

/** Counts and opaque ids ONLY (the lead's rule): never a hash, a secret, a lookup value
 *  (a username is one, and is often an address) or an address. A differing human with no
 *  principal yet has no id to name, so it is counted, not sampled. */
export interface ParityReport {
  agents: { checked: number; diffs: number; sample: string[] };
  humans: { checked: number; diffs: number; withoutPrincipal: number; sample: string[] };
  /** Live password credentials whose smtp_credentials row is gone (credential ids). */
  orphans: { diffs: number; sample: string[] };
}

const SAMPLE = 20;

/** Compare every old-table row with its principal and credential. Deterministic. */
export async function principalParity(env: Env): Promise<ParityReport> {
  const agentDiff =
    "SELECT a.id FROM agent_identities a " +
    "LEFT JOIN credentials c ON c.id = 'crd_' || substr(a.id, 5) " +
    "LEFT JOIN principals p ON p.id = a.id " +
    "WHERE c.id IS NULL OR p.id IS NULL OR c.lookup IS NOT a.token_hash OR c.caps IS NOT a.scopes " +
    "OR c.principal_id IS NOT a.id OR p.kind IS NOT 'agent' " +
    "OR (c.revoked_at IS NULL) <> (a.revoked_at IS NULL) OR (p.disabled_at IS NULL) <> (a.revoked_at IS NULL) " +
    "ORDER BY a.id";
  const humanDiff =
    "SELECT p.id FROM smtp_credentials u " +
    "LEFT JOIN credentials c ON c.type = 'password' AND c.lookup = u.username AND c.revoked_at IS NULL " +
    "LEFT JOIN principals p ON p.id = c.principal_id " +
    "WHERE c.id IS NULL OR p.id IS NULL OR c.secret IS NOT u.secret_hash OR p.kind IS NOT 'human' " +
    "OR (p.disabled_at IS NOT NULL) <> (u.disabled <> 0) " +
    "ORDER BY u.username";
  const orphanDiff =
    "SELECT c.id FROM credentials c WHERE c.type = 'password' AND c.revoked_at IS NULL " +
    "AND NOT EXISTS (SELECT 1 FROM smtp_credentials u WHERE u.username = c.lookup) ORDER BY c.id";
  const count = async (table: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
  const rows = async (sql: string) =>
    ((await env.DB.prepare(sql).all<Record<string, string | null>>()).results ?? []).map((r) => Object.values(r)[0]);
  const [a, h, o] = await Promise.all([rows(agentDiff), rows(humanDiff), rows(orphanDiff)]);
  const humanIds = h.filter((x): x is string => typeof x === "string");
  return {
    agents: { checked: await count("agent_identities"), diffs: a.length, sample: (a as string[]).slice(0, SAMPLE) },
    humans: {
      checked: await count("smtp_credentials"),
      diffs: h.length,
      withoutPrincipal: h.length - humanIds.length,
      sample: humanIds.slice(0, SAMPLE),
    },
    orphans: { diffs: o.length, sample: (o as string[]).slice(0, SAMPLE) },
  };
}

// --- #854 M2 part ii: the read side (agree-or-fallback) ------------------------------

/**
 * Count one read-path disagreement. A single upsert, made ONLY when a disagreement was
 * seen, so an agreeing sign-in writes nothing. Best effort by design: a counter failure is
 * logged and swallowed, and the caller's answer (the old table's) stands either way.
 */
export async function recordReadMiss(env: Env, kind: "agent" | "human"): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO principal_read_misses (day, kind, misses) VALUES (?, ?, 1) " +
        "ON CONFLICT(day, kind) DO UPDATE SET misses = misses + 1",
    )
      .bind(new Date().toISOString().slice(0, 10), kind)
      .run();
  } catch (err) {
    console.error("principal read-miss counter failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Does the `credentials` table agree with the old table about one agent token? `old` is
 * the LIVE agent_identities row the token hash found, or null when the old table denies it.
 * Agreement: a live old row has a live credential with the same principal and caps, under a
 * live agent principal; a denied token has NO live credential. A credentials read that
 * fails counts as agreement (no evidence), so it can never change an answer or a count.
 */
export async function agentCredentialAgrees(
  env: Env,
  tokenHash: string,
  old: { id: string; scopes: string } | null,
): Promise<boolean> {
  let row: { principal_id: string; caps: string; disabled_at: string | null; kind: string } | null;
  try {
    row = await env.DB.prepare(
      "SELECT c.principal_id, c.caps, p.disabled_at, p.kind FROM credentials c LEFT JOIN principals p ON p.id = c.principal_id " +
        "WHERE c.type = 'api_token' AND c.lookup = ? AND c.revoked_at IS NULL",
    )
      .bind(tokenHash)
      .first();
  } catch {
    return true;
  }
  if (!old) return row === null;
  return row !== null && row.principal_id === old.id && row.caps === old.scopes && row.kind === "agent" && row.disabled_at === null;
}

/**
 * Does the `credentials` table agree with the old table about one login? `old` is the
 * smtp_credentials row (or null when there is none). Agreement: an existing row has a live
 * password credential with the same secret under a human principal whose disabled state
 * matches; a missing row has NO live credential. A failed read counts as agreement.
 */
export async function humanCredentialAgrees(
  env: Env,
  username: string,
  old: { secretHash: string; disabled: boolean } | null,
): Promise<boolean> {
  let row: { secret: string | null; disabled_at: string | null; kind: string | null } | null;
  try {
    row = await env.DB.prepare(
      "SELECT c.secret, p.disabled_at, p.kind FROM credentials c LEFT JOIN principals p ON p.id = c.principal_id " +
        "WHERE c.type = 'password' AND c.lookup = ? AND c.revoked_at IS NULL",
    )
      .bind(username)
      .first();
  } catch {
    return true;
  }
  if (!old) return row === null;
  return row !== null && row.secret === old.secretHash && row.kind === "human" && (row.disabled_at !== null) === old.disabled;
}

/** The read-path miss counts for the last `days` UTC days (counts only). */
export async function readMisses(env: Env, days = 30): Promise<{ agent: number; human: number; byDay: Array<{ day: string; kind: string; misses: number }> }> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  let rows: Array<{ day: string; kind: string; misses: number }> = [];
  try {
    rows = (await env.DB.prepare("SELECT day, kind, misses FROM principal_read_misses WHERE day >= ? ORDER BY day, kind").bind(since).all<{ day: string; kind: string; misses: number }>()).results ?? [];
  } catch {
    rows = [];
  }
  const sum = (k: string) => rows.filter((r) => r.kind === k).reduce((n, r) => n + Number(r.misses), 0);
  return { agent: sum("agent"), human: sum("human"), byDay: rows.map((r) => ({ day: r.day, kind: r.kind, misses: Number(r.misses) })) };
}

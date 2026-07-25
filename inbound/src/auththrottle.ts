// Durable online brute-force throttle for the webmail session mint (#409). This is
// the control #351 explicitly deferred to #355 and that #355 closed without: the
// worker verifies against the SAME smtp_credentials store the submission relay
// (relay/throttle.go, #105) and the IMAP door (imap/posternimap/throttle.py, #183)
// each guard, so an unthrottled POST /api/session silently undercut both of them.
//
// SEMANTICS ARE A PORT OF relay/throttle.go, deliberately, so the three doors in
// front of one credential store behave the same way:
//   - keyed on the presented ACCOUNT (lower-cased/trimmed, so case variants cannot
//     multiply the budget), never on whether that account EXISTS;
//   - enumeration-SAFE: an unknown username is counted and locked out exactly like a
//     known one, and below the trip line every rejection is the same E_AUTH_FAILED;
//   - only a real credential rejection counts. An infra error (D1 down) throws out
//     of the mint path before anything is recorded, so an outage cannot lock users
//     out (relay/submission.go makes the same distinction);
//   - a throttled attempt does NOT extend its own lockout (the relay does not call
//     fail() when allow() denied), so knocking on a locked door does not punish the
//     legitimate user who comes back;
//   - exponential backoff past the threshold, capped, with idle decay so a
//     long-quiet account starts fresh.
//
// TWO DELIBERATE DEVIATIONS from the relay, both because the environment differs:
//
//   1. A SECOND KEYED LAYER on the client IP (CF-Connecting-IP). The relay dropped
//      per-IP because behind the bastion every public connection presents ONE source
//      IP, making per-IP blind. A Worker sees the real client IP, so the per-IP layer
//      is meaningful here and it is what catches spread-spraying (one guess each
//      across many accounts) WITHOUT punishing anyone else.
//   2. The relay GLOBAL layer is present but DEFAULT-OFF (WEBMAIL_AUTH_GLOBAL_MAX
//      unset = 0 = disabled). On a public endpoint a global cooldown is a
//      login-denial lever any anonymous attacker can pull for everyone; the relay
//      accepted that trade because per-IP was blind there and global was its ONLY
//      spread-spraying defense. Here the per-IP layer covers that case, so global is
//      an operator opt-in backstop rather than a default denial surface.
//
// STORE: D1 (migration 0014, webmail_auth_failures). The mint path already REQUIRES
// D1 (it INSERTs the session row), the table is additive so the #112 deploy gate
// auto-applies it, and the counters are inspectable and prunable with the same tools
// as every other table here. Counting is a read-modify-write, not an atomic SQL
// increment, so two failures landing in the same instant can under-count by one; the
// lockout still trips within an attempt or two and every attempt costs a
// 210k-iteration PBKDF2, so the race buys an attacker no meaningful budget.
//
// FAIL-CLOSED: every function here throws on a store error. The caller maps that to
// a refusal (503), never to "proceed unthrottled" -- a control that silently degrades
// to off is not a control.

import { normalizeUsername } from "./smtpcreds";

// The single global-layer row. Prefixes keep the three layers in one table without a
// type column: "a:" account, "i:" client IP, "g:" the global counter.
const GLOBAL_KEY = "g:all";

// Bound what an attempt can write into the key column (the username is
// attacker-supplied and unbounded).
const MAX_ACCOUNT_KEY = 190;
const MAX_CLIENT_KEY = 64;

export interface ThrottleConfig {
  enabled: boolean;
  maxFailures: number;   // consecutive failures on a key before it locks
  lockoutS: number;      // base lockout, doubled per failure past the threshold
  maxLockoutS: number;   // backoff cap; also the idle-decay window
  globalMax: number;     // failures within globalWindowS before a global cooldown (0 = off)
  globalWindowS: number;
}

// Knobs are clamped to sane minimums (as the relay clamps) so a misconfigured value
// cannot disable the control while leaving it nominally enabled.
export function throttleConfig(env: Env): ThrottleConfig {
  const raw = (env.WEBMAIL_AUTH_THROTTLE || "").trim().toLowerCase();
  const lockoutS = posInt(env.WEBMAIL_AUTH_LOCKOUT_SECONDS, 60);
  return {
    enabled: raw !== "off",
    maxFailures: posInt(env.WEBMAIL_AUTH_MAX_FAILURES, 5),
    lockoutS,
    maxLockoutS: Math.max(lockoutS, posInt(env.WEBMAIL_AUTH_MAX_LOCKOUT_SECONDS, 3600)),
    globalMax: nonNegInt(env.WEBMAIL_AUTH_GLOBAL_MAX, 0),
    globalWindowS: posInt(env.WEBMAIL_AUTH_GLOBAL_WINDOW_SECONDS, 60),
  };
}

function posInt(rawValue: string | undefined, fallback: number): number {
  const n = Number(rawValue);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
function nonNegInt(rawValue: string | undefined, fallback: number): number {
  const n = Number(rawValue);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

interface FailureRow {
  scope_key: string;
  failures: number;
  window_start_at: string;
  last_failure_at: string;
  locked_until: string | null;
}

/** The keyed layers a single attempt touches. */
export interface AttemptKeys {
  account: string;
  client?: string;   // absent when the platform gave us no client IP
}

/** The verdict of the pre-verify gate, plus the rows it read (reused by the writer). */
export interface AttemptGate {
  allowed: boolean;
  retryAfter: number;              // whole seconds; 0 when allowed
  rows: Map<string, FailureRow>;
}

/**
 * Derive an attempt key set. The account key uses the SAME normalization
 * smtpcreds.lookup uses, so Conrad@... and conrad@... share one budget.
 */
export function attemptKeys(request: Request, username: string): AttemptKeys {
  const account = "a:" + normalizeUsername(username).slice(0, MAX_ACCOUNT_KEY);
  const ip = (request.headers.get("cf-connecting-ip") || "").trim();
  return ip ? { account, client: "i:" + ip.slice(0, MAX_CLIENT_KEY) } : { account };
}

/**
 * Read the counters for this attempt and decide whether it may reach the verifier.
 * ONE D1 read per attempt (every layer in a single statement) and NO write, so a
 * successful login against a clean account costs zero extra writes.
 */
export async function gateAttempt(env: Env, keys: AttemptKeys): Promise<AttemptGate> {
  const cfg = throttleConfig(env);
  if (!cfg.enabled) return { allowed: true, retryAfter: 0, rows: new Map() };

  const wanted = scopeKeys(keys, cfg);
  const placeholders = wanted.map(() => "?").join(", ");
  const res = await env.DB.prepare(
    "SELECT scope_key, failures, window_start_at, last_failure_at, locked_until " +
      `FROM webmail_auth_failures WHERE scope_key IN (${placeholders})`,
  )
    .bind(...wanted)
    .all<FailureRow>();

  const rows = new Map<string, FailureRow>();
  for (const row of res.results ?? []) rows.set(row.scope_key, row);

  const now = Date.now();
  let retryAfter = 0;
  for (const key of wanted) {
    const row = rows.get(key);
    if (!row || !row.locked_until) continue;
    const untilMs = Date.parse(row.locked_until);
    if (Number.isFinite(untilMs) && untilMs > now) {
      retryAfter = Math.max(retryAfter, Math.ceil((untilMs - now) / 1000));
    }
  }
  return { allowed: retryAfter === 0, retryAfter, rows };
}

/**
 * Record ONE real credential rejection across every layer. Called only when the
 * verifier returned a definite wrong-credential -- never for a validation error, a
 * throttled attempt, or an infra failure.
 */
export async function recordFailure(env: Env, keys: AttemptKeys, gate: AttemptGate): Promise<void> {
  const cfg = throttleConfig(env);
  if (!cfg.enabled) return;
  const now = Date.now();
  await bumpKeyed(env, cfg, keys.account, gate.rows.get(keys.account), now);
  if (keys.client) await bumpKeyed(env, cfg, keys.client, gate.rows.get(keys.client), now);
  if (cfg.globalMax > 0) await bumpGlobal(env, cfg, gate.rows.get(GLOBAL_KEY), now);
}

/**
 * A correct password fully resets the ACCOUNT counter (relay throttle success), and
 * ONLY that one: clearing the client-IP layer on success would let an attacker who
 * holds one valid credential wipe their own spraying budget at will, and the global
 * window is a time window, not a per-account streak.
 *
 * The write is skipped entirely when the gate read found no account row, so an
 * ordinary clean login adds NO D1 write at all.
 */
export async function clearFailures(env: Env, keys: AttemptKeys, gate: AttemptGate): Promise<void> {
  if (!gate.rows.has(keys.account)) return;
  await env.DB.prepare("DELETE FROM webmail_auth_failures WHERE scope_key = ?")
    .bind(keys.account)
    .run();
}

/**
 * Housekeeping: drop decayed, unlocked rows (the analogue of relay/throttle.go
 * pruneLocked and session.ts pruneExpiredSessions). Rows are inert before pruning --
 * the gate ignores an expired locked_until and bumpKeyed decays a stale streak -- so
 * this is storage hygiene, not a security control. Exported for a scheduled trigger;
 * not wired to one here (that is infra).
 */
export async function pruneAuthFailures(env: Env): Promise<number> {
  const cfg = throttleConfig(env);
  const cutoff = new Date(Date.now() - cfg.maxLockoutS * 1000).toISOString();
  const nowIso = new Date(Date.now()).toISOString();
  const res = await env.DB.prepare(
    "DELETE FROM webmail_auth_failures WHERE last_failure_at < ? " +
      "AND (locked_until IS NULL OR locked_until <= ?)",
  )
    .bind(cutoff, nowIso)
    .run();
  return res.meta?.changes ?? 0;
}

function scopeKeys(keys: AttemptKeys, cfg: ThrottleConfig): string[] {
  const out = [keys.account];
  if (keys.client) out.push(keys.client);
  if (cfg.globalMax > 0) out.push(GLOBAL_KEY);
  return out;
}

// A keyed (account / client-IP) layer: consecutive-failure streak with idle decay and
// exponential backoff past the threshold, capped at maxLockoutS.
async function bumpKeyed(
  env: Env,
  cfg: ThrottleConfig,
  key: string,
  row: FailureRow | undefined,
  now: number,
): Promise<void> {
  const lastMs = row ? Date.parse(row.last_failure_at) : NaN;
  const decayed = !row || !Number.isFinite(lastMs) || now - lastMs > cfg.maxLockoutS * 1000;
  const failures = (decayed ? 0 : (row as FailureRow).failures) + 1;
  const windowStart = decayed || !row ? new Date(now).toISOString() : row.window_start_at;
  const lockedUntil =
    failures >= cfg.maxFailures ? new Date(now + backoffMs(cfg, failures)).toISOString() : null;
  await upsert(env, key, failures, windowStart, new Date(now).toISOString(), lockedUntil);
}

// The global layer: a sliding COUNT within globalWindowS; crossing the ceiling cools
// down every mint for one window (relay/throttle.go fail(), global half).
async function bumpGlobal(
  env: Env,
  cfg: ThrottleConfig,
  row: FailureRow | undefined,
  now: number,
): Promise<void> {
  const startMs = row ? Date.parse(row.window_start_at) : NaN;
  const rolled = !row || !Number.isFinite(startMs) || now - startMs > cfg.globalWindowS * 1000;
  const count = (rolled ? 0 : (row as FailureRow).failures) + 1;
  const windowStart = rolled || !row ? new Date(now).toISOString() : row.window_start_at;
  const lockedUntil =
    count > cfg.globalMax ? new Date(now + cfg.globalWindowS * 1000).toISOString() : null;
  await upsert(env, GLOBAL_KEY, count, windowStart, new Date(now).toISOString(), lockedUntil);
}

// The base lockout doubled once per failure beyond the threshold, capped (identical
// shape to relay/throttle.go backoff()).
function backoffMs(cfg: ThrottleConfig, failures: number): number {
  let d = cfg.lockoutS * 1000;
  const cap = cfg.maxLockoutS * 1000;
  for (let i = 0; i < failures - cfg.maxFailures && d < cap; i++) d *= 2;
  return Math.min(d, cap);
}

async function upsert(
  env: Env,
  key: string,
  failures: number,
  windowStart: string,
  lastFailure: string,
  lockedUntil: string | null,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO webmail_auth_failures (scope_key, failures, window_start_at, last_failure_at, locked_until) " +
      "VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope_key) DO UPDATE SET " +
      "failures = excluded.failures, window_start_at = excluded.window_start_at, " +
      "last_failure_at = excluded.last_failure_at, locked_until = excluded.locked_until",
  )
    .bind(key, failures, windowStart, lastFailure, lockedUntil)
    .run();
}

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
//   1. A SECOND KEYED LAYER on the client IP (CF-Connecting-IP). The relay keyed on
//      the account instead, because a door behind an L4 load balancer may see one
//      apparent source IP for everyone unless PROXY protocol is configured. A Worker
//      ALWAYS sees the real client IP, so the per-IP layer is meaningful here and
//      it is what catches spread-spraying (one guess each across many accounts)
//      WITHOUT punishing anyone else.
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
// as every other table here.
//
// COUNTING IS A RESERVATION, TAKEN ATOMICALLY BEFORE THE VERIFY. `gateAttempt` runs one
// upsert per layer that increments the counter in SQL and RETURNS the new count, and
// whose DO UPDATE ... WHERE refuses (returns no row) when the layer is locked or its
// budget is already spent. Every attempt in flight therefore holds its own numbered
// slot, so N concurrent guesses are counted as N, and at most `maxFailures` of them
// reach the verifier before the lock. After the verify:
//   - a definite rejection (`recordFailure`) KEEPS the reservation and sets the lock
//     when the reserved count reached the threshold;
//   - a success (`clearFailures`) deletes the account row and RELEASES the other
//     layers' reservations (a success is not a client-IP or global failure);
//   - anything else, an infra error above all (`releaseAttempt`), releases every
//     reservation, so an outage still cannot lock users out.
// The cost is one write per attempt, where the old read-only gate cost none.
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

/** The keyed layers a single attempt touches. */
export interface AttemptKeys {
  account: string;
  client?: string;   // absent when the platform gave us no client IP
}

/** The verdict of the pre-verify gate, plus the count each layer reserved for this attempt. */
export interface AttemptGate {
  allowed: boolean;
  retryAfter: number;              // whole seconds; 0 when allowed
  reserved: Map<string, number>;   // scope key -> the failure count this attempt holds
}

/**
 * Account-only keys, for a caller that is not the end user's client: the doors call
 * /api/smtp-auth from their own address, so a client-IP layer there would lock every
 * user of that door at once. Same normalization as the lookup, so variants that reach
 * the same account share one budget.
 */
export function accountKeys(username: string): AttemptKeys {
  return { account: "a:" + normalizeUsername(username).slice(0, MAX_ACCOUNT_KEY) };
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
 * Reserve this attempt on every layer, atomically, and decide whether it may reach the
 * verifier. A layer refuses when it is locked, or when its budget is already held by
 * attempts in flight. If any layer refuses, the layers that did reserve are released,
 * so a refused attempt never extends its own lockout (the relay does not call fail()
 * when allow() denied).
 */
export async function gateAttempt(env: Env, keys: AttemptKeys): Promise<AttemptGate> {
  const cfg = throttleConfig(env);
  if (!cfg.enabled) return { allowed: true, retryAfter: 0, reserved: new Map() };

  const now = Date.now();
  const reserved = new Map<string, number>();
  let refusedKey: string | undefined;
  for (const key of scopeKeys(keys, cfg)) {
    const count = key === GLOBAL_KEY ? await reserveGlobal(env, cfg, now) : await reserveKeyed(env, cfg, key, now);
    if (count === null) {
      refusedKey = key;
      break;
    }
    reserved.set(key, count);
  }
  if (refusedKey === undefined) return { allowed: true, retryAfter: 0, reserved };

  await release(env, reserved);
  return { allowed: false, retryAfter: await retryAfterFor(env, cfg, refusedKey, now), reserved: new Map() };
}

/**
 * Record ONE real credential rejection. The count was already taken by the gate; this
 * sets the lock on each layer whose reserved count reached its threshold. Called only
 * when the verifier returned a definite wrong-credential.
 */
export async function recordFailure(env: Env, keys: AttemptKeys, gate: AttemptGate): Promise<void> {
  const cfg = throttleConfig(env);
  if (!cfg.enabled) return;
  const now = Date.now();
  for (const [key, count] of gate.reserved) {
    if (key === GLOBAL_KEY) {
      if (count > cfg.globalMax) await lock(env, key, new Date(now + cfg.globalWindowS * 1000).toISOString());
    } else if (count >= cfg.maxFailures) {
      await lock(env, key, new Date(now + backoffMs(cfg, count)).toISOString());
    }
  }
}

/**
 * A correct password fully resets the ACCOUNT counter (relay throttle success), and
 * ONLY that one: the client-IP and global reservations are released (a success is not
 * a failure there), never cleared, so an attacker who holds one valid credential cannot
 * wipe their own spraying budget.
 */
export async function clearFailures(env: Env, keys: AttemptKeys, gate: AttemptGate): Promise<void> {
  if (!throttleConfig(env).enabled) return;
  await env.DB.prepare("DELETE FROM webmail_auth_failures WHERE scope_key = ?")
    .bind(keys.account)
    .run();
  const others = new Map([...gate.reserved].filter(([key]) => key !== keys.account));
  await release(env, others);
}

/**
 * Give back every reservation this attempt holds, for an outcome that is neither a
 * rejection nor a success: an infra error in the verifier, or a lost race. Without it a
 * D1 hiccup mid-verify would count against the user.
 */
export async function releaseAttempt(env: Env, gate: AttemptGate): Promise<void> {
  await release(env, gate.reserved);
}

async function release(env: Env, reserved: Map<string, number>): Promise<void> {
  for (const key of reserved.keys()) {
    await env.DB.prepare(
      "UPDATE webmail_auth_failures SET failures = MAX(failures - 1, 0) WHERE scope_key = ?",
    )
      .bind(key)
      .run();
  }
}

// Reserve one slot on a keyed (account / client-IP) layer: a consecutive-failure streak
// with idle decay. Returns the reserved count, or null when the layer refuses: locked,
// or at its budget with the lock still pending (attempts in flight hold every slot).
// A counted attempt clears an EXPIRED lock, so after a lockout exactly one attempt
// passes before the next lock is decided.
async function reserveKeyed(env: Env, cfg: ThrottleConfig, key: string, now: number): Promise<number | null> {
  const nowIso = new Date(now).toISOString();
  const decayCutoff = new Date(now - cfg.maxLockoutS * 1000).toISOString();
  const row = await env.DB.prepare(
    "INSERT INTO webmail_auth_failures (scope_key, failures, window_start_at, last_failure_at, locked_until) " +
      "VALUES (?1, 1, ?2, ?2, NULL) ON CONFLICT(scope_key) DO UPDATE SET " +
      "failures = CASE WHEN last_failure_at < ?3 THEN 1 ELSE failures + 1 END, " +
      "window_start_at = CASE WHEN last_failure_at < ?3 THEN ?2 ELSE window_start_at END, " +
      "last_failure_at = ?2, locked_until = NULL " +
      "WHERE NOT (locked_until IS NOT NULL AND locked_until > ?2) " +
      "AND NOT (locked_until IS NULL AND failures >= ?4 AND last_failure_at >= ?3) " +
      "RETURNING failures",
  )
    .bind(key, nowIso, decayCutoff, cfg.maxFailures)
    .first<{ failures: number }>();
  return row ? Number(row.failures) : null;
}

// Reserve one slot on the global layer: a sliding COUNT within globalWindowS; a count
// past globalMax cools down every mint for one window (relay/throttle.go fail()).
async function reserveGlobal(env: Env, cfg: ThrottleConfig, now: number): Promise<number | null> {
  const nowIso = new Date(now).toISOString();
  const windowCutoff = new Date(now - cfg.globalWindowS * 1000).toISOString();
  const row = await env.DB.prepare(
    "INSERT INTO webmail_auth_failures (scope_key, failures, window_start_at, last_failure_at, locked_until) " +
      "VALUES (?1, 1, ?2, ?2, NULL) ON CONFLICT(scope_key) DO UPDATE SET " +
      "failures = CASE WHEN window_start_at < ?3 THEN 1 ELSE failures + 1 END, " +
      "window_start_at = CASE WHEN window_start_at < ?3 THEN ?2 ELSE window_start_at END, " +
      "last_failure_at = ?2, locked_until = NULL " +
      "WHERE NOT (locked_until IS NOT NULL AND locked_until > ?2) " +
      "AND NOT (locked_until IS NULL AND failures > ?4 AND window_start_at >= ?3) " +
      "RETURNING failures",
  )
    .bind(GLOBAL_KEY, nowIso, windowCutoff, cfg.globalMax)
    .first<{ failures: number }>();
  return row ? Number(row.failures) : null;
}

// Set a lock, never shortening one already in place.
async function lock(env: Env, key: string, untilIso: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE webmail_auth_failures SET locked_until = CASE " +
      "WHEN locked_until IS NULL OR locked_until < ?2 THEN ?2 ELSE locked_until END WHERE scope_key = ?1",
  )
    .bind(key, untilIso)
    .run();
}

// Whole seconds until the refusing layer can admit an attempt: the live lock's
// remainder, or, while the lock is still pending behind attempts in flight, one base
// lockout (the earliest that lock can end).
async function retryAfterFor(env: Env, cfg: ThrottleConfig, key: string, now: number): Promise<number> {
  const row = await env.DB.prepare("SELECT locked_until FROM webmail_auth_failures WHERE scope_key = ?")
    .bind(key)
    .first<{ locked_until: string | null }>();
  const untilMs = row?.locked_until ? Date.parse(row.locked_until) : NaN;
  if (Number.isFinite(untilMs) && untilMs > now) return Math.ceil((untilMs - now) / 1000);
  return key === GLOBAL_KEY ? cfg.globalWindowS : cfg.lockoutS;
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

// The base lockout doubled once per failure beyond the threshold, capped (identical
// shape to relay/throttle.go backoff()).
function backoffMs(cfg: ThrottleConfig, failures: number): number {
  let d = cfg.lockoutS * 1000;
  const cap = cfg.maxLockoutS * 1000;
  for (let i = 0; i < failures - cfg.maxFailures && d < cap; i++) d *= 2;
  return Math.min(d, cap);
}

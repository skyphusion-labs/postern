// SMTP submission credentials (docs/CONTRACT.md section 9, issue #68), which are also
// the human ACCOUNTS of the native backend (docs/design/webmail-v2-contracts.md 1.10,
// #790): one row is one user, verified by the submission relay, the IMAP door and the
// webmail sign-in alike. The store + hashing behind POST /api/smtp-auth, the session
// mint, and the operator user-management routes. Secrets are persisted ONLY as a
// PBKDF2 derivation (HMAC-SHA512 since #828; HMAC-SHA256 rows from before still
// verify), never in plaintext, and never logged.
//
// This is a SEPARATE concern from store.ts (the message store): it gates the
// SENDER per user. The mailbox/store stays the shared skyphusion.org D1.

// THE CAP (#821, ruled by the lead): the DEPLOYED Cloudflare Workers runtime refuses a
// PBKDF2 iteration count above 100,000 ("Pbkdf2 failed: iteration counts above 100000 are
// not supported"). Node and local `wrangler dev` accept more, which is how a 210,000 value
// shipped with a green suite (#68) and could neither create nor verify ANY credential in
// production. Do NOT raise this from a local result: the suite runs under the edge's limit
// (test-setup/workers-pbkdf2-cap.ts) and goes red above it. A stronger KDF (scrypt or
// Argon2 in WASM) is a separate design item.
import { humanCredentialAgrees, mirrorHuman, recordReadMiss } from "./principalmirror";

export const RUNTIME_PBKDF2_MAX_ITERATIONS = 100_000;

// THE TARGET (#828): PBKDF2-HMAC-SHA512 at the cap. At a FIXED iteration count, SHA-512
// costs a GPU attacker more per guess than SHA-256 (64-bit operations, larger state), so
// under the same 100,000 ceiling this is a strength upgrade, not a fix. The KDF and count
// are encoded into each stored hash, so a legacy `pbkdf2$` (SHA-256) row keeps verifying
// at its own parameters, and a successful sign-in re-hashes any row that is not at the
// target (a different KDF, or a lower count) to the target, never above it (contract
// 1.10.2). dummyHash() below is at the same count hashing uses.
export const PBKDF2_ITERATIONS = RUNTIME_PBKDF2_MAX_ITERATIONS;
const SALT_BYTES = 16;

// Test-only override (#909). Production wrangler configs never set this. Unset,
// empty, or not an integer from 1 to the cap, the target stays PBKDF2_ITERATIONS.
// The Worker reads it off Env, the same object every credential path already
// receives. hashSecret() with no Env falls through to process.env of the same
// name, so the vitest suite can lower the count for every direct call. A present
// Env key wins over the process, and an empty one forces the production count
// even while the suite override is set. A lower count weakens stored passwords,
// which is why a deploy must not set it.
export const TEST_PBKDF2_ITERATIONS_VAR = "POSTERN_TEST_PBKDF2_ITERATIONS";

export interface Pbkdf2IterationSource {
  POSTERN_TEST_PBKDF2_ITERATIONS?: string;
}

function parseIterationOverride(raw: string | undefined): number | "absent" | "invalid" {
  if (raw === undefined) return "absent";
  const trimmed = raw.trim();
  if (trimmed === "") return "absent";
  if (!/^[1-9][0-9]*$/.test(trimmed)) return "invalid";
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > RUNTIME_PBKDF2_MAX_ITERATIONS) return "invalid";
  return n;
}

function readProcessOverride(): number | "absent" | "invalid" {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return parseIterationOverride(proc?.env?.[TEST_PBKDF2_ITERATIONS_VAR]);
}

function logBadOverride(): void {
  console.error(
    "config error: " + TEST_PBKDF2_ITERATIONS_VAR + " is not an integer from 1 to " +
      RUNTIME_PBKDF2_MAX_ITERATIONS + "; using " + PBKDF2_ITERATIONS,
  );
}

/** The count new hashes, the dummy hash, and the rehash target use. */
export function pbkdf2Iterations(env?: Pbkdf2IterationSource): number {
  if (env !== undefined && Object.prototype.hasOwnProperty.call(env, TEST_PBKDF2_ITERATIONS_VAR)) {
    const parsed = parseIterationOverride(env.POSTERN_TEST_PBKDF2_ITERATIONS);
    if (typeof parsed === "number") return parsed;
    if (parsed === "invalid") logBadOverride();
    return PBKDF2_ITERATIONS;
  }
  const fromProcess = readProcessOverride();
  if (typeof fromProcess === "number") return fromProcess;
  if (fromProcess === "invalid") logBadOverride();
  return PBKDF2_ITERATIONS;
}

/** One supported KDF: the tag a stored hash starts with, its PRF, and its output length. */
interface Kdf {
  tag: string;
  hash: "SHA-256" | "SHA-512";
  bytes: number;
}
const LEGACY_SHA256: Kdf = { tag: "pbkdf2", hash: "SHA-256", bytes: 32 };
const TARGET_SHA512: Kdf = { tag: "pbkdf2-sha512", hash: "SHA-512", bytes: 64 };
const KDFS: readonly Kdf[] = [LEGACY_SHA256, TARGET_SHA512];

/** The tag and PRF every new hash is written with (#828). */
export const PBKDF2_TARGET_TAG = TARGET_SHA512.tag;
export const PBKDF2_TARGET_HASH = TARGET_SHA512.hash;

// A well-formed dummy hash at the active target (same KDF, same count), verified
// against when a username is unknown or disabled, so a missing user costs the same
// work as a wrong secret on a current row (no user enumeration by timing). It never
// matches. A row still on the legacy SHA-256 KDF costs a little less to verify until
// its owner next signs in and it is re-hashed; that is the same transitional property
// a lower iteration count had under #810, and it closes per row on the next sign-in.
function dummyHash(env?: Pbkdf2IterationSource): string {
  return [
    TARGET_SHA512.tag,
    String(pbkdf2Iterations(env)),
    "A".repeat(22) + "==",
    "A".repeat(86) + "==",
  ].join("$");
}

// Contract 1.10.1 bounds.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const LOGIN_MAX = 64;
const DISPLAY_NAME_MAX = 128;
// A login is always a safe address local part (contract 1.10.1, lead ruling G11).
const LOGIN_RE = /^[a-z0-9._-]+$/;

export interface SmtpCredential {
  username: string;
  fromAddr: string;
  secretHash: string;
  disabled: boolean;
  displayName: string | null;
}

/** The public projection of a user (contract 1.10.4). Never carries a hash. */
export interface UserRecord {
  username: string;
  from: string;
  displayName: string | null;
  disabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** What a successful verify proves: who signed in, and as which identity. */
export interface AuthenticatedAccount {
  username: string;
  fromAddr: string;
  displayName: string | null;
}

interface CredRow {
  username: string;
  from_addr: string;
  secret_hash: string;
  disabled: number;
  display_name: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const COLS = "username, from_addr, secret_hash, disabled, display_name, created_at, updated_at";

interface ParsedHash {
  kdf: Kdf;
  iterations: number;
  salt: string;
  hash: string;
}

/** Parse `<tag>$<iterations>$<saltB64>$<hashB64>` for a supported tag, or null. */
function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 4) return null;
  const kdf = KDFS.find((k) => k.tag === parts[0]);
  if (!kdf) return null;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return { kdf, iterations: n, salt: parts[2], hash: parts[3] };
}

/** Encode a secret at the target: pbkdf2-sha512$<iterations>$<saltB64>$<hashB64>. */
export async function hashSecret(secret: string, env?: Pbkdf2IterationSource): Promise<string> {
  const iterations = pbkdf2Iterations(env);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await pbkdf2(secret, salt, iterations, TARGET_SHA512);
  return [TARGET_SHA512.tag, String(iterations), toB64(salt), toB64(derived)].join("$");
}

/** The iteration count an encoded hash was made with (any supported KDF), or null if malformed. */
export function hashIterations(encoded: string): number | null {
  return parseHash(encoded)?.iterations ?? null;
}

/** The PRF an encoded hash was made with, or null if malformed or an unknown tag. */
export function hashPrf(encoded: string): "SHA-256" | "SHA-512" | null {
  return parseHash(encoded)?.kdf.hash ?? null;
}

/**
 * True when a VERIFIED row should be re-hashed: it is on a KDF other than the target, or
 * below the target count. A malformed row is false (it never verifies, so it is never
 * reached with a good password anyway).
 */
export function needsRehash(encoded: string, env?: Pbkdf2IterationSource): boolean {
  const p = parseHash(encoded);
  if (!p) return false;
  return p.kdf.tag !== TARGET_SHA512.tag || p.iterations < pbkdf2Iterations(env);
}

/**
 * Constant-time verify of a secret against an encoded hash. Returns false for any
 * malformed encoding (including an unknown KDF tag, or an output of the wrong length for
 * its KDF) rather than throwing, so a corrupt row fails closed.
 */
export async function verifySecret(
  secret: string,
  encoded: string,
  account = "?",
  env?: Pbkdf2IterationSource,
): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (parsed === null) return false;
  const iterations = parsed.iterations;
  // A stored hash above the runtime cap cannot be derived on Workers. Fail CLOSED with a
  // named config error (never a 5xx that leaks the runtime message): every caller then
  // answers exactly as for a wrong password, so the account is not distinguishable.
  // Such a row can only have been minted outside the Worker; the fix is a password reset.
  // TIMING: it must also COST what a wrong password costs, so run the same derive at the
  // target against the dummy hash before refusing; an early return would answer in
  // microseconds and expose the account by its speed.
  if (iterations > RUNTIME_PBKDF2_MAX_ITERATIONS) {
    console.error(
      "config error: credential for " + account + " is hashed at " + iterations +
        " PBKDF2 iterations, above the runtime cap of " + RUNTIME_PBKDF2_MAX_ITERATIONS +
        "; it cannot sign in until an operator resets its password",
    );
    await verifySecret(secret, dummyHash(env), account, env);
    return false;
  }
  const salt = fromB64(parsed.salt);
  const expected = fromB64(parsed.hash);
  if (!salt || !expected) return false;
  const derived = await pbkdf2(secret, salt, iterations, parsed.kdf);
  return timingSafeEqualBytes(derived, expected);
}

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number, kdf: Kdf): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: kdf.hash, salt, iterations },
    key,
    kdf.bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Validate {username, secret} against the table. Returns the account on success, or
 * null on any failure (unknown user, disabled, wrong secret). An unknown or disabled
 * user still runs a PBKDF2 against a dummy hash at the target count, so the timing
 * does not reveal whether the username exists.
 *
 * On success, a hash that is not at the target (a legacy SHA-256 row, or a lower count)
 * is re-hashed at the target (contract 1.10.2, #828). The write is conditional on the hash just verified, so a
 * concurrent reset always wins, and a failed upgrade never fails the sign-in.
 */
export async function authenticateAccount(
  env: Env,
  username: string,
  secret: string,
): Promise<AuthenticatedAccount | null> {
  const cred = await lookup(env, username);
  // #854 M2 part ii: consult the credentials table too; the OLD row's answer stands either
  // way (agree-or-fallback), and a disagreement is only counted.
  if (!(await humanCredentialAgrees(env, normalizeUsername(username), cred ? { secretHash: cred.secretHash, disabled: cred.disabled } : null))) {
    await recordReadMiss(env, "human");
  }
  if (!cred || cred.disabled) {
    // Equalize timing: do the same work, ignore the result.
    await verifySecret(secret, dummyHash(env), "?", env);
    return null;
  }
  const ok = await verifySecret(secret, cred.secretHash, cred.username, env);
  if (!ok) return null;
  if (needsRehash(cred.secretHash, env)) {
    try {
      await setPassword(env, cred.username, await hashSecret(secret, env), new Date().toISOString(), cred.secretHash);
    } catch (err) {
      console.error("hash upgrade failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return { username: cred.username, fromAddr: cred.fromAddr, displayName: cred.displayName };
}

/** The relay seam: the bound From on success, else null (POST /api/smtp-auth). */
export async function authenticate(env: Env, username: string, secret: string): Promise<string | null> {
  const acct = await authenticateAccount(env, username, secret);
  return acct ? acct.fromAddr : null;
}

function fromRow(row: CredRow): SmtpCredential {
  return {
    username: row.username,
    fromAddr: row.from_addr,
    secretHash: row.secret_hash,
    disabled: row.disabled === 1,
    displayName: row.display_name ?? null,
  };
}

function toUser(row: CredRow): UserRecord {
  return {
    username: row.username,
    from: row.from_addr,
    displayName: row.display_name ?? null,
    disabled: row.disabled === 1,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

async function readRow(env: Env, username: string): Promise<CredRow | null> {
  const u = normalizeUsername(username);
  if (!u) return null;
  return await env.DB.prepare(`SELECT ${COLS} FROM smtp_credentials WHERE username = ? LIMIT 1`)
    .bind(u)
    .first<CredRow>();
}

/** Read one credential by login (case-insensitive). */
export async function lookup(env: Env, username: string): Promise<SmtpCredential | null> {
  const row = await readRow(env, username);
  return row ? fromRow(row) : null;
}

/** Read one user (public projection), or null. */
export async function getUser(env: Env, username: string): Promise<UserRecord | null> {
  const row = await readRow(env, username);
  return row ? toUser(row) : null;
}

/** One keyset page of users ordered by username; nextCursor is the last username. */
export async function listUsers(
  env: Env,
  limit: number,
  cursor: string | null,
): Promise<{ users: UserRecord[]; nextCursor: string | null }> {
  const rows = cursor
    ? await env.DB.prepare(`SELECT ${COLS} FROM smtp_credentials WHERE username > ? ORDER BY username LIMIT ?`)
        .bind(cursor, limit + 1)
        .all<CredRow>()
    : await env.DB.prepare(`SELECT ${COLS} FROM smtp_credentials ORDER BY username LIMIT ?`)
        .bind(limit + 1)
        .all<CredRow>();
  const page = (rows.results ?? []).slice(0, limit);
  const more = (rows.results ?? []).length > limit;
  return { users: page.map(toUser), nextCursor: more && page.length ? page[page.length - 1].username : null };
}

/** Create a user; never overwrites. Returns false when the username already exists. */
export async function createUser(
  env: Env,
  user: { username: string; fromAddr: string; displayName: string | null },
  secretHash: string,
  now: string,
): Promise<boolean> {
  const u = normalizeUsername(user.username);
  const [res] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(username) DO NOTHING`,
    ).bind(u, user.fromAddr, secretHash, user.displayName, now, now),
    ...mirrorHuman(env, u, now), // #854 M2: the principal tables change with it
  ]);
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Does ANY account row exist (enabled or not)? The default-backend rule and the
 * first-run gate both key on this (contract 1.10.6/1.10.7): a disabled user is still
 * a row, so disabling everyone never re-opens setup. One indexed read.
 */
export async function anyUser(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS one FROM smtp_credentials LIMIT 1").first<{ one: number }>();
  return row !== null;
}

/**
 * Create the FIRST user, atomically: the insert happens only while the table is still
 * empty, so two racing first-run requests produce exactly one user (contract 1.10.7).
 * Returns false when any row already exists.
 */
export async function createFirstUser(
  env: Env,
  user: { username: string; fromAddr: string; displayName: string | null },
  secretHash: string,
  now: string,
): Promise<boolean> {
  const u = normalizeUsername(user.username);
  const [res] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, display_name, created_at, updated_at)
       SELECT ?, ?, ?, 0, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM smtp_credentials)`,
    ).bind(u, user.fromAddr, secretHash, user.displayName, now, now),
    ...mirrorHuman(env, u, now), // #854 M2
  ]);
  return (res.meta?.changes ?? 0) > 0;
}

/** Change any of disabled / displayName / from. Returns the updated user, or null. */
export async function updateUser(
  env: Env,
  username: string,
  patch: { disabled?: boolean; displayName?: string | null; fromAddr?: string },
  now: string,
): Promise<UserRecord | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.disabled !== undefined) {
    sets.push("disabled = ?");
    args.push(patch.disabled ? 1 : 0);
  }
  if (patch.displayName !== undefined) {
    sets.push("display_name = ?");
    args.push(patch.displayName);
  }
  if (patch.fromAddr !== undefined) {
    sets.push("from_addr = ?");
    args.push(patch.fromAddr);
  }
  if (sets.length === 0) return await getUser(env, username);
  sets.push("updated_at = ?");
  args.push(now, normalizeUsername(username));
  const [res] = await env.DB.batch([
    env.DB.prepare(`UPDATE smtp_credentials SET ${sets.join(", ")} WHERE username = ?`).bind(...args),
    ...mirrorHuman(env, normalizeUsername(username), now), // #854 M2
  ]);
  if ((res.meta?.changes ?? 0) === 0) return null;
  return await getUser(env, username);
}

/**
 * Replace a user's hash. With expectedHash, only if the stored hash still equals it
 * (the upgrade-on-sign-in and change-password compare-and-set). Returns true if a row
 * changed.
 */
export async function setPassword(
  env: Env,
  username: string,
  secretHash: string,
  now: string,
  expectedHash?: string,
): Promise<boolean> {
  const u = normalizeUsername(username);
  const update = expectedHash === undefined
    ? env.DB.prepare("UPDATE smtp_credentials SET secret_hash = ?, updated_at = ? WHERE username = ?").bind(secretHash, now, u)
    : env.DB.prepare(
        "UPDATE smtp_credentials SET secret_hash = ?, updated_at = ? WHERE username = ? AND secret_hash = ?",
      ).bind(secretHash, now, u, expectedHash);
  // #854 M2: every hash change, the upgrade-on-sign-in rehash included, moves the
  // credential's secret in the same batch.
  const [res] = await env.DB.batch([update, ...mirrorHuman(env, u, now)]);
  return (res.meta?.changes ?? 0) > 0;
}

/** Create or rotate a credential (upsert on username). The legacy admin route. */
export async function upsert(
  env: Env,
  username: string,
  fromAddr: string,
  secretHash: string,
  now: string,
): Promise<void> {
  const u = normalizeUsername(username);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         from_addr = excluded.from_addr,
         secret_hash = excluded.secret_hash,
         disabled = 0,
         updated_at = excluded.updated_at`,
    ).bind(u, fromAddr, secretHash, now, now),
    ...mirrorHuman(env, u, now), // #854 M2
  ]);
}

/** Remove a credential. Returns true if a row was deleted. */
export async function remove(env: Env, username: string): Promise<boolean> {
  const u = normalizeUsername(username);
  if (!u) return false;
  const [res] = await env.DB.batch([
    env.DB.prepare("DELETE FROM smtp_credentials WHERE username = ?").bind(u),
    ...mirrorHuman(env, u, new Date().toISOString()), // #854 M2: revoke and disable, never delete
  ]);
  return (res.meta?.changes ?? 0) > 0;
}

/** A login normalizes to a trimmed, lowercased string. */
export function normalizeUsername(username: string): string {
  return (username ?? "").trim().toLowerCase();
}

/**
 * Contract 1.10.1: the reason a NEW username is refused, or null. Input is normalized.
 * Either a bare login L, or L@<allowedDomain>; L is 1 to 64 of a-z 0-9 . _ - with no
 * leading or trailing dot and no "..", so it is always a safe address local part.
 * Existing rows are not re-validated.
 */
export function usernameProblem(username: string, allowedDomain: string): string | null {
  const rule = `username must be 1 to ${LOGIN_MAX} characters of a-z 0-9 . _ - (no leading, trailing or double dot), optionally followed by @${allowedDomain}`;
  if (!username) return rule;
  const at = username.indexOf("@");
  const login = at < 0 ? username : username.slice(0, at);
  if (at >= 0 && username.slice(at + 1) !== allowedDomain) return rule;
  if (login.length < 1 || login.length > LOGIN_MAX || !LOGIN_RE.test(login)) return rule;
  if (login.startsWith(".") || login.endsWith(".") || login.includes("..")) return rule;
  return null;
}

/** Contract 1.10.1: the reason a display name is refused, or null. */
export function displayNameProblem(name: string): string | null {
  if (name.length > DISPLAY_NAME_MAX) return `displayName must be at most ${DISPLAY_NAME_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "displayName must not contain control characters";
  return null;
}

/**
 * Contract 1.10.1 password policy (NIST SP 800-63B style, no composition rules). Returns
 * the user-facing reason a password is refused, or null. Runs before any PBKDF2.
 */
export function passwordProblem(password: string, username: string, current?: string): string | null {
  if (password.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  if (password.toLowerCase() === normalizeUsername(username)) return "password must not be the username";
  if (current !== undefined && password === current) return "new password must differ from the current one";
  return null;
}

/** Generate a high-entropy URL-safe secret for a freshly minted credential. */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return toB64Url(bytes);
}

// --- byte helpers ---

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time byte compare. Length may differ (it short-circuits) but the byte
// contents of equal-length inputs are compared without an early exit.
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

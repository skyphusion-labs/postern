// SMTP submission credentials (docs/CONTRACT.md section 9, issue #68), which are also
// the human ACCOUNTS of the native backend (docs/design/webmail-v2-contracts.md 1.10,
// #790): one row is one user, verified by the submission relay, the IMAP door and the
// webmail sign-in alike. The store + hashing behind POST /api/smtp-auth, the session
// mint, and the operator user-management routes. Secrets are persisted ONLY as a
// PBKDF2-HMAC-SHA256 derivation, never in plaintext, and never logged.
//
// This is a SEPARATE concern from store.ts (the message store): it gates the
// SENDER per user. The mailbox/store stays the shared skyphusion.org D1.

// The deployed Cloudflare Workers runtime refuses PBKDF2 above this many iterations
// ("Pbkdf2 failed: iteration counts above 100000 are not supported", #821). Node and
// local wrangler dev accept more, which is how a 210,000 target shipped green and broke
// every native credential on the edge. The suite now runs under this cap
// (test-setup/workers-pbkdf2-cap.ts), so exceeding it goes red locally.
export const RUNTIME_PBKDF2_MAX_ITERATIONS = 100_000;

// The target (contract 1.10.2): PBKDF2-HMAC-SHA512 at the runtime ceiling. At a fixed
// iteration count SHA-512 costs a GPU attacker more per guess than SHA-256, and no other
// KDF is in Web Crypto on Workers. Each row names its own KDF and count, so the target
// can change without a schema change, and a successful sign-in re-hashes an older row.
export const PBKDF2_ITERATIONS = RUNTIME_PBKDF2_MAX_ITERATIONS;
const TARGET_TAG = "pbkdf2-sha512";
const SALT_BYTES = 16;

// Encodings by tag. "pbkdf2" is the #68 legacy (SHA-256, 32-byte output).
const KDFS: Record<string, { hash: "SHA-256" | "SHA-512"; bytes: number }> = {
  "pbkdf2-sha512": { hash: "SHA-512", bytes: 64 },
  pbkdf2: { hash: "SHA-256", bytes: 32 },
};

/**
 * A stored hash this runtime cannot verify (its iteration count is above the Workers
 * cap). A DATA condition, not a wrong password: callers answer it as an infra failure
 * and never count it as a guess, so it cannot lock a user out (contract 1.10.2).
 */
export class UnverifiableHashError extends Error {}

// A well-formed dummy hash at the TARGET parameters (16-byte salt, 64-byte output),
// verified against when a username is unknown or disabled, so a missing user costs the
// same PBKDF2 work as a wrong secret (no user enumeration by timing). The plaintext it
// encodes is irrelevant; it never matches.
const DUMMY_HASH = [TARGET_TAG, String(PBKDF2_ITERATIONS), "A".repeat(22) + "==", "A".repeat(86) + "=="].join("$");

// Contract 1.10.1 bounds.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const USERNAME_MAX = 254;
const DISPLAY_NAME_MAX = 128;
const USERNAME_RE = /^[a-z0-9][a-z0-9._+@-]*$/;

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

/** Encode a secret at the target: pbkdf2-sha512$<iterations>$<saltB64>$<hashB64>. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const kdf = KDFS[TARGET_TAG];
  const derived = await pbkdf2(secret, salt, PBKDF2_ITERATIONS, kdf.hash, kdf.bytes);
  return [TARGET_TAG, String(PBKDF2_ITERATIONS), toB64(salt), toB64(derived)].join("$");
}

interface ParsedHash {
  tag: string;
  hash: "SHA-256" | "SHA-512";
  iterations: number;
  salt: Uint8Array;
  expected: Uint8Array;
}

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 4) return null;
  const kdf = KDFS[parts[0]];
  if (!kdf) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  if (!salt || !expected || expected.length !== kdf.bytes) return null;
  return { tag: parts[0], hash: kdf.hash, iterations, salt, expected };
}

/** Is this stored hash below the target (another KDF, or fewer iterations)? */
export function needsUpgrade(encoded: string): boolean {
  const h = parseHash(encoded);
  return h !== null && (h.tag !== TARGET_TAG || h.iterations < PBKDF2_ITERATIONS);
}

/** The iteration count an encoded hash was made with, or null if malformed. */
export function hashIterations(encoded: string): number | null {
  return parseHash(encoded)?.iterations ?? null;
}

/**
 * Constant-time verify of a secret against an encoded hash. Returns false for any
 * malformed encoding rather than throwing, so a corrupt row fails closed.
 */
export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const h = parseHash(encoded);
  if (!h) return false;
  // A well-formed hash above the runtime cap is NOT a wrong password: throw, before
  // deriving anything, so callers answer it as an infra failure (contract 1.10.2).
  if (h.iterations > RUNTIME_PBKDF2_MAX_ITERATIONS) {
    throw new UnverifiableHashError(
      "stored hash uses " + h.iterations + " iterations and cannot be verified on this runtime (max " +
        RUNTIME_PBKDF2_MAX_ITERATIONS + "); reset the password",
    );
  }
  const derived = await pbkdf2(secret, h.salt, h.iterations, h.hash, h.expected.length);
  return timingSafeEqualBytes(derived, h.expected);
}

async function pbkdf2(
  secret: string,
  salt: Uint8Array,
  iterations: number,
  hash: "SHA-256" | "SHA-512",
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash, salt, iterations },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Validate {username, secret} against the table. Returns the account on success, or
 * null on any failure (unknown user, disabled, wrong secret). An unknown or disabled
 * user still runs a PBKDF2 against a dummy hash at the target count, so the timing
 * does not reveal whether the username exists.
 *
 * On success, a hash below the current iteration target is re-hashed at the target
 * (contract 1.10.2). The write is conditional on the hash just verified, so a
 * concurrent reset always wins, and a failed upgrade never fails the sign-in.
 */
export async function authenticateAccount(
  env: Env,
  username: string,
  secret: string,
): Promise<AuthenticatedAccount | null> {
  const cred = await lookup(env, username);
  if (!cred || cred.disabled) {
    // Equalize timing: do the same work, ignore the result.
    await verifySecret(secret, DUMMY_HASH);
    return null;
  }
  let ok: boolean;
  try {
    ok = await verifySecret(secret, cred.secretHash);
  } catch (err) {
    if (err instanceof UnverifiableHashError) {
      // Name the account so the operator can reset it; never log the secret.
      console.error("credential for " + cred.username + " needs a password reset: " + err.message);
    }
    throw err;
  }
  if (!ok) return null;
  if (needsUpgrade(cred.secretHash)) {
    try {
      await setPassword(env, cred.username, await hashSecret(secret), new Date().toISOString(), cred.secretHash);
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
  const res = await env.DB.prepare(
    `INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, display_name, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(username) DO NOTHING`,
  )
    .bind(normalizeUsername(user.username), user.fromAddr, secretHash, user.displayName, now, now)
    .run();
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
  const res = await env.DB.prepare(`UPDATE smtp_credentials SET ${sets.join(", ")} WHERE username = ?`)
    .bind(...args)
    .run();
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
  const res = expectedHash === undefined
    ? await env.DB.prepare("UPDATE smtp_credentials SET secret_hash = ?, updated_at = ? WHERE username = ?")
        .bind(secretHash, now, u)
        .run()
    : await env.DB.prepare(
        "UPDATE smtp_credentials SET secret_hash = ?, updated_at = ? WHERE username = ? AND secret_hash = ?",
      )
        .bind(secretHash, now, u, expectedHash)
        .run();
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
  await env.DB.prepare(
    `INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       from_addr = excluded.from_addr,
       secret_hash = excluded.secret_hash,
       disabled = 0,
       updated_at = excluded.updated_at`,
  )
    .bind(u, fromAddr, secretHash, now, now)
    .run();
}

/** Remove a credential. Returns true if a row was deleted. */
export async function remove(env: Env, username: string): Promise<boolean> {
  const u = normalizeUsername(username);
  if (!u) return false;
  const res = await env.DB.prepare("DELETE FROM smtp_credentials WHERE username = ?").bind(u).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** A login normalizes to a trimmed, lowercased string. */
export function normalizeUsername(username: string): string {
  return (username ?? "").trim().toLowerCase();
}

/** Contract 1.10.1: the reason a NEW username is refused, or null. Input is normalized. */
export function usernameProblem(username: string): string | null {
  if (!username) return "username is required";
  if (username.length > USERNAME_MAX) return `username must be at most ${USERNAME_MAX} characters`;
  if (!USERNAME_RE.test(username)) {
    return "username may use a-z, 0-9 and . _ + @ - and must start with a letter or digit";
  }
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

// SMTP submission credentials (docs/CONTRACT.md section 9, issue #68). The store
// + hashing behind POST /api/smtp-auth (the submission relay's per-user auth
// check) and the operator provisioning route. Secrets are persisted ONLY as a
// PBKDF2-HMAC-SHA256 derivation, never in plaintext, and never logged.
//
// This is a SEPARATE concern from store.ts (the message store): it gates the
// SENDER per user. The mailbox/store stays the shared skyphusion.org D1.

// OWASP 2023 floor for PBKDF2-HMAC-SHA256. Encoded into the hash string so it can
// be raised later without a schema change (old hashes verify at their own count).
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

// A well-formed dummy hash verified against when a username is unknown, so a
// missing user costs the same PBKDF2 work as a wrong secret (no user enumeration
// by timing). The plaintext it encodes is irrelevant; it never matches.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

export interface SmtpCredential {
  username: string;
  fromAddr: string;
  secretHash: string;
  disabled: boolean;
}

/** Encode a secret as pbkdf2$<iterations>$<saltB64>$<hashB64>. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await pbkdf2(secret, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(derived)}`;
}

/**
 * Constant-time verify of a secret against an encoded hash. Returns false for any
 * malformed encoding rather than throwing, so a corrupt row fails closed.
 */
export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  if (!salt || !expected) return false;
  const derived = await pbkdf2(secret, salt, iterations);
  return timingSafeEqualBytes(derived, expected);
}

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Validate {username, secret} against the table. Returns the bound From identity
 * on success, or null on any failure (unknown user, disabled, wrong secret). An
 * unknown user still runs a PBKDF2 against a dummy hash so the timing does not
 * reveal whether the username exists.
 */
export async function authenticate(env: Env, username: string, secret: string): Promise<string | null> {
  const cred = await lookup(env, username);
  if (!cred || cred.disabled) {
    // Equalize timing: do the same work, ignore the result.
    await verifySecret(secret, DUMMY_HASH);
    return null;
  }
  const ok = await verifySecret(secret, cred.secretHash);
  return ok ? cred.fromAddr : null;
}

/** Read one credential by login (case-insensitive). */
export async function lookup(env: Env, username: string): Promise<SmtpCredential | null> {
  const u = normalizeUsername(username);
  if (!u) return null;
  const row = await env.DB.prepare(
    "SELECT username, from_addr, secret_hash, disabled FROM smtp_credentials WHERE username = ? LIMIT 1",
  )
    .bind(u)
    .first<{ username: string; from_addr: string; secret_hash: string; disabled: number }>();
  if (!row) return null;
  return {
    username: row.username,
    fromAddr: row.from_addr,
    secretHash: row.secret_hash,
    disabled: row.disabled === 1,
  };
}

/** Create or rotate a credential (upsert on username). */
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

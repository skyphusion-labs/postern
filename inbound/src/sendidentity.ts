// Per-identity send registry (#28, the layer above the #85 scope resolver). #85
// resolves a Bearer to a SCOPE (read / send / both); this resolves a send token
// further to a DISTINCT, AUTHORITATIVE sender identity. MANY send-scoped tokens
// each carry the SAME send scope but a different bound From, so everyone sends as
// THEMSELVES through their own per-identity token instead of one shared key.
//
// The registry is OPERATOR CONFIG (a worker secret, POSTERN_SEND_IDENTITIES), not
// code: an operator adds an identity by editing the secret, with no deploy. It
// stores sha256 HASHES of tokens, never the raw tokens, so the secret itself never
// holds a plaintext send credential. Resolution hashes the presented Bearer and
// indexes the map by that hash (an index on a hash of a high-entropy secret, so
// the non-constant-time Map lookup does not leak the token).

/** The scope a presented mailbox token carries (canonical home for the #85 type). */
export type Scope = "read" | "send" | "both";

/**
 * A sender identity bound to a registry token. `from` is AUTHORITATIVE: the worker
 * sets/overrides the outbound From to it, so a token cannot send as anyone else.
 */
export interface BoundIdentity {
  from: string;
  displayName?: string;
}

/**
 * The outcome of resolving a presented Bearer: its scope, plus the bound identity
 * when (and only when) the token came from the per-identity send registry. A static
 * scope token (both/read/send) resolves with no identity (back-compat From rules).
 */
export interface TokenResolution {
  scope: Scope;
  identity?: BoundIdentity;
}

// Linear, ReDoS-safe address shape check, mirroring mailbox.ts: dot-free labels
// joined by literal dots. Used to reject a registry entry with a malformed From.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;

/**
 * Lowercase sha256 hex of a UTF-8 string via Web Crypto (present in workerd). Hex
 * matches `printf %s "$token" | sha256sum | cut -d" " -f1`, so an operator can
 * compute a registry key with stock CLI tools.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Parse the registry secret into a Map<tokenHash, BoundIdentity>. Defensive by
 * design: a missing, malformed, or partially-bad secret yields an empty (or
 * partial) map rather than throwing, so a broken registry can only DENY (a token
 * that fails to resolve is 401) and never escalates, and the back-compat static
 * tokens keep working regardless. Each entry is validated -- the key must be a
 * 64-char lowercase sha256 hex and `from` a well-formed address; a bad entry is
 * skipped, not fatal.
 *
 * When `allowedDomain` is given, the domain policy stays AUTHORITATIVE over the
 * registry: the per-identity From is authoritative over the CALLER, but a registry
 * entry can never widen the sender domain. An entry whose From is outside the allowed
 * domain is DENIED at resolve time (skipped here) and logged, so a fat-fingered or
 * tampered entry cannot make the worker send as an arbitrary external domain.
 */
export function parseRegistry(
  raw: string | undefined,
  allowedDomain?: string,
): Map<string, BoundIdentity> {
  const map = new Map<string, BoundIdentity>();
  if (!raw || raw.trim() === "") return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map; // malformed JSON: deny-by-default, never throw on the request path
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;

  const domain = allowedDomain ? allowedDomain.toLowerCase() : undefined;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/.test(key)) continue; // not a sha256 hex key
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const from = typeof v.from === "string" ? v.from.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(from)) continue; // entry with no/invalid From: skip (deny)
    // Domain policy authoritative over the registry: an off-domain entry is denied at
    // the gate (and logged), defense in depth with resolveFrom. The From is config
    // data, not a secret, so it is safe to log; the token/hash is never logged.
    if (domain && from.split("@")[1] !== domain) {
      console.warn(
        `POSTERN_SEND_IDENTITIES: ignoring entry with from="${from}" outside ALLOWED_FROM_DOMAIN="${domain}"`,
      );
      continue;
    }
    const identity: BoundIdentity = { from };
    if (typeof v.displayName === "string" && v.displayName.trim() !== "") {
      identity.displayName = v.displayName.trim();
    }
    map.set(key, identity);
  }
  return map;
}

/**
 * Resolve a presented Bearer against the send-identity registry: the bound identity
 * for a known registry token, or null if the token is not registered. The caller
 * resolves the static scope tokens FIRST and consults this only when none matched,
 * so a registry hit always means scope `send` with an authoritative From. An entry
 * whose From is outside `allowedDomain` is treated as not present (denied -> 401).
 */
export async function resolveRegistryIdentity(
  token: string,
  raw: string | undefined,
  allowedDomain?: string,
): Promise<BoundIdentity | null> {
  if (!token) return null;
  const map = parseRegistry(raw, allowedDomain);
  if (map.size === 0) return null;
  const hash = await sha256Hex(token);
  return map.get(hash) ?? null;
}

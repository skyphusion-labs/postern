// Per-identity credential registry (#28, extended by #544 for read).
//
// #85 resolves a Bearer to a SCOPE (read / send / both / ...). This registry maps a
// token hash to a DISTINCT, AUTHORITATIVE mail identity (and which functions it may
// use). MANY tokens each bind a different person: everyone acts as THEMSELVES through
// their own credential instead of one shared estate key.
//
// Historically (#28) entries implied send-only. #544 adds optional `scopes` so the
// same registry can mint read-bound credentials (MCP / agents) whose reads are forced
// to that identity server-side -- filtering is not optional etiquette.
//
// The registry is OPERATOR CONFIG (the POSTERN_SEND_IDENTITIES var in wrangler
// config, #335; a worker secret before that), not code: an operator adds an identity
// by editing the var and redeploying. It stores sha256 HASHES of tokens, never the
// raw tokens, so the registry never holds a plaintext credential -- which is
// exactly why it is a readable var and not a write-only secret: there is nothing
// confidential in it, and a write-only registry cannot be merged, diffed, or
// recovered (#335). Resolution hashes the presented Bearer and
// indexes the map by that hash (an index on a hash of a high-entropy secret, so
// the non-constant-time Map lookup does not leak the token).

/** The scope a presented mailbox token carries (canonical home for the #85 type).
 *  `delete` is the #352 (C4) hard-delete scope: DELETE /api/messages/{id} accepts a
 *  `delete` token OR `both`, so the IMAP EXPUNGE credential drops from full-admin
 *  `both` to delete-only least privilege. `both` = read + send + delete + admin. */
export type Scope = "read" | "send" | "delete" | "imap" | "both";

/** Registry-granted functions only. Never delete/admin: those stay on static `both`. */
export type IdentityCap = "read" | "send";

/**
 * A mail identity bound to a registry token. `from` is AUTHORITATIVE for send (the
 * worker sets/overrides outbound From) and for read (#544: list/search/get are forced
 * to this address + role queues, never the estate).
 */
export interface BoundIdentity {
  from: string;
  displayName?: string;
}

/**
 * One registry hit: bound identity plus the capability SET used by authorize()
 * (membership, like webmail sessions). Caps are only "read" and/or "send".
 */
export interface RegistryHit {
  identity: BoundIdentity;
  caps: IdentityCap[];
}

/**
 * The outcome of resolving a presented Bearer: a primary Scope (static tokens) plus
 * optional bound identity / caps (registry or session). A static scope token
 * (both/read/send) resolves with no identity (back-compat; estate-wide for read).
 */
export interface TokenResolution {
  scope: Scope;
  identity?: BoundIdentity;
  /** When set, authorize() uses membership instead of scopeSatisfies(scope). */
  caps?: string[];
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
 * Parse the registry into a Map<tokenHash, RegistryHit>. Defensive by design: a
 * missing, malformed, or partially-bad secret yields an empty (or partial) map rather
 * than throwing, so a broken registry can only DENY (a token that fails to resolve is
 * 401) and never escalates, and the back-compat static tokens keep working regardless.
 * Each entry is validated -- the key must be a 64-char lowercase sha256 hex and `from`
 * a well-formed address; a bad entry is skipped, not fatal.
 *
 * `scopes` (optional, #544): array of "read" and/or "send". Omitted or empty defaults
 * to `["send"]` so every pre-#544 registry entry stays send-only. Unknown strings are
 * ignored; if nothing valid remains after filtering, the entry is skipped.
 *
 * When `allowedDomain` is given, the domain policy stays AUTHORITATIVE over the
 * registry: the per-identity From is authoritative over the CALLER, but a registry
 * entry can never widen the sender domain. An entry whose From is outside the allowed
 * domain is DENIED at resolve time (skipped here) and logged, so a fat-fingered or
 * tampered entry cannot make the worker send as an arbitrary external domain.
 *
 * `raw` is normally the JSON string from the "vars" block, but wrangler also accepts
 * a JSON OBJECT as a var value and hands it to the Worker already parsed. An operator
 * who pastes the registry as an object meant exactly that registry, so it is accepted
 * as-is (every entry still passes the same per-entry validation). Any other type
 * yields an empty map: it must never throw, because this runs for every bearer that
 * is not a static token, and a throw there is a 500 instead of a 401.
 */
export function parseRegistry(
  raw: unknown,
  allowedDomain?: string,
): Map<string, RegistryHit> {
  const map = new Map<string, RegistryHit>();

  let parsed: unknown;
  if (typeof raw === "string") {
    if (raw.trim() === "") return map;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return map; // malformed JSON: deny-by-default, never throw on the request path
    }
  } else {
    parsed = raw; // already-parsed object var (or junk, rejected just below)
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
    const caps = parseIdentityCaps(v.scopes);
    if (caps.length === 0) continue;
    const identity: BoundIdentity = { from };
    if (typeof v.displayName === "string" && v.displayName.trim() !== "") {
      identity.displayName = v.displayName.trim();
    }
    map.set(key, { identity, caps });
  }
  return map;
}

/** Default scopes=["send"] for back-compat with every pre-#544 registry entry. */
function parseIdentityCaps(raw: unknown): IdentityCap[] {
  if (raw === undefined || raw === null) return ["send"];
  if (!Array.isArray(raw)) return ["send"];
  const out: IdentityCap[] = [];
  for (const item of raw) {
    if (item === "read" || item === "send") {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

/**
 * Resolve a presented Bearer against the identity registry: a RegistryHit for a known
 * token, or null if the token is not registered. The caller resolves the static scope
 * tokens FIRST and consults this only when none matched. An entry whose From is outside
 * `allowedDomain` is treated as not present (denied -> 401).
 */
export async function resolveRegistryIdentity(
  token: string,
  raw: unknown,
  allowedDomain?: string,
): Promise<RegistryHit | null> {
  if (!token) return null;
  const map = parseRegistry(raw, allowedDomain);
  if (map.size === 0) return null;
  const hash = await sha256Hex(token);
  return map.get(hash) ?? null;
}

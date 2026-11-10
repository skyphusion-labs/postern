// Runtime agent identities (#801, slice S1 of #632) and the audit log they write.
//
// POSTERN_SEND_IDENTITIES (sendidentity.ts) is operator CONFIG: adding or removing an
// agent credential there needs a deploy, so it cannot be revoked in an incident. This
// module is the runtime half, on the smtp-credentials precedent (#68): an operator (a
// static `both` token, the only holder of `admin`) mints, lists and revokes identities
// with the same read / send / organize caps the registry grants. The resolver in api.ts
// consults this table AFTER the static tokens and the env registry, so every existing
// deploy keeps resolving exactly as before.
//
// Properties, each pinned by inbound/agent-identities.test.ts:
//   - The store holds the sha256 HASH of a token, never the token. The token is in the
//     mint response once and is not retrievable again from any route.
//   - No response carries token_hash: not the list, not the audit log, not whoami.
//   - Every identity has a stable `id` (never reused; rows are never deleted) that
//     #740's audit trail attributes entries to.
//   - Revocation takes effect on the NEXT request: resolution reads D1 every time and
//     there is no cache to expire.
//   - A runtime identity never holds `admin`: its caps are a subset of read, send and
//     organize, and an unknown or admin-level cap is refused at mint (400), not stripped.
//   - Every mint, list and revoke writes one audit_log row, refusals included. A
//     successful mint or revoke and its audit row land in ONE D1 batch, so the action
//     cannot happen without its record.

import type { BoundIdentity, IdentityCap } from "./sendidentity";
import { sha256Hex } from "./sendidentity";
import { allowedFromDomain } from "./fromdomain";
import { displayNameProblem } from "./smtpcreds";
import { readBodyCapped, PayloadTooLargeError } from "./body";

/** What a runtime identity may hold: exactly the registry caps. Never delete or admin. */
export const RUNTIME_CAPS: readonly IdentityCap[] = ["read", "send", "organize"];

/** One resolved runtime identity: what the gate needs, plus the stable id. */
export interface RuntimeHit {
  id: string;
  identity: BoundIdentity;
  caps: IdentityCap[];
}

/**
 * The identity store could not be read. Thrown by the resolver so the gate answers 503
 * rather than 401: a client that reads 401 as "revoked" would discard a live credential
 * during a D1 outage, and a 200 is impossible without the row.
 */
export class IdentityStoreUnavailable extends Error {}

const TOKEN_PREFIX = "pstn_";
const ID_PREFIX = "idn_";
const MAX_BODY_BYTES = 4 * 1024;
const LABEL_MAX = 100;
const LIST_DEFAULT = 100;
const LIST_MAX = 500;
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const ID_RE = /^idn_[0-9a-f]{24}$/;

class IdentityError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function fail(err: IdentityError): Response {
  const body: Record<string, unknown> = { ok: false, error: err.code, message: err.message };
  if (err.field) body.field = err.field;
  return json(body, err.status);
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh token: a recognisable prefix (so secret scanners can match it) plus 256 bits. */
export function generateToken(): string {
  return TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function generateId(): string {
  return ID_PREFIX + hex(crypto.getRandomValues(new Uint8Array(12)));
}

/** Parse a stored scopes column. Unknown strings are dropped, so a bad row can only narrow. */
function parseCaps(raw: unknown): IdentityCap[] {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: IdentityCap[] = [];
  for (const item of parsed) {
    if ((RUNTIME_CAPS as readonly unknown[]).includes(item) && !out.includes(item as IdentityCap)) {
      out.push(item as IdentityCap);
    }
  }
  return out;
}

// --- resolution (the gate's half) ---

interface IdentityRow {
  id: string;
  from_addr: string;
  display_name: string | null;
  label: string | null;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Resolve a presented Bearer against the runtime table, or null. A revoked row, a row
 * whose From is off the allowed domain (the domain may have changed since the mint), or
 * a row with no usable caps all resolve to null, which the gate answers 401. A read
 * failure THROWS IdentityStoreUnavailable (503), never null.
 */
export async function resolveRuntimeIdentity(env: Env, token: string, allowedDomain: string): Promise<RuntimeHit | null> {
  if (!token) return null;
  const hash = await sha256Hex(token);
  let row: IdentityRow | null;
  try {
    row = await env.DB.prepare(
      "SELECT id, from_addr, display_name, scopes FROM agent_identities WHERE token_hash = ? AND revoked_at IS NULL",
    )
      .bind(hash)
      .first<IdentityRow>();
  } catch (err) {
    console.error("agent_identities lookup failed", err instanceof Error ? err.message : String(err));
    throw new IdentityStoreUnavailable("identity store unavailable");
  }
  if (!row) return null;
  const from = row.from_addr.toLowerCase();
  if (from.split("@")[1] !== allowedDomain.toLowerCase()) {
    console.warn(`agent identity ${row.id}: from="${from}" is outside ALLOWED_FROM_DOMAIN, denied`);
    return null;
  }
  const caps = parseCaps(row.scopes);
  if (caps.length === 0) return null;
  const identity: BoundIdentity = { from };
  if (row.display_name) identity.displayName = row.display_name;
  return { id: row.id, identity, caps };
}

// --- audit ---

interface AuditEntry {
  action: "identity.mint" | "identity.list" | "identity.revoke";
  targetId?: string | null;
  outcome: "ok" | "refused";
  detail?: Record<string, unknown>;
}

// Every writer today is the operator (a static `both` token, which carries no id).
// actor_kind / actor_id exist so #740 can record an agent identity as the actor.
function auditStatement(env: Env, at: string, entry: AuditEntry) {
  return env.DB.prepare(
    "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_kind, target_id, outcome, detail) " +
      "VALUES (?, 'operator', NULL, ?, ?, ?, ?, ?)",
  ).bind(
    at,
    entry.action,
    entry.targetId ? "identity" : null,
    entry.targetId ?? null,
    entry.outcome,
    entry.detail ? JSON.stringify(entry.detail) : null,
  );
}

/**
 * Record a refusal. Best effort BY DESIGN: the refusal already happened and its answer
 * is the same either way, so a failed write is logged and the refusal is still returned
 * (failing it would turn a 400 into a 500 and tell the caller less, not more).
 */
async function auditRefusal(env: Env, entry: Omit<AuditEntry, "outcome">, err: IdentityError) {
  try {
    await auditStatement(env, new Date().toISOString(), {
      ...entry,
      outcome: "refused",
      detail: { ...(entry.detail ?? {}), error: err.code },
    }).run();
  } catch (e) {
    console.error("audit_log write failed for a refusal", e instanceof Error ? e.message : String(e));
  }
}

// --- request parsing ---

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBodyCapped(request, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) throw new IdentityError(413, "E_PAYLOAD_TOO_LARGE", "request body too large");
    throw err;
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IdentityError(400, "E_VALIDATION_ERROR", "invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IdentityError(400, "E_VALIDATION_ERROR", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireDomain(env: Env): string {
  const domain = allowedFromDomain(env);
  if (!domain) throw new IdentityError(500, "E_INTERNAL_SERVER_ERROR", "ALLOWED_FROM_DOMAIN is not configured");
  return domain;
}

/** Requested caps: a non-empty array of known cap names. Anything else is a 400, never a strip. */
function requestedCaps(body: Record<string, unknown>): IdentityCap[] {
  const raw = body.scopes;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new IdentityError(400, "E_VALIDATION_ERROR", `scopes must be a non-empty array of ${RUNTIME_CAPS.join(", ")}`, "scopes");
  }
  const out: IdentityCap[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !(RUNTIME_CAPS as readonly string[]).includes(item)) {
      throw new IdentityError(
        400,
        "E_VALIDATION_ERROR",
        `unknown scope ${JSON.stringify(item)}: an agent identity may hold only ${RUNTIME_CAPS.join(", ")}`,
        "scopes",
      );
    }
    if (!out.includes(item as IdentityCap)) out.push(item as IdentityCap);
  }
  return out;
}

function optText(body: Record<string, unknown>, key: "displayName" | "label"): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new IdentityError(400, "E_VALIDATION_ERROR", `${key} must be a string`, key);
  const s = v.trim();
  if (!s) return null;
  if (key === "displayName") {
    const problem = displayNameProblem(s);
    if (problem) throw new IdentityError(400, "E_VALIDATION_ERROR", problem, key);
  } else {
    if (s.length > LABEL_MAX) throw new IdentityError(400, "E_VALIDATION_ERROR", `label must be at most ${LABEL_MAX} characters`, key);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(s)) throw new IdentityError(400, "E_VALIDATION_ERROR", "label must not contain control characters", key);
  }
  return s;
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return LIST_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > LIST_MAX) {
    throw new IdentityError(400, "E_VALIDATION_ERROR", `limit must be an integer from 1 to ${LIST_MAX}`, "limit");
  }
  return n;
}

function parseIncludeRevoked(url: URL): boolean {
  const raw = url.searchParams.get("includeRevoked");
  if (raw === null || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new IdentityError(400, "E_VALIDATION_ERROR", "includeRevoked must be 1, true, 0 or false", "includeRevoked");
}

// Keyset cursor over (created_at, id). Opaque base64url of "created_at id".
function encodeCursor(row: { created_at: string; id: string }): string {
  return b64url(new TextEncoder().encode(`${row.created_at} ${row.id}`));
}

function decodeCursor(url: URL): { createdAt: string; id: string } | null {
  const raw = url.searchParams.get("cursor");
  if (raw === null) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const text = atob(padded + "===".slice((padded.length + 3) % 4));
    const [createdAt, id] = text.split(" ");
    if (!createdAt || !id || !ID_RE.test(id)) throw new Error("shape");
    return { createdAt, id };
  } catch {
    throw new IdentityError(400, "E_VALIDATION_ERROR", "malformed cursor", "cursor");
  }
}

function pathId(raw: string): string {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new IdentityError(400, "E_VALIDATION_ERROR", "malformed identity id in path");
  }
  if (!ID_RE.test(id)) throw new IdentityError(404, "E_NOT_FOUND", "no such identity");
  return id;
}

// The column list every read of a row uses. token_hash is deliberately NOT in it: the
// one statement that reads the hash is the resolver's WHERE clause, so no handler ever
// holds a hash it could leak into a response.
const COLUMNS = "id, from_addr, display_name, label, scopes, created_at, revoked_at";

/** The wire projection of a row. Never the hash; the token is never stored at all. */
function project(row: IdentityRow) {
  return {
    id: row.id,
    from: row.from_addr,
    displayName: row.display_name,
    label: row.label,
    scopes: parseCaps(row.scopes),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

// --- the three operations ---

async function mint(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const domain = requireDomain(env);
  const caps = requestedCaps(body);
  const displayName = optText(body, "displayName");
  const label = optText(body, "label");
  const raw = body.from;
  if (typeof raw !== "string") throw new IdentityError(400, "E_FIELD_MISSING", "from is required", "from");
  const from = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(from) || from.split("@")[1] !== domain) {
    throw new IdentityError(400, "E_SENDER_NOT_ALLOWED", `from must be a valid address on @${domain}`, "from");
  }

  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const id = generateId();
  const now = new Date().toISOString();
  const insert = env.DB.prepare(
    "INSERT INTO agent_identities (id, token_hash, from_addr, display_name, label, scopes, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, tokenHash, from, displayName, label, JSON.stringify(caps), now);
  const audit = auditStatement(env, now, {
    action: "identity.mint",
    targetId: id,
    outcome: "ok",
    detail: { from, scopes: caps },
  });
  await env.DB.batch([insert, audit]);
  return json(
    {
      ok: true,
      id,
      token,
      from,
      displayName,
      label,
      scopes: caps,
      createdAt: now,
      note: "the token is shown once and cannot be retrieved again; only its hash is stored",
    },
    201,
  );
}

async function list(url: URL, env: Env): Promise<Response> {
  const limit = parseLimit(url);
  const includeRevoked = parseIncludeRevoked(url);
  const cursor = decodeCursor(url);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!includeRevoked) where.push("revoked_at IS NULL");
  if (cursor) {
    where.push("(created_at > ? OR (created_at = ? AND id > ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql =
    `SELECT ${COLUMNS} FROM agent_identities` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at, id LIMIT ?";
  binds.push(limit + 1);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<IdentityRow>();
  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  // The list is audited as well: who enumerated the credentials is part of the record.
  // Written BEFORE answering, and a failed write fails the request, because an
  // unrecorded enumeration is exactly what the log exists to rule out.
  await auditStatement(env, new Date().toISOString(), {
    action: "identity.list",
    outcome: "ok",
    detail: { returned: page.length, includeRevoked },
  }).run();
  return json({ ok: true, items: page.map(project), cursor: next });
}

async function revoke(env: Env, rawId: string): Promise<Response> {
  const id = pathId(rawId);
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM agent_identities WHERE id = ?`).bind(id).first<IdentityRow>();
  if (!row) throw new IdentityError(404, "E_NOT_FOUND", "no such identity");
  const now = new Date().toISOString();
  const update = env.DB.prepare(
    "UPDATE agent_identities SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(now, id);
  const audit = auditStatement(env, now, {
    action: "identity.revoke",
    targetId: id,
    outcome: "ok",
    detail: { alreadyRevoked: row.revoked_at !== null },
  });
  const results = await env.DB.batch([update, audit]);
  const revoked = results[0]?.meta?.changes ?? 0;
  return json({ ok: true, id, revoked, alreadyRevoked: row.revoked_at !== null });
}

// --- route handlers ---

const ADMIN_ITEM = /^\/api\/admin\/identities\/([^/]+)$/;

async function run(env: Env, action: AuditEntry["action"], targetId: string | null, fn: () => Promise<Response>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IdentityError) {
      // Only a well-formed id is recorded as the target; a junk path segment is not data.
      await auditRefusal(env, { action, targetId: targetId && ID_RE.test(targetId) ? targetId : null }, err);
      return fail(err);
    }
    throw err;
  }
}

/**
 * /api/admin/identities[/{id}], reached only past the `admin` scope gate. Returns null
 * for a method or path this does not serve, which falls through to 404. That matters: a
 * method with no row in routes.ts has no scope gate in front of it, so serving it here
 * would be a door.
 */
export async function handleAdminIdentities(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/admin/identities") {
    if (request.method === "POST") return run(env, "identity.mint", null, () => mint(request, env));
    if (request.method === "GET") return run(env, "identity.list", null, () => list(url, env));
    return null;
  }
  const m = ADMIN_ITEM.exec(path);
  if (m && request.method === "DELETE") return run(env, "identity.revoke", m[1], () => revoke(env, m[1]));
  return null;
}

/** GET /api/admin/audit: the audit log, newest first, one keyset page (operator only). */
export async function handleAudit(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/admin/audit" || request.method !== "GET") return null;
  try {
    const limit = parseLimit(url);
    const rawCursor = url.searchParams.get("cursor");
    let before: number | null = null;
    if (rawCursor !== null) {
      before = Number(rawCursor);
      if (!Number.isInteger(before) || before < 1) throw new IdentityError(400, "E_VALIDATION_ERROR", "malformed cursor", "cursor");
    }
    const sql =
      "SELECT id, at, actor_kind, actor_id, action, target_kind, target_id, outcome, detail FROM audit_log" +
      (before !== null ? " WHERE id < ?" : "") +
      " ORDER BY id DESC LIMIT ?";
    const binds: unknown[] = before !== null ? [before, limit + 1] : [limit + 1];
    const { results } = await env.DB.prepare(sql).bind(...binds).all<{
      id: number; at: string; actor_kind: string; actor_id: string | null; action: string;
      target_kind: string | null; target_id: string | null; outcome: string; detail: string | null;
    }>();
    const rows = results ?? [];
    const page = rows.slice(0, limit);
    return json({
      ok: true,
      items: page.map((r) => ({
        id: r.id,
        at: r.at,
        actor: { kind: r.actor_kind, id: r.actor_id },
        action: r.action,
        target: r.target_id ? { kind: r.target_kind, id: r.target_id } : null,
        outcome: r.outcome,
        detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
      })),
      cursor: rows.length > limit ? String(page[page.length - 1].id) : null,
    });
  } catch (err) {
    if (err instanceof IdentityError) return fail(err);
    throw err;
  }
}

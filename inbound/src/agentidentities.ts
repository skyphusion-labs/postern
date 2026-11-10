// Runtime agent identities (#801, slice S1 of #632) and the audit log they write.
//
// POSTERN_SEND_IDENTITIES (sendidentity.ts) is operator CONFIG: adding or removing an
// agent credential there needs a deploy, so it cannot be revoked in an incident. This
// module is the runtime half. An operator (`both`) mints, lists and revokes identities
// with the same read / send / organize caps the registry grants, and the resolver in
// api.ts consults this table AFTER the static tokens and the env registry, so every
// existing deploy keeps resolving exactly as before.
//
// Properties, each pinned by inbound/agent-identities.test.ts:
//   - The store holds the sha256 HASH of a token, never the token. The token is in the
//     mint response once and nowhere else.
//   - Every identity has a stable `id` (never reused; rows are never deleted) that
//     #740's audit trail attributes entries to.
//   - Revocation takes effect on the NEXT request: resolution reads D1 every time and
//     there is no cache to expire. Revoking an identity also revokes every identity it
//     minted, transitively.
//   - Delegated minting is OPT-IN through the `mint` cap, which only a runtime identity
//     can hold (the env registry never grants it, and a webmail session never carries
//     it). A delegated mint can never be broader than the minter: the child's From is
//     the minter's From, and the child's caps must be a subset of the minter's caps.
//   - Every mint, list and revoke writes one audit_log row, refusals included. A
//     successful mint or revoke and its audit row land in ONE D1 batch, so the action
//     cannot happen without its record.

import type { BoundIdentity, IdentityCap } from "./sendidentity";
import { sha256Hex } from "./sendidentity";
import { allowedFromDomain } from "./fromdomain";
import { displayNameProblem } from "./smtpcreds";
import { readBodyCapped, PayloadTooLargeError } from "./body";

/** What a runtime identity may hold: the registry caps plus the opt-in `mint`. */
export type RuntimeCap = IdentityCap | "mint";
export const RUNTIME_CAPS: readonly RuntimeCap[] = ["read", "send", "organize", "mint"];

/** One resolved runtime identity: what the gate needs, plus the stable id. */
export interface RuntimeHit {
  id: string;
  identity: BoundIdentity;
  caps: RuntimeCap[];
}

/** Who performed an audited action. `operator` is a static `both` token (it has no id). */
export type Actor = { kind: "operator" } | { kind: "identity"; id: string; from: string; caps: string[] };

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
/** Active identities one identity may have minted at once (a leaked `mint` token cannot fill D1). */
export const MAX_ACTIVE_CHILDREN = 100;
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
function parseCaps(raw: unknown): RuntimeCap[] {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RuntimeCap[] = [];
  for (const item of parsed) {
    if ((RUNTIME_CAPS as readonly unknown[]).includes(item) && !out.includes(item as RuntimeCap)) {
      out.push(item as RuntimeCap);
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
  parent_id: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
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

function auditStatement(env: Env, actor: Actor, at: string, entry: AuditEntry, onlyIfIdentityExists?: string) {
  const values = [
    at,
    actor.kind,
    actor.kind === "identity" ? actor.id : null,
    entry.action,
    entry.targetId ? "identity" : null,
    entry.targetId ?? null,
    entry.outcome,
    entry.detail ? JSON.stringify(entry.detail) : null,
  ];
  if (onlyIfIdentityExists) {
    // Conditional on the row the same batch just inserted, so a mint that did not
    // happen (its parent was revoked between check and insert) records no "ok" row.
    return env.DB.prepare(
      "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_kind, target_id, outcome, detail) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_identities WHERE id = ?)",
    ).bind(...values, onlyIfIdentityExists);
  }
  return env.DB.prepare(
    "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_kind, target_id, outcome, detail) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(...values);
}

/**
 * Record a refusal. Best effort BY DESIGN: the refusal already happened and its answer
 * is the same either way, so a failed write is logged and the refusal is still returned
 * (failing it would turn a 403 into a 500 and tell the caller less, not more).
 */
async function auditRefusal(env: Env, actor: Actor, entry: Omit<AuditEntry, "outcome">, err: IdentityError) {
  try {
    await auditStatement(env, actor, new Date().toISOString(), {
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
function requestedCaps(body: Record<string, unknown>): RuntimeCap[] {
  const raw = body.scopes;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new IdentityError(400, "E_VALIDATION_ERROR", `scopes must be a non-empty array of ${RUNTIME_CAPS.join(", ")}`, "scopes");
  }
  const out: RuntimeCap[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !(RUNTIME_CAPS as readonly string[]).includes(item)) {
      throw new IdentityError(
        400,
        "E_VALIDATION_ERROR",
        `unknown scope ${JSON.stringify(item)}: an agent identity may hold only ${RUNTIME_CAPS.join(", ")}`,
        "scopes",
      );
    }
    if (!out.includes(item as RuntimeCap)) out.push(item as RuntimeCap);
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

/** The wire projection of a row. Never carries the hash; the token is never stored. */
function project(row: IdentityRow) {
  return {
    id: row.id,
    from: row.from_addr,
    displayName: row.display_name,
    label: row.label,
    scopes: parseCaps(row.scopes),
    parentId: row.parent_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

// The subtree BELOW an identity (not the identity itself). Rows are only ever created
// under an existing parent with a fresh random id, so the parent graph cannot cycle.
const SUBTREE =
  "WITH RECURSIVE sub(id) AS (SELECT id FROM agent_identities WHERE parent_id = ? " +
  "UNION SELECT a.id FROM agent_identities a JOIN sub ON a.parent_id = sub.id) ";

const COLUMNS = "id, from_addr, display_name, label, scopes, parent_id, created_at, revoked_at, revoked_by";

// --- the three operations ---

async function mint(request: Request, env: Env, actor: Actor): Promise<Response> {
  const body = await readBody(request);
  const domain = requireDomain(env);
  const caps = requestedCaps(body);
  const displayName = optText(body, "displayName");
  const label = optText(body, "label");

  let from: string;
  let parentId: string | null = null;
  if (actor.kind === "operator") {
    const raw = body.from;
    if (typeof raw !== "string") throw new IdentityError(400, "E_FIELD_MISSING", "from is required", "from");
    from = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(from) || from.split("@")[1] !== domain) {
      throw new IdentityError(400, "E_SENDER_NOT_ALLOWED", `from must be a valid address on @${domain}`, "from");
    }
  } else {
    // Delegated: never broader than the minter. Same From, caps a subset.
    from = actor.from;
    if (body.from !== undefined && body.from !== null) {
      if (typeof body.from !== "string" || body.from.trim().toLowerCase() !== actor.from) {
        throw new IdentityError(403, "E_FORBIDDEN", "a delegated identity always sends and reads as its minter; from must be omitted or equal it", "from");
      }
    }
    const wider = caps.filter((c) => !actor.caps.includes(c));
    if (wider.length > 0) {
      throw new IdentityError(403, "E_SCOPE_EXCEEDS", `cannot grant scopes this credential does not hold: ${wider.join(", ")}`, "scopes");
    }
    parentId = actor.id;
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM agent_identities WHERE parent_id = ? AND revoked_at IS NULL",
    )
      .bind(actor.id)
      .first<{ n: number }>();
    if ((active?.n ?? 0) >= MAX_ACTIVE_CHILDREN) {
      throw new IdentityError(409, "E_LIMIT", `at most ${MAX_ACTIVE_CHILDREN} active identities per minter; revoke one first`);
    }
  }

  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const id = generateId();
  const now = new Date().toISOString();
  const values = [id, tokenHash, from, displayName, label, JSON.stringify(caps), parentId, now];
  // A delegated insert is conditional on the minter still being active, so a revoke that
  // lands between the gate and this write cannot leave a live child under a dead parent.
  const insert = parentId
    ? env.DB.prepare(
        `INSERT INTO agent_identities (id, token_hash, from_addr, display_name, label, scopes, parent_id, created_at) ` +
          "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_identities WHERE id = ? AND revoked_at IS NULL)",
      ).bind(...values, parentId)
    : env.DB.prepare(
        `INSERT INTO agent_identities (id, token_hash, from_addr, display_name, label, scopes, parent_id, created_at) ` +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(...values);
  const audit = auditStatement(env, actor, now, {
    action: "identity.mint",
    targetId: id,
    outcome: "ok",
    detail: { from, scopes: caps, parentId },
  }, id);
  const results = await env.DB.batch([insert, audit]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new IdentityError(401, "unauthorized", "the minting identity was revoked");
  }
  return json(
    {
      ok: true,
      id,
      token,
      from,
      displayName,
      label,
      scopes: caps,
      parentId,
      createdAt: now,
      note: "the token is shown once; only its hash is stored",
    },
    201,
  );
}

async function list(url: URL, env: Env, actor: Actor): Promise<Response> {
  const limit = parseLimit(url);
  const includeRevoked = parseIncludeRevoked(url);
  const cursor = decodeCursor(url);
  const where: string[] = [];
  const binds: unknown[] = [];
  let prefix = "";
  if (actor.kind === "identity") {
    prefix = SUBTREE;
    binds.push(actor.id);
    where.push("id IN (SELECT id FROM sub)");
  }
  if (!includeRevoked) where.push("revoked_at IS NULL");
  if (cursor) {
    where.push("(created_at > ? OR (created_at = ? AND id > ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql =
    `${prefix}SELECT ${COLUMNS} FROM agent_identities` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at, id LIMIT ?";
  binds.push(limit + 1);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<IdentityRow>();
  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  // The list is audited as well: who enumerated which credentials is part of the record.
  // Written BEFORE answering, and a failed write fails the request, because an
  // unrecorded enumeration is exactly what the log exists to rule out.
  await auditStatement(env, actor, new Date().toISOString(), {
    action: "identity.list",
    outcome: "ok",
    detail: { returned: page.length, includeRevoked },
  }).run();
  return json({ ok: true, items: page.map(project), cursor: next });
}

async function revoke(env: Env, actor: Actor, rawId: string): Promise<Response> {
  const id = pathId(rawId);
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM agent_identities WHERE id = ?`).bind(id).first<IdentityRow>();
  // An identity may revoke itself or anything below it. Anything else is 404, the same
  // answer as an id that does not exist, so the route is not an oracle for other ids.
  let visible = Boolean(row);
  if (row && actor.kind === "identity" && id !== actor.id) {
    const hit = await env.DB.prepare(`${SUBTREE}SELECT 1 AS hit FROM sub WHERE id = ?`).bind(actor.id, id).first();
    visible = Boolean(hit);
  }
  if (!row || !visible) throw new IdentityError(404, "E_NOT_FOUND", "no such identity");

  const below = await env.DB.prepare(`${SUBTREE}SELECT a.id FROM agent_identities a JOIN sub ON a.id = sub.id WHERE a.revoked_at IS NULL`)
    .bind(id)
    .all<{ id: string }>();
  const cascade = (below.results ?? []).map((r) => r.id);
  const now = new Date().toISOString();
  const by = actor.kind === "operator" ? "operator" : actor.id;
  const update = env.DB.prepare(
    "WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT a.id FROM agent_identities a JOIN sub ON a.parent_id = sub.id) " +
      "UPDATE agent_identities SET revoked_at = ?, revoked_by = ? WHERE id IN (SELECT id FROM sub) AND revoked_at IS NULL",
  ).bind(id, now, by);
  const audit = auditStatement(env, actor, now, {
    action: "identity.revoke",
    targetId: id,
    outcome: "ok",
    detail: { alreadyRevoked: row.revoked_at !== null, cascade },
  });
  const results = await env.DB.batch([update, audit]);
  const revoked = results[0]?.meta?.changes ?? 0;
  return json({ ok: true, id, revoked, alreadyRevoked: row.revoked_at !== null, cascade });
}

// --- route handlers ---

const ADMIN_ITEM = /^\/api\/admin\/identities\/([^/]+)$/;
const SELF_ITEM = /^\/api\/identities\/([^/]+)$/;

async function run(env: Env, actor: Actor, action: AuditEntry["action"], targetId: string | null, fn: () => Promise<Response>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IdentityError) {
      // Only a well-formed id is recorded as the target; a junk path segment is not data.
      await auditRefusal(env, actor, { action, targetId: targetId && ID_RE.test(targetId) ? targetId : null }, err);
      return fail(err);
    }
    throw err;
  }
}

/**
 * /api/admin/identities[/{id}] for a static `both` token. Returns null for a method or
 * path this does not serve, which falls through to 404. That matters: a method with no
 * row in routes.ts has no scope gate in front of it, so serving it here would be a door.
 */
export async function handleAdminIdentities(request: Request, env: Env, url: URL): Promise<Response | null> {
  const actor: Actor = { kind: "operator" };
  const path = url.pathname;
  if (path === "/api/admin/identities") {
    if (request.method === "POST") return run(env, actor, "identity.mint", null, () => mint(request, env, actor));
    if (request.method === "GET") return run(env, actor, "identity.list", null, () => list(url, env, actor));
    return null;
  }
  const m = ADMIN_ITEM.exec(path);
  if (m && request.method === "DELETE") return run(env, actor, "identity.revoke", m[1], () => revoke(env, actor, m[1]));
  return null;
}

/**
 * /api/identities[/{id}]: delegated minting, for a RUNTIME identity holding `mint`. The
 * gate has already demanded the `mint` scope; this decides WHO the caller is. A static
 * `both` token passes the gate but has no identity to delegate from, so it is pointed at
 * the admin routes rather than silently minting an operator identity here.
 */
export async function handleSelfIdentities(
  request: Request,
  env: Env,
  url: URL,
  caller: { identityId?: string; identity?: BoundIdentity; caps?: string[] },
): Promise<Response | null> {
  const path = url.pathname;
  const isCollection = path === "/api/identities";
  const m = SELF_ITEM.exec(path);
  const served = (isCollection && (request.method === "POST" || request.method === "GET")) || (m && request.method === "DELETE");
  if (!served) return null;
  if (!caller.identityId || !caller.identity || !caller.caps) {
    return fail(
      new IdentityError(
        403,
        "E_IDENTITY_REQUIRED",
        "delegated minting needs a runtime agent identity holding the mint scope; an operator token uses /api/admin/identities",
      ),
    );
  }
  const actor: Actor = { kind: "identity", id: caller.identityId, from: caller.identity.from, caps: [...caller.caps] };
  if (isCollection && request.method === "POST") return run(env, actor, "identity.mint", null, () => mint(request, env, actor));
  if (isCollection) return run(env, actor, "identity.list", null, () => list(url, env, actor));
  const rawId = (m as RegExpExecArray)[1];
  return run(env, actor, "identity.revoke", rawId, () => revoke(env, actor, rawId));
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

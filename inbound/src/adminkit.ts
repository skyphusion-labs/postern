// Shared plumbing for the operator credential routes: runtime agent identities (#801)
// and delegation grants (#740 S1). One copy of the error envelope, the capped JSON body,
// the keyset paging and the audit writer, so the two route families cannot drift apart
// on how they refuse, page, or record.

import { allowedFromDomain } from "./fromdomain";
import { readBodyCapped, PayloadTooLargeError } from "./body";

export const MAX_ADMIN_BODY_BYTES = 4 * 1024;
export const LIST_DEFAULT = 100;
export const LIST_MAX = 500;
export const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;

/** A refusal with a status, a stable error code, and optionally the offending field. */
export class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

export function fail(err: AdminError): Response {
  const body: Record<string, unknown> = { ok: false, error: err.code, message: err.message };
  if (err.field) body.field = err.field;
  return json(body, err.status);
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh id: a prefix plus 96 random bits as 24 hex characters. */
export function generateId(prefix: string): string {
  return prefix + hex(crypto.getRandomValues(new Uint8Array(12)));
}

/** A capped JSON object body; an empty body is {}. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBodyCapped(request, MAX_ADMIN_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) throw new AdminError(413, "E_PAYLOAD_TOO_LARGE", "request body too large");
    throw err;
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdminError(400, "E_VALIDATION_ERROR", "invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdminError(400, "E_VALIDATION_ERROR", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** The deploy's sender domain; unset refuses rather than borrowing one (#615). */
export function requireDomain(env: Env): string {
  const domain = allowedFromDomain(env);
  if (!domain) throw new AdminError(500, "E_INTERNAL_SERVER_ERROR", "ALLOWED_FROM_DOMAIN is not configured");
  return domain;
}

/** An optional single-line text field: trimmed, at most `max` characters, no control characters. */
export function optLine(body: Record<string, unknown>, key: string, max: number): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new AdminError(400, "E_VALIDATION_ERROR", `${key} must be a string`, key);
  const s = v.trim();
  if (!s) return null;
  if (s.length > max) throw new AdminError(400, "E_VALIDATION_ERROR", `${key} must be at most ${max} characters`, key);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new AdminError(400, "E_VALIDATION_ERROR", `${key} must not contain control characters`, key);
  return s;
}

export function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return LIST_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > LIST_MAX) {
    throw new AdminError(400, "E_VALIDATION_ERROR", `limit must be an integer from 1 to ${LIST_MAX}`, "limit");
  }
  return n;
}

export function parseIncludeRevoked(url: URL): boolean {
  const raw = url.searchParams.get("includeRevoked");
  if (raw === null || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new AdminError(400, "E_VALIDATION_ERROR", "includeRevoked must be 1, true, 0 or false", "includeRevoked");
}

// Keyset cursor over (created_at, id). Opaque base64url of "created_at id".
export function encodeCursor(row: { created_at: string; id: string }): string {
  return b64url(new TextEncoder().encode(`${row.created_at} ${row.id}`));
}

export function decodeCursor(url: URL, idRe: RegExp): { createdAt: string; id: string } | null {
  const raw = url.searchParams.get("cursor");
  if (raw === null) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const text = atob(padded + "===".slice((padded.length + 3) % 4));
    const [createdAt, id] = text.split(" ");
    if (!createdAt || !id || !idRe.test(id)) throw new Error("shape");
    return { createdAt, id };
  } catch {
    throw new AdminError(400, "E_VALIDATION_ERROR", "malformed cursor", "cursor");
  }
}

/** A path id that must match `idRe`; anything else is the same 404 as an absent id. */
export function pathId(raw: string, idRe: RegExp, what: string): string {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new AdminError(400, "E_VALIDATION_ERROR", `malformed ${what} id in path`);
  }
  if (!idRe.test(id)) throw new AdminError(404, "E_NOT_FOUND", `no such ${what}`);
  return id;
}

// --- the audit log (migration 0016) ---

export interface AuditEntry {
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  outcome: "ok" | "refused";
  detail?: Record<string, unknown>;
}

/**
 * One audit_log INSERT with the operator as actor. Every writer here is reached only by a
 * static `both` token (the admin routes), so the actor is the `svc_both` SERVICE principal
 * (#854 M1, D-ID-5), never the anonymous `operator` + NULL of rows written before it.
 * Agent actors are written by agentAudit / agentMessageAudit.
 *
 * `onlyIf`, when given, makes the insert conditional on a row existing, so an audit row
 * in the same batch as a conditional write records "ok" only when that write happened.
 */
/** Who an audited admin-style action is recorded as. The default is the operator. */
export interface AuditActor {
  kind: "service" | "human";
  id: string;
}
export const OPERATOR_ACTOR: AuditActor = { kind: "service", id: "svc_both" };

export function auditStatement(
  env: Env,
  at: string,
  entry: AuditEntry,
  onlyIf?: { sql: string; binds: unknown[] },
  actor: AuditActor = OPERATOR_ACTOR,
) {
  const values = [
    at,
    entry.action,
    entry.targetId ? (entry.targetKind ?? null) : null,
    entry.targetId ?? null,
    entry.outcome,
    entry.detail ? JSON.stringify(entry.detail) : null,
  ];
  const head = "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_kind, target_id, outcome, detail) ";
  if (onlyIf) {
    return env.DB.prepare(head + `SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${onlyIf.sql})`)
      .bind(values[0], actor.kind, actor.id, ...values.slice(1), ...onlyIf.binds);
  }
  return env.DB.prepare(head + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(values[0], actor.kind, actor.id, ...values.slice(1));
}

/**
 * One audit_log row PER MESSAGE an agent's organize write touches on a granted address
 * (#740 S2). An INSERT ... SELECT over `messages m`, so it names exactly the rows the
 * caller's predicate matches, and it runs in the SAME D1 batch as the write it records:
 * if this insert fails the batch rolls back and the write does not happen.
 *
 * The actor is the grantee's stable agent_identities id and the target is the message
 * id: both stable ids, so a later identity layer can adopt these rows unchanged.
 */
export function agentMessageAudit(
  env: Env,
  at: string,
  actorId: string,
  action: string,
  detail: Record<string, unknown>,
  where: { sql: string; binds: unknown[] },
) {
  return env.DB.prepare(
    "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_kind, target_id, outcome, detail) " +
      `SELECT ?, 'agent', ?, ?, 'message', m.message_id, 'ok', ? FROM messages m WHERE ${where.sql}`,
  ).bind(at, actorId, action, JSON.stringify(detail), ...where.binds);
}

/**
 * One audit_log row with an AGENT identity as actor and a plain target (#740 S4: the
 * address a send_as send went out as). The caller runs it before the act it records
 * and treats a failed insert as a failed act.
 */
export function agentAudit(
  env: Env,
  at: string,
  actorId: string,
  action: string,
  target: { kind: string; id: string },
  detail: Record<string, unknown>,
) {
  return env.DB.prepare(
    "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_kind, target_id, outcome, detail) " +
      "VALUES (?, 'agent', ?, ?, ?, ?, 'ok', ?)",
  ).bind(at, actorId, action, target.kind, target.id, JSON.stringify(detail));
}

/**
 * Record a refusal. Best effort BY DESIGN: the refusal already happened and its answer
 * is the same either way, so a failed write is logged and the refusal is still returned.
 */
export async function auditRefusal(
  env: Env,
  entry: Omit<AuditEntry, "outcome">,
  err: AdminError,
  actor: AuditActor = OPERATOR_ACTOR,
): Promise<void> {
  try {
    await auditStatement(env, new Date().toISOString(), {
      ...entry,
      outcome: "refused",
      detail: { ...(entry.detail ?? {}), error: err.code },
    }, undefined, actor).run();
  } catch (e) {
    console.error("audit_log write failed for a refusal", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Run one operator action: an AdminError becomes its envelope plus an audited refusal
 * (with the target recorded only when it is a well-formed id). Anything else rethrows
 * to the route-level 500 mapping.
 */
export async function runAudited(
  env: Env,
  action: string,
  target: { kind: string; raw: string | null; idRe: RegExp },
  fn: () => Promise<Response>,
  actor: AuditActor = OPERATOR_ACTOR,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AdminError) {
      const targetId = target.raw && target.idRe.test(target.raw) ? target.raw : null;
      await auditRefusal(env, { action, targetKind: target.kind, targetId }, err, actor);
      return fail(err);
    }
    throw err;
  }
}

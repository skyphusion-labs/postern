// #854 M3a: the operator's read-only view of the principal layer (docs/IDENTITY.md
// section 6). GET /api/admin/principals lists principals; GET /api/admin/principals/{id}
// shows one with its credentials and addresses. Nothing here authorizes anything, and
// nothing here writes the principal tables.
//
// Properties, each pinned by inbound/principal-admin.test.ts:
//   - No response carries a credential's `secret` (a password hash or token hash) or its
//     `lookup` (a username, or a token hash for an agent). The column lists below leave
//     both out, so no handler ever holds them.
//   - Every list and show writes one audit_log row before it answers, refusals included:
//     who enumerated the principals is part of the record, as for identity.list.
//   - A method or path this module does not serve returns null (404 upstream), because a
//     method with no row in routes.ts has no scope gate in front of it.

import {
  AdminError,
  auditStatement,
  decodeCursor,
  encodeCursor,
  json,
  parseLimit,
  pathId,
  runAudited,
  OPERATOR_ACTOR,
  type AuditActor,
} from "./adminkit";

/** idn_ (an agent keeps its identity id), prn_ (a human), svc_ (a static slot). */
export const PRINCIPAL_ID_RE = /^(?:idn_[0-9a-f]{24}|prn_[0-9a-f]{24}|svc_[a-z]{1,20})$/;

const KINDS = ["human", "agent", "service"] as const;
type Kind = (typeof KINDS)[number];

interface PrincipalRow {
  id: string;
  kind: string;
  display_name: string | null;
  label: string | null;
  created_by: string;
  created_at: string;
  disabled_at: string | null;
}

interface CredentialRow {
  id: string;
  type: string;
  caps: string;
  protocols: string | null;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

interface AddressRow {
  address: string;
  is_primary: number;
}

const PRINCIPAL_COLUMNS = "id, kind, display_name, label, created_by, created_at, disabled_at";
// lookup and secret are deliberately NOT here: see the header.
const CREDENTIAL_COLUMNS = "id, type, caps, protocols, label, created_at, last_used_at, expires_at, revoked_at";

function jsonList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function projectPrincipal(row: PrincipalRow) {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

function projectCredential(row: CredentialRow) {
  return {
    id: row.id,
    type: row.type,
    caps: jsonList(row.caps) ?? [],
    protocols: jsonList(row.protocols),
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function parseKind(url: URL): Kind | null {
  const raw = url.searchParams.get("kind");
  if (raw === null) return null;
  if ((KINDS as readonly string[]).includes(raw)) return raw as Kind;
  throw new AdminError(400, "E_VALIDATION_ERROR", `kind must be one of ${KINDS.join(", ")}`, "kind");
}

function parseIncludeDisabled(url: URL): boolean {
  const raw = url.searchParams.get("includeDisabled");
  if (raw === null || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new AdminError(400, "E_VALIDATION_ERROR", "includeDisabled must be 1, true, 0 or false", "includeDisabled");
}

async function list(url: URL, env: Env, actor: AuditActor): Promise<Response> {
  const limit = parseLimit(url);
  const kind = parseKind(url);
  const includeDisabled = parseIncludeDisabled(url);
  const cursor = decodeCursor(url, PRINCIPAL_ID_RE);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!includeDisabled) where.push("disabled_at IS NULL");
  if (kind) {
    where.push("kind = ?");
    binds.push(kind);
  }
  if (cursor) {
    where.push("(created_at > ? OR (created_at = ? AND id > ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql =
    `SELECT ${PRINCIPAL_COLUMNS} FROM principals` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at, id LIMIT ?";
  binds.push(limit + 1);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<PrincipalRow>();
  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  await auditStatement(env, new Date().toISOString(), {
    action: "principal.list",
    outcome: "ok",
    detail: { returned: page.length, kind, includeDisabled },
  }, undefined, actor).run();
  return json({ ok: true, items: page.map(projectPrincipal), cursor: next });
}

async function show(env: Env, rawId: string, actor: AuditActor): Promise<Response> {
  const id = pathId(rawId, PRINCIPAL_ID_RE, "principal");
  const row = await env.DB.prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM principals WHERE id = ?`).bind(id).first<PrincipalRow>();
  if (!row) throw new AdminError(404, "E_NOT_FOUND", "no such principal");
  const [creds, addrs] = await env.DB.batch([
    env.DB.prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE principal_id = ? ORDER BY created_at, id`).bind(id),
    env.DB.prepare("SELECT address, is_primary FROM principal_addresses WHERE principal_id = ? ORDER BY is_primary DESC, address").bind(id),
  ]);
  const credentials = ((creds?.results ?? []) as CredentialRow[]).map(projectCredential);
  const addresses = ((addrs?.results ?? []) as AddressRow[]).map((a) => ({ address: a.address, primary: a.is_primary === 1 }));
  await auditStatement(env, new Date().toISOString(), {
    action: "principal.show",
    targetKind: "principal",
    targetId: id,
    outcome: "ok",
    detail: { credentials: credentials.length, addresses: addresses.length },
  }, undefined, actor).run();
  return json({ ok: true, principal: projectPrincipal(row), credentials, addresses });
}

const ADMIN_ITEM = /^\/api\/admin\/principals\/([^/]+)$/;

/**
 * GET /api/admin/principals and GET /api/admin/principals/{id}, reached only past the
 * `admin` scope gate. The parity and backfill routes are matched before this in api.ts.
 */
export async function handleAdminPrincipals(
  request: Request,
  env: Env,
  url: URL,
  actor: AuditActor = OPERATOR_ACTOR,
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const path = url.pathname;
  const target = (raw: string | null) => ({ kind: "principal", raw, idRe: PRINCIPAL_ID_RE });
  if (path === "/api/admin/principals") {
    return runAudited(env, "principal.list", target(null), () => list(url, env, actor), actor);
  }
  const m = ADMIN_ITEM.exec(path);
  if (m) return runAudited(env, "principal.show", target(m[1]), () => show(env, m[1], actor), actor);
  return null;
}

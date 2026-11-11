// Delegation grants (#740 S1): the store and the operator routes.
//
// A grant says that one agent identity (#801, agent_identities.id) may act on one human
// address with a named set of powers. #740 is "delegated agent read AND send with an
// audit trail", and the audit trail is a precondition for the write side. S1 laid the
// store and the routes; S2 (the end of this file) enforces read and organize. The powers
// are named so a grant made today means what the later slices enforce:
//
//   read      read the address's mail (under AGENT_READ_SCOPE=granted) (S2)
//   organize  mark read / flags / move on the address's mail          (S2)
//   quote     quote the address's mail into a reply or forward        (S3)
//   send_as   send with the address as From                           (S4)
//
// Properties, each pinned by inbound/delegations.test.ts:
//   - Operator only (`admin`). No agent identity, no static scoped token, and no session
//     can grant, list or revoke.
//   - The grantee must be a LIVE agent identity at mint. D1 does not enforce foreign keys,
//     so the INSERT itself is conditional on the grantee row existing unrevoked; a revoke
//     that lands between the check and the write leaves no grant and no "ok" audit row.
//   - powers is a non-empty subset of the four above; anything else is 400, never
//     stripped. Every power implies `read` (filing, quoting or sending as mail you cannot
//     read means nothing), so the STORED set always carries it: the record says what the
//     grant allows, with no rule left for a reader to re-derive.
//   - The address must be on ALLOWED_FROM_DOMAIN and must not be the grantee's
//     own address (an identity already acts on its own mail; a grant there means nothing).
//   - At most one ACTIVE grant per (grantee, address), enforced by a partial unique index.
//   - Every grant, list and revoke writes one audit_log row, refusals included; a grant or
//     revoke and its row land in one D1 batch.

import { IDENTITY_ID_RE } from "./agentidentities";
import {
  AdminError,
  EMAIL_RE,
  OPERATOR_ACTOR,
  auditStatement,
  type AuditActor,
  decodeCursor,
  encodeCursor,
  generateId,
  json,
  optLine,
  parseIncludeRevoked,
  parseLimit,
  pathId,
  readBody,
  requireDomain,
  runAudited,
} from "./adminkit";

export type DelegationPower = "read" | "organize" | "quote" | "send_as";
export const DELEGATION_POWERS: readonly DelegationPower[] = ["read", "organize", "quote", "send_as"];
export const DELEGATION_ID_RE = /^dlg_[0-9a-f]{24}$/;
const LABEL_MAX = 100;

interface GrantRow {
  id: string;
  grantee_id: string;
  address: string;
  powers: string;
  label: string | null;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

const COLUMNS = "id, grantee_id, address, powers, label, created_by, created_at, revoked_at";

function parsePowers(raw: unknown): DelegationPower[] {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return DELEGATION_POWERS.filter((p) => parsed.includes(p));
}

function project(row: GrantRow) {
  return {
    id: row.id,
    granteeId: row.grantee_id,
    address: row.address,
    powers: parsePowers(row.powers),
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** Requested powers: a non-empty array of known names. Anything else is 400, never a strip. */
function requestedPowers(body: Record<string, unknown>): DelegationPower[] {
  const raw = body.powers;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AdminError(400, "E_VALIDATION_ERROR", `powers must be a non-empty array of ${DELEGATION_POWERS.join(", ")}`, "powers");
  }
  const out: DelegationPower[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !(DELEGATION_POWERS as readonly string[]).includes(item)) {
      throw new AdminError(
        400,
        "E_VALIDATION_ERROR",
        `unknown power ${JSON.stringify(item)}: a grant may carry only ${DELEGATION_POWERS.join(", ")}`,
        "powers",
      );
    }
    if (!out.includes(item as DelegationPower)) out.push(item as DelegationPower);
  }
  // Every power implies read. Returned in the canonical order, so equal grants store
  // byte-equal sets.
  if (!out.includes("read")) out.push("read");
  return DELEGATION_POWERS.filter((p) => out.includes(p));
}

function bodyAddress(body: Record<string, unknown>, domain: string): string {
  const raw = body.address;
  if (typeof raw !== "string") throw new AdminError(400, "E_FIELD_MISSING", "address is required", "address");
  const address = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(address) || address.split("@")[1] !== domain) {
    throw new AdminError(400, "E_VALIDATION_ERROR", `address must be a valid address on @${domain}`, "address");
  }
  return address;
}

const LIVE_GRANTEE = "SELECT 1 FROM agent_identities WHERE id = ? AND revoked_at IS NULL";

/**
 * Who makes or revokes a grant (#854 M2). The operator by default; a human principal for
 * #740 S5 self-service, which also pins the grant to that human's OWN address. `actor` is
 * what the audit row names; `createdBy` is what the grant row stores (the string
 * `operator` for the operator, unchanged; the human's prn_ id for a human).
 */
export interface Grantor {
  actor: AuditActor;
  createdBy: string;
  /** When set, the only address this grantor may grant or revoke on. */
  ownAddress?: string;
}
export const OPERATOR_GRANTOR: Grantor = { actor: OPERATOR_ACTOR, createdBy: "operator" };

export async function grant(request: Request, env: Env, grantor: Grantor = OPERATOR_GRANTOR): Promise<Response> {
  const body = await readBody(request);
  const domain = requireDomain(env);
  const rawGrantee = body.granteeId;
  if (typeof rawGrantee !== "string") throw new AdminError(400, "E_FIELD_MISSING", "granteeId is required", "granteeId");
  const granteeId = rawGrantee.trim();
  // A self-service grantor grants on its own address and nowhere else: the address is not
  // a field it may send at all, so a wrong one is refused rather than silently replaced.
  if (grantor.ownAddress !== undefined && body.address !== undefined) {
    throw new AdminError(400, "E_VALIDATION_ERROR", "address is your own and is not a field here", "address");
  }
  const address = grantor.ownAddress !== undefined ? grantor.ownAddress.trim().toLowerCase() : bodyAddress(body, domain);
  const powers = requestedPowers(body);
  const label = optLine(body, "label", LABEL_MAX);

  // The reference check. Absent and revoked are the same refusal: either way there is no
  // live identity to grant to, and the operator learns which from the identity list.
  const grantee = IDENTITY_ID_RE.test(granteeId)
    ? await env.DB.prepare("SELECT from_addr, revoked_at FROM agent_identities WHERE id = ?")
        .bind(granteeId)
        .first<{ from_addr: string; revoked_at: string | null }>()
    : null;
  if (!grantee || grantee.revoked_at !== null) {
    throw new AdminError(400, "E_GRANTEE_INVALID", "granteeId must name a live (unrevoked) agent identity", "granteeId");
  }
  if (grantee.from_addr.toLowerCase() === address) {
    throw new AdminError(400, "E_VALIDATION_ERROR", "an identity already acts on its own address; a grant there means nothing", "address");
  }
  const active = await env.DB.prepare(
    "SELECT id FROM delegation_grants WHERE grantee_id = ? AND address = ? AND revoked_at IS NULL",
  )
    .bind(granteeId, address)
    .first<{ id: string }>();
  if (active) {
    throw new AdminError(409, "E_CONFLICT", `an active grant already exists (${active.id}); revoke it to change the powers`);
  }

  const id = generateId("dlg_");
  const now = new Date().toISOString();
  // Conditional on the grantee STILL being live, in the same statement as the write.
  const insert = env.DB.prepare(
    `INSERT INTO delegation_grants (id, grantee_id, address, powers, label, created_by, created_at) ` +
      `SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${LIVE_GRANTEE})`,
  ).bind(id, granteeId, address, JSON.stringify(powers), label, grantor.createdBy, now, granteeId);
  const audit = auditStatement(
    env,
    now,
    { action: "delegation.grant", targetKind: "delegation", targetId: id, outcome: "ok", detail: { granteeId, address, powers } },
    { sql: "SELECT 1 FROM delegation_grants WHERE id = ?", binds: [id] },
    grantor.actor,
  );
  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = await env.DB.batch([insert, audit]);
  } catch (err) {
    // The partial unique index: a concurrent grant for the same pair won the race.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new AdminError(409, "E_CONFLICT", "an active grant already exists for this grantee and address");
    }
    throw err;
  }
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new AdminError(409, "E_GRANTEE_INVALID", "the grantee was revoked before the grant was written");
  }
  return json(
    { ok: true, id, granteeId, address, powers, label, createdBy: grantor.createdBy, createdAt: now, revokedAt: null },
    201,
  );
}

async function list(url: URL, env: Env, actor: AuditActor = OPERATOR_ACTOR): Promise<Response> {
  const limit = parseLimit(url);
  const includeRevoked = parseIncludeRevoked(url);
  const cursor = decodeCursor(url, DELEGATION_ID_RE);
  const where: string[] = [];
  const binds: unknown[] = [];
  const grantee = url.searchParams.get("grantee");
  if (grantee !== null) {
    if (!IDENTITY_ID_RE.test(grantee)) throw new AdminError(400, "E_VALIDATION_ERROR", "grantee must be an agent identity id", "grantee");
    where.push("grantee_id = ?");
    binds.push(grantee);
  }
  const address = url.searchParams.get("address");
  if (address !== null) {
    const a = address.trim().toLowerCase();
    if (!EMAIL_RE.test(a)) throw new AdminError(400, "E_VALIDATION_ERROR", "address must be an email address", "address");
    where.push("address = ?");
    binds.push(a);
  }
  if (!includeRevoked) where.push("revoked_at IS NULL");
  if (cursor) {
    where.push("(created_at > ? OR (created_at = ? AND id > ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql =
    `SELECT ${COLUMNS} FROM delegation_grants` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at, id LIMIT ?";
  binds.push(limit + 1);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<GrantRow>();
  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  // Audited before answering; a failed write fails the request (same rule as identities).
  await auditStatement(env, new Date().toISOString(), {
    action: "delegation.list",
    outcome: "ok",
    detail: { returned: page.length, includeRevoked, grantee, address },
  }, undefined, actor).run();
  return json({ ok: true, items: page.map(project), cursor: next });
}

export async function revoke(env: Env, rawId: string, grantor: Grantor = OPERATOR_GRANTOR): Promise<Response> {
  const id = pathId(rawId, DELEGATION_ID_RE, "delegation");
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM delegation_grants WHERE id = ?`).bind(id).first<GrantRow>();
  // A self-service grantor sees only grants on its own address: any other id is the same
  // 404 as a missing one, so nothing says another address's grant exists.
  const mine = grantor.ownAddress === undefined || (row && row.address === grantor.ownAddress.trim().toLowerCase());
  if (!row || !mine) throw new AdminError(404, "E_NOT_FOUND", "no such delegation");
  const now = new Date().toISOString();
  const update = env.DB.prepare(
    "UPDATE delegation_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(now, id);
  const audit = auditStatement(env, now, {
    action: "delegation.revoke",
    targetKind: "delegation",
    targetId: id,
    outcome: "ok",
    detail: { alreadyRevoked: row.revoked_at !== null, granteeId: row.grantee_id, address: row.address },
  }, undefined, grantor.actor);
  const results = await env.DB.batch([update, audit]);
  return json({ ok: true, id, revoked: results[0]?.meta?.changes ?? 0, alreadyRevoked: row.revoked_at !== null });
}

const ADMIN_ITEM = /^\/api\/admin\/delegations\/([^/]+)$/;

/**
 * /api/admin/delegations[/{id}], reached only past the `admin` scope gate. Returns null
 * for a method or path this does not serve (falls through to 404): a method with no
 * route row has no scope gate in front of it.
 */
export async function handleAdminDelegations(
  request: Request,
  env: Env,
  url: URL,
  actor: AuditActor = OPERATOR_ACTOR,
): Promise<Response | null> {
  const path = url.pathname;
  const target = (raw: string | null) => ({ kind: "delegation", raw, idRe: DELEGATION_ID_RE });
  // Any operator-level credential makes an `operator` grant; the audit row names which.
  const grantor: Grantor = { ...OPERATOR_GRANTOR, actor };
  if (path === "/api/admin/delegations") {
    if (request.method === "POST") return runAudited(env, "delegation.grant", target(null), () => grant(request, env, grantor), actor);
    if (request.method === "GET") return runAudited(env, "delegation.list", target(null), () => list(url, env, actor), actor);
    return null;
  }
  const m = ADMIN_ITEM.exec(path);
  if (m && request.method === "DELETE") return runAudited(env, "delegation.revoke", target(m[1]), () => revoke(env, m[1], grantor), actor);
  return null;
}

// --- #740 S2: what a grant lets its grantee do ---------------------------------------

export type AgentReadScope = "estate" | "granted";

/** The audit_log action of an agent's organize write on a granted address. */
export const ORGANIZE_AUDIT_ACTION = "delegation.organize";
/** The audit_log action of an agent quoting a granted address's mail (#740 S3). */
export const QUOTE_AUDIT_ACTION = "delegation.quote";
/** The audit_log action of an agent sending as a granted address (#740 S4). */
export const SEND_AS_AUDIT_ACTION = "delegation.send_as";

let readScopeConfigLogged: string | undefined;

/**
 * The operator flag AGENT_READ_SCOPE (Conrad's Q1 ruling on #740, "opt-in fallback").
 *
 *   unset      "estate": an upgraded deploy keeps the #718 estate-wide agent read.
 *   "estate"   "estate".
 *   "granted"  an agent reads its own address (and its role queues) plus every address it
 *              holds an active grant on. The installer writes this on a new install.
 *   other      "granted", and a config error is logged once per value per isolate. A typo
 *              must not widen reads on the very deploy whose operator tried to narrow them.
 *
 * Exact values only: "Granted" and "" are typos, so they fail closed with the rest.
 */
export function agentReadScope(env: Env): AgentReadScope {
  const raw = env.AGENT_READ_SCOPE;
  if (raw === undefined || raw === "estate") return "estate";
  if (raw === "granted") return "granted";
  if (readScopeConfigLogged !== raw) {
    readScopeConfigLogged = raw;
    console.error(
      `config error: AGENT_READ_SCOPE=${JSON.stringify(raw)} is not "estate" or "granted"; agent reads fail closed to granted`,
    );
  }
  return "granted";
}

export interface AgentDelegations {
  /** Every address the grantee holds an ACTIVE grant on. Every power implies read. */
  read: string[];
  /** The subset whose grant carries organize. */
  organize: string[];
  /** The subset whose grant carries quote (#740 S3). */
  quote: string[];
  /** The subset whose grant carries send_as (#740 S4). */
  sendAs: string[];
  /** The active grants themselves, as GET /api/whoami reports them. */
  grants: Array<{ id: string; address: string; powers: DelegationPower[] }>;
}

export function noDelegations(): AgentDelegations {
  return { read: [], organize: [], quote: [], sendAs: [], grants: [] };
}

/**
 * The active grants one runtime agent identity holds. Read on every request that needs
 * them, never cached across requests, so a revoke takes effect on the next request, the
 * same rule the identity resolver follows for a revoked identity.
 *
 * A grant counts ONLY while its grantee identity is live: the lookup joins
 * agent_identities on `revoked_at IS NULL`. Revoking an identity therefore cuts every
 * grant it holds at once, from one source of truth, with no cascade write that could
 * fail half way. The grant rows stay as they are (still listed by the operator routes),
 * so the record of what was granted is not rewritten by the revoke.
 *
 * A row whose stored powers parse to nothing grants nothing (fail closed). Any power puts
 * the address in `read`, because every power implies read; S1 stores read explicitly, and
 * this does not depend on that.
 */
export async function activeDelegations(env: Env, granteeId: string): Promise<AgentDelegations> {
  const rows = await env.DB.prepare(
    "SELECT g.id AS id, g.address AS address, g.powers AS powers FROM delegation_grants g " +
      "JOIN agent_identities i ON i.id = g.grantee_id AND i.revoked_at IS NULL " +
      "WHERE g.grantee_id = ? AND g.revoked_at IS NULL ORDER BY g.address, g.id",
  )
    .bind(granteeId)
    .all<{ id: string; address: string; powers: string }>();
  const out = noDelegations();
  for (const row of rows.results ?? []) {
    const powers = parsePowers(row.powers);
    if (powers.length === 0) continue;
    const address = row.address.trim().toLowerCase();
    out.grants.push({ id: row.id, address, powers });
    if (!out.read.includes(address)) out.read.push(address);
    if (powers.includes("organize") && !out.organize.includes(address)) out.organize.push(address);
    if (powers.includes("quote") && !out.quote.includes(address)) out.quote.push(address);
    if (powers.includes("send_as") && !out.sendAs.includes(address)) out.sendAs.push(address);
  }
  return out;
}

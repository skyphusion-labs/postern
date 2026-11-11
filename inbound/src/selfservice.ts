// #740 S5: a human manages delegation on their OWN address and reads their own audit
// trail, from a webmail session. This is what makes the trail a product feature rather
// than an operator log (DELEGATION.md section 5).
//
// The human's door ONLY: every route here needs a webmail SESSION (a Bearer of any kind
// is refused, E_SESSION_REQUIRED), and the general gate already demands CSRF on its
// state-changing verbs. The address is always the session's own; no route takes one.
// Grants and revokes reuse the operator code path (delegations.ts) with a human
// Grantor (#854 M2): created_by and the audit actor are the human's principal id.

import { AdminError, fail, json, parseLimit, runAudited, type AuditActor } from "./adminkit";
import { grant, revoke, DELEGATION_ID_RE, DELEGATION_POWERS, type Grantor } from "./delegations";

/** What the routes need from the resolved caller. */
export interface SelfCaller {
  viaSession?: boolean;
  principalId?: string | null;
  identity?: { from: string };
}

const SELF_ITEM = /^\/api\/delegations\/mine\/([^/]+)$/;

function caller(resolution: SelfCaller): { address: string; principalId: string } {
  if (!resolution.viaSession || !resolution.identity) {
    throw new AdminError(403, "E_SESSION_REQUIRED", "this is the webmail session door: sign in to webmail; a token is not accepted here");
  }
  if (!resolution.principalId) {
    // A session minted before migration 0020 names no principal: one more sign-in fixes it.
    throw new AdminError(401, "E_REAUTH_REQUIRED", "sign in again to manage delegation");
  }
  return { address: resolution.identity.from.trim().toLowerCase(), principalId: resolution.principalId };
}

/** /api/delegations/mine[...] and /api/audit/mine. Returns null for anything else. */
export async function handleSelfService(request: Request, env: Env, url: URL, resolution: SelfCaller): Promise<Response | null> {
  const path = url.pathname;
  const isOurs = path === "/api/audit/mine" || path === "/api/delegations/mine" || path.startsWith("/api/delegations/mine/");
  if (!isOurs) return null;
  let me: { address: string; principalId: string };
  try {
    me = caller(resolution);
  } catch (err) {
    if (err instanceof AdminError) return fail(err);
    throw err;
  }
  const actor: AuditActor = { kind: "human", id: me.principalId };
  const grantor: Grantor = { actor, createdBy: me.principalId, ownAddress: me.address };
  const target = (raw: string | null) => ({ kind: "delegation", raw, idRe: DELEGATION_ID_RE });

  try {
    if (path === "/api/delegations/mine/grantees" && request.method === "GET") return await grantees(env);
    if (path === "/api/delegations/mine" && request.method === "GET") return await mine(env, me.address);
    if (path === "/api/delegations/mine" && request.method === "POST") {
      return await runAudited(env, "delegation.grant", target(null), () => grant(request, env, grantor), actor);
    }
    if (path === "/api/audit/mine" && request.method === "GET") return await auditMine(env, url, me.address);
    const m = SELF_ITEM.exec(path);
    if (m && m[1] !== "grantees" && request.method === "DELETE") {
      return await runAudited(env, "delegation.revoke", target(m[1]), () => revoke(env, m[1], grantor), actor);
    }
  } catch (err) {
    if (err instanceof AdminError) return fail(err);
    throw err;
  }
  return null;
}

/** The LIVE agent identities a human may grant to: exactly id, display name and From.
 *  Every signed-in human on the deploy sees this roster (IDENTITY.md section 8, lead's
 *  ruling on S5 Q1). Nothing about powers, grants held or creation is exposed. */
async function grantees(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, display_name, from_addr FROM agent_identities WHERE revoked_at IS NULL ORDER BY lower(COALESCE(display_name, from_addr)), id",
  ).all<{ id: string; display_name: string | null; from_addr: string }>();
  return json({
    ok: true,
    items: (results ?? []).map((r) => ({ id: r.id, displayName: r.display_name, from: r.from_addr })),
  });
}

/** The ACTIVE grants on my address whose grantee is still live (a grant of a revoked
 *  identity counts for nothing, so it is not shown as if it did), newest first. */
async function mine(env: Env, address: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT g.id, g.grantee_id, g.powers, g.label, g.created_by, g.created_at, i.display_name, i.from_addr " +
      "FROM delegation_grants g JOIN agent_identities i ON i.id = g.grantee_id AND i.revoked_at IS NULL " +
      "WHERE g.address = ? AND g.revoked_at IS NULL ORDER BY g.created_at DESC, g.id DESC",
  )
    .bind(address)
    .all<{ id: string; grantee_id: string; powers: string; label: string | null; created_by: string; created_at: string; display_name: string | null; from_addr: string }>();
  return json({
    ok: true,
    items: (results ?? []).map((r) => ({
      id: r.id,
      granteeId: r.grantee_id,
      granteeName: r.display_name,
      granteeFrom: r.from_addr,
      powers: canonicalPowers(r.powers),
      label: r.label,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
  });
}

function canonicalPowers(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? DELEGATION_POWERS.filter((p) => parsed.includes(p)) : [];
}

/** The audit rows ABOUT my address, newest first, keyset-paged like /api/admin/audit.
 *  About me means: a grant or revoke on my address, a send as me, a quote of my mail, an
 *  organize write on my mail. Nothing about any other address is ever returned. */
async function auditMine(env: Env, url: URL, address: string): Promise<Response> {
  const limit = parseLimit(url);
  const rawCursor = url.searchParams.get("cursor");
  let before: number | null = null;
  if (rawCursor !== null) {
    before = Number(rawCursor);
    if (!Number.isInteger(before) || before < 1) throw new AdminError(400, "E_VALIDATION_ERROR", "malformed cursor", "cursor");
  }
  const about =
    "((a.action IN ('delegation.grant', 'delegation.revoke', 'delegation.quote', 'delegation.organize') AND json_extract(a.detail, '$.address') = ?1) " +
    "OR (a.action = 'delegation.send_as' AND a.target_kind = 'address' AND a.target_id = ?1))";
  const sql =
    "SELECT a.id, a.at, a.actor_kind, a.actor_id, a.action, a.target_kind, a.target_id, a.outcome, a.detail FROM audit_log a " +
    `WHERE a.detail IS NOT NULL AND json_valid(a.detail) AND ${about}` +
    (before !== null ? " AND a.id < ?2" : "") +
    ` ORDER BY a.id DESC LIMIT ${before !== null ? "?3" : "?2"}`;
  const binds: unknown[] = before !== null ? [address, before, limit + 1] : [address, limit + 1];
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
}

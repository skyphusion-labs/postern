// The principal layer, phase M1 (#854; docs/IDENTITY.md sections 3 and 6).
//
// M1 is STORE ONLY: nothing here authorizes anything, and no read or auth path consults
// these tables. Every credential resolves exactly as before. This module owns the
// BACKFILL that copies today's two people models into the new tables:
//
//   agent_identities -> an `agent` principal that KEEPS its idn_ id (so every grant and
//                       audit row already written stays valid), an `api_token` credential
//                       (lookup = the existing sha256 token hash) and its primary address;
//   smtp_credentials -> a `human` principal (prn_ id), a `password` credential (lookup =
//                       the username, secret = the existing PBKDF2 string) and its address;
//   the static slots -> the six `service` principals, also seeded by migration 0019.
//
// IDEMPOTENT and CONVERGENT: a second run inserts nothing and changes nothing; a run after
// the source changed (an identity revoked, a user disabled, a password changed, a user
// deleted) mirrors exactly that change and nothing else. It is a function, not migration
// SQL, because a copy is an INSERT ... SELECT, which the #112 deploy gate refuses.

import { generateId } from "./adminkit";
import { NATIVE_SESSION_CAPS } from "./caps";

/** The six static token slots as service principals (D-ID-5), fixed ids. */
export const SERVICE_PRINCIPALS: ReadonlyArray<{ id: string; displayName: string }> = [
  { id: "svc_both", displayName: "Operator (POSTERN_API_TOKEN)" },
  { id: "svc_read", displayName: "POSTERN_API_TOKEN_READ" },
  { id: "svc_send", displayName: "POSTERN_API_TOKEN_SEND" },
  { id: "svc_delete", displayName: "POSTERN_API_TOKEN_DELETE" },
  { id: "svc_imap", displayName: "POSTERN_API_TOKEN_IMAP" },
  { id: "svc_organize", displayName: "POSTERN_API_TOKEN_ORGANIZE" },
];

/** The principal every operator (static `both`) action is audited as. */
export const OPERATOR_PRINCIPAL_ID = "svc_both";

const SEED_AT = "2026-11-11T00:00:00.000Z";

export interface BackfillReport {
  services: { added: number };
  agents: { added: number; synced: number };
  humans: { added: number; synced: number; orphansRevoked: number };
  /** An address already owned by a different principal is left with its owner. */
  addressConflicts: Array<{ address: string; principalId: string; ownerId: string }>;
}

interface AgentRow {
  id: string;
  token_hash: string;
  from_addr: string;
  display_name: string | null;
  label: string | null;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

interface HumanRow {
  username: string;
  from_addr: string;
  secret_hash: string;
  disabled: number;
  created_at: string | null;
  updated_at: string | null;
  display_name: string | null;
}

/** Copy agents, humans and the service slots into the principal tables. See the header. */
export async function backfillPrincipals(env: Env, now = new Date().toISOString()): Promise<BackfillReport> {
  const report: BackfillReport = {
    services: { added: 0 },
    agents: { added: 0, synced: 0 },
    humans: { added: 0, synced: 0, orphansRevoked: 0 },
    addressConflicts: [],
  };

  for (const s of SERVICE_PRINCIPALS) {
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at) " +
        "VALUES (?, 'service', ?, 'static slot', 'migration', ?)",
    )
      .bind(s.id, s.displayName, SEED_AT)
      .run();
    report.services.added += res.meta?.changes ?? 0;
  }

  const agents = await env.DB.prepare(
    "SELECT id, token_hash, from_addr, display_name, label, scopes, created_at, revoked_at FROM agent_identities ORDER BY created_at, id",
  ).all<AgentRow>();
  for (const a of agents.results ?? []) {
    const credentialId = "crd_" + a.id.slice("idn_".length);
    const added = await env.DB.prepare(
      "INSERT OR IGNORE INTO principals (id, kind, display_name, label, created_by, created_at, disabled_at) " +
        "VALUES (?, 'agent', ?, ?, 'migration', ?, ?)",
    )
      .bind(a.id, a.display_name, a.label, a.created_at, a.revoked_at)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO credentials (id, principal_id, type, lookup, secret, caps, protocols, label, created_at, revoked_at) " +
        "VALUES (?, ?, 'api_token', ?, NULL, ?, NULL, ?, ?, ?)",
    )
      .bind(credentialId, a.id, a.token_hash, a.scopes, a.label, a.created_at, a.revoked_at)
      .run();
    if ((added.meta?.changes ?? 0) > 0) {
      report.agents.added++;
    } else {
      // Converge: a revoke (or a display-name change) made after the first run.
      const p = await env.DB.prepare(
        "UPDATE principals SET disabled_at = ?, display_name = ? WHERE id = ? AND (disabled_at IS NOT ? OR display_name IS NOT ?)",
      )
        .bind(a.revoked_at, a.display_name, a.id, a.revoked_at, a.display_name)
        .run();
      const c = await env.DB.prepare("UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NOT ?")
        .bind(a.revoked_at, credentialId, a.revoked_at)
        .run();
      if ((p.meta?.changes ?? 0) + (c.meta?.changes ?? 0) > 0) report.agents.synced++;
    }
    await claimAddress(env, a.from_addr, a.id, report);
  }

  const humans = await env.DB.prepare(
    "SELECT username, from_addr, secret_hash, disabled, created_at, updated_at, display_name FROM smtp_credentials ORDER BY username",
  ).all<HumanRow>();
  for (const h of humans.results ?? []) {
    await upsertHuman(env, h, now, report);
  }

  // A user deleted since the last run: its password credential stops being live, and its
  // principal is disabled. The rows themselves stay (never deleted).
  const orphans = await env.DB.prepare(
    "SELECT id, principal_id FROM credentials WHERE type = 'password' AND revoked_at IS NULL " +
      "AND lookup NOT IN (SELECT username FROM smtp_credentials)",
  ).all<{ id: string; principal_id: string }>();
  for (const o of orphans.results ?? []) {
    await env.DB.batch([
      env.DB.prepare("UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, o.id),
      env.DB.prepare("UPDATE principals SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").bind(now, o.principal_id),
    ]);
    report.humans.orphansRevoked++;
  }

  return report;
}

/** Create or converge ONE human's principal from its smtp_credentials row; returns the
 *  principal id, or null when a concurrent run won the insert (the next run converges). */
async function upsertHuman(env: Env, h: HumanRow, now: string, report: BackfillReport): Promise<string | null> {
  const disabledAt = h.disabled ? (h.updated_at ?? now) : null;
  const existing = await env.DB.prepare(
    "SELECT c.id AS credential_id, c.principal_id AS principal_id FROM credentials c " +
      "WHERE c.type = 'password' AND c.lookup = ? AND c.revoked_at IS NULL",
  )
    .bind(h.username)
    .first<{ credential_id: string; principal_id: string }>();
  if (!existing) {
    const principalId = generateId("prn_");
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO principals (id, kind, display_name, label, created_by, created_at, disabled_at) " +
            "VALUES (?, 'human', ?, NULL, 'migration', ?, ?)",
        ).bind(principalId, h.display_name, h.created_at ?? now, disabledAt),
        env.DB.prepare(
          "INSERT INTO credentials (id, principal_id, type, lookup, secret, caps, protocols, label, created_at) " +
            "VALUES (?, ?, 'password', ?, ?, ?, NULL, NULL, ?)",
        ).bind(generateId("crd_"), principalId, h.username, h.secret_hash, JSON.stringify(NATIVE_SESSION_CAPS), h.created_at ?? now),
      ]);
    } catch {
      // A concurrent run took this username first (the unique lookup index): the batch
      // rolled back, and the caller re-reads the winner (or the next run converges).
      return null;
    }
    report.humans.added++;
    await claimAddress(env, h.from_addr, principalId, report);
    return principalId;
  }
  // Converge: a password change, a disable or re-enable, or a display-name change.
  const c = await env.DB.prepare("UPDATE credentials SET secret = ? WHERE id = ? AND secret IS NOT ?")
    .bind(h.secret_hash, existing.credential_id, h.secret_hash)
    .run();
  // Only the presence of disabled_at is mirrored, so re-running never moves the time.
  const p = await env.DB.prepare(
    "UPDATE principals SET disabled_at = CASE WHEN ? THEN COALESCE(disabled_at, ?) ELSE NULL END, display_name = ? " +
      "WHERE id = ? AND ((? AND disabled_at IS NULL) OR (NOT ? AND disabled_at IS NOT NULL) OR display_name IS NOT ?)",
  )
    .bind(h.disabled ? 1 : 0, disabledAt, h.display_name, existing.principal_id, h.disabled ? 1 : 0, h.disabled ? 1 : 0, h.display_name)
    .run();
  if ((c.meta?.changes ?? 0) + (p.meta?.changes ?? 0) > 0) report.humans.synced++;
  await claimAddress(env, h.from_addr, existing.principal_id, report);
  return existing.principal_id;
}

/** Give an address its primary owner, once. An address another principal already owns is
 *  reported, never moved: one owner per address (IDENTITY.md section 3.3). */
async function claimAddress(env: Env, rawAddress: string, principalId: string, report: BackfillReport): Promise<void> {
  const address = rawAddress.trim().toLowerCase();
  await env.DB.prepare("INSERT OR IGNORE INTO principal_addresses (address, principal_id, is_primary) VALUES (?, ?, 1)")
    .bind(address, principalId)
    .run();
  const owner = await env.DB.prepare("SELECT principal_id FROM principal_addresses WHERE address = ?")
    .bind(address)
    .first<{ principal_id: string }>();
  if (owner && owner.principal_id !== principalId) {
    report.addressConflicts.push({ address, principalId, ownerId: owner.principal_id });
  }
}

/**
 * The principal id of one human login (#854 M2), creating it from smtp_credentials if
 * the backfill has not reached it yet. Used by every session mint, so a webmail session
 * always names a principal. Throws if the account row is gone (the caller just verified
 * it, so that is a race the mint should fail on, not paper over).
 */
export async function ensureHumanPrincipal(env: Env, username: string): Promise<string> {
  const live = await env.DB.prepare(
    "SELECT principal_id FROM credentials WHERE type = 'password' AND lookup = ? AND revoked_at IS NULL",
  )
    .bind(username)
    .first<{ principal_id: string }>();
  if (live) return live.principal_id;
  const row = await env.DB.prepare(
    "SELECT username, from_addr, secret_hash, disabled, created_at, updated_at, display_name FROM smtp_credentials WHERE username = ?",
  )
    .bind(username)
    .first<HumanRow>();
  if (!row) throw new Error("ensureHumanPrincipal: no account row for this login");
  const scratch: BackfillReport = {
    services: { added: 0 },
    agents: { added: 0, synced: 0 },
    humans: { added: 0, synced: 0, orphansRevoked: 0 },
    addressConflicts: [],
  };
  const id = await upsertHuman(env, row, new Date().toISOString(), scratch);
  if (id) return id;
  // A concurrent mint or backfill created it between our read and our insert.
  const again = await env.DB.prepare(
    "SELECT principal_id FROM credentials WHERE type = 'password' AND lookup = ? AND revoked_at IS NULL",
  )
    .bind(username)
    .first<{ principal_id: string }>();
  if (!again) throw new Error("ensureHumanPrincipal: could not create a principal for this login");
  return again.principal_id;
}

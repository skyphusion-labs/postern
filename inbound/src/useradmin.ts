// Human account management (#790, contract docs/design/webmail-v2-contracts.md 1.10.4).
// Operator routes under the `admin` scope: only the static `both` token reaches them
// (api.ts runs the scope gate first; a webmail session never carries `admin`). A user
// is ONE smtp_credentials row; nothing here adds a store or a permission concept.
//
// Every write that changes who an account is, or whether it may sign in (disable, a
// from change, a password reset, delete, the legacy rotate), ends that account's
// webmail sessions BEFORE the answer is sent (contract 1.10.3).

import {
  createUser,
  displayNameProblem,
  generateSecret,
  getUser,
  hashSecret,
  listUsers,
  lookup,
  normalizeUsername,
  passwordProblem,
  remove,
  setPassword,
  updateUser,
  upsert,
  usernameProblem,
} from "./smtpcreds";
import { endUserSessions } from "./session";
import { allowedFromDomain } from "./fromdomain";
import { readBodyCapped, PayloadTooLargeError } from "./body";

const MAX_ADMIN_BODY_BYTES = 4 * 1024;
const LIST_DEFAULT = 100;
const LIST_MAX = 500;
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const USER_PATH = /^\/api\/admin\/users\/([^/]+)(\/password)?$/;

class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function fail(err: AdminError): Response {
  const body: Record<string, unknown> = { ok: false, error: err.code, message: err.message };
  if (err.field) body.field = err.field;
  return json(body, err.status);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
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

// Bound identity check shared by create, PATCH and the legacy upsert. Unset domain
// refuses rather than borrowing one (#615).
function requireDomain(env: Env): string {
  const domain = allowedFromDomain(env);
  if (!domain) throw new AdminError(500, "E_INTERNAL_SERVER_ERROR", "ALLOWED_FROM_DOMAIN is not configured");
  return domain;
}

function validFrom(env: Env, raw: string): string {
  const domain = requireDomain(env);
  const fromAddr = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(fromAddr) || fromAddr.split("@")[1] !== domain) {
    throw new AdminError(400, "E_SENDER_NOT_ALLOWED", `from must be a valid address on @${domain}`, "from");
  }
  return fromAddr;
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new AdminError(400, "E_VALIDATION_ERROR", `${key} must be a string`, key);
  return v;
}

function displayName(body: Record<string, unknown>): string | null | undefined {
  const v = body.displayName;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new AdminError(400, "E_VALIDATION_ERROR", "displayName must be a string or null", "displayName");
  const name = v.trim();
  const problem = displayNameProblem(name);
  if (problem) throw new AdminError(400, "E_VALIDATION_ERROR", problem, "displayName");
  return name || null;
}

function policy(password: string, username: string): void {
  const problem = passwordProblem(password, username);
  if (problem) throw new AdminError(400, "E_PASSWORD_POLICY", problem, "password");
}

function pathUser(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new AdminError(400, "E_VALIDATION_ERROR", "malformed username in path");
  }
  const u = normalizeUsername(decoded);
  if (!u) throw new AdminError(400, "E_VALIDATION_ERROR", "username is required");
  return u;
}

const notFound = () => new AdminError(404, "E_NOT_FOUND", "no such user");

/**
 * The /api/admin/users routes. Returns null for a path this does not own. Called only
 * after the scope gate has authorized `admin`.
 */
export async function handleUserAdmin(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const m = request.method;
  try {
    if (path === "/api/admin/users") {
      if (m === "GET") return await list(url, env);
      if (m === "POST") return await create(request, env);
      return json({ ok: false, error: "method_not_allowed", message: "GET or POST" }, 405);
    }
    const match = USER_PATH.exec(path);
    if (!match) return null;
    const username = pathUser(match[1]);
    if (match[2]) {
      if (m !== "POST") return json({ ok: false, error: "method_not_allowed", message: "POST only" }, 405);
      return await resetPassword(request, env, username);
    }
    if (m === "GET") {
      const user = await getUser(env, username);
      if (!user) throw notFound();
      return json({ ok: true, user });
    }
    if (m === "PATCH") return await patch(request, env, username);
    if (m === "DELETE") return await deleteUser(env, username);
    return json({ ok: false, error: "method_not_allowed", message: "GET, PATCH or DELETE" }, 405);
  } catch (err) {
    if (err instanceof AdminError) return fail(err);
    throw err;
  }
}

async function list(url: URL, env: Env): Promise<Response> {
  const rawLimit = url.searchParams.get("limit");
  let limit = LIST_DEFAULT;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) {
      throw new AdminError(400, "E_VALIDATION_ERROR", `limit must be an integer from 1 to ${LIST_MAX}`, "limit");
    }
  }
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && !rawCursor.trim()) {
    throw new AdminError(400, "E_VALIDATION_ERROR", "cursor must not be empty", "cursor");
  }
  const page = await listUsers(env, limit, rawCursor === null ? null : normalizeUsername(rawCursor));
  return json({ ok: true, users: page.users, nextCursor: page.nextCursor });
}

/** A validated new user, shared by the admin create and the first-run setup. */
export interface NewUser {
  username: string;
  fromAddr: string;
  displayName: string | null;
  password: string | undefined;
}

function parseNewUser(env: Env, body: Record<string, unknown>, requirePassword: boolean): NewUser {
  const rawUser = optString(body, "username");
  if (!rawUser || !rawUser.trim()) throw new AdminError(400, "E_FIELD_MISSING", "username is required", "username");
  const username = normalizeUsername(rawUser);
  const domain = requireDomain(env);
  const problem = usernameProblem(username, domain);
  if (problem) throw new AdminError(400, "E_INVALID_USERNAME", problem, "username");
  const chosen = optString(body, "password");
  if (requirePassword && !chosen) throw new AdminError(400, "E_FIELD_MISSING", "password is required", "password");
  // A bare login binds to login@domain; an address binds to itself (contract 1.10.1).
  const defaultFrom = username.includes("@") ? username : `${username}@${domain}`;
  const fromAddr = validFrom(env, optString(body, "from")?.trim() || defaultFrom);
  const name = displayName(body) ?? null;
  if (chosen !== undefined) policy(chosen, username);
  return { username, fromAddr, displayName: name, password: chosen };
}

/**
 * The contract 1.10.1 checks for a new user, for a caller outside this module (the
 * first-run setup). Returns the user, or the refusal as a Response.
 */
export function validateNewUser(
  env: Env,
  body: Record<string, unknown>,
  requirePassword: boolean,
): { user: NewUser } | { refusal: Response } {
  try {
    return { user: parseNewUser(env, body, requirePassword) };
  } catch (err) {
    if (err instanceof AdminError) return { refusal: fail(err) };
    throw err;
  }
}

async function create(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const { username, fromAddr, displayName: name, password: chosen } = parseNewUser(env, body, false);
  const password = chosen ?? generateSecret();

  const created = await createUser(env, { username, fromAddr, displayName: name }, await hashSecret(password, env), now());
  if (!created) throw new AdminError(409, "E_CONFLICT", "a user with that username already exists", "username");
  const user = await getUser(env, username);
  const out: Record<string, unknown> = { ok: true, user };
  if (chosen === undefined) out.password = password;
  return json(out, 201);
}

async function patch(request: Request, env: Env, username: string): Promise<Response> {
  const body = await readBody(request);
  const changes: { disabled?: boolean; displayName?: string | null; fromAddr?: string } = {};
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") throw new AdminError(400, "E_VALIDATION_ERROR", "disabled must be a boolean", "disabled");
    changes.disabled = body.disabled;
  }
  const name = displayName(body);
  if (name !== undefined) changes.displayName = name;
  const rawFrom = optString(body, "from");
  if (rawFrom !== undefined) changes.fromAddr = validFrom(env, rawFrom);
  if (Object.keys(changes).length === 0) {
    throw new AdminError(400, "E_FIELD_MISSING", "give at least one of disabled, displayName, from");
  }
  const before = await lookup(env, username);
  if (!before) throw notFound();
  const user = await updateUser(env, username, changes, now());
  if (!user) throw notFound();
  const ends = changes.disabled === true || (changes.fromAddr !== undefined && changes.fromAddr !== before.fromAddr);
  const sessionsEnded = ends ? await endUserSessions(env, username, before.fromAddr) : 0;
  return json({ ok: true, user, sessionsEnded });
}

async function resetPassword(request: Request, env: Env, username: string): Promise<Response> {
  const body = await readBody(request);
  const chosen = optString(body, "password");
  if (chosen !== undefined) policy(chosen, username);
  const before = await lookup(env, username);
  if (!before) throw notFound();
  const password = chosen ?? generateSecret();
  if (!(await setPassword(env, username, await hashSecret(password, env), now()))) throw notFound();
  const sessionsEnded = await endUserSessions(env, username, before.fromAddr);
  // "I am locked out" has an operator fix: clear the ACCOUNT lockout only, never an IP row.
  await env.DB.prepare("DELETE FROM webmail_auth_failures WHERE scope_key = ?").bind("a:" + username).run();
  const out: Record<string, unknown> = { ok: true, user: await getUser(env, username), sessionsEnded };
  if (chosen === undefined) out.password = password;
  return json(out);
}

async function deleteUser(env: Env, username: string): Promise<Response> {
  const before = await lookup(env, username);
  if (!before || !(await remove(env, username))) throw notFound();
  const sessionsEnded = await endUserSessions(env, username, before.fromAddr);
  return json({ ok: true, deleted: username, sessionsEnded });
}

// --- the legacy routes (#68), kept for back-compat ------------------------------

/**
 * POST /api/admin/smtp-credentials: create OR rotate (upsert). Reads `password`, the
 * name the route contract has always declared, with `secret` as an alias; reads
 * through the body cap; a rotation ends the user's sessions. The secret is returned
 * once and only its PBKDF2 hash is stored.
 */
export async function handleCredentialUpsert(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readBody(request);
    const username = normalizeUsername(optString(body, "username") ?? "");
    if (!username) throw new AdminError(400, "E_FIELD_MISSING", "username is required", "username");
    const fromAddr = validFrom(env, optString(body, "from")?.trim() || username);
    const password = optString(body, "password");
    const secret = optString(body, "secret");
    if (password !== undefined && secret !== undefined && password !== secret) {
      throw new AdminError(400, "E_VALIDATION_ERROR", "give password or secret, not two different values", "password");
    }
    let chosen = password ?? secret ?? "";
    if (chosen && chosen.length < 12) {
      throw new AdminError(400, "E_VALIDATION_ERROR", "secret must be at least 12 characters", "password");
    }
    if (!chosen) chosen = generateSecret();
    const before = await lookup(env, username);
    await upsert(env, username, fromAddr, await hashSecret(chosen, env), now());
    if (before) await endUserSessions(env, username, before.fromAddr);
    return json({ ok: true, username, from: fromAddr, secret: chosen });
  } catch (err) {
    if (err instanceof AdminError) return fail(err);
    throw err;
  }
}

/** DELETE /api/admin/smtp-credentials/{username}: an alias of the user delete. */
export async function handleCredentialDelete(env: Env, rawUsername: string): Promise<Response> {
  try {
    const username = pathUser(rawUsername);
    const before = await lookup(env, username);
    if (!before || !(await remove(env, username))) {
      return json({ ok: false, error: "E_NOT_FOUND", message: "no such credential" }, 404);
    }
    await endUserSessions(env, username, before.fromAddr);
    return json({ ok: true, deleted: username });
  } catch (err) {
    if (err instanceof AdminError) return fail(err);
    throw err;
  }
}

function now(): string {
  return new Date().toISOString();
}

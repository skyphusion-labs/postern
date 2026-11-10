// First run: POST /api/setup (#791, contract docs/design/webmail-v2-contracts.md 1.10.7).
// Creates the FIRST user of a fresh deploy and signs them in, so a one-click install
// needs nobody to paste a token. It is armed only while ALL hold: WEBMAIL_AUTH_BACKEND
// is explicitly native (unset is off), the Worker secret POSTERN_SETUP_TOKEN is set (at
// least 32 characters), and smtp_credentials has no row at all. Once any row exists it
// is closed for good (409 E_SETUP_COMPLETE); the token is then inert.
//
// It writes ONE smtp_credentials row through the same validation as the admin create,
// so there is no second path to an account. Scripted installers that hold the `both`
// token can skip this and use POST /api/admin/users.

import { attemptKeys, clearFailures, gateAttempt, recordFailure, type AttemptKeys } from "./auththrottle";
import { readBodyCapped, PayloadTooLargeError } from "./body";
import { sha256Hex } from "./sendidentity";
import {
  csrfCookie,
  crossSiteMint,
  idleSeconds,
  insertSession,
  MAX_SESSION_BODY_BYTES,
  sessionCookie,
  setupToken,
  throttled,
  unavailable,
  webmailAuthBackend,
} from "./session";
import { anyUser, createFirstUser, getUser, hashSecret } from "./smtpcreds";
import { validateNewUser } from "./useradmin";

// The fixed throttle key for the setup token. Rides the `account` slot of the shared
// throttle (its prefix keeps it apart from every a:<username> row), next to the
// client-IP key, with the 1.6.1 defaults.
const SETUP_SCOPE = "s:setup";

function sjson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const notArmed = () => sjson({ ok: false, error: "E_NOT_FOUND", message: "first-run setup is not available" }, 404);
const complete = () => sjson({ ok: false, error: "E_SETUP_COMPLETE", message: "setup is already done; sign in" }, 409);

/** The /api/setup route. Pre-gate (it carries its own auth: the setup token). */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Armed only with an EXPLICIT native backend (decision D-AUTH-3): unset is off.
  if (webmailAuthBackend(env) !== "native") return notArmed();
  const expected = setupToken(env);
  if (expected === null) return notArmed();
  if (request.method !== "POST") {
    return sjson({ ok: false, error: "method_not_allowed", message: "POST only" }, 405);
  }
  if (crossSiteMint(request, url)) {
    return sjson({ ok: false, error: "E_CROSS_ORIGIN", message: "cross-site setup refused" }, 403);
  }
  let rawBody: string;
  try {
    rawBody = await readBodyCapped(request, MAX_SESSION_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return sjson({ ok: false, error: "E_PAYLOAD_TOO_LARGE", message: "request body too large" }, 413);
    }
    throw err;
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return sjson({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
  }
  // Cheap, and says nothing GET /api/session (setupRequired) does not already say.
  if (await anyUser(env)) return complete();

  const presented = typeof body.setupToken === "string" ? body.setupToken : "";
  if (!presented) {
    return sjson({ ok: false, error: "E_FIELD_MISSING", message: "setupToken is required", field: "setupToken" }, 400);
  }
  const checked = validateNewUser(env, body, true);
  if ("refusal" in checked) return checked.refusal;
  const user = checked.user;

  // Throttle BEFORE the token compare, on the client IP and the fixed setup key.
  const ipKeys = attemptKeys(request, "");
  const keys: AttemptKeys = ipKeys.client ? { account: SETUP_SCOPE, client: ipKeys.client } : { account: SETUP_SCOPE };
  let gate;
  try {
    gate = await gateAttempt(env, keys);
  } catch {
    return unavailable();
  }
  if (!gate.allowed) return throttled(gate.retryAfter);

  // Constant time over fixed-length digests, so the token LENGTH does not leak either.
  const ok = timingSafeEqual(await sha256Hex(presented), await sha256Hex(expected));
  if (!ok) {
    try {
      await recordFailure(env, keys, gate);
    } catch {
      return unavailable();
    }
    return sjson({ ok: false, error: "E_AUTH_FAILED" }, 401);
  }

  const created = await createFirstUser(
    env,
    { username: user.username, fromAddr: user.fromAddr, displayName: user.displayName },
    await hashSecret(user.password as string),
    new Date().toISOString(),
  );
  if (!created) return complete(); // lost the race: the other request made the first user
  try {
    await clearFailures(env, keys, gate);
  } catch {
    // The user exists and the token is now inert; a stale counter row is harmless.
  }

  const minted = await insertSession(env, {
    username: user.username, fromAddr: user.fromAddr, displayName: user.displayName,
  });
  const idle = idleSeconds(env);
  const h = new Headers({ "content-type": "application/json" });
  h.append("set-cookie", sessionCookie(minted.rawId, idle));
  h.append("set-cookie", csrfCookie(minted.csrfToken, idle));
  return new Response(
    JSON.stringify({
      ok: true,
      setup: true,
      user: await getUser(env, user.username),
      identity: { from: minted.identity.from, displayName: minted.identity.displayName },
      capabilities: minted.caps,
      expiresAt: minted.expiresAt,
      csrfToken: minted.csrfToken,
    }),
    { status: 201, headers: h },
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

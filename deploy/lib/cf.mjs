// cf.mjs -- the smallest Cloudflare API client the installer needs.
//
// Two rules hold everywhere in this file:
//   1. The API token is read once and only ever placed in an Authorization header.
//      No message, error, or log line built here interpolates it.
//   2. Every call names the token PERMISSION it exercises, so a 403 becomes
//      "the token lacks <permission>" instead of a bare status code.

export const API_BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare reports a scope miss as HTTP 403 and/or error code 10000
// ("Authentication error") or 9109 ("Unauthorized to access requested resource").
const PERMISSION_CODES = new Set([10000, 9109]);

export class CfError extends Error {
  constructor(step, perm, status, errors) {
    const detail = (errors || []).map((e) => `${e.code}: ${e.message}`).join("; ");
    const denied = status === 403 || (errors || []).some((e) => PERMISSION_CODES.has(e.code));
    const head = denied
      ? `${step}: the token lacks the "${perm}" permission (HTTP ${status})`
      : status === 401
        ? `${step}: the token was rejected (HTTP 401); check it is current and not expired`
        : `${step} failed: HTTP ${status}${detail ? ` (${detail})` : ""}`;
    super(head);
    this.step = step;
    this.perm = perm;
    this.status = status;
    this.errors = errors || [];
    this.permissionDenied = denied;
  }
}

export function cfClient({ token, fetch: fetchImpl = globalThis.fetch, base = API_BASE }) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  async function call(step, perm, method, path, body, { allow404 = false } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    if (allow404 && res.status === 404) return null;
    if (!res.ok || json.success === false) throw new CfError(step, perm, res.status, json.errors);
    return json;
  }

  // GET a paginated list and return every item. Prints nothing; a truncated
  // list would read as "absent", so we walk every page the API reports.
  async function list(step, perm, path) {
    const out = [];
    for (let page = 1; page < 1000; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const json = await call(step, perm, "GET", `${path}${sep}page=${page}&per_page=50`);
      const items = Array.isArray(json.result) ? json.result : [];
      out.push(...items);
      const info = json.result_info || {};
      const totalPages = info.total_pages ?? (info.total_count != null ? Math.ceil(info.total_count / 50) : 1);
      if (page >= totalPages || items.length === 0) break;
    }
    return out;
  }

  return { call, list };
}

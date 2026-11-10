// config.mjs -- render the operator's real wrangler config from the committed
// template (inbound/wrangler.jsonc) plus the installer's state. The template stays
// the single source of bindings; the installer only fills in the operator's ids,
// names, and vars, so a new binding added upstream reaches an install on upgrade.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Strip // and /* */ comments and trailing commas, outside of strings.
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // trailing commas: a comma followed only by whitespace before } or ]
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

// Vars the installer owns. Anything else in the template's vars is kept at the
// template value unless the operator overrode it with --var (stored in state).
export function installerVars(opts) {
  return {
    DEFAULT_FROM: `noreply@${opts.domain}`,
    DEFAULT_FROM_NAME: opts.fromName,
    ALLOWED_FROM_DOMAIN: opts.domain,
    WEBMAIL_AUTH_BACKEND: "native",
  };
}

export function renderConfig({ repoRoot, state, opts }) {
  const inbound = join(repoRoot, "inbound");
  const tpl = parseJsonc(readFileSync(join(inbound, "wrangler.jsonc"), "utf8"));
  const cfg = { ...tpl };
  delete cfg.$schema;
  cfg.name = opts.name;
  // The rendered file lives in the state dir, so every path is made absolute.
  cfg.main = join(inbound, tpl.main);
  cfg.account_id = state.accountId;
  cfg.workers_dev = false;
  cfg.routes = [{ pattern: opts.hostname, custom_domain: true }];

  const db = (tpl.d1_databases || []).find((d) => d.binding === "DB");
  if (!db) throw new Error("inbound/wrangler.jsonc has no d1_databases entry with binding DB");
  cfg.d1_databases = (tpl.d1_databases || []).map((d) =>
    d.binding === "DB"
      ? { ...d, database_name: opts.d1Name, database_id: state.d1Id, migrations_dir: join(inbound, d.migrations_dir || "migrations") }
      : d,
  );
  const r2 = (tpl.r2_buckets || []).find((b) => b.binding === "ATTACHMENTS");
  if (!r2) throw new Error("inbound/wrangler.jsonc has no r2_buckets entry with binding ATTACHMENTS");
  cfg.r2_buckets = (tpl.r2_buckets || []).map((b) => (b.binding === "ATTACHMENTS" ? { ...b, bucket_name: opts.bucket } : b));

  cfg.vars = { ...(tpl.vars || {}), ...installerVars(opts), ...(state.vars || {}) };
  return cfg;
}

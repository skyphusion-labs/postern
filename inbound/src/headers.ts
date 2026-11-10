// Pure CF-transport helpers (header verdict parsing + content coercion),
// factored out of index.ts so the unit suite can import them without pulling in
// the worker entrypoint (cloudflare:workers). Used by the inbound email()
// driver; the storage-side pure helpers live in ingest.ts.

export function toArrayBuffer(content: unknown): ArrayBuffer | null {
  if (content instanceof ArrayBuffer) return content;
  // Copy into a fresh ArrayBuffer so the type is unambiguously ArrayBuffer
  // (Uint8Array.buffer / TextEncoder().buffer are typed as ArrayBufferLike).
  let view: Uint8Array | null = null;
  if (content instanceof Uint8Array) view = content;
  else if (typeof content === "string") view = new TextEncoder().encode(content);
  if (!view) return null;
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

// Choose the sender to STORE for an inbound message (#from-fidelity): the RFC 5322
// `From:` header (raw, display name preserved) when the message has one, else the SMTP
// envelope sender (MAIL FROM) as a fallback for a header-less message. The envelope
// sender is a dynamic VERP/bounce address for many ESPs (SparkPost/SendGrid/SES/
// Mailgun/Cloudflare notify), so it must NEVER win when a real From header exists --
// otherwise clients show `msprvs1=...=bounces-...@...` instead of `"Cloudflare"
// <noreply@...>`. reply() extracts the bare angle address from the result, and ingest's
// trust check parses the address before allowlist-matching, so a display-name header is
// safe downstream.
export function chooseFrom(headerFrom: string | null | undefined, envelopeFrom: string): string {
  const header = (headerFrom ?? "").trim();
  return header || envelopeFrom;
}

// --- Auth verdict helpers (parse the CF/MTA headers into a verdict) ---

export function extractSpfResult(header: string): string {
  const m = header.match(/^(pass|fail|softfail|neutral|none|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

export function extractDkimResult(authResults: string): string {
  const m = authResults.match(/dkim=(pass|fail|neutral|none|policy|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

export function extractDmarcResult(authResults: string): string {
  const m = authResults.match(/dmarc=(pass|fail|none|bestguesspass|temperror|permerror)/i);
  return m ? m[1].toLowerCase() : "none";
}

// --- Sender-trust inputs (aligned identities from the CF verdict) ---

/** The verdicts plus the authenticated domains needed to check alignment with the
 *  header From. Mirrors ParsedInbound.auth (ingest.ts). */
export interface AuthVerdicts {
  spf: string;
  dkim: string;
  dmarc: string;
  /** Domain SPF evaluated (smtp.mailfrom), set only when SPF passed. */
  spfDomain?: string;
  /** `header.d` of every DKIM signature that passed. */
  dkimDomains?: string[];
  /** The `header.from` domain DMARC was evaluated for. */
  dmarcFrom?: string;
}

/**
 * The FIRST instance of a header that `Headers.get()` joined. Repeats are joined in
 * header order with ", " (Fetch spec; same in workerd). CF prepends its own trace
 * headers, so the first instance is the one CF wrote; any copy the SENDER put in the
 * message sits below it and must never be read.
 *
 * This cuts at the first comma. It is NOT a header-boundary parser: a comma inside CF's
 * own instance (for example in a quoted MAIL FROM local part it echoes) cuts there too.
 * That only drops the rest of CF's instance (fail toward NOT trusted), and the cut text
 * is then read by `authResultsText`, which drops an unterminated quote or comment, so a
 * cut can never expose sender text as a verdict.
 */
export function firstHeaderInstance(joined: string | null | undefined): string {
  const v = joined ?? "";
  const i = v.indexOf(",");
  return (i < 0 ? v : v.slice(0, i)).trim();
}

/**
 * The structural text of one Authentication-Results instance, safe to split on ";".
 * One linear scan:
 *  - a quoted-string ("...", backslash escapes honoured) becomes `""`, so a quoted MAIL
 *    FROM local part (`"x;dkim=pass header.d=ours"@attacker`) carries no ";" or "=";
 *  - a comment ( ... ) (nested, backslash escapes honoured) becomes one space;
 *  - an UNTERMINATED quote or comment drops the rest of the text (fail closed).
 */
export function authResultsText(instance: string): string {
  let out = "";
  let i = 0;
  const n = instance.length;
  while (i < n) {
    const c = instance[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && instance[j] !== '"') j += instance[j] === "\\" ? 2 : 1;
      if (j >= n) break; // unterminated quoted-string: drop the rest
      out += '""';
      i = j + 1;
    } else if (c === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const d = instance[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "(") depth++;
        else if (d === ")") depth--;
        j++;
      }
      if (depth > 0) break; // unterminated comment: drop the rest
      out += " ";
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Domain part of `local@domain` or a bare domain, lower-cased; "" when unusable. */
function domainOf(v: string): string {
  const d = v.trim().toLowerCase();
  const at = d.lastIndexOf("@");
  const dom = at >= 0 ? d.slice(at + 1) : d;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom) ? dom : "";
}

/**
 * Parse ONE Authentication-Results instance (RFC 8601): `authserv-id; method=result
 * prop=value ...; ...`. CF writes the results in a fixed order: every `dkim=` entry,
 * then `dmarc=`, then the `spf=` entries (HELO first, then MAIL FROM), then `arc=`.
 * The SPF entries carry values the SENDER chose (smtp.helo, smtp.mailfrom), so the
 * parse is positional and fail-closed:
 *
 *  - `dkim=` entries count only in the leading run, before any other method;
 *  - only the first `dmarc=` counts, and only before any `spf=` entry;
 *  - SPF is the ONE `spf=` entry that carries smtp.mailfrom; HELO entries are ignored.
 *    Zero or more than one such entry reads as spf=none, so an entry smuggled in
 *    through an smtp.helo value cannot be selected;
 *  - smtp.helo / smtp.mailfrom values are opaque: only the mailfrom domain is read.
 *
 * `dkim` is the FIRST DKIM verdict (kept conservative: trust also needs it to be pass);
 * `dkimDomains` lists the `header.d` of every passing signature in that run.
 */
export function parseAuthResults(instance: string): AuthVerdicts {
  const out: AuthVerdicts = { spf: "none", dkim: "none", dmarc: "none" };
  const parts = authResultsText(instance).split(";").map((p) => p.trim());
  parts.shift(); // authserv-id
  const dkimDomains: string[] = [];
  let dkimRun = true;
  let dkimSeen = false;
  let dmarcSeen = false;
  let spfSeen = false;
  const spfMailfrom: { result: string; domain: string }[] = [];
  for (const part of parts) {
    const m = part.match(/^([a-z0-9_-]+)\s*=\s*([a-z]+)(.*)$/is);
    if (!m) continue;
    const method = m[1].toLowerCase();
    const result = m[2].toLowerCase();
    const props: Record<string, string> = {};
    for (const p of m[3].matchAll(/([a-z0-9_-]+\.[a-z0-9_-]+)\s*=\s*((?:""|[^\s;"])+)/gi)) {
      props[p[1].toLowerCase()] = p[2];
    }
    if (method !== "dkim") dkimRun = false;
    if (method === "dkim") {
      if (!dkimRun) continue;
      if (!dkimSeen) out.dkim = result;
      dkimSeen = true;
      if (result === "pass" && props["header.d"]) {
        const d = domainOf(props["header.d"]);
        if (d) dkimDomains.push(d);
      }
    } else if (method === "dmarc") {
      if (dmarcSeen || spfSeen) continue;
      dmarcSeen = true;
      out.dmarc = result;
      if (props["header.from"]) {
        const d = domainOf(props["header.from"]);
        if (d) out.dmarcFrom = d;
      }
    } else if (method === "spf") {
      spfSeen = true;
      if (props["smtp.mailfrom"] !== undefined) {
        spfMailfrom.push({ result, domain: domainOf(props["smtp.mailfrom"]) });
      }
    }
  }
  if (spfMailfrom.length === 1) {
    out.spf = spfMailfrom[0].result;
    if (out.spf === "pass" && spfMailfrom[0].domain) out.spfDomain = spfMailfrom[0].domain;
  }
  if (dkimDomains.length) out.dkimDomains = dkimDomains;
  return out;
}

/**
 * The in-Worker driver's auth block, read ONLY from the headers CF hands the Worker
 * (`message.headers`), never from the parsed MIME, and only from the FIRST instance of
 * each header (the one CF prepended). The SPF verdict comes from Received-SPF when CF
 * wrote one, else from the Authentication-Results `spf=` entry.
 */
export function authFromHeaders(get: (name: string) => string | null): AuthVerdicts {
  const ar = parseAuthResults(firstHeaderInstance(get("authentication-results")));
  const receivedSpf = firstHeaderInstance(get("received-spf"));
  const spf = receivedSpf ? extractSpfResult(receivedSpf) : ar.spf;
  const out: AuthVerdicts = { spf, dkim: ar.dkim, dmarc: ar.dmarc };
  if (spf === "pass" && ar.spf === "pass" && ar.spfDomain) out.spfDomain = ar.spfDomain;
  if (ar.dkimDomains) out.dkimDomains = ar.dkimDomains;
  if (ar.dmarcFrom) out.dmarcFrom = ar.dmarcFrom;
  return out;
}

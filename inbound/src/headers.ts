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
 * message sits below it and must never be read. Cutting at the first comma can only
 * shorten CF's own instance (CF verdicts carry no comma outside comments), which drops
 * evidence and so fails toward NOT trusted; it can never pull in sender text.
 */
export function firstHeaderInstance(joined: string | null | undefined): string {
  const v = joined ?? "";
  const i = v.indexOf(",");
  return (i < 0 ? v : v.slice(0, i)).trim();
}

/** Remove RFC 5322 comments `( ... )`, nested to a bounded depth. Linear per pass. */
function stripComments(s: string): string {
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/\([^()]*\)/g, " ");
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Domain part of `local@domain` or a bare domain, lower-cased; "" when unusable. */
function domainOf(v: string): string {
  const d = v.replace(/^"|"$/g, "").trim().toLowerCase();
  const at = d.lastIndexOf("@");
  const dom = at >= 0 ? d.slice(at + 1) : d;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom) ? dom : "";
}

/**
 * Parse ONE Authentication-Results instance (RFC 8601): `authserv-id; method=result
 * prop=value ...; ...`. Returns the first verdict per method and the authenticated
 * domains used for alignment.
 */
export function parseAuthResults(instance: string): AuthVerdicts {
  const out: AuthVerdicts = { spf: "none", dkim: "none", dmarc: "none" };
  const parts = stripComments(instance).split(";").map((p) => p.trim());
  parts.shift(); // authserv-id
  const seen = new Set<string>();
  const dkimDomains: string[] = [];
  for (const part of parts) {
    const m = part.match(/^([a-z0-9_-]+)\s*=\s*([a-z]+)(.*)$/i);
    if (!m) continue;
    const method = m[1].toLowerCase();
    const result = m[2].toLowerCase();
    const props: Record<string, string> = {};
    for (const p of m[3].matchAll(/([a-z0-9_-]+\.[a-z0-9_-]+)\s*=\s*("[^"]*"|[^\s;]+)/gi)) {
      props[p[1].toLowerCase()] = p[2];
    }
    if (method === "dkim") {
      if (!seen.has("dkim")) out.dkim = result;
      if (result === "pass" && props["header.d"]) {
        const d = domainOf(props["header.d"]);
        if (d) dkimDomains.push(d);
      }
    } else if (method === "spf" && !seen.has("spf")) {
      out.spf = result;
      if (result === "pass" && props["smtp.mailfrom"]) {
        const d = domainOf(props["smtp.mailfrom"]);
        if (d) out.spfDomain = d;
      }
    } else if (method === "dmarc" && !seen.has("dmarc")) {
      out.dmarc = result;
      if (props["header.from"]) {
        const d = domainOf(props["header.from"]);
        if (d) out.dmarcFrom = d;
      }
    }
    seen.add(method);
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

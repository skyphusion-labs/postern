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
 *  header From. Mirrors ParsedInbound.auth (ingest.ts). `spf` is stored and shown, but
 *  it is NEVER used for trust (see parseAuthResults). */
export interface AuthVerdicts {
  spf: string;
  dkim: string;
  dmarc: string;
  /** `header.d` of every DKIM signature that passed, in the trusted region. */
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
 * own instance (in a value CF echoes from the sender) cuts there too. That only drops
 * evidence, and parseAuthResults voids the whole instance if the cut leaves a quote or
 * comment open, so a cut can never make sender text count as a verdict.
 */
export function firstHeaderInstance(joined: string | null | undefined): string {
  const v = joined ?? "";
  const i = v.indexOf(",");
  return (i < 0 ? v : v.slice(0, i)).trim();
}

/**
 * The structural text of an Authentication-Results region, safe to split on ";", or
 * null when the region is ANOMALOUS. One linear scan:
 *  - a quoted-string ("...", backslash escapes honoured) becomes `""`;
 *  - a comment ( ... ) becomes one space; it nests, honours backslash escapes, and
 *    treats a quoted-string inside it as ATOMIC, so a ")" inside an echoed quoted value
 *    cannot close it;
 *  - an unterminated quote or comment, or a ")" with no open comment, returns null.
 * null voids the whole header: an echo CF did not escape is ambiguous by construction,
 * so a header that does not scan cleanly yields no verdict at all.
 */
export function authResultsText(region: string): string | null {
  let out = "";
  let i = 0;
  const n = region.length;
  // Index just past the quoted-string that starts at `at`, or -1 when unterminated.
  const skipQuoted = (at: number): number => {
    let j = at + 1;
    while (j < n && region[j] !== '"') j += region[j] === "\\" ? 2 : 1;
    return j >= n ? -1 : j + 1;
  };
  while (i < n) {
    const c = region[i];
    if (c === '"') {
      const j = skipQuoted(i);
      if (j < 0) return null;
      out += '""';
      i = j;
    } else if (c === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const d = region[j];
        if (d === "\\") { j += 2; continue; }
        if (d === '"') {
          const k = skipQuoted(j);
          if (k < 0) return null;
          j = k;
          continue;
        }
        if (d === "(") depth++;
        else if (d === ")") depth--;
        j++;
      }
      if (depth > 0) return null;
      out += " ";
      i = j;
    } else if (c === ")") {
      return null;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * A BARE domain (header.d / header.from), lower-cased with one optional trailing dot
 * removed, or null. LDH labels (letters, digits, hyphen; no leading or trailing hyphen;
 * 1-63 chars), at least two, dot-separated, 253 chars or less. Punycode (xn--) is LDH.
 * No "@", no quotes, no local part: CF writes these as bare domains, so anything else
 * is sender text that a balanced quote merged in (round 5) and must void the header.
 */
export function bareDomain(v: string): string | null {
  let d = v.toLowerCase();
  if (d.endsWith(".")) d = d.slice(0, -1);
  if (d.length === 0 || d.length > 253) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) {
    // Length first, so the (bounded) regex only ever sees a 1-63 char label.
    if (l.length < 1 || l.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l)) return null;
  }
  return d;
}

const NO_VERDICT: AuthVerdicts = { spf: "none", dkim: "none", dmarc: "none" };

/** Per method: the results and the property keys an entry may carry. Taken from the
 *  CF shapes observed live (npm via SES, github.com) plus the RFC 8601 / 6376 DKIM keys
 *  CF may emit (header.i, header.a). Anything outside this grammar voids the header. */
const ENTRY_GRAMMAR: Record<string, { results: Set<string>; keys: Set<string> }> = {
  dkim: {
    results: new Set(["pass", "fail", "neutral", "none", "policy", "temperror", "permerror"]),
    keys: new Set(["header.d", "header.i", "header.s", "header.b", "header.a", "reason"]),
  },
  dmarc: {
    results: new Set(["pass", "fail", "none", "bestguesspass", "temperror", "permerror"]),
    keys: new Set(["header.from", "policy.dmarc", "reason"]),
  },
};

/** Keys whose value must be a bare domain; a failing value voids the header. */
const DOMAIN_KEYS = new Set(["header.d", "header.from"]);

/** One `method=result key=value ...` entry, "skip" for a well-formed entry of a method
 *  trust does not read, or null when it breaks the strict grammar: a token that is not
 *  `key=value`, an empty value, a key that appears TWICE, and for dkim / dmarc also an
 *  unknown result, a key outside the method's set, or a header.d / header.from that is
 *  not a bare domain. A duplicate or a non-bare domain is the signature of a balanced
 *  quote or comment that spans entries and merges text (rounds 4 and 5): void, never
 *  override. `reason` (RFC 8601) is allowed and never read. An unknown method is safe to
 *  skip because sender text cannot hold ";", so only CF can create an entry. */
function parseEntry(part: string): { method: string; result: string; props: Record<string, string> } | "skip" | null {
  const tokens = part.split(/\s+/).filter(Boolean);
  const head = (tokens.shift() ?? "").match(/^([a-z0-9_-]+)=([a-z]+)$/i);
  if (!head) return null;
  const method = head[1].toLowerCase();
  const result = head[2].toLowerCase();
  const grammar = ENTRY_GRAMMAR[method];
  if (grammar && !grammar.results.has(result)) return null;
  const props: Record<string, string> = {};
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq <= 0 || eq === t.length - 1) return null;
    const key = t.slice(0, eq).toLowerCase();
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)?$/.test(key) || key in props) return null;
    if (grammar && !grammar.keys.has(key)) return null;
    const value = t.slice(eq + 1);
    if (grammar && DOMAIN_KEYS.has(key)) {
      const d = bareDomain(value);
      if (d === null) return null;
      props[key] = d;
    } else {
      props[key] = value;
    }
  }
  if (!grammar) return "skip";
  return { method, result, props };
}

/**
 * Parse ONE Authentication-Results instance (RFC 8601) for the two legs trust uses:
 * DKIM and DMARC. Fail closed by construction:
 *
 *  1. Read NOTHING at or after the first raw `spf=`. CF writes `dkim=` entries, then
 *     `dmarc=`, then the `spf=` entries, and the SPF entries echo values the SENDER
 *     chose (smtp.helo and smtp.mailfrom, each twice: in a comment and as a value),
 *     unescaped. RFC 5322 comments do not hold quoted-strings, so such an echo cannot be
 *     parsed unambiguously; no rule over the text after `spf=` is safe. The cut is found
 *     in the RAW text, so a sender who plants `spf=` earlier only truncates evidence.
 *     The SPF leg is therefore not read from AR at all; DMARC pass covers an aligned
 *     SPF pass for any domain that publishes DMARC.
 *  2. The region before the cut can still hold sender text (a signature's `header.s` /
 *     `header.d`). It cannot hold ";" (DKIM tag syntax), so it cannot start an entry, but
 *     a balanced quote or comment can SPAN entries. So the region must scan cleanly
 *     (authResultsText), and every entry must fit the strict grammar (parseEntry); any
 *     violation, including a repeated key, voids the whole instance.
 *  3. `dkim` is the FIRST DKIM verdict; `dkimDomains` lists the `header.d` of every
 *     passing signature in the leading dkim run; only the first `dmarc=` counts.
 *
 * RESIDUAL (accepted, tracked): this trusts the FIRST instance because CF prepends its
 * own Authentication-Results to every message it routes (observed live). If CF ever
 * delivered a message without one, a sender-supplied instance would become the first
 * and be read as CF's. An authserv-id check cannot help (it is forgeable); only
 * validating CF's ARC-Seal would remove this reliance. Not built.
 */
export function parseAuthResults(instance: string): AuthVerdicts {
  const cut = instance.search(/spf\s*=/i);
  const region = cut < 0 ? instance : instance.slice(0, cut);
  const text = authResultsText(region);
  if (text === null) return { ...NO_VERDICT };
  const out: AuthVerdicts = { ...NO_VERDICT };
  const parts = text.split(";").map((p) => p.trim());
  parts.shift(); // authserv-id
  const dkimDomains: string[] = [];
  let dkimRun = true;
  let dkimSeen = false;
  let dmarcSeen = false;
  for (const part of parts) {
    if (!part) continue;
    const entry = parseEntry(part);
    if (!entry) return { ...NO_VERDICT };
    if (entry === "skip") {
      dkimRun = false; // conservative: an unknown entry ends the leading dkim run
      continue;
    }
    const { method, result, props } = entry;
    if (method !== "dkim") dkimRun = false;
    if (method === "dkim") {
      if (!dkimRun) continue;
      if (!dkimSeen) out.dkim = result;
      dkimSeen = true;
      if (result === "pass" && props["header.d"]) dkimDomains.push(props["header.d"]);
    } else if (method === "dmarc" && !dmarcSeen) {
      dmarcSeen = true;
      out.dmarc = result;
      if (props["header.from"]) out.dmarcFrom = props["header.from"];
    }
  }
  if (dkimDomains.length) out.dkimDomains = dkimDomains;
  return out;
}

/**
 * The in-Worker driver's auth block, read ONLY from the headers CF hands the Worker
 * (`message.headers`), never from the parsed MIME, and only from the FIRST instance of
 * each header (the one CF prepended). `spf` is the Received-SPF verdict, stored for
 * display only: Received-SPF echoes the same sender-chosen values, so it is never a
 * trust input (isTrusted does not read it).
 */
export function authFromHeaders(get: (name: string) => string | null): AuthVerdicts {
  const ar = parseAuthResults(firstHeaderInstance(get("authentication-results")));
  const receivedSpf = firstHeaderInstance(get("received-spf"));
  const out: AuthVerdicts = { spf: receivedSpf ? extractSpfResult(receivedSpf) : "none", dkim: ar.dkim, dmarc: ar.dmarc };
  if (ar.dkimDomains) out.dkimDomains = ar.dkimDomains;
  if (ar.dmarcFrom) out.dmarcFrom = ar.dmarcFrom;
  return out;
}

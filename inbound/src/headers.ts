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

// MTA-STS policy endpoint (#197, RFC 8461): STARTTLS-stripping resilience for
// INBOUND mail. A cooperating sender fetches this policy over HTTPS before
// delivering to us and then refuses to downgrade off TLS to the listed MX hosts.
//
// Served at GET /.well-known/mta-sts.txt on the mta-sts.<domain> host. The policy
// is assembled from env (MTA_STS_MODE / MTA_STS_MX / MTA_STS_MAX_AGE) so it is
// OPERATOR CONFIG, not a code constant; unset MTA_STS_MODE => the route is dark
// (404) and the feature is off. See docs/MTA-STS.md for the design + the
// load-bearing MX reasoning (our inbound MX is Cloudflare Email Routing, so the
// policy mx: is *.mx.cloudflare.net, NOT our submission door).
//
// ANONYMOUS BY DESIGN: MTA-STS senders fetch this with NO authentication
// (RFC 8461 sec. 3.3). Do NOT add a token gate to this route -- gating it would
// make the policy undiscoverable and silently disable downgrade protection. This
// comment exists so nobody "hardens" it into uselessness.

/** Fully-resolved policy inputs for the pure builder. */
export interface MtaStsParams {
  mode: string; // "testing" | "enforce" | "none"
  mx: string[]; // one or more mx patterns (may be empty ONLY when mode is "none")
  maxAge: number; // seconds a sender caches the policy
}

// RFC 8461 sec. 3.1 policy modes. "none" is the retirement transition (published
// for >= the prior max_age before the DNS record is removed).
const VALID_MODES = new Set(["testing", "enforce", "none"]);

/**
 * Build an RFC 8461 policy file body. Pure + deterministic. LF line endings (the
 * RFC accepts CRLF or LF); a trailing newline keeps the last field well-formed.
 */
export function buildMtaStsPolicy(p: MtaStsParams): string {
  return [
    "version: STSv1",
    `mode: ${p.mode}`,
    ...p.mx.map((m) => `mx: ${m}`),
    `max_age: ${p.maxAge}`,
    "",
  ].join("\n");
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Public, cacheable document; senders additionally cache per max_age.
      "cache-control": status === 200 ? "public, max-age=600" : "no-store",
    },
  });
}

/**
 * GET /.well-known/mta-sts.txt
 *
 * Env-gated + dark by default: returns 404 when MTA_STS_MODE is unset. When set,
 * assembles + serves the policy. A configured-but-invalid policy (bad mode, or
 * missing mx/max_age for an enforcing mode) returns 500 and logs, rather than
 * serving a malformed policy that conforming senders would reject anyway.
 */
export function handleMtaSts(_request: Request, env: Env): Response {
  const mode = (env.MTA_STS_MODE ?? "").trim().toLowerCase();
  if (!mode) {
    // Dark by default: the feature is simply not enabled here.
    return textResponse("not found\n", 404);
  }
  if (!VALID_MODES.has(mode)) {
    console.error("MTA-STS misconfigured: MTA_STS_MODE is not testing|enforce|none");
    return textResponse("misconfigured\n", 500);
  }

  const mx = (env.MTA_STS_MX ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxAge = Number.parseInt((env.MTA_STS_MAX_AGE ?? "").trim(), 10);

  // mx is required for an enforcing/testing policy; RFC 8461 permits it to be
  // omitted only when mode is "none" (retirement). max_age is always required.
  const mxRequired = mode !== "none";
  if ((mxRequired && mx.length === 0) || !Number.isFinite(maxAge) || maxAge <= 0) {
    console.error("MTA-STS misconfigured: MTA_STS_MX and/or MTA_STS_MAX_AGE missing or invalid");
    return textResponse("misconfigured\n", 500);
  }

  return textResponse(buildMtaStsPolicy({ mode, mx, maxAge }), 200);
}

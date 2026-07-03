# MTA-STS + TLSRPT design (RFC 8461 / RFC 8460)

Status: DESIGN, staged. The DNS records and the policy-host deploy are
Conrad-supervised mutations (see the fleet-chezmoi CR). Nothing here mutates
production; this document is the contract the CR implements.

Issue: #197 (edge: implicit-TLS 465 + MTA-STS, STARTTLS-stripping resilience).

## 1. What this defends

STARTTLS is opportunistic: an on-path attacker can strip the `STARTTLS`
capability from the SMTP greeting and force a cooperating sender to deliver in
cleartext. MTA-STS lets a receiving domain publish a policy that says "mail for
me MUST go over TLS to these MX hosts, with a valid matching certificate", so a
conforming sender refuses the downgrade. TLSRPT gives us daily aggregate reports
of successes and failures so we can watch before we enforce.

MTA-STS governs INBOUND mail (mail sent TO us). It has nothing to do with our
submission doors (587/465), which are outbound-from-the-client. The 465
implicit-TLS listener (part 1 of #197) is a separate, complementary control on
the submission side.

## 2. The load-bearing fact: our MX is Cloudflare, not our LB

Postern receives inbound mail through Cloudflare Email Routing. The live MX set
for `skyphusion.org` is:

    14 route1.mx.cloudflare.net.
    50 route2.mx.cloudflare.net.
    51 route3.mx.cloudflare.net.

Therefore the MTA-STS policy `mx:` patterns MUST list the Cloudflare Email
Routing hosts, NOT `smtp.skyphusion.org` (our submission door) and NOT the mail
edge. A sender validates the MX it is about to deliver to against the policy;
listing anything other than the real MX would make every inbound delivery fail
the policy. All Cloudflare Email Routing MX hosts live under `mx.cloudflare.net`
and present valid TLS certificates for their own hostnames, which is exactly
what MTA-STS requires.

We use a single wildcard entry (RFC 8461 sec. 3.1 permits a leading `*.` label),
which matches all three route hosts and is resilient to Cloudflare adding or
retiring a numbered route host:

    mx: *.mx.cloudflare.net

## 3. The three artifacts

### 3.1 Policy file

Served at `https://mta-sts.skyphusion.org/.well-known/mta-sts.txt`, content-type
`text/plain`, over HTTPS with a certificate valid for `mta-sts.skyphusion.org`.
CRLF or LF line endings both accepted by RFC; we serve LF.

Testing phase (ship this first):

    version: STSv1
    mode: testing
    mx: *.mx.cloudflare.net
    max_age: 86400

Enforce phase (flip only after TLSRPT is clean for a full max_age window):

    version: STSv1
    mode: enforce
    mx: *.mx.cloudflare.net
    max_age: 604800

- `mode: testing` -> conforming senders evaluate the policy and REPORT failures
  via TLSRPT but STILL deliver even on a TLS failure. Zero delivery risk; this
  is the bake window.
- `mode: enforce` -> senders refuse to deliver if TLS/cert/MX validation fails.
- `max_age` is how long a sender caches the policy. Short (1 day) during testing
  so we can iterate; long (>= 1 week) at enforce so a transient policy-host
  outage cannot silently drop the policy for the whole sender fleet.

### 3.2 Policy-ID TXT record

    _mta-sts.skyphusion.org.  IN TXT  "v=STSv1; id=<id>"

`id` is an opaque token a sender uses to detect that the policy changed; it MUST
be updated every time the policy file changes, or caches will not refetch.
Convention: a UTC timestamp, e.g. `id=20260703T000000Z`. The concrete id is
stamped when the CR is applied (see the CR checklist), so the TXT id and the
policy file are updated in the same change.

### 3.3 TLSRPT record

    _smtp._tls.skyphusion.org.  IN TXT  "v=TLSRPTv1; rua=mailto:tls-reports@skyphusion.org"

Reports land in the postern mailbox itself (dogfood): route
`tls-reports@skyphusion.org` to the mailbox via Cloudflare Email Routing. This
is the visibility that gates the testing -> enforce flip: no new failure classes
across a full max_age window before enforce.

## 4. Serving the policy (CF-native)

The policy host must answer `GET /.well-known/mta-sts.txt` over HTTPS with a
valid cert for `mta-sts.skyphusion.org`. The CF-native, IaC-first answer is a
tiny dedicated Worker on a route, so the mail-core inbound Worker's surface and
CSP are untouched:

wrangler.toml (dedicated worker, illustrative):

    name = "postern-mta-sts"
    main = "src/index.ts"
    compatibility_date = "2025-01-01"
    routes = [
      { pattern = "mta-sts.skyphusion.org/.well-known/mta-sts.txt", zone_name = "skyphusion.org" }
    ]

src/index.ts:

    const POLICY = [
      "version: STSv1",
      "mode: testing",
      "mx: *.mx.cloudflare.net",
      "max_age: 86400",
      "",
    ].join("\n");

    export default {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname !== "/.well-known/mta-sts.txt") {
          return new Response("not found", { status: 404 });
        }
        return new Response(POLICY, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    };

The policy string is the single source of truth for the mode/max_age; changing
it is a code change + a matching `_mta-sts` id bump, reviewed as one PR. (An
equivalent option is a static route on the inbound Worker under the
`mta-sts.` host; a dedicated worker is preferred to keep the mail-API worker's
attack surface and CSP unchanged. Left to review.)

## 5. Deploy ordering (critical)

The policy host MUST be live and serving a valid policy over HTTPS BEFORE the
`_mta-sts` TXT is published, and the TXT MUST be published BEFORE flipping the
policy to `enforce`. Ordering, per the CR:

1. Deploy `postern-mta-sts` Worker + route; verify
   `curl https://mta-sts.skyphusion.org/.well-known/mta-sts.txt` returns the
   `mode: testing` policy with a valid cert.
2. Publish the TLSRPT TXT (`_smtp._tls`) and route `tls-reports@` to the mailbox.
3. Publish the `_mta-sts` TXT with the initial id (mode still testing).
4. Bake for >= one `max_age` window; confirm TLSRPT shows no new failure class.
5. Flip policy to `mode: enforce` + longer `max_age`, and bump the `_mta-sts`
   id in the same change.

A dangling `_mta-sts` TXT with no reachable policy host, or an `enforce` policy
that lists the wrong MX, breaks inbound mail for conforming senders. Never
publish the TXT ahead of a verified policy host; never flip to enforce on an
unverified MX set.

## 6. Rollback

- Testing mode is delivery-safe by definition; the fast rollback from any
  problem is to leave/return the policy to `mode: testing` (or `mode: none`,
  which disables enforcement) and bump the id.
- `mode: none` published for at least the previous `max_age` cleanly retires
  MTA-STS; removing the DNS records without a `none` transition can leave
  senders enforcing a cached policy until their cache expires.

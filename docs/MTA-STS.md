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

## 4. Serving the policy (CF-native): an env-gated route on the inbound Worker

DECISION (review of PR #213): serve the policy from the EXISTING inbound Worker
as an env-gated static route, NOT a dedicated Worker. Rationale:

- M10 is consolidating Workers (#190 folds `worker/` into `inbound/`); a new
  deploy lane cuts against that direction.
- The attack-surface/CSP argument does not apply here: the route is a static text
  response with no query/body parsing and no shared response headers, so it adds
  zero input surface, and CSP is per-response.
- As an inbound-Worker feature it becomes a real product capability a forker gets
  for free, driven by env, rather than an illustrative second Worker to discover.

The Worker answers `GET /.well-known/mta-sts.txt` on the `mta-sts.<domain>` host
ONLY when the policy env is set; unset = the route is not served (404), so the
feature is dark by default.

Env (operator-configured):

- `MTA_STS_MODE`    -- `testing` | `enforce` | `none` (unset = route disabled).
- `MTA_STS_MX`      -- comma-separated policy `mx:` value(s); for us `*.mx.cloudflare.net`.
- `MTA_STS_MAX_AGE` -- cache lifetime in seconds (e.g. `86400` testing, `604800` enforce).

wrangler route (added to the inbound Worker):

    routes = [
      # ... existing inbound routes ...
      { pattern = "mta-sts.skyphusion.org/.well-known/mta-sts.txt", zone_name = "skyphusion.org" },
    ]

Handler shape (inbound Worker); the body is assembled from env so the policy is
operator config, not a code constant:

    if (url.hostname === "mta-sts.skyphusion.org"
        && url.pathname === "/.well-known/mta-sts.txt") {
      if (!env.MTA_STS_MODE) return new Response("not found", { status: 404 });
      const body = [
        "version: STSv1",
        `mode: ${env.MTA_STS_MODE}`,
        ...env.MTA_STS_MX.split(",").map((mx) => `mx: ${mx.trim()}`),
        `max_age: ${env.MTA_STS_MAX_AGE}`,
        "",
      ].join("\n");
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

Changing the policy (e.g. testing -> enforce) is an env change on the Worker plus
a matching `_mta-sts` id bump, applied together in the supervised window.

The implementation (env-gated route + tests) is a small follow-up postern PR;
once it is deployed, the CR window only has to add the DNS records (including the
proxied `mta-sts` host record that makes the route resolvable) -- no new Worker
to stand up.

NOTED ALTERNATIVE (not chosen): a dedicated `postern-mta-sts` Worker on the same
route. Rejected here for the consolidation + zero-surface reasons above; kept on
record in case the inbound Worker is ever split for unrelated isolation reasons.

## 5. Deploy ordering (critical)

The policy host MUST be live and serving a valid policy over HTTPS BEFORE the
`_mta-sts` TXT is published, and the TXT MUST be published BEFORE flipping the
policy to `enforce`. Ordering, per the CR:

1. Enable the inbound-Worker MTA-STS route (set `MTA_STS_MODE=testing`,
   `MTA_STS_MX=*.mx.cloudflare.net`, `MTA_STS_MAX_AGE=86400`; deployed by the
   follow-up postern PR that adds the route + the proxied `mta-sts` host record).
   Verify `curl https://mta-sts.skyphusion.org/.well-known/mta-sts.txt` returns
   the `mode: testing` policy with a valid cert.
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

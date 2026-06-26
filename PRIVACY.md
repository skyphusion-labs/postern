# Postern Privacy Policy

> **STATUS: DRAFT for review. Not legal advice. Not yet in force.**
> Written by Ernst (Conrad's legal-affairs helper, not a lawyer) and grounded in what the software
> actually does. Conrad signs off before it goes live. Items that need a licensed attorney are
> flagged at the end.

**Last updated:** DRAFT (unpublished)

---

## BLUF (bottom line up front)

We do not want your data. With Postern that is not a slogan, it is a literal fact: **there is no
Postern service that Skyphusion Labs operates for you, so there is nothing for us to collect.**

- **Postern is free software (AGPL-3.0-only) that you run yourself.** You deploy it on your own
  infrastructure (your own Cloudflare account, your own domain), and your mail lives entirely on
  infrastructure YOU control. Skyphusion Labs never sees a byte of it, because your instance never
  talks to us.
- **Skyphusion Labs does not run a hosted, multi-tenant mailbox service.** There is no Postern
  account you create with us, no platform we host your mail on, and no pool of user data we hold.
  We maintain the software; we do not operate it for the public.

## Where your data actually lives (when you self-host)

Postern stores mail in services in **your own** Cloudflare account: messages and full-text search
in your D1 database, attachments in your R2 bucket, and (optionally, if you enable it) embeddings
for semantic recall in your Vectorize index. Inbound mail arrives through your Cloudflare Email
Routing; outbound mail leaves through Cloudflare Email Sending. The optional SMTP/IMAP relay runs
on your own host. In every case the data is held by **you**, the operator of your instance, under
your Cloudflare account's terms, not ours.

## You are the data controller

If you run Postern, you are the data controller for your instance. You decide what mail it
processes, how long it is kept, and who can read it. You are responsible for complying with the
laws that apply to you and your users (for example data-protection, retention, and lawful-access
obligations in your jurisdiction). The AGPL gives you the software; it does not give you a pass on
the law.

## What Postern is built to minimize

The software is designed so that the only data it holds is the mail and the mechanically necessary
metadata to send, receive, search, and thread it. It does no tracking, no profiling, no advertising,
and it does not phone home to Skyphusion Labs. Embeddings (Vectorize) are opt-in. Anything stored is
under the operator's control and is deletable by the operator (your D1 rows, your R2 objects, your
Vectorize vectors are yours to purge).

## Third parties

When you self-host, your mail necessarily transits and is stored by **your** chosen providers
(Cloudflare for transport and storage; any AI Gateway / embedding provider you enable for semantic
recall; your LDAP/PAM source if you wire the relay to one). Those providers process that data under
**your** agreements with them, not under any agreement with Skyphusion Labs. Review their terms;
self-hosting means those choices, and their privacy consequences, are yours.

## Children

Postern is general-purpose mail-server software, not a service directed at children, and Skyphusion
Labs operates no instance. Each operator is responsible for any age-related obligations on their own
instance.

## Changes

Because this describes software behavior rather than a service we run, this policy changes when the
software's data handling changes. Material changes are noted in the changelog and in this file.

## Contact

Questions about the Postern **project** (not about any particular instance, which is the operator's
to answer): open an issue, or for anything sensitive see [SECURITY.md](SECURITY.md). Skyphusion Labs
cannot act on data held in an instance it does not run.

---

## Open items that need a licensed attorney before launch

1. Whether a self-hosted mail server distributed (not operated) by Skyphusion Labs triggers any
   controller/processor characterization for the project itself in any jurisdiction (expected: no,
   because we operate nothing, but confirm).
2. Operator-facing guidance on data-protection / lawful-access duties is intentionally left to each
   operator; confirm we are not implying we assume any of those duties.

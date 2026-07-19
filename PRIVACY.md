# Postern Privacy Policy

> Grounded in what the software actually does. Written by Ernst (Conrad's legal-affairs helper, not a
> lawyer); this is not legal advice.

**Last updated:** 2026-07-10

> The product-wide commitment this policy is written against is
> [`PRIVACY-COMMITMENT.md`](PRIVACY-COMMITMENT.md), a pointer to the canonical copy at the
> constellation hub.

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

## Scope: software, not a service

Skyphusion Labs writes and distributes Postern as software. It does not operate Postern for anyone,
and it will not host mail for anyone; Skyphusion Labs is not an email hosting company. Because
Skyphusion Labs runs no Postern instance, it has no access to any mail or user data, and no
data-controller or data-processor role attaches to the project for a service it does not run.

Running a Postern instance in compliance with the law is the operator's responsibility. Each
operator operates the software in accordance with the laws and regulations of their own jurisdiction
(for example data-protection, retention, and lawful-access duties). This policy describes how the
software behaves; it does not assume any of those duties for Skyphusion Labs.

This document is not legal advice. If you run a mail server, consult a lawyer about the obligations
that apply to you.

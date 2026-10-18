# Security Policy

Postern is self-hosted software: Skyphusion Labs operates no mail service and
holds no user mail; the only instance it runs is the public demo mailbox (see
[PRIVACY.md](PRIVACY.md)). This policy covers vulnerabilities in the Postern
**software**, not incidents on any particular operator instance, which are the
operator to handle. A vulnerability you find through the demo is a software
vulnerability and belongs here.

## Supported

Security fixes land on `main` and ship in the next release. Run a current release.

## Reporting a vulnerability

Please report privately, not in a public issue:

- Preferred: GitHub private vulnerability reporting on this repository
  (**Security -> Report a vulnerability**), which opens a private advisory thread.

Include the affected component (`inbound/`, `relay/`, `mcp/`, `imap/`,
`webmail/`, `clients/python/`), a description, and reproduction steps if you have
them. Please give us a reasonable window to fix and release before public
disclosure. We will acknowledge your report and keep you updated on the fix.

## Scope

In scope: the code in this repository. Out of scope: the configuration, secrets,
DNS, and Cloudflare account of any operator running their own instance; those are
the operator responsibility. If you are an operator with an incident on your own
deployment, this project cannot access or act on data in an instance it does not
run.

Two things are documented defaults, not vulnerabilities: a per-identity agent
credential whose `scopes` include `read` reading mail addressed to every address
on a deployment (README, "What an agent credential can read"), and the published
demo token reading the whole demo mailbox ([PRIVACY.md](PRIVACY.md)). A report is
in scope where the software crosses a boundary it states: a credential changing
mail outside its own bound address, or a webmail cookie session reading beyond
its own person and role queues.

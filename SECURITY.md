# Security Policy

Postern is self-hosted software: Skyphusion Labs operates no instance and holds
no user mail (see [PRIVACY.md](PRIVACY.md)). This policy covers vulnerabilities
in the Postern **software**, not incidents on any particular operator instance,
which are the operator to handle.

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

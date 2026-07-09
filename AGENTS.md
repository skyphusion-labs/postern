# AGENTS.md

See `CLAUDE.md` for the product overview, component map, per-component commands, and
house conventions. `DEPLOY.md` is the clean-install (real Cloudflare) quickstart.

## Cursor Cloud specific instructions

The startup update script already installs all dependencies: `npm ci` in `inbound/`,
`mcp/`; `go mod download` in `relay/`; and a `.venv` per Python component
(`imap/`, `clients/python/`) with the `[dev]` extras. Toolchains (Node 22, Go, Python
3.12 + `python3.12-venv`) are preinstalled in the VM snapshot.

Components and how to work with them (standard commands live in `CLAUDE.md` and each
component's `package.json`/`pyproject.toml`):

- **`inbound/` (core Worker, required).** Lint/test gate: `npm run typecheck` then
  `npm test` (vitest). Run locally with the DEV config, not the prod one:
  `npx wrangler dev --config wrangler.dev.jsonc` (binds local D1 + local R2, no remote
  Cloudflare bindings). There is no `npm run dev` script; use `npx wrangler dev --config wrangler.dev.jsonc`.
- **Stack map:** [docs/architecture.md](docs/architecture.md) (mermaid diagrams for every component).
- **`mcp/` (optional).** `npm run typecheck` + `npm test`.
- **`relay/` (optional, Go).** `go vet ./...` + `go test ./...`.
- **`imap/`, `clients/python/` (optional).** Activate the venv first
  (`. .venv/bin/activate`), then run the tests / `mypy` documented in each README.

### Non-obvious caveats

- **Secrets for `wrangler dev`.** The dev worker needs `POSTERN_API_TOKEN` (mailbox
  API, gates `/api/*`) and `POSTERN_TRANSPORT_TOKEN` (infra seam, gates `/ingest` and
  `/api/smtp-auth`). Wrangler reads these from `inbound/.dev.vars` (gitignored, so it
  is NOT recreated by the update script; create it once per session). Any non-empty
  values work locally, e.g.:
  `printf 'POSTERN_API_TOKEN=dev\nPOSTERN_TRANSPORT_TOKEN=dev\n' > inbound/.dev.vars`.
  The two tokens are deliberately distinct; the transport token gates ingest, the API
  token gates the mailbox API.
- **Seed the local D1 before first use.** A fresh local D1 has no tables. Apply the
  schema once: `npx wrangler d1 execute postern-dev --local --config wrangler.dev.jsonc
  --file=schema.sql` (optionally then `seed.dev.sql` for synthetic demo data). Local
  D1/R2 state lives under `inbound/.wrangler/` (gitignored) and persists across dev
  restarts within a session.
- **No live email locally.** `OUTBOUND_TRANSPORT` defaults to `cf`, so `POST /api/send`
  needs the Cloudflare Email Sending binding, which is absent in `wrangler dev`. To
  exercise the mailbox end-to-end without a Cloudflare account, ingest mail directly:
  `POST /ingest` (Bearer = transport token) writes an inbound message to the store,
  then read it back via `GET /api/messages`, `GET /api/search?q=...`,
  `GET /api/threads/{id}`, or the browser at `/webmail`. The webmail is read-only and
  prompts for the API origin (`http://127.0.0.1:8787`) + the API token.
- **Human doors are API clients, never a second store.** `webmail/` (served by the
  inbound worker at `/webmail`) and the `imap/` proxy read the same API; point them at
  a running `inbound/` origin.
- **Python TLS tests skip by default.** `imap/` TLS/IMAPS tests need the optional
  `.[tls]` extra (pyOpenSSL); they skip cleanly when it is absent (expected).

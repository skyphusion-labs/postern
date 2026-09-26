<!--
Thanks for contributing. Conventions are in CLAUDE.md ("Conventions") and the README.
This is an AGPL-3.0-only project.
-->

## What changed and why

<!-- A sentence or two. The "why" matters more than the "what". -->

## How it was validated

- [ ] `npm run typecheck` passes (`tsc --noEmit`)
- [ ] `npm test` passes (vitest)
- [ ] If the schema changed: a new file under `inbound/migrations/` (never edit an applied one), with `inbound/schema.sql` kept in step
- [ ] If a route was added or renamed: `inbound/src/routes.ts` edited and `npm run routes:emit` re-run in the same commit
- [ ] If a new binding/secret/var is needed: the public template `inbound/wrangler.jsonc` and `DEPLOY.md` were updated

## Checklist

- [ ] No em-dashes or en-dashes (use commas, semicolons, or parentheses)
- [ ] No secrets in the diff (tokens, `.dev.vars`, a real wrangler config, Access JWTs)
- [ ] Did not bump the version or add a CHANGELOG release heading (maintainers cut releases)

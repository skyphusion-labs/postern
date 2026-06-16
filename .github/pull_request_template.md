<!--
Thanks for contributing. See CONTRIBUTING.md for the workflow and conventions.
This is an AGPL-3.0-only project.
-->

## What changed and why

<!-- A sentence or two. The "why" matters more than the "what". -->

## How it was validated

- [ ] `npm run typecheck` passes (`tsc --noEmit`)
- [ ] `npm test` passes (vitest)
- [ ] If schema/migrations changed: a migration was added and `MIGRATIONS.md` updated
- [ ] If a new binding/secret is needed: `wrangler.example.toml` and the README setup were updated

## Checklist

- [ ] No em-dashes or en-dashes (use commas, semicolons, or parentheses)
- [ ] No secrets in the diff (tokens, `.dev.vars`, real `wrangler.toml`, Access JWTs)
- [ ] Did not bump the version or add a CHANGELOG release heading (maintainers cut releases)

# Webmail v2 phase 6 adversarial review (2026-07-18)

Release-gate security review for epic #338 / issue #355.

- **Reviewer:** laptop Cursor (Conrad operator session)
- **Branch / PR:** `feat/355-webmail-phase6-release-gate`
- **Method:** epic #338 checklist exercised as automated proofs in
  `inbound/webmail-adversarial.test.ts`, plus re-verification of prior suites
  (`sanitize-html.test.ts`, `webmail-remote-content.test.ts`, `session.test.ts`,
  `attachments.test.ts`, `draft-attachments.test.ts`). Critical journeys covered
  by Playwright under `webmail/e2e/`.
- **Severity:** critical / high / medium / low / residual. Status: fixed / verified
  already-closed / accepted residual.

## Checklist coverage

| Area | Result | Evidence |
|---|---|---|
| Stored/reflected DOM XSS (headers/body) | Pass | No `innerHTML` of body/subject; sandboxed `srcdoc`; sanitize-html suite |
| Malicious HTML email (inbound + outbound) | Pass | D-HTML-1 sanitize on send; adversarial send store assertion |
| CSS/resource tracking + remote images | Pass (#343 closed) | CSP `img-src 'self' data:`; neutralizeRemoteHtml; no opt-in lie |
| `cid:` / `data:` / `blob:` URL handling | Pass (prior) | sanitize-html + remote-content tests |
| Attachment content-type confusion | Pass | Forced `attachment` disposition, nosniff, sandboxed CSP |
| Session / CSRF / CORS / clickjacking / exfil | Pass | session suite; CSP `frame-ancestors 'none'` + `connect-src 'self'` |
| Draft / folder / attachment IDOR | Fixed (#355) | Session PUT now mirrors IMAP `getDraftOwner` 403; store refuses dual-own |
| Recipient / header injection | Pass | CRLF rejected on send (400) |
| Unauthorized From / spoof | Pass (contract) | Per-identity tokens bind From authoritatively (#28) |
| Resource abuse (attach count / search amp) | Pass (mitigated) | Max 20 attachments; search limit clamped to 200 |
| Scope least-privilege | Pass | Read token cannot send/delete; delete token cannot list |

## Findings

| # | Sev | Finding | Impact | Resolution |
|---|---|---|---|---|
| P6-1 | critical | Session `PUT /api/drafts/{id}` did not check draft ownership before `putDraft`. Cross-identity PUT returned 200 and (under a fake without PK) could dual-own; under real D1 it would PK-fail as 500. IMAP PUT already gated. | Another bound identity could attempt overwrite of a known draft id | **Fixed:** session PUT + IMAP POST create check `getDraftOwner` (403); `putDraft` refuses foreign owner; fake enforces `drafts.id` PK |
| P6-2 | (none) | Spoofed `from` on a registry send token returns 200 | Caller might think spoof worked | **Verified intended:** `#28` authoritative bind; adversarial test asserts outbound From is the bound address |
| P6-3 | medium residual | No per-token rate limit on send/search (Fable C8) | Leaked send token can blast | Accepted residual; tracked pre-#355 roadmap, not a phase-6 ship blocker |
| P6-4 | medium residual | Send/reply lack idempotency keys (Fable C2) | Client retry can double-send | Accepted residual; document at-least-once in CONTRACT |
| P6-5 | low residual | Webmail CSP still requires `script-src`/`style-src 'unsafe-inline'` (single inline app) | XSS relies on no-innerHTML + sandbox | Accepted; asserted in `webmail.test.ts` / #343 truth-up |

## Residual risk (accepted for v2 release)

1. **Inline script/style CSP** -- sole top-frame XSS control remains no-innerHTML + sandboxed srcdoc. Acceptable for the single-file SPA; revisit if the page ever loads third-party script.
2. **No send rate limit** -- operator/token blast radius; follow-up issue territory, not a webmail-v2 gate.
3. **At-least-once send** -- unchanged mailbox semantics.

No other critical/high findings remain open against the phase-6 checklist.

## Commands run

| Command | Result |
|---|---|
| `cd inbound && npx vitest run webmail-adversarial.test.ts` | pass |
| `cd inbound && npm run typecheck` | (run before PR) |
| `cd webmail/e2e && npx playwright test` | (CI + local) |

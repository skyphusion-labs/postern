# Proof: per-identity send (Postern MCP send tools, v1.1)

End-to-end evidence that an agent can send mail **as itself** through the Postern
MCP send tools, and that a send token can only ever send as **its own bound
identity**. Reproducible from this document alone.

The path under proof:

```
agent (MCP client)
  -> mailbox_send / mailbox_reply        (this repo, mcp/, scope "send")
  -> POST /api/send | /api/reply         (inbound worker, skyphusion-email-inbound)
  -> token -> identity registry          (worker hashes the Bearer, looks it up)
  -> From-binding                        (worker STAMPS From = bound identity, then validates + DKIM-signs)
  -> stored outbound row                 (the sent copy, direction = outbound, from_addr = bound identity)
  -> indexed                             (Vectorize + FTS, so it is searchable like any mail)
```

Three independent layers establish the property:

1. **Client gate (this repo, lane C).** The send tools exist at runtime only when a
   send-scoped token is configured; the token is the agent's own. **Section 1.**
2. **Worker From-binding (lane A, Rollins).** The worker resolves the send token to
   one bound identity and OVERRIDES `From` to it, so a token cannot send as anyone
   else. Contract: `docs/SEND-IDENTITIES.md`. **Section 2.**
3. **Live per-identity send (lane B, Strummer).** One real send per identity on the
   live worker, From verified as the token's bound identity, stored outbound and
   indexed. **Section 3.**

---

## 1. Client gate -- CONFIRMED

The MCP server registers the two send tools (`mailbox_send`, `mailbox_reply`)
**only** when `POSTERN_SEND_TOKEN` is present in its env, on a separate client that
uses the send token; the read token is never used on a write route. Absent the send
token, the server is exactly the v1 read server and an agent cannot see or call the
send tools (`mcp/src/index.ts`, `mcp/src/tools.ts`: `registerTools` skips any tool
whose scope the configured credentials do not satisfy).

### How to reproduce

From `mcp/`, after `npm run build`:

```bash
npm run smoke
```

`scripts/stdio-smoke.mjs` boots the built `dist/index.js` over a real stdio
JSON-RPC transport, runs `initialize` + `tools/list`, and asserts the tool surface
against the configured scope. No network is dialed (the URL/token are dummies); this
is a boot/registration check.

### Observed (verbatim)

Boot WITHOUT a send token (`POSTERN_SEND_TOKEN` unset/empty):

```
postern-mcp: ready (4 tools: mailbox_search, mailbox_list, mailbox_get, mailbox_thread) -> https://example.invalid
```

Boot WITH a send token (`POSTERN_SEND_TOKEN=send-dummy`):

```
postern-mcp: send tools ENABLED (POSTERN_SEND_TOKEN present) -- mutating mail capability is live
postern-mcp: ready (6 tools: mailbox_search, mailbox_list, mailbox_get, mailbox_thread, mailbox_send, mailbox_reply) -> https://example.invalid
```

`npm run smoke` result:

```
ok   read-only server exposes exactly the read tools: ["mailbox_get","mailbox_list","mailbox_search","mailbox_thread"]
ok   send-enabled server exposes read + send tools: ["mailbox_get","mailbox_list","mailbox_reply","mailbox_search","mailbox_send","mailbox_thread"]
ok   startup notice: 'send tools ENABLED' present on stderr
SMOKE PASSED
```

The same gate is unit-covered: `test/send-tools.test.ts` (registration gate) and
`test/send.test.ts` (the send/reply client calls), part of the 36-test suite
(`npm test`).

**Conclusion:** the send capability is opt-in by construction. An agent gets the
send tools only by being handed a send token; that token is the agent's own.

---

## 2. Worker From-binding (token -> identity) -- CONTRACT

Authoritative contract: **`docs/SEND-IDENTITIES.md`** (the per-identity send registry
ICD, merged in #138), with the scope table in `docs/AUTH-CONTRACT.md` section 7. The
MCP client does not implement any of this; it forwards a composed message and the
worker is authoritative. Summary of what the client relies on:

- **Registry, not per-token secrets.** One worker secret `POSTERN_SEND_IDENTITIES`
  maps the lowercase **sha256 hex of the raw token** to `{ from, displayName? }`. It
  stores hashes, never raw tokens. Operators register an identity by editing the
  secret; no code change (`docs/SEND-IDENTITIES.md` sections 3, 7).
- **Two-stage resolution** (`inbound/src/api.ts` `resolveToken`,
  `inbound/src/sendidentity.ts`): the static scope tokens (`both`/`read`/`send`) are
  tried first, constant-time; only on no static match does the worker hash the
  presented Bearer and look it up in the registry. A hit grants `send` scope **plus**
  the bound identity; a miss is `401`.
- **Authoritative From OVERRIDE.** On `POST /api/send` and `POST /api/reply`, a
  registry token makes the worker **stamp** `From = bound identity`, discarding any
  caller-supplied `from`. The client need not send a `from` at all. The stamped
  address still flows through the same `ALLOWED_FROM_DOMAIN` / shape / CRLF
  validation, so a misconfigured bound From fails loud, never a silent bad send
  (`docs/SEND-IDENTITIES.md` section 4). This differs from the 587 relay path, which
  *rejects* `From != mail`; the worker-direct path is authoritative-stamp.
- **Stored + indexed.** The stored outbound row's `from_addr` is the bound identity's
  email, lowercased (e.g. `joan@skyphusion.org`) -- the same address put on the wire
  and DKIM-signed (the `displayName` is header-only, not stored in `from_addr`). The
  sent copy is threaded and indexed: outbound mail is always indexed into Vectorize,
  and FTS covers it, so "who sent it" in the store equals the bound identity.

### Failure modes (deny-by-default)

| Condition | Result |
|---|---|
| Token not static and not in the registry | `401 { "ok": false, "error": "unauthorized" }` |
| Registry (send) token on a READ route (`GET` messages/search/threads) | `403 { "ok": false, "error": "forbidden", "message": "requires read scope" }` |
| Registry token on an ADMIN route (smtp-credentials / reindex / reconcile) | `403 { "ok": false, "error": "forbidden", "message": "requires admin scope" }` |
| Registry entry `from` off `ALLOWED_FROM_DOMAIN` | **as of #139 (merged, `4dae5e4`):** the entry is dropped at parse, so its token resolves to `401` at the gate; the send-time `403 { "ok": false, "error": "E_SENDER_NOT_ALLOWED", "message": "from address must be on @skyphusion.org" }` is kept as a second layer. Either way, nothing sent. |

Success shape: `200 { "ok": true, "messageId": "...", "threadId": "...", "providerMessageId": "..." }`.

> Defense in depth: as of #139 (merged, `4dae5e4`), the off-domain case is denied
> **at the gate** -- the off-domain entry is dropped at parse, so its token resolves
> to `401`, with the send-time `403 E_SENDER_NOT_ALLOWED` kept as a second layer. The
> happy path (a valid `@skyphusion.org` identity) is unaffected, so the client docs
> and this proof do not change.

The MCP client surfaces the worker's `{ error, message }` verbatim on a 400/401/403
as an MCP `isError` result (`mcp/src/client.ts`), so an agent sees the real reason
(e.g. `requires read scope`) rather than a thrown exception.

---

## 3. Live per-identity send -- PROVEN (lane B, Strummer)

The immediate live worker-level per-identity send proof was run by Strummer (lane B),
who held the four freshly-minted raw tokens this session. A mid-session agent env has
no send token until a fresh login-shell relaunch, so the loopback was driven directly
against the live worker with each raw token. Internal `@skyphusion.org` loopback only,
nothing external.

Worker state at proof time: resolver #138 deployed green on `skyphusion-email-inbound`;
`POSTERN_SEND_IDENTITIES` registered with each member's `sha256hex(token) -> { from }`
(joan's token -> `from = joan@skyphusion.org`, displayName "Joan").

**Method.** Per token, `POST /api/send` with a *spoofed* on-domain `from` -- a
DIFFERENT crew member's `@skyphusion.org` address -- to internal
`loopback-test@skyphusion.org`, then read the stored outbound copy back and assert the
`From` was overridden to the token's own bound identity.

**Results** (spoofed `from` -> stored outbound `From`):

| Token | Spoofed `from` (caller-supplied) | Stored outbound `From` | Verdict |
|---|---|---|---|
| mackaye | `rollins@skyphusion.org` | `mackaye@skyphusion.org` | PASS |
| strummer | `joan@skyphusion.org` | `strummer@skyphusion.org` | PASS |
| rollins | `mackaye@skyphusion.org` | `rollins@skyphusion.org` | PASS |
| joan | `strummer@skyphusion.org` | `joan@skyphusion.org` | PASS |
| (negative) bogus / unknown token | -- | -- | `401` PASS |

**Why the on-domain spoof matters.** Each spoofed `from` was itself a valid
`@skyphusion.org` address, so it would pass `ALLOWED_FROM_DOMAIN` on its own. The
worker still overrode it to the token's bound identity. So the per-identity From
override is authoritative over the CALLER even for a plausible same-domain spoof: a
token sends ONLY as itself. That is the whole thesis -- openness (everyone sends) AND
accountability (as themselves) in one mechanism. The stored `From` equalling the bound
identity is the load-bearing assertion: it is both the wire From (DKIM-signed) and the
stored/threaded `from_addr`, which is the field that gets indexed.

Per-message `messageId` / `threadId` are in Strummer's lane-B run log and readable back
via the read MCP (`mailbox_search` for `loopback-test@skyphusion.org` / the outbound
copies); the security-critical assertions (correct bound From per token, on-domain
spoof override, unknown-token `401`) are the table above.

---

## 4. Toolbelt activation milestone (crew refresh, D)

Sections 1 and 3 prove the two halves independently: the client gate registers the
send tools when a send token is present (Section 1), and the live worker binds From to
the token's identity (Section 3). The remaining step joins them in a real agent
toolbelt: each agent calling `mailbox_send` **as itself** from its own session. That
is the lane-C closeout at the crew refresh -- the **client-path reconfirmation**.

The gate, per Strummer (lane B):

1. crew-secrets #29 merges (adds each member's per-identity `secrets-send-<member>.env.age`,
   encrypted to that member alone; `load.sh` sources it).
2. On the member's account: `chezmoi update && chezmoi apply` places the encrypted send
   file at `~/.config/crew/`.
3. Claude Code restarts from a fresh login shell, so `.bashrc -> load.sh` exports
   `POSTERN_SEND_TOKEN`, and Claude Code expands `${POSTERN_SEND_TOKEN}` into the
   `postern` MCP server env at spawn (`~/.claude.json` holds the literal
   `"${POSTERN_SEND_TOKEN}"`, never the raw token).

After relaunch, the lane-C reconfirmation is: the v1.1 send tools register (Section 1's
gate, now with the real token present), and a `mailbox_send` to an internal
`@skyphusion.org` address lands `From = joan@skyphusion.org` (Section 2's binding),
stored outbound and indexed. The transport + registry underneath are already green
(Section 3), so a registered tool that sends as the bound identity is the whole proof.

A session started before its token was provisioned has no send token in env, so its
send tools stay dormant until relaunch -- the gate working as designed, not a bug.

---

## References

- `mcp/README.md` -- the send tools, the scope gate, per-identity wiring.
- `mcp/src/tools.ts` -- `SEND_TOOLS` + `registerTools` (the client scope gate).
- `mcp/src/index.ts` -- send tools register only when `POSTERN_SEND_TOKEN` is set.
- `mcp/src/client.ts` -- forwards the composed message; surfaces worker errors verbatim.
- `mcp/scripts/stdio-smoke.mjs` -- the boot-level gate proof (Section 1).
- `docs/SEND-IDENTITIES.md` -- the per-identity send registry ICD (worker contract).
- `docs/AUTH-CONTRACT.md` section 7 -- worker token scopes (#85).

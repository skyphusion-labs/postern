# Integrating callers

Two ways to reach Postern. Same-account Workers use the service binding (no
token, no public hop). Everything else uses the public HTTPS endpoint with the
`POSTERN_API_TOKEN` bearer.

## Same-account Worker (service binding)

Bind to the `MailboxService` RPC entrypoint on the deployed Worker (use your own
Worker name from `inbound/wrangler.jsonc`):

```jsonc
// caller wrangler.jsonc
{
  "services": [
    {
      "binding": "MAILBOX",
      "service": "postern",
      "entrypoint": "MailboxService"
    }
  ]
}
```

Legacy send-only consumers may keep an `EmailService` binding on the same worker
(repoint `"service"` from the retired `postern-send` worker; entrypoint unchanged):

```jsonc
{ "binding": "EMAIL", "service": "postern", "entrypoint": "EmailService" }
```

After editing the binding, regenerate types: `npx wrangler types`.

Then send from anywhere in the worker:

```typescript
const { messageId } = await env.MAILBOX.send({
  to: user.email,
  subject: "Your render is ready",
  html: `<p>Project <strong>${name}</strong> finished rendering.</p>`,
  text: `Project ${name} finished rendering.`,
  // from defaults to DEFAULT_FROM; override within ALLOWED_FROM_DOMAIN:
  // from: { email: "renders@your-domain", name: "Renders" },
});
```

`send()` throws on failure; the thrown error carries `.code` (an `E_*` string)
and `.message`. Wrap in try/catch and log the code. The RPC entrypoint also
exposes `reply`, `get`, `thread`, `list`, and `search`, mirroring the HTTP API.

## External callers (public HTTPS endpoint)

`POST https://<your-worker>.<account>.workers.dev/api/send` with
`Authorization: Bearer <POSTERN_API_TOKEN>`. Body is the same shape as `send()`:

```bash
curl https://<your-worker>.<account>.workers.dev/api/send \
  -H "Authorization: Bearer $POSTERN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "dev@example.com",
    "subject": "Build green",
    "text": "main is green."
  }'
```

`POST /send` stays as a back-compat alias of `/api/send`.

Responses:

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{"ok":true,"messageId":"..."}` | Sent |
| 400 | `{"ok":false,"error":"E_...","message":"..."}` | Bad request, do not retry |
| 401 | `{"ok":false,"error":"unauthorized"}` | Missing/wrong bearer token |
| 413 | `{"ok":false,"error":"E_PAYLOAD_TOO_LARGE","message":"..."}` | Body exceeds the size cap |
| 502 | `{"ok":false,"error":"E_...","message":"..."}` | Transient upstream, retry with backoff |

## Reading the store

The read endpoints take the same bearer token:

```bash
# list / filter (q = full-text over subject + body)
curl "https://<your-worker>.<account>.workers.dev/api/messages?direction=inbound&q=invoice&limit=20" \
  -H "Authorization: Bearer $POSTERN_API_TOKEN"

# one message + attachment metadata
curl "https://<your-worker>.<account>.workers.dev/api/messages/<messageId>" \
  -H "Authorization: Bearer $POSTERN_API_TOKEN"

# attachment bytes (i = 0-based index into the message's attachments[])
curl "https://<your-worker>.<account>.workers.dev/api/messages/<messageId>/attachments/0" \
  -H "Authorization: Bearer $POSTERN_API_TOKEN" -OJ

# search (mode = fts | semantic | hybrid; semantic/hybrid need the AI+Vectorize bindings)
curl "https://<your-worker>.<account>.workers.dev/api/search?q=invoice&mode=fts" \
  -H "Authorization: Bearer $POSTERN_API_TOKEN"

# a full thread, ordered by date
curl "https://<your-worker>.<account>.workers.dev/api/threads/<threadId>" \
  -H "Authorization: Bearer $POSTERN_API_TOKEN"
```

## Request fields (send / reply)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `to` | string \| string[] | yes (send) | Recipient(s) |
| `subject` | string | yes (send) | |
| `html` / `text` | string | one required | Include both for deliverability |
| `from` | string \| `{email,name}` | no | Defaults to `DEFAULT_FROM`; must be on `ALLOWED_FROM_DOMAIN` |
| `replyTo` | string \| `{email,name}` | no | |
| `cc` / `bcc` | string \| string[] | no | to+cc+bcc <= 50 |
| `headers` | object | no | String values only; CR/LF rejected (no header injection) |

`POST /api/reply` takes `{ messageId, html?, text? }`; core fills `to`,
`subject` (`Re:`), `In-Reply-To`, `References`, and the `thread_id` from the
stored message, so a reply cannot be pointed at an arbitrary thread.

# Integrating callers

Two ways to reach the email worker. Same-account Workers use the service
binding (no token, no public hop). Everything else uses the public HTTPS
endpoint with the shared `RELAY_TOKEN`.

## skyphusion-llm-public (service binding)

Add a service binding pointing at the `EmailService` RPC entrypoint:

```jsonc
// skyphusion-llm-public wrangler.jsonc
{
  "services": [
    {
      "binding": "EMAIL",
      "service": "skyphusion-email",
      "entrypoint": "EmailService"
    }
  ]
}
```

After editing the binding, regenerate types: `npx wrangler types`.

Then send from anywhere in the worker:

```typescript
const { messageId } = await env.EMAIL.send({
  to: user.email,
  subject: "Your render is ready",
  html: `<p>Project <strong>${name}</strong> finished rendering.</p>`,
  text: `Project ${name} finished rendering.`,
  // from defaults to noreply@skyphusion.net; override within @skyphusion.net:
  // from: { email: "renders@skyphusion.net", name: "Vivijure" },
});
```

`send()` throws on failure; the thrown error carries `.code` (an `E_*` string)
and `.message`. Wrap in try/catch and log the code.

## External callers (public HTTPS endpoint)

`POST https://skyphusion-email.<account>.workers.dev/send` with
`Authorization: Bearer <RELAY_TOKEN>`. Body is the same shape as `send()`:

```bash
curl https://skyphusion-email.<account>.workers.dev/send \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "dev@example.com",
    "subject": "Build green",
    "text": "main is green."
  }'
```

Responses:

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{"ok":true,"messageId":"..."}` | Sent |
| 400 | `{"ok":false,"error":"E_...","message":"..."}` | Bad request, do not retry |
| 401 | `{"ok":false,"error":"unauthorized"}` | Missing/wrong bearer token |
| 502 | `{"ok":false,"error":"E_...","message":"..."}` | Transient upstream, retry with backoff |

## Request fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `to` | string \| string[] | yes | Recipient(s) |
| `subject` | string | yes | |
| `html` / `text` | string | one required | Include both for deliverability |
| `from` | string \| `{email,name}` | no | Defaults to `DEFAULT_FROM`; must be `@skyphusion.net` |
| `replyTo` | string \| `{email,name}` | no | |
| `cc` / `bcc` | string \| string[] | no | to+cc+bcc <= 50 |
| `headers` | object | no | Whitelisted headers only |

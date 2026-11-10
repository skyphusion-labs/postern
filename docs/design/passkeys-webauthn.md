# Passkeys (WebAuthn) sign-in: design note

Status: **design note only (#792). Nothing here is built.** It is written so a later
sprint can build passkeys without inventing a second account model. It extends
`docs/design/webmail-v2-contracts.md` section 1 (sessions) and 1.10 (human accounts).
Where this note and that contract disagree, the contract wins until this note is
ratified and folded in.

## 1. What a passkey is here, and what it is not

A passkey is a **second way to prove you are an existing user**. It is not a new kind of
user:

- A passkey belongs to ONE `smtp_credentials` row (the user). It never creates a user
  and never carries its own identity, caps or From.
- A passkey sign-in mints the SAME session `POST /api/session` mints (contract 1.5): the
  same cookie custody, CSRF, caps (`NATIVE_SESSION_CAPS`), windows, revocation, and the
  1.10.3 rule that a session lives only while its account is enabled.
- The password stays. This note does not make accounts passwordless (decision
  D-PASSKEY-2 below). Recovery is therefore the existing operator reset.
- Passkeys follow the backend rule (contract 1.10.6, decision D-AUTH-3): every passkey
  route exists only when `WEBMAIL_AUTH_BACKEND` is explicitly `native`. Unset or `off`
  means no passkey routes, the same as no password sign-in, so a release that adds
  passkeys never opens a sign-in surface on an existing deploy.

## 2. Why it is worth building

- **Phishing resistance.** A WebAuthn assertion is bound to the origin by the browser. A
  look-alike page cannot replay it. Passwords cannot offer this.
- **No shared secret on the server.** The server stores a PUBLIC key. A leaked database
  yields nothing that signs in.
- **Fits the privacy stance.** With attestation `none` the server learns no device make or
  model. The sign-in is between the user, their authenticator and their own deploy.

## 3. Zero-dependency verification on a Worker

The house rule is near-zero runtime dependencies. A full WebAuthn library brings a CBOR
decoder, COSE key parsing and attestation-format code. We avoid all of it:

- **Registration** uses the browser's `AuthenticatorAttestationResponse.getPublicKey()`
  (SPKI DER) and `getPublicKeyAlgorithm()` (COSE alg id), part of WebAuthn Level 2. The
  Worker imports the SPKI with Web Crypto (`crypto.subtle.importKey("spki", ...)`). With
  attestation `none` the attestation statement carries no trust anyway, so there is
  nothing in the CBOR `attestationObject` the server must verify. A browser without
  `getPublicKey()` cannot register a passkey; it falls back to the password. That is an
  honest limit, not a silent one.
- **authenticatorData** (both ceremonies) is a FIXED binary layout, not CBOR: 32-byte
  `rpIdHash`, 1 flags byte, 4-byte big-endian `signCount`, then optional data. A bounded
  hand-written parser reads only those first 37 bytes.
- **clientDataJSON** is JSON.
- **Signature check**: Web Crypto `verify` over `authenticatorData || sha256(clientDataJSON)`.
  Supported algs: ES256 (-7, ECDSA P-256; the signature arrives DER-encoded and is
  converted to the raw r||s form Web Crypto expects) and Ed25519 (-8). RS256 (-257) only
  if a real authenticator in use needs it. Any other alg is refused at registration.

## 4. Storage (one additive migration)

```sql
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id TEXT PRIMARY KEY,   -- base64url of the raw credential id
  username      TEXT NOT NULL,      -- the owning smtp_credentials.username
  public_key    TEXT NOT NULL,      -- base64 SPKI DER
  alg           INTEGER NOT NULL,   -- COSE alg id (-7, -8)
  sign_count    INTEGER NOT NULL DEFAULT 0,
  backed_up     INTEGER NOT NULL DEFAULT 0,  -- BS flag: a synced passkey
  name          TEXT,               -- user-chosen label ("laptop"), shown in the list
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_username ON webauthn_credentials(username);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_hash TEXT PRIMARY KEY,  -- sha256hex; the raw challenge is never stored
  purpose        TEXT NOT NULL,     -- "register" | "authenticate"
  username       TEXT,              -- set for register; NULL for authenticate
  expires_at     TEXT NOT NULL      -- 5 minutes
);
```

Deleting a user deletes its passkeys in the same admin call (the user delete, 1.10.4,
gains one statement). A challenge is deleted when it is used, so it is single-use, and a
sweep removes expired ones.

## 5. Routes (all same-origin; the 1.6 `Sec-Fetch-Site`/`Origin` rule applies)

Registration (a signed-in user adds a passkey to their own account):

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/api/session/passkeys/options` | session + CSRF + `{currentPassword}` | step-up re-auth (throttled on the sign-in keys, 1.10.5), then a creation challenge |
| POST | `/api/session/passkeys` | session + CSRF | verify and store; `{name?}` |
| GET | `/api/session/passkeys` | session | list own passkeys (id, name, created, last used, synced) |
| DELETE | `/api/session/passkeys/{id}` | session + CSRF | remove one of OWN passkeys |

Sign-in (no session yet):

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/api/session/passkey/options` | none | an assertion challenge with EMPTY `allowCredentials` |
| POST | `/api/session/passkey` | the assertion | verify, then mint the session exactly as `POST /api/session` |

Operator: `GET /api/admin/users/{u}/passkeys` and `DELETE /api/admin/users/{u}/passkeys/{id}`
(admin scope). A disabled user cannot sign in with a passkey, because the assertion
checks the account and the session re-checks it (1.10.3).

Creation options: `rp.id` = the request host (override `WEBAUTHN_RP_ID` for a deploy
that serves webmail on a subdomain of the mail domain), `user.id` = 32 random bytes kept
on the account (not the username, so the authenticator stores no address),
`residentKey: "required"`, `userVerification: "required"`, `attestation: "none"`,
`pubKeyCredParams` = ES256 and Ed25519 only, `excludeCredentials` = the user's own ids.

## 6. Verification steps (sign-in)

1. Look up and DELETE the challenge by `sha256(clientData.challenge)`; missing, expired
   or wrong purpose fails.
2. `clientData.type` is `webauthn.get`; `clientData.origin` EQUALS the request origin
   exactly (no suffix match); `crossOrigin` is not true.
3. `rpIdHash` equals `sha256(rp.id)`; flags have UP and UV set.
4. Find the credential by id; its account exists and is enabled.
5. Verify the signature with the stored key and alg.
6. Sign count: if both the stored and the presented counts are non-zero, the presented
   count MUST be greater. Otherwise refuse and log a possible cloned authenticator.
   Synced passkeys report 0, so 0 is accepted.
7. Update `sign_count`, `last_used_at`; mint the session.

Every failure answers ONE `401 E_AUTH_FAILED`.

## 7. Threats

| Threat | Answer |
|---|---|
| Phishing | Origin-bound assertion; exact origin and rpIdHash checks (6.2, 6.3). |
| Replay | Single-use, hashed, 5-minute challenge (6.1). |
| Username enumeration | Discoverable credentials and empty `allowCredentials`: the sign-in never takes a username, so it cannot leak one. One error for every failure. |
| Brute force | There is no secret to guess. The options and assertion routes still go through `auththrottle` on `i:<ip>` (plus `a:<username>` once a credential id resolves) so they cannot become a cheap D1 load lever. |
| Account takeover through a stolen session | Adding a passkey needs a fresh password check (step-up), so a stolen cookie alone cannot plant a persistent credential. |
| CSRF | Registration and removal need the session-bound CSRF header plus same-origin. |
| Cloned authenticator | Sign-count regression is refused (6.6). |
| Device fingerprinting | Attestation `none`; no AAGUID is stored. |
| Offboarding | Disable and delete stop passkey sign-in (5); delete removes the keys. |

## 8. Decisions for signoff

| id | Decision | Recommendation |
|---|---|---|
| D-PASSKEY-1 | Step-up (current password) before adding a passkey? | **Yes.** It is the one control that stops a stolen session from becoming a permanent credential. |
| D-PASSKEY-2 | Allow passwordless accounts (passkey only)? | **Not in the first build.** It needs a recovery story that is not "the operator resets a password", and a decision on what the SMTP and IMAP doors (which cannot do WebAuthn) authenticate with. |
| D-PASSKEY-3 | Accept browsers without `getPublicKey()` by adding a CBOR/COSE parser? | **No.** Every current major browser has it. A parser is the dependency (or the hand-rolled attack surface) this design exists to avoid. |

## 9. Test plan for the build

Against the real sqlite harness, plus golden vectors recorded once from real
authenticators (ES256 from a platform authenticator, Ed25519 from a security key):

- A good assertion signs in, and the session is a normal native session.
- Each of 6.1 to 6.6 refuses on its own (wrong origin, wrong rpIdHash, UV missing, reused
  challenge, expired challenge, disabled account, bad signature, sign-count regression).
- A stolen session cannot add a passkey without the password (step-up).
- Unknown credential id and bad signature answer byte-identical bodies.
- Mutation pass: removing each check turns its test red.

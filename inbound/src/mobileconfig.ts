// Per-user Apple .mobileconfig generator (#187, follow-up to #180).
//
// iOS Mail has NO DNS/HTTP autodiscovery for a generic IMAP account; Apple's one
// supported one-tap path is a downloadable configuration profile. This module
// emits a prefilled per-user profile for the Postern mailbox:
//   - Incoming:  IMAP  <imapHost>:993 over TLS (implicit SSL)
//   - Outgoing:  SMTP  <smtpHost>:587 with STARTTLS
// NO password is ever baked in: iOS prompts the user on install. That is why the
// route is READ-scoped (it emits configuration text, never a secret) and why the
// profile is safe to hand out / cache-bust per user.
//
// STARTTLS-on-587 note: the com.apple.mail.managed payload has NO separate
// STARTTLS key. `*UseSSL = true` tells iOS to secure the link; iOS then picks the
// mechanism by port -- implicit TLS on 993, STARTTLS on 587. So UseSSL=true on
// BOTH servers is the correct, documented way to express "993 SSL + 587 STARTTLS".
//
// Identifier strategy (deliberate, see #187 review): the PayloadUUIDs are minted
// fresh per generation (a distinct profile instance each download), but the
// PayloadIdentifiers are STABLE per user (derived from the email address). iOS
// keys profile REPLACEMENT on PayloadIdentifier, so a reinstall cleanly REPLACES
// the user's existing Postern profile instead of stacking a duplicate mailbox on
// the device -- the correct on-device behavior for Conrad's #180 verification.

// Standard mailbox ports. 993 = IMAPS (implicit TLS); 587 = submission (STARTTLS).
// Fixed per the #187 spec (not operator-tunable); revisit if a deployment needs
// 465 implicit-TLS submission (tracked separately under #197).
const IMAP_PORT = 993;
const SMTP_PORT = 587;

// Bound how much caller-supplied text can land in the emitted plist, so a
// pathological query cannot inflate the profile. 254 is the RFC 5321 max email
// length; display name gets the same ceiling.
const MAX_FIELD = 254;

/** Fully-resolved inputs for the pure builder. UUIDs are injected so the builder
 * is deterministic and unit-testable; the handler mints them per generation. */
export interface MobileconfigParams {
  emailAddress: string; // the user's mailbox address (EmailAddress)
  username: string; // IMAP/SMTP login username (often the same as the address)
  displayName: string; // account display name (EmailAccountName), e.g. the user's full name
  imapHost: string;
  smtpHost: string;
  organization: string; // PayloadOrganization label
  identifierPrefix: string; // reverse-DNS base for PayloadIdentifier, e.g. "org.example.postern"
  profileUUID: string; // top-level PayloadUUID (minted per generation)
  emailPayloadUUID: string; // the mail payload's PayloadUUID (minted per generation)
}

// Escape text for XML 1.0 element content. `&` MUST be replaced first. Control
// characters that are illegal in XML 1.0 (everything below U+0020 except tab, LF,
// CR, plus DEL) are stripped: they would make the whole plist unparseable and iOS
// would reject the profile. A display name can be arbitrary UTF-8, which XML
// permits once these five metacharacters are escaped.
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// A reverse-DNS-ish slug for a PayloadIdentifier segment: lowercase, non
// [a-z0-9] runs collapsed to a single hyphen, trimmed. Stable for a given
// address, so the profile identifier is stable per user.
function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "user";
}

/**
 * Build a well-formed Apple configuration profile (.mobileconfig) as a plist XML
 * string. Pure and deterministic: every dynamic field is XML-escaped, and the two
 * UUIDs are taken from `params` (the handler injects freshly-minted ones).
 */
export function buildMobileconfig(params: MobileconfigParams): string {
  const email = xmlEscape(params.emailAddress);
  const username = xmlEscape(params.username);
  const display = xmlEscape(params.displayName);
  const imapHost = xmlEscape(params.imapHost);
  const smtpHost = xmlEscape(params.smtpHost);
  const org = xmlEscape(params.organization);

  // Identifiers are derived from the (unescaped) inputs, then escaped for output.
  // The prefix is operator config; the per-user segment is a slug of the address.
  const profileId = xmlEscape(`${params.identifierPrefix}.${slug(params.emailAddress)}`);
  const emailPayloadId = xmlEscape(`${params.identifierPrefix}.${slug(params.emailAddress)}.email`);
  const profileUUID = xmlEscape(params.profileUUID);
  const emailPayloadUUID = xmlEscape(params.emailPayloadUUID);

  // NOTE: no Incoming/OutgoingPassword keys -> iOS prompts on install.
  // OutgoingPasswordSameAsIncomingPassword=true so the user is prompted once.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadType</key>
			<string>com.apple.mail.managed</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>PayloadIdentifier</key>
			<string>${emailPayloadId}</string>
			<key>PayloadUUID</key>
			<string>${emailPayloadUUID}</string>
			<key>PayloadDisplayName</key>
			<string>${email}</string>
			<key>EmailAccountType</key>
			<string>EmailTypeIMAP</string>
			<key>EmailAccountName</key>
			<string>${display}</string>
			<key>EmailAccountDescription</key>
			<string>${email}</string>
			<key>EmailAddress</key>
			<string>${email}</string>
			<key>IncomingMailServerAuthentication</key>
			<string>EmailAuthPassword</string>
			<key>IncomingMailServerHostName</key>
			<string>${imapHost}</string>
			<key>IncomingMailServerPortNumber</key>
			<integer>${IMAP_PORT}</integer>
			<key>IncomingMailServerUseSSL</key>
			<true/>
			<key>IncomingMailServerUsername</key>
			<string>${username}</string>
			<key>OutgoingMailServerAuthentication</key>
			<string>EmailAuthPassword</string>
			<key>OutgoingMailServerHostName</key>
			<string>${smtpHost}</string>
			<key>OutgoingMailServerPortNumber</key>
			<integer>${SMTP_PORT}</integer>
			<key>OutgoingMailServerUseSSL</key>
			<true/>
			<key>OutgoingMailServerUsername</key>
			<string>${username}</string>
			<key>OutgoingPasswordSameAsIncomingPassword</key>
			<true/>
			<key>SMIMEEnabled</key>
			<false/>
		</dict>
	</array>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadIdentifier</key>
	<string>${profileId}</string>
	<key>PayloadUUID</key>
	<string>${profileUUID}</string>
	<key>PayloadDisplayName</key>
	<string>${org} Mail (${email})</string>
	<key>PayloadDescription</key>
	<string>Configures Mail for ${email}</string>
	<key>PayloadOrganization</key>
	<string>${org}</string>
</dict>
</plist>
`;
}

// Email shape check (linear, no ReDoS), mirroring api.ts / mailbox.ts.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;

/**
 * GET /api/mobileconfig?user=<addr>&username=<login>&name=<display>
 *
 * Read-scoped (emits no secret). Validates the address, resolves the imap/smtp
 * hostnames from Env (domain-derived defaults, operator-overridable), mints the
 * per-generation UUIDs, and returns the profile with the Apple config MIME type.
 */
export function handleMobileconfig(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const p = url.searchParams;

  const emailRaw = (p.get("user") ?? "").trim().slice(0, MAX_FIELD);
  if (!emailRaw) {
    return json({ ok: false, error: "E_FIELD_MISSING", message: "user (email address) is required" }, 400);
  }
  const email = emailRaw.toLowerCase();
  const allowedDomain = (env.ALLOWED_FROM_DOMAIN || "skyphusion.org").toLowerCase();
  if (!EMAIL_RE.test(email) || email.split("@")[1] !== allowedDomain) {
    return json(
      { ok: false, error: "E_VALIDATION_ERROR", message: `user must be a valid address on @${allowedDomain}` },
      400,
    );
  }

  // Login username defaults to the address (Postern's LDAP door accepts the full
  // address); a caller may override it. Display name defaults to the address.
  const username = ((p.get("username") ?? "").trim() || email).slice(0, MAX_FIELD);
  const displayName = ((p.get("name") ?? "").trim() || email).slice(0, MAX_FIELD);

  const imapHost = (env.MOBILECONFIG_IMAP_HOST || `imap.${allowedDomain}`).trim();
  const smtpHost = (env.MOBILECONFIG_SMTP_HOST || `smtp.${allowedDomain}`).trim();
  const organization = (env.MOBILECONFIG_ORG || env.DEFAULT_FROM_NAME || "Postern").trim();
  const identifierPrefix = (
    env.MOBILECONFIG_IDENTIFIER || `${allowedDomain.split(".").reverse().join(".")}.postern`
  ).trim();

  const xml = buildMobileconfig({
    emailAddress: email,
    username,
    displayName,
    imapHost,
    smtpHost,
    organization,
    identifierPrefix,
    // Uppercase by Apple convention; minted fresh per generation.
    profileUUID: crypto.randomUUID().toUpperCase(),
    emailPayloadUUID: crypto.randomUUID().toUpperCase(),
  });

  const filename = email.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "postern";
  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/x-apple-aspen-config; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}.mobileconfig"`,
      // Per-user config, no intermediary caching.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// Local JSON helper mirroring api.ts's (kept private so this module has no import
// cycle with api.ts). Matches the { ok, error, message } error envelope.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

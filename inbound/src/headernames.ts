// Caller-supplied header NAMES on a send (SendRequest.headers -> OutboundMessage.headers).
// ONE rule for every transport, mirrored by the relay (relay/smtp_transport.go):
//
//  - a name must be an RFC 5322 field-name: printable US-ASCII 33-126 except ":"
//    (section 3.6.8). Anything else lets a name smuggle a second header onto the wire
//    (`From: x (` + `: )` renders as a full From line);
//  - a name is at most MAX_HEADER_NAME_LENGTH (76) characters (RFC 5322 recommends short
//    names; 76 keeps a name plus ": " inside the 78-character line advice);
//  - a caller may not set a header postern owns: identity and addressing (From, Sender,
//    To, Cc, Bcc, Reply-To, Return-Path, Resent-*), trace and authentication results
//    (Received, Received-SPF, Authentication-Results, ARC-*, DKIM-Signature), message
//    identity and framing (Message-ID, Date, Subject, MIME-Version, Content-*). The From
//    binding of a per-identity token is only a guarantee if nothing else can name a
//    sender or claim a verdict.
//
// Parity with the Go relay is tested against one table: relay/testdata/header_names.json.

const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

export const MAX_HEADER_NAME_LENGTH = 76;

const RESERVED = new Set([
  "from", "sender", "to", "cc", "bcc", "reply-to", "return-path", "received",
  "received-spf", "authentication-results", "dkim-signature",
  "message-id", "date", "subject", "mime-version",
]);

/** Why a caller header name is refused, or null when it may be sent. */
export function headerNameProblem(name: string): string | null {
  if (!FIELD_NAME.test(name)) return "is not a valid header field name";
  if (name.length > MAX_HEADER_NAME_LENGTH) return `is longer than ${MAX_HEADER_NAME_LENGTH} characters`;
  const k = name.toLowerCase();
  if (RESERVED.has(k) || k.startsWith("content-") || k.startsWith("resent-") || k.startsWith("arc-")) {
    return "is set by postern and cannot be supplied";
  }
  return null;
}

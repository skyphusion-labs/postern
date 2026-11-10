// Caller-supplied header NAMES on a send (SendRequest.headers -> OutboundMessage.headers).
// ONE rule for every transport, mirrored by the relay (relay/smtp_transport.go):
//
//  - a name must be an RFC 5322 field-name: printable US-ASCII 33-126 except ":"
//    (section 3.6.8). Anything else lets a name smuggle a second header onto the wire
//    (`From: x (` + `: )` renders as a full From line);
//  - a caller may not set a header postern owns: identity and addressing (From, Sender,
//    To, Cc, Bcc, Reply-To, Return-Path, Resent-*), trace (Received), message identity
//    and framing (Message-ID, Date, Subject, MIME-Version, Content-*). The From binding
//    of a per-identity token is only a guarantee if nothing else can name a sender.

const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

const RESERVED = new Set([
  "from", "sender", "to", "cc", "bcc", "reply-to", "return-path", "received",
  "message-id", "date", "subject", "mime-version",
]);

/** Why a caller header name is refused, or null when it may be sent. */
export function headerNameProblem(name: string): string | null {
  if (!FIELD_NAME.test(name)) return "is not a valid header field name";
  const k = name.toLowerCase();
  if (RESERVED.has(k) || k.startsWith("content-") || k.startsWith("resent-")) {
    return "is set by postern and cannot be supplied";
  }
  return null;
}

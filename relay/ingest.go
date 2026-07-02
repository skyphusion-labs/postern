package main

import (
	"encoding/base64"
	"net/mail"
	"strings"

	"github.com/jhillyerd/enmime"
)

// ParsedInbound is the inbound transport contract (docs/CONTRACT.md section 2).
// Every inbound transport normalizes the message it received into this one shape
// and hands it to core's ingest() (here: via POST /ingest). Field names and JSON
// tags map 1:1 to the TS ParsedInbound so the seam stays traceable.
//
// Locked v1 decisions (CONTRACT section 8): attachment bytes travel base64-encoded
// over JSON in content; the transport (not the API) token gates /ingest.
type ParsedInbound struct {
	MessageID   string          `json:"messageId,omitempty"` // raw Message-ID without <>; core normalizes
	From        string          `json:"from"`                // envelope/header From
	To          string          `json:"to"`                  // the delivered-to recipient
	Subject     string          `json:"subject,omitempty"`
	Date        string          `json:"date,omitempty"` // ISO; core defaults to now if empty
	InReplyTo   string          `json:"inReplyTo,omitempty"`
	References  []string        `json:"references,omitempty"`
	Text        string          `json:"text,omitempty"`
	HTML        string          `json:"html,omitempty"` // core derives body_text from text, else stripped html
	Attachments []InboundAttach `json:"attachments,omitempty"`
	Auth        *InboundAuth    `json:"auth,omitempty"` // SMTP transport may omit

	// Envelope fidelity v2 (CONTRACT section 10.4, #189). All optional and
	// wire-compatible: an old relay omits them and core treats each as absent.
	// These carry RAW DECODED header strings straight from enmime GetHeader --
	// NEVER parsed or re-formatted into address lists, because a display name may
	// contain a comma. To (above) keeps its v1 meaning: THE delivered-to envelope
	// recipient, which owns the envelope-semantics role in core.
	ToHeader string `json:"toHeader,omitempty"` // raw decoded To header; core stores it as to_addr
	CC       string `json:"cc,omitempty"`       // raw decoded Cc header
	Sender   string `json:"sender,omitempty"`   // raw decoded Sender header
	ReplyTo  string `json:"replyTo,omitempty"`  // raw decoded Reply-To header
	RawSize  int    `json:"rawSize,omitempty"`  // RFC822 wire byte size as received
}

// InboundAttach carries one attachment. content is base64 of the raw bytes
// (CONTRACT section 8: "stream bytes for v1, base64-encoded over JSON"); core
// decodes to an ArrayBuffer before storing in R2.
type InboundAttach struct {
	Filename string `json:"filename,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	Content  string `json:"content"` // base64 of the raw bytes
}

// InboundAuth mirrors ParsedInbound.auth. The relay receives plain SMTP with no
// CF auth verdicts, so these are normally absent; core falls back to its
// allowlist-only trust path when the auth block is omitted.
type InboundAuth struct {
	SPF   string `json:"spf,omitempty"`
	DKIM  string `json:"dkim,omitempty"`
	DMARC string `json:"dmarc,omitempty"`
}

// buildParsedInbound turns an SMTP envelope + parsed MIME into a ParsedInbound.
//
//   - recipient (To) comes from the FIRST envelope RCPT TO (the real
//     delivered-to), not the headers.
//   - From prefers the header From, falling back to the envelope MAIL FROM.
//   - the relay does not invent auth verdicts: it leaves Auth nil so core
//     applies its allowlist-only trust logic for header-stripped intake.
//   - rawSize is the RFC822 wire byte size as received (len of the raw DATA
//     stream), carried so core can serve RFC822.SIZE honestly (CONTRACT 10.4).
//   - the envelope-fidelity headers (To/Cc/Sender/Reply-To) are carried RAW and
//     decoded via GetHeader, never parsed into address lists.
func buildParsedInbound(rcpts []string, mailFrom string, rawSize int, env *enmime.Envelope) ParsedInbound {
	to := ""
	if len(rcpts) > 0 {
		to = rcpts[0]
	}

	from := firstAddress(env.GetHeader("From"))
	if from == "" {
		from = mailFrom
	}

	p := ParsedInbound{
		MessageID:  stripAngles(env.GetHeader("Message-ID")),
		From:       from,
		To:         to,
		Subject:    env.GetHeader("Subject"),
		Date:       parseDateISO(env.GetHeader("Date")),
		InReplyTo:  stripAngles(env.GetHeader("In-Reply-To")),
		References: parseReferences(env.GetHeader("References")),
		Text:       env.Text,
		HTML:       env.HTML,
		// Envelope fidelity v2 (CONTRACT 10.4): raw decoded headers, never parsed.
		// omitempty drops any header that was absent, so core sees them as absent.
		ToHeader: env.GetHeader("To"),
		CC:       env.GetHeader("Cc"),
		Sender:   env.GetHeader("Sender"),
		ReplyTo:  env.GetHeader("Reply-To"),
		RawSize:  rawSize,
	}

	// Carry every non-body MIME part (attachments + inlines + other parts) via the
	// shared collector so this intake seam and the submission seam cannot drift on
	// what survives (#184). Fidelity of bytes is the contract.
	for _, part := range collectMIMEParts(env) {
		p.Attachments = append(p.Attachments, InboundAttach{
			Filename: part.FileName,
			MimeType: part.ContentType,
			Content:  base64.StdEncoding.EncodeToString(part.Content),
		})
	}

	return p
}

// stripAngles removes surrounding angle brackets and whitespace from a header
// value like "<id@host>" -> "id@host". Multiple ids are not expected here.
func stripAngles(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "<")
	s = strings.TrimSuffix(s, ">")
	return strings.TrimSpace(s)
}

// parseReferences splits a References header (whitespace/CRLF-separated
// <id> tokens) into bare ids, in order. Returns nil when empty.
func parseReferences(header string) []string {
	header = strings.TrimSpace(header)
	if header == "" {
		return nil
	}
	var out []string
	for _, f := range strings.Fields(header) {
		if id := stripAngles(f); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// parseDateISO normalizes an RFC 5322 Date header to RFC 3339 (ISO 8601).
// Returns "" when the header is missing or unparseable, so core defaults to now.
func parseDateISO(header string) string {
	header = strings.TrimSpace(header)
	if header == "" {
		return ""
	}
	t, err := mail.ParseDate(header)
	if err != nil {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

package main

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"sort"
	"strings"
	"time"
)

// SMTPTransport sends OutboundMessages through a bring-your-own upstream SMTP
// server (CONTRACT section 3, the #28 "not locked into CF" escape hatch). It uses
// only the standard library net/smtp so the relay stays dependency-free.
type SMTPTransport struct {
	cfg         SMTPOutCfg
	defaultFrom string
}

// NewSMTPTransport builds an SMTPTransport. defaultFrom is the envelope MAIL FROM
// used when an OutboundMessage somehow carries no From (core normally fills it).
func NewSMTPTransport(cfg SMTPOutCfg, defaultFrom string) *SMTPTransport {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	if cfg.Port == 0 {
		cfg.Port = 587
	}
	return &SMTPTransport{cfg: cfg, defaultFrom: defaultFrom}
}

// Dispatch builds the RFC 5322 message and delivers it to the upstream SMTP
// server. The returned providerMessageId is the message's own Message-ID (the
// stdlib smtp client surfaces no server id), so threading stays stable.
func (t *SMTPTransport) Dispatch(msg OutboundMessage) (DispatchResult, error) {
	rcpts := msg.recipients()
	if len(rcpts) == 0 {
		return DispatchResult{}, fmt.Errorf("no recipients")
	}

	mailFrom := msg.From.Email
	if mailFrom == "" {
		mailFrom = t.defaultFrom
	}
	if mailFrom == "" {
		return DispatchResult{}, fmt.Errorf("no From address and no POSTERN_OUTBOUND_FROM fallback")
	}

	// Validate the envelope MAIL FROM and every RCPT TO as well-formed addresses
	// before they reach the SMTP conversation. A bare address must contain no
	// CR/LF or stray control characters; SMTP command smuggling and message
	// injection both start here.
	if _, err := parseHeaderAddress(mailFrom); err != nil {
		return DispatchResult{}, fmt.Errorf("invalid envelope From %q: %w", mailFrom, err)
	}
	for _, r := range rcpts {
		if _, err := parseHeaderAddress(r); err != nil {
			return DispatchResult{}, fmt.Errorf("invalid recipient %q: %w", r, err)
		}
	}

	raw, err := renderMIME(msg, mailFrom)
	if err != nil {
		return DispatchResult{}, fmt.Errorf("render message: %w", err)
	}

	if err := t.send(mailFrom, rcpts, raw); err != nil {
		return DispatchResult{}, err
	}
	return DispatchResult{ProviderMessageID: msg.MessageID}, nil
}

// send opens the SMTP conversation (optionally STARTTLS + PLAIN auth) and writes
// the message. Split out so the wire steps are clear and the dial is timeout-bound.
func (t *SMTPTransport) send(from string, rcpts []string, raw []byte) error {
	addr := net.JoinHostPort(t.cfg.Host, fmt.Sprintf("%d", t.cfg.Port))

	conn, err := net.DialTimeout("tcp", addr, t.cfg.Timeout)
	if err != nil {
		return fmt.Errorf("dial %s: %w", addr, err)
	}
	_ = conn.SetDeadline(time.Now().Add(t.cfg.Timeout))

	c, err := smtp.NewClient(conn, t.cfg.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp handshake: %w", err)
	}
	defer c.Close()

	if t.cfg.StartTLS {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(&tls.Config{ServerName: t.cfg.Host}); err != nil {
				return fmt.Errorf("starttls: %w", err)
			}
		} else {
			return fmt.Errorf("upstream %s does not advertise STARTTLS (set SMTP_OUT_STARTTLS=false to allow plaintext)", t.cfg.Host)
		}
	}

	if t.cfg.Username != "" {
		auth := smtp.PlainAuth("", t.cfg.Username, t.cfg.Password, t.cfg.Host)
		if err := c.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}

	if err := c.Mail(from); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	for _, r := range rcpts {
		if err := c.Rcpt(r); err != nil {
			return fmt.Errorf("RCPT TO %s: %w", r, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}
	if _, err := w.Write(raw); err != nil {
		return fmt.Errorf("write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close DATA: %w", err)
	}
	return c.Quit()
}

// renderMIME produces the RFC 5322 message bytes for an OutboundMessage.
// text-only -> text/plain; html-only -> text/html; both -> multipart/alternative.
//
// Every header value derived from caller input is validated or sanitized before
// it is written: address headers (From/To/Cc/Reply-To) are parsed as RFC 5322
// addresses and re-rendered from the parsed result, so a malformed value (CR/LF,
// extra headers, command smuggling) is rejected rather than emitted; text headers
// (Subject/Message-ID/custom) have CR/LF stripped. This is what breaks the
// go/email-injection taint flow into the SMTP DATA write.
func renderMIME(msg OutboundMessage, mailFrom string) ([]byte, error) {
	var b bytes.Buffer

	fromHdr, err := formatAddress(msg.From, mailFrom)
	if err != nil {
		return nil, fmt.Errorf("invalid From: %w", err)
	}
	writeHeader(&b, "From", fromHdr)

	toHdr, err := headerAddressList(msg.To)
	if err != nil {
		return nil, fmt.Errorf("invalid To: %w", err)
	}
	writeHeader(&b, "To", toHdr)

	if len(msg.CC) > 0 {
		ccHdr, err := headerAddressList(msg.CC)
		if err != nil {
			return nil, fmt.Errorf("invalid Cc: %w", err)
		}
		writeHeader(&b, "Cc", ccHdr)
	}
	// BCC is intentionally never written as a header (envelope-only).
	if msg.ReplyTo != nil && msg.ReplyTo.Email != "" {
		replyHdr, err := formatAddress(*msg.ReplyTo, "")
		if err != nil {
			return nil, fmt.Errorf("invalid Reply-To: %w", err)
		}
		writeHeader(&b, "Reply-To", replyHdr)
	}
	writeHeader(&b, "Subject", mime.QEncoding.Encode("utf-8", sanitizeHeader(msg.Subject)))
	if msg.MessageID != "" {
		writeHeader(&b, "Message-ID", "<"+sanitizeHeader(msg.MessageID)+">")
	}
	writeHeader(&b, "Date", time.Now().UTC().Format(time.RFC1123Z))
	writeHeader(&b, "MIME-Version", "1.0")

	// Reply threading + any caller-supplied headers, sorted for determinism.
	keys := make([]string, 0, len(msg.Headers))
	for k := range msg.Headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if isReservedHeader(k) {
			continue // never let arbitrary headers override the ones we set
		}
		writeHeader(&b, sanitizeHeader(k), sanitizeHeader(msg.Headers[k]))
	}

	// Body: text/plain, text/html, or multipart/alternative (both). With
	// attachments (#92) that body becomes the first part of a multipart/mixed and
	// the attachment parts follow it.
	if len(msg.Attachments) > 0 {
		if err := writeMixed(&b, msg); err != nil {
			return nil, err
		}
		return b.Bytes(), nil
	}
	if err := writeBodyEntity(&b, msg); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// writeBodyEntity writes the message body as a self-contained MIME entity (its own
// Content-Type [+ Content-Transfer-Encoding] header lines, a blank line, then the
// encoded body) to w. Written straight after the top-level headers it IS the
// message body; written into a multipart/mixed part it is the body part. Byte for
// byte identical to the previous inline body for the no-attachment case.
func writeBodyEntity(w io.Writer, msg OutboundMessage) error {
	switch {
	case msg.HTML != "" && msg.Text != "":
		mw := multipart.NewWriter(w)
		if _, err := io.WriteString(w, "Content-Type: multipart/alternative; boundary="+mw.Boundary()+"\r\n\r\n"); err != nil {
			return err
		}
		if err := writeQPPart(mw, "text/plain; charset=utf-8", msg.Text); err != nil {
			return err
		}
		if err := writeQPPart(mw, "text/html; charset=utf-8", msg.HTML); err != nil {
			return err
		}
		return mw.Close()
	case msg.HTML != "":
		if _, err := io.WriteString(w, "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quotedprintable\r\n\r\n"); err != nil {
			return err
		}
		return writeQP(w, msg.HTML)
	default:
		if _, err := io.WriteString(w, "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quotedprintable\r\n\r\n"); err != nil {
			return err
		}
		return writeQP(w, msg.Text)
	}
}

// writeMixed wraps the body + attachments in a multipart/mixed entity (#92). The
// boundary is written manually (consistent with the file's manual-header style) so
// the body entity, which may itself be a nested multipart/alternative, can be
// embedded verbatim as the first part without the CreatePart header-ownership clash.
func writeMixed(b *bytes.Buffer, msg OutboundMessage) error {
	boundary := newBoundary()
	writeHeader(b, "Content-Type", "multipart/mixed; boundary="+boundary)
	b.WriteString("\r\n")

	// Part 1: the body entity (text / html / alternative).
	b.WriteString("--" + boundary + "\r\n")
	if err := writeBodyEntity(b, msg); err != nil {
		return err
	}
	b.WriteString("\r\n")

	// Parts 2..N: one per attachment.
	for i, att := range msg.Attachments {
		b.WriteString("--" + boundary + "\r\n")
		if err := writeAttachmentPart(b, att, i); err != nil {
			return err
		}
		b.WriteString("\r\n")
	}

	b.WriteString("--" + boundary + "--\r\n")
	return nil
}

// writeAttachmentPart writes one attachment as a MIME entity: a validated
// Content-Type + Content-Disposition, base64 Content-Transfer-Encoding, and the
// re-wrapped base64 body. The wire content is base64; it is DECODED here (which
// validates it) then re-encoded in 76-char lines so no single line can exceed the
// SMTP line-length limit. The filename is sanitized to a quote/CRLF-free token and
// the media type to RFC-2045 token chars, so neither can inject a header or break
// the parameter quoting.
func writeAttachmentPart(w io.Writer, att OutboundAttachment, index int) error {
	data, err := decodeBase64(att.Content)
	if err != nil {
		return fmt.Errorf("attachment %d: invalid base64 content: %w", index, err)
	}

	name := safeAttachmentName(att.Filename, index)
	ctype := safeMediaType(att.MimeType)

	if _, err := io.WriteString(w, "Content-Type: "+ctype+"; name=\""+name+"\"\r\n"); err != nil {
		return err
	}
	if _, err := io.WriteString(w, "Content-Disposition: attachment; filename=\""+name+"\"\r\n"); err != nil {
		return err
	}
	if _, err := io.WriteString(w, "Content-Transfer-Encoding: base64\r\n\r\n"); err != nil {
		return err
	}
	return writeBase64Wrapped(w, data)
}

// newBoundary returns a fresh RFC-2046 boundary token (30 hex chars from
// multipart.Writer, used here only as a generator).
func newBoundary() string {
	return multipart.NewWriter(io.Discard).Boundary()
}

// decodeBase64 strips ASCII whitespace (some clients wrap base64) then decodes with
// standard padded base64, the encoding the worker / btoa produces.
func decodeBase64(s string) ([]byte, error) {
	clean := strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\r', '\n':
			return -1
		}
		return r
	}, s)
	return base64.StdEncoding.DecodeString(clean)
}

// writeBase64Wrapped writes data as standard base64 in 76-char lines (RFC 2045).
func writeBase64Wrapped(w io.Writer, data []byte) error {
	const lineLen = 76
	enc := base64.StdEncoding.EncodeToString(data)
	for len(enc) > 0 {
		n := lineLen
		if n > len(enc) {
			n = len(enc)
		}
		if _, err := io.WriteString(w, enc[:n]+"\r\n"); err != nil {
			return err
		}
		enc = enc[n:]
	}
	return nil
}

// safeAttachmentName reduces a filename to a quote/CRLF/control-free token
// ([A-Za-z0-9._-], others -> _), capped at 100 chars, defaulting to
// "attachment-<index>" when empty. Mirrors the read-API download sanitization so a
// filename can never inject a header or break the name="..." parameter quoting.
func safeAttachmentName(name string, index int) string {
	mapped := strings.Map(func(r rune) rune {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r == '.' || r == '_' || r == '-':
			return r
		default:
			return '_'
		}
	}, name)
	if len(mapped) > 100 {
		mapped = mapped[:100]
	}
	if mapped == "" {
		return fmt.Sprintf("attachment-%d", index)
	}
	return mapped
}

// safeMediaType returns the attachment's media type if it is a well-formed type
// of RFC-2045 token characters, else application/octet-stream. Rejecting anything
// else keeps a stray quote / semicolon / CR-LF out of the Content-Type header.
func safeMediaType(mt string) string {
	const fallback = "application/octet-stream"
	mt = strings.TrimSpace(mt)
	if mt == "" {
		return fallback
	}
	parsed, _, err := mime.ParseMediaType(mt)
	if err != nil || !isTokenMediaType(parsed) {
		return fallback
	}
	return parsed
}

// isTokenMediaType reports whether s is "type/subtype" of RFC-2045 token chars.
func isTokenMediaType(s string) bool {
	slash := strings.IndexByte(s, '/')
	if slash <= 0 || slash == len(s)-1 {
		return false
	}
	for _, r := range s {
		if r == '/' {
			continue
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case strings.ContainsRune("!#$&-^_.+", r):
		default:
			return false
		}
	}
	return true
}

func writeQPPart(mw *multipart.Writer, contentType, body string) error {
	h := textproto.MIMEHeader{}
	h.Set("Content-Type", contentType)
	h.Set("Content-Transfer-Encoding", "quotedprintable")
	pw, err := mw.CreatePart(h)
	if err != nil {
		return err
	}
	qp := quotedprintable.NewWriter(pw)
	if _, err := qp.Write([]byte(body)); err != nil {
		return err
	}
	return qp.Close()
}

func writeQP(w io.Writer, body string) error {
	qp := quotedprintable.NewWriter(w)
	if _, err := qp.Write([]byte(body)); err != nil {
		return err
	}
	return qp.Close()
}

func writeHeader(b *bytes.Buffer, key, value string) {
	b.WriteString(key)
	b.WriteString(": ")
	b.WriteString(value)
	b.WriteString("\r\n")
}

// parseHeaderAddress validates a single address. It rejects anything that is not
// a well-formed RFC 5322 address (which inherently rejects embedded CR/LF and
// header/command injection) and additionally rejects any residual control
// characters as defense in depth. It returns the parsed, canonical address.
func parseHeaderAddress(addr string) (*mail.Address, error) {
	if strings.ContainsAny(addr, "\r\n") || hasControlRunes(addr) {
		return nil, fmt.Errorf("address contains control characters")
	}
	a, err := mail.ParseAddress(addr)
	if err != nil {
		return nil, err
	}
	// The parsed address itself must be control-char free (paranoia: a display
	// name could in theory carry one through some inputs).
	if strings.ContainsAny(a.Address, "\r\n") || hasControlRunes(a.Address) {
		return nil, fmt.Errorf("parsed address contains control characters")
	}
	return a, nil
}

// headerAddressList validates each address and re-renders the list from the
// parsed results, so the emitted header can only ever contain canonical,
// CR/LF-free addresses. Any malformed entry rejects the whole message.
func headerAddressList(addrs []string) (string, error) {
	if len(addrs) == 0 {
		return "", fmt.Errorf("empty address list")
	}
	parts := make([]string, 0, len(addrs))
	for _, raw := range addrs {
		a, err := parseHeaderAddress(raw)
		if err != nil {
			return "", fmt.Errorf("%q: %w", raw, err)
		}
		// a.String() emits a safe, RFC-5322-encoded form (Q-encoding any display
		// name, angle-bracketing the address); it never contains a bare CR/LF.
		parts = append(parts, a.String())
	}
	return strings.Join(parts, ", "), nil
}

// hasControlRunes reports whether s contains any ASCII control character
// (below 0x20, excluding the tab it never needs) or DEL. Used to reject
// smuggling attempts that a lenient parser might otherwise let through.
func hasControlRunes(s string) bool {
	for _, r := range s {
		if r == '\t' {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// formatAddress renders an EmailAddress as a validated header value, falling back
// to the envelope From when no address is set. It parses the resulting address so
// a malformed email or display name is rejected, not emitted.
func formatAddress(a EmailAddress, fallback string) (string, error) {
	email := a.Email
	if email == "" {
		email = fallback
	}
	parsed, err := parseHeaderAddress(email)
	if err != nil {
		return "", err
	}
	out := EmailAddress{Email: parsed.Address, Name: a.Name}
	// Build through mail.Address so the rendered form is always canonical and
	// CR/LF-free; the display name is Q-encoded by Address.String().
	ma := mail.Address{Name: sanitizeHeader(out.Name), Address: out.Email}
	rendered := ma.String()
	if strings.ContainsAny(rendered, "\r\n") {
		return "", fmt.Errorf("rendered address contains control characters")
	}
	return rendered, nil
}

// sanitizeHeader strips CR and LF so a value can never inject another header or
// terminate the header block early (header-injection defense for non-address
// header values like Subject and custom headers).
func sanitizeHeader(v string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(v)
}

// isReservedHeader reports whether a caller-supplied header name collides with
// one the renderer sets itself. Comparison is case-insensitive.
func isReservedHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "from", "to", "cc", "bcc", "reply-to", "subject", "message-id",
		"date", "mime-version", "content-type", "content-transfer-encoding":
		return true
	}
	return false
}

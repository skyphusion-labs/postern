package main

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
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
// Header values are sanitized so a caller cannot inject extra headers via CR/LF.
func renderMIME(msg OutboundMessage, mailFrom string) ([]byte, error) {
	var b bytes.Buffer

	writeHeader(&b, "From", formatAddress(msg.From, mailFrom))
	writeHeader(&b, "To", strings.Join(msg.To, ", "))
	if len(msg.CC) > 0 {
		writeHeader(&b, "Cc", strings.Join(msg.CC, ", "))
	}
	// BCC is intentionally never written as a header (envelope-only).
	if msg.ReplyTo != nil && msg.ReplyTo.Email != "" {
		writeHeader(&b, "Reply-To", formatAddress(*msg.ReplyTo, ""))
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

	switch {
	case msg.HTML != "" && msg.Text != "":
		mw := multipart.NewWriter(&b)
		writeHeader(&b, "Content-Type", "multipart/alternative; boundary="+mw.Boundary())
		b.WriteString("\r\n")
		if err := writeQPPart(mw, "text/plain; charset=utf-8", msg.Text); err != nil {
			return nil, err
		}
		if err := writeQPPart(mw, "text/html; charset=utf-8", msg.HTML); err != nil {
			return nil, err
		}
		if err := mw.Close(); err != nil {
			return nil, err
		}
	case msg.HTML != "":
		writeHeader(&b, "Content-Type", "text/html; charset=utf-8")
		writeHeader(&b, "Content-Transfer-Encoding", "quotedprintable")
		b.WriteString("\r\n")
		if err := writeQP(&b, msg.HTML); err != nil {
			return nil, err
		}
	default:
		writeHeader(&b, "Content-Type", "text/plain; charset=utf-8")
		writeHeader(&b, "Content-Transfer-Encoding", "quotedprintable")
		b.WriteString("\r\n")
		if err := writeQP(&b, msg.Text); err != nil {
			return nil, err
		}
	}

	return b.Bytes(), nil
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

func writeQP(b *bytes.Buffer, body string) error {
	qp := quotedprintable.NewWriter(b)
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

// formatAddress renders an EmailAddress as a header value, falling back to the
// envelope From when no address is set.
func formatAddress(a EmailAddress, fallback string) string {
	email := a.Email
	if email == "" {
		email = fallback
	}
	email = sanitizeHeader(email)
	if a.Name == "" {
		return email
	}
	return mime.QEncoding.Encode("utf-8", sanitizeHeader(a.Name)) + " <" + email + ">"
}

// sanitizeHeader strips CR and LF so a value can never inject another header or
// terminate the header block early (header-injection defense).
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

package main

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net/mail"
	"strings"

	"github.com/emersion/go-smtp"
	"github.com/jhillyerd/enmime"
)

// MaxRecipients caps the number of envelope recipients (to + cc + bcc) the
// go-smtp server accepts per message. Keep this in sync with the worker's
// MAX_RECIPIENTS in worker/src/email.ts.
const MaxRecipients = 50

// Backend hands out a fresh Session per SMTP connection.
type Backend struct {
	cfg    Config
	client *Client
}

func (b *Backend) NewSession(_ *smtp.Conn) (smtp.Session, error) {
	return &Session{cfg: b.cfg, client: b.client}, nil
}

// Session accumulates the envelope (MAIL FROM / RCPT TO) and, on DATA, parses
// the MIME body and delivers it to core (the inbound transport seam).
type Session struct {
	cfg    Config
	client *Client
	from   string
	rcpts  []string
}

func (s *Session) Mail(from string, _ *smtp.MailOptions) error {
	s.from = from
	return nil
}

func (s *Session) Rcpt(to string, _ *smtp.RcptOptions) error {
	s.rcpts = append(s.rcpts, to)
	return nil
}

func (s *Session) Data(r io.Reader) error {
	if len(s.rcpts) == 0 {
		return &smtp.SMTPError{Code: 554, EnhancedCode: smtp.EnhancedCode{5, 5, 4}, Message: "no recipients"}
	}

	raw, err := io.ReadAll(io.LimitReader(r, s.cfg.MaxSize+1))
	if err != nil {
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "read failed"}
	}
	if int64(len(raw)) > s.cfg.MaxSize {
		return &smtp.SMTPError{Code: 552, EnhancedCode: smtp.EnhancedCode{5, 3, 4}, Message: "message too large"}
	}

	env, err := enmime.ReadEnvelope(bytes.NewReader(raw))
	if err != nil {
		return &smtp.SMTPError{Code: 554, EnhancedCode: smtp.EnhancedCode{5, 6, 0}, Message: "parse failed: " + err.Error()}
	}

	// Inbound transport seam (CONTRACT section 2): normalize to ParsedInbound and
	// POST to core /ingest. Legacy deployments without /ingest configured fall
	// back to posting an EmailPayload to the worker /send endpoint.
	if s.client.usesIngest() {
		p := buildParsedInbound(s.rcpts, s.from, env)
		if err := s.client.PostIngest(p); err != nil {
			log.Printf("ingest failed to=%s from=%s subject=%q: %v", p.To, p.From, p.Subject, err)
			return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "ingest to core failed"}
		}
		log.Printf("ingested to=%s from=%s subject=%q attachments=%d", p.To, p.From, p.Subject, len(p.Attachments))
		return nil
	}

	payload := s.buildPayload(env)
	if err := s.client.Send(payload); err != nil {
		// 451 = transient; the sending MTA may retry.
		log.Printf("relay failed to=%v subject=%q: %v", payload.To, payload.Subject, err)
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "relay to worker failed"}
	}
	log.Printf("relayed to=%v from=%s subject=%q", payload.To, payload.From, payload.Subject)
	return nil
}

func (s *Session) Reset() {
	s.from = ""
	s.rcpts = nil
}

func (s *Session) Logout() error { return nil }

// buildPayload turns the SMTP envelope + parsed MIME into the worker's legacy
// /send JSON request. Recipients come from RCPT TO (the real envelope), not the
// headers.
//
// The worker only accepts From addresses on FromDomain. Local services often
// send as cron@localhost or root@host, so any off-domain sender is rewritten to
// DefaultFrom with the original preserved as Reply-To. (Legacy path only; the
// /ingest seam stores mail verbatim and does no rewriting.)
func (s *Session) buildPayload(env *enmime.Envelope) EmailPayload {
	p := EmailPayload{
		To:      append([]string(nil), s.rcpts...),
		Subject: env.GetHeader("Subject"),
		HTML:    env.HTML,
		Text:    env.Text,
	}

	origin := firstAddress(env.GetHeader("From"))
	if origin == "" {
		origin = s.from // envelope MAIL FROM
	}
	if origin != "" && onDomain(origin, s.cfg.FromDomain) {
		p.From = origin
	} else {
		p.From = s.cfg.DefaultFrom
		if origin != "" {
			p.ReplyTo = origin
		}
	}
	return p
}

// firstAddress extracts the bare address from a header value that may be
// "Name <addr@host>" or a comma-separated list.
func firstAddress(header string) string {
	header = strings.TrimSpace(header)
	if header == "" {
		return ""
	}
	if addrs, err := mail.ParseAddressList(header); err == nil && len(addrs) > 0 {
		return addrs[0].Address
	}
	return header
}

func onDomain(addr, domain string) bool {
	at := strings.LastIndex(addr, "@")
	if at < 0 {
		return false
	}
	return strings.EqualFold(addr[at+1:], domain)
}

func run(cfg Config) error {
	be := &Backend{cfg: cfg, client: NewClient(cfg)}
	addrs := splitListen(cfg.Listen)
	if len(addrs) == 0 {
		return fmt.Errorf("no listen address configured (SMTP_LISTEN)")
	}

	// The function blocks until any listener exits. Size the channel for the SMTP
	// intake listeners, the optional outbound /dispatch bridge, and the two
	// optional submission listeners (587 STARTTLS + 465 implicit TLS).
	errc := make(chan error, len(addrs)+3)

	// Optional outbound bridge (CONTRACT section 3): core POSTs OutboundMessages
	// here and the relay sends them via bring-your-own SMTP.
	if cfg.HTTPListen != "" {
		transport, err := newTransport(cfg)
		if err != nil {
			return fmt.Errorf("outbound transport: %w", err)
		}
		go func() { errc <- startDispatchServer(cfg, transport) }()
	}

	// Optional submission seam (CONTRACT section 9): authenticated SMTP submission
	// for IMAP clients on 587 (STARTTLS) and 465 (implicit TLS). AUTH is offered
	// only over TLS, so a cert is loaded and AllowInsecureAuth stays false.
	if cfg.Submission.enabled() {
		if err := startSubmission(cfg, errc); err != nil {
			return fmt.Errorf("submission: %w", err)
		}
	}

	// One go-smtp server per address (e.g. loopback for host services plus a
	// docker-bridge IP for a containerized caller like Uptime Kuma). They share
	// the stateless Backend.
	for _, addr := range addrs {
		srv := smtp.NewServer(be)
		srv.Addr = addr
		srv.Domain = "localhost"
		srv.MaxMessageBytes = cfg.MaxSize
		srv.MaxRecipients = MaxRecipients
		srv.AllowInsecureAuth = true // plaintext on trusted interfaces only (no STARTTLS)
		log.Printf("skyphusion-email-relay listening on %s (inbound mode=%s)", addr, cfg.inboundMode())
		go func(s *smtp.Server) { errc <- s.ListenAndServe() }(srv)
	}
	return fmt.Errorf("relay server: %w", <-errc)
}

// splitListen parses a comma-separated SMTP_LISTEN into trimmed addresses.
func splitListen(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// startSubmission loads the TLS cert and launches the configured submission
// listeners (587 STARTTLS and/or 465 implicit TLS) as goroutines feeding errc.
func startSubmission(cfg Config, errc chan error) error {
	cert, err := tls.LoadX509KeyPair(cfg.Submission.TLSCert, cfg.Submission.TLSKey)
	if err != nil {
		return fmt.Errorf("load TLS keypair: %w", err)
	}
	tlsCfg := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	be := &submissionBackend{cfg: cfg, client: NewSubmitClient(cfg)}

	if cfg.Submission.STARTTLSListen != "" {
		srv := newSubmissionServer(be, tlsCfg, cfg)
		srv.Addr = cfg.Submission.STARTTLSListen
		log.Printf("submission (STARTTLS) listening on %s", srv.Addr)
		go func(s *smtp.Server) { errc <- s.ListenAndServe() }(srv)
	}
	if cfg.Submission.TLSListen != "" {
		srv := newSubmissionServer(be, tlsCfg, cfg)
		srv.Addr = cfg.Submission.TLSListen
		log.Printf("submission (implicit TLS) listening on %s", srv.Addr)
		go func(s *smtp.Server) { errc <- s.ListenAndServeTLS() }(srv)
	}
	return nil
}

// newSubmissionServer builds a go-smtp server for the submission backend. Setting
// TLSConfig with AllowInsecureAuth=false is what makes go-smtp offer/accept AUTH
// ONLY over TLS: on 587 the client must STARTTLS first, on 465 the whole
// connection is TLS; a cleartext AUTH is answered 523 (TLS required).
func newSubmissionServer(be smtp.Backend, tlsCfg *tls.Config, cfg Config) *smtp.Server {
	srv := smtp.NewServer(be)
	srv.Domain = cfg.Submission.FromDomain
	srv.TLSConfig = tlsCfg
	srv.AllowInsecureAuth = false
	srv.MaxMessageBytes = cfg.MaxSize
	srv.MaxRecipients = MaxRecipients
	return srv
}

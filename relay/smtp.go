package main

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"net/mail"
	"os"
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
		p := buildParsedInbound(s.rcpts, s.from, len(raw), env)
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

// inboundIntakeAddrs returns the SMTP intake addresses run() will bind. It is
// empty unless inbound is active (an inbound destination is configured); this is
// the seam that lets a submission-only or dispatch-only deploy bind no intake
// port. Pure and side-effect free, so the binding decision is directly testable.
func inboundIntakeAddrs(cfg Config) []string {
	if !cfg.inboundActive() {
		return nil
	}
	return splitListen(cfg.Listen)
}

// intakeAddrIsLoopback reports whether a resolved intake bind address binds ONLY a
// loopback interface. It fails closed: anything it cannot positively confirm as
// loopback (a wildcard bind like ":2525", 0.0.0.0, ::, or a non-localhost hostname
// it cannot resolve to a literal) is treated as NON-loopback. A SplitHostPort error
// is surfaced so a malformed address is rejected rather than silently allowed.
func intakeAddrIsLoopback(addr string) (bool, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false, fmt.Errorf("intake listen address %q is not a valid host:port: %w", addr, err)
	}
	if host == "" {
		// e.g. ":2525" -- a wildcard bind on every interface, NOT loopback.
		return false, nil
	}
	if strings.EqualFold(host, "localhost") {
		return true, nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		// A non-localhost hostname we cannot positively confirm as loopback.
		return false, nil
	}
	return ip.IsLoopback(), nil
}

// checkIntakeLoopback enforces audit finding F4: the inbound intake listener is
// unauthenticated by design (no AUTH, AllowInsecureAuth=true), so it is safe ONLY
// on loopback. We make "intake is loopback-only" an ENFORCED invariant, not just a
// default: if any resolved intake bind address is non-loopback the relay refuses to
// start (fail closed). An operator who genuinely needs a non-loopback intake must
// front it with something that authenticates.
func checkIntakeLoopback(addrs []string) error {
	for _, addr := range addrs {
		ok, err := intakeAddrIsLoopback(addr)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("inbound intake listener must bind loopback only; got %q (the intake door is unauthenticated by design, so a public bind is an open injection/store-poisoning door; front it with an authenticated proxy if you truly need a non-loopback intake)", addr)
		}
	}
	return nil
}

func run(cfg Config) error {
	be := &Backend{cfg: cfg, client: NewClient(cfg)}

	// Intake listeners are bound ONLY when an inbound destination is configured
	// (see inboundIntakeAddrs). A submission-only or dispatch-only deploy leaves the
	// inbound vars unset and therefore binds NO intake port (no more vestigial dead
	// loopback listener).
	addrs := inboundIntakeAddrs(cfg)
	if len(addrs) == 0 && os.Getenv("SMTP_LISTEN") != "" {
		// Footgun: an operator set SMTP_LISTEN intending inbound but configured no
		// destination, so intake is skipped. Warn loudly rather than fail: a valid
		// submission-only or dispatch-only deploy may still carry a leftover (or
		// default-shaped) SMTP_LISTEN, and we must not block those.
		log.Printf("WARNING: SMTP_LISTEN=%q is set but no inbound destination "+
			"(POSTERN_INGEST_URL or EMAIL_WORKER_URL) is configured; inbound intake is DISABLED. "+
			"Set an inbound destination to enable intake, or unset SMTP_LISTEN to silence this.",
			os.Getenv("SMTP_LISTEN"))
	}

	// F4: the intake door is unauthenticated by design, so enforce loopback-only at
	// the binding decision. Refuse to start on any non-loopback intake bind.
	if err := checkIntakeLoopback(addrs); err != nil {
		return err
	}

	// Parse submission listeners up front so the error channel is sized exactly.
	var subListeners []submissionListener
	if cfg.Submission.enabled() {
		var err error
		subListeners, err = parseSubmissionListeners(cfg.Submission.Listeners)
		if err != nil {
			return fmt.Errorf("submission: %w", err)
		}
	}

	// Nothing-to-do guard. loadConfig already enforces this, but run() is also
	// driven directly from tests, so guard here too: with no intake, no submission,
	// and no /dispatch bridge there is nothing to serve.
	if len(addrs) == 0 && len(subListeners) == 0 && cfg.HTTPListen == "" {
		return fmt.Errorf("nothing to do: set POSTERN_INGEST_URL (inbound), SUBMISSION_LISTENERS (submission), or POSTERN_RELAY_HTTP_LISTEN (dispatch)")
	}

	// The function blocks until any listener exits. Size the channel for the intake
	// listeners, the optional outbound /dispatch bridge, and every submission listener.
	errc := make(chan error, len(addrs)+1+len(subListeners))

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
	// for IMAP clients on an arbitrary, operator-configured set of (port, tls-mode)
	// listeners. AUTH is offered only over TLS, so the cert is loaded (and
	// hot-reloaded on renewal) and AllowInsecureAuth stays false on every listener.
	if len(subListeners) > 0 {
		if err := startSubmission(cfg, subListeners, errc); err != nil {
			return fmt.Errorf("submission: %w", err)
		}
	}

	// One go-smtp server per address. Every address is loopback-only by the F4
	// invariant enforced above (the intake door is unauthenticated), so multiple
	// binds are just multiple loopback aliases. They share the stateless Backend.
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

// startSubmission builds the shared cert reloader, the send bridge, and the
// selected auth backend, then launches one go-smtp server per configured listener
// (STARTTLS or implicit TLS) as goroutines feeding errc.
func startSubmission(cfg Config, listeners []submissionListener, errc chan error) error {
	reloader, err := newCertReloader(cfg.Submission.TLSCert, cfg.Submission.TLSKey)
	if err != nil {
		return err
	}
	tlsCfg := &tls.Config{GetCertificate: reloader.GetCertificate, MinVersion: tls.VersionTLS12}

	sc := NewSubmitClient(cfg)
	auth, err := selectAuthProvider(cfg, sc)
	if err != nil {
		return err
	}
	throttle := newAuthThrottle(cfg.Submission.Throttle, nil)
	be := &submissionBackend{cfg: cfg, auth: auth, sender: sc, throttle: throttle}
	log.Printf("submission auth backend = %s", submissionBackendName(cfg))
	if cfg.Submission.Throttle.Enabled {
		log.Printf("submission auth throttle: per-account lockout after %d failures (#105)", cfg.Submission.Throttle.MaxFailures)
	}
	proxyCfg := cfg.Submission.ProxyProtocol
	if proxyCfg.enabled() {
		log.Printf("submission PROXY protocol = %s (%d trusted CIDR(s), real client IP recovered for logging + #105) (#155)", proxyCfg.Mode, len(proxyCfg.Trusted))
	}

	for _, l := range listeners {
		srv := newSubmissionServer(be, tlsCfg, cfg)
		srv.Addr = l.Addr

		// Listen on the raw TCP socket ourselves so the PROXY header is read off the
		// front of the stream BEFORE any TLS handshake. The wrap is a no-op when
		// PROXY protocol is off, so the default deploy is unchanged. For implicit
		// TLS we then layer tls.NewListener exactly as go-smtp's ListenAndServeTLS
		// would; for STARTTLS go-smtp upgrades the (already PROXY-stripped) conn.
		ln, err := net.Listen("tcp", l.Addr)
		if err != nil {
			return fmt.Errorf("submission listen %s: %w", l.Addr, err)
		}
		ln = wrapProxyListener(ln, proxyCfg)
		if l.Implicit {
			ln = tls.NewListener(ln, tlsCfg)
			log.Printf("submission (implicit TLS) listening on %s", l.Addr)
		} else {
			log.Printf("submission (STARTTLS) listening on %s", l.Addr)
		}
		go func(s *smtp.Server, ln net.Listener) { errc <- s.Serve(ln) }(srv, ln)
	}
	return nil
}

func submissionBackendName(cfg Config) string {
	if cfg.Submission.Backend == "" {
		return "native"
	}
	return cfg.Submission.Backend
}

// newSubmissionServer builds a go-smtp server for the submission backend. Setting
// TLSConfig with AllowInsecureAuth=false is what makes go-smtp offer/accept AUTH
// ONLY over TLS: on a STARTTLS listener the client must upgrade first, on an
// implicit-TLS listener the whole connection is TLS; a cleartext AUTH is answered
// 523 (TLS required). GetCertificate picks up a renewed cert without a restart.
func newSubmissionServer(be smtp.Backend, tlsCfg *tls.Config, cfg Config) *smtp.Server {
	srv := smtp.NewServer(be)
	srv.Domain = cfg.Submission.Hostname
	srv.TLSConfig = tlsCfg
	srv.AllowInsecureAuth = false
	srv.MaxMessageBytes = cfg.MaxSize
	srv.MaxRecipients = MaxRecipients
	return srv
}

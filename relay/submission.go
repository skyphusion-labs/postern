package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net/mail"
	"os"
	"strings"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
	"github.com/jhillyerd/enmime"
)

// submissionDebug, set by SUBMISSION_DEBUG, turns on per-session diagnostic logging
// (connection, auth username + OUTCOME, and auth-required rejections). It NEVER logs
// the password or the raw AUTH line. Off by default; a deploy-time troubleshooting aid.
var submissionDebug = os.Getenv("SUBMISSION_DEBUG") != ""

// sender is the worker /api/send bridge the session needs once a message is
// authenticated + From-enforced. *SubmitClient is the production implementation;
// tests substitute a stub (mirrors the Transport seam in http.go). Login
// verification is the separate AuthProvider seam (auth.go), so the auth backend
// (native/ldap/system) is independent of the send path.
type sender interface {
	Send(p SendPayload) error
}

// submissionBackend serves authenticated SMTP submission (#68) for IMAP clients
// on 587 (STARTTLS) and 465 (implicit TLS). It is distinct from the inbound
// intake Backend in smtp.go: every message here is AUTH-gated, From-enforced, and
// bridged to the worker /api/send seam, never posted to /ingest.
type submissionBackend struct {
	cfg      Config
	auth     AuthProvider
	sender   sender
	throttle *authThrottle // shared across all sessions; per-account brute-force throttle (#105)
}

func (b *submissionBackend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	// RemoteAddr is the real client IP recovered from a trusted PROXY header when
	// PROXY protocol is on (#155), else the raw peer. It is the remote-addr for
	// logging and the key context any future per-IP control would use; #105 stays
	// per-account. Capture it once at session open so every log line is consistent.
	remote := c.Conn().RemoteAddr().String()
	if submissionDebug {
		log.Printf("submission session opened from %s", remote)
	}
	return &submissionSession{cfg: b.cfg, auth: b.auth, sender: b.sender, throttle: b.throttle, remote: remote}, nil
}

// submissionSession holds per-connection auth + envelope state. authed flips true
// only after a successful /api/smtp-auth check, which binds boundFrom (the
// identity the message From must match).
type submissionSession struct {
	cfg       Config
	auth      AuthProvider
	sender    sender
	throttle  *authThrottle
	remote    string // real client IP (PROXY-recovered when trusted, #155), for logging
	authed    bool
	boundFrom string
	rcpts     []string
}

// AuthMechanisms advertises PLAIN + LOGIN. go-smtp advertises these (and accepts
// AUTH at all) ONLY once the connection is over TLS, because the server is built
// with AllowInsecureAuth=false + a TLSConfig; a cleartext AUTH attempt gets 523.
func (s *submissionSession) AuthMechanisms() []string {
	return []string{sasl.Plain, sasl.Login}
}

// Auth returns the SASL server for the chosen mechanism. Both validate the login
// against the worker and bind the From identity on success. PLAIN ignores the
// optional authorization identity (we authenticate the login itself).
func (s *submissionSession) Auth(mech string) (sasl.Server, error) {
	switch mech {
	case sasl.Plain:
		return sasl.NewPlainServer(func(_, username, password string) error {
			return s.authenticate(username, password)
		}), nil
	case sasl.Login:
		return sasl.NewLoginServer(func(username, password string) error {
			return s.authenticate(username, password)
		}), nil
	default:
		return nil, smtp.ErrAuthUnsupported
	}
}

// authenticate runs the per-user check. Infra errors are logged but collapsed to
// the generic auth failure so the client never learns whether the username
// exists or whether the relay itself is misconfigured.
func (s *submissionSession) authenticate(username, password string) error {
	// #105: per-account online brute-force throttle. Keyed on the account, not the
	// source IP (behind the bastion every connection is one IP). A throttled
	// attempt returns the SAME generic auth failure as a wrong password, so it
	// never reveals whether the account exists -- and we do NOT touch the backend,
	// so a guess against a locked account costs the attacker nothing useful.
	account := throttleKey(username)
	if !s.throttle.allow(account) {
		if submissionDebug {
			log.Printf("submission auth THROTTLED user=%q (too many recent failures)", username)
		}
		return smtp.ErrAuthFailed
	}

	identity, err := s.auth.Authenticate(username, password)
	if err != nil {
		if err != errAuthFailed {
			// Infra error (backend down): NOT a password guess, so it must not
			// count toward the throttle, else an outage locks every user out.
			log.Printf("submission auth infra error user=%q: %v", username, err)
		} else {
			s.throttle.fail(account)
			if submissionDebug {
				log.Printf("submission auth REJECTED user=%q (backend returned auth-failed)", username)
			}
		}
		return smtp.ErrAuthFailed
	}
	s.throttle.success(account)
	s.authed = true
	s.boundFrom = identity
	if submissionDebug {
		log.Printf("submission auth OK user=%q -> identity=%q", username, identity)
	}
	return nil
}

func (s *submissionSession) Mail(_ string, _ *smtp.MailOptions) error {
	if !s.authed {
		if submissionDebug {
			log.Printf("submission MAIL rejected: session not authenticated")
		}
		return smtp.ErrAuthRequired
	}
	return nil
}

func (s *submissionSession) Rcpt(to string, _ *smtp.RcptOptions) error {
	if !s.authed {
		return smtp.ErrAuthRequired
	}
	s.rcpts = append(s.rcpts, to)
	return nil
}

// Data enforces auth + From, reconstructs to/cc/bcc, carries attachments through
// (#70), and bridges to the worker /api/send seam.
func (s *submissionSession) Data(r io.Reader) error {
	if !s.authed {
		return smtp.ErrAuthRequired
	}
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

	// From-enforcement (the seam's core safety property): the header From MUST be
	// the authenticated bound identity. No From, or a mismatch, is a spoof attempt.
	hdrFrom := firstAddress(env.GetHeader("From"))
	if hdrFrom == "" {
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "missing From header"}
	}
	if !strings.EqualFold(hdrFrom, s.boundFrom) {
		return &smtp.SMTPError{
			Code:         550,
			EnhancedCode: smtp.EnhancedCode{5, 7, 1},
			Message:      fmt.Sprintf("From %q does not match the authenticated identity %q", hdrFrom, s.boundFrom),
		}
	}

	payload, err := s.buildSendPayload(env)
	if err != nil {
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: err.Error()}
	}

	if err := s.sender.Send(payload); err != nil {
		return mapSendError(payload, err)
	}
	log.Printf("submitted client=%s from=%s to=%v cc=%v bcc=%d attachments=%d subject=%q", s.remote, payload.From, payload.To, payload.CC, len(payload.BCC), len(payload.Attachments), payload.Subject)
	return nil
}

func (s *submissionSession) Reset() {
	s.rcpts = nil
	// authed + boundFrom persist across RSET within one authenticated connection.
}

func (s *submissionSession) Logout() error { return nil }

// buildSendPayload reconstructs the worker SendRequest from the parsed message and
// the SMTP envelope. The envelope (RCPT TO) is authoritative for delivery; the
// To/Cc headers classify the visible recipients, and anything in the envelope not
// named in a header is Bcc (kept envelope-only, never headered). This preserves
// Bcc privacy through the field-based /api/send.
func (s *submissionSession) buildSendPayload(env *enmime.Envelope) (SendPayload, error) {
	envSet := lowerSet(s.rcpts)
	classified := make(map[string]struct{})

	to := classifyHeaderRecipients(env.GetHeader("To"), envSet, classified)
	cc := classifyHeaderRecipients(env.GetHeader("Cc"), envSet, classified)

	var bcc []string
	for _, r := range s.rcpts {
		key := strings.ToLower(strings.TrimSpace(r))
		if _, done := classified[key]; done {
			continue
		}
		classified[key] = struct{}{}
		bcc = append(bcc, r)
	}

	// The worker requires at least one To recipient. A Bcc-only submission (no To
	// or Cc header recipient in the envelope) is rejected rather than silently
	// rewriting the visible header. Documented v1 limitation.
	if len(to) == 0 {
		return SendPayload{}, fmt.Errorf("at least one To recipient is required")
	}

	p := SendPayload{
		From:        s.boundFrom,
		To:          to,
		CC:          cc,
		BCC:         bcc,
		Subject:     env.GetHeader("Subject"),
		HTML:        env.HTML,
		Text:        env.Text,
		Attachments: collectAttachments(env),
	}

	// Carry reply threading so a reply sent from the client threads on the wire.
	// The worker forwards In-Reply-To / References to the provider (CF whitelists
	// them); any other header is left to the worker to set.
	headers := make(map[string]string)
	if v := strings.TrimSpace(env.GetHeader("In-Reply-To")); v != "" {
		headers["In-Reply-To"] = v
	}
	if v := strings.TrimSpace(env.GetHeader("References")); v != "" {
		headers["References"] = v
	}
	if len(headers) > 0 {
		p.Headers = headers
	}
	return p, nil
}

// collectAttachments maps the parsed MIME's non-body parts (#70) to the worker
// SendRequest.attachments shape. Attachments, inline parts (e.g. an Apple Mail
// inline image), AND other parts (multipart/related extras) are all carried -- the
// same set the daemon used to reject loudly -- so a real MUA's message survives
// intact with nothing silently dropped. The worker hands them to the send_email
// binding, which builds the MIME. Content is base64 (the JSON wire form). Carrying
// inline parts as attachments preserves their bytes; rendering them inline (cid)
// rather than as attachments is a tracked follow-up, not a silent drop.
func collectAttachments(env *enmime.Envelope) []SendAttachment {
	parts := make([]*enmime.Part, 0, len(env.Attachments)+len(env.Inlines)+len(env.OtherParts))
	parts = append(parts, env.Attachments...)
	parts = append(parts, env.Inlines...)
	parts = append(parts, env.OtherParts...)

	out := make([]SendAttachment, 0, len(parts))
	for _, part := range parts {
		if len(part.Content) == 0 {
			continue // structural part with no bytes; nothing to carry
		}
		out = append(out, SendAttachment{
			Filename: part.FileName,
			MimeType: part.ContentType,
			Content:  base64.StdEncoding.EncodeToString(part.Content),
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// classifyHeaderRecipients returns the header addresses that are present in the
// envelope set (so a header address the client did not actually RCPT is not
// delivered), recording each in classified so it is not later counted as Bcc.
func classifyHeaderRecipients(header string, envSet map[string]string, classified map[string]struct{}) []string {
	var out []string
	for _, addr := range parseAddressList(header) {
		key := strings.ToLower(addr)
		if _, ok := envSet[key]; !ok {
			continue // headered but not in the envelope: not a real recipient
		}
		if _, done := classified[key]; done {
			continue
		}
		classified[key] = struct{}{}
		out = append(out, envSet[key]) // use the envelope-cased address
	}
	return out
}

// parseAddressList extracts bare addresses from a To/Cc header value, tolerating
// "Name <addr>" and comma lists. Unparseable values yield no addresses.
func parseAddressList(header string) []string {
	header = strings.TrimSpace(header)
	if header == "" {
		return nil
	}
	addrs, err := mail.ParseAddressList(header)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, a.Address)
	}
	return out
}

// lowerSet maps lowercased address -> original-cased address for the envelope
// recipients (the last casing wins; addresses are case-insensitive in practice).
func lowerSet(rcpts []string) map[string]string {
	m := make(map[string]string, len(rcpts))
	for _, r := range rcpts {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		m[strings.ToLower(r)] = r
	}
	return m
}

// mapSendError translates a worker /api/send failure into the right SMTP reply.
// 4xx (validation / sender-not-allowed) is a permanent client problem (550); our
// own misconfig (401) and upstream/transport failures (5xx, network) are transient
// (451) so the client's MTA may retry while the operator fixes it.
func mapSendError(p SendPayload, err error) error {
	se, ok := err.(*sendError)
	if !ok {
		log.Printf("submission send transport error from=%s: %v", p.From, err)
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "submission temporarily unavailable"}
	}
	switch {
	case se.status == 401:
		log.Printf("submission send rejected: worker rejected the send token (401): %s", se.msg)
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "submission temporarily unavailable"}
	case se.status == 413:
		return &smtp.SMTPError{Code: 552, EnhancedCode: smtp.EnhancedCode{5, 3, 4}, Message: "message too large"}
	case se.status >= 500:
		log.Printf("submission send upstream failure (%d): %s", se.status, se.msg)
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "upstream send failed, try again"}
	default:
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "rejected: " + se.msg}
	}
}

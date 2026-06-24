package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is loaded entirely from the environment so the systemd unit can drive
// it via an EnvironmentFile. No config file, no flags.
//
// The relay is a two-seam transport bridge for Postern (see docs/CONTRACT.md):
//
//   - INBOUND  (#22): SMTP in -> ParsedInbound -> POST /ingest on core, using
//     the transport token. This is the default intake path off CF Email Routing.
//   - OUTBOUND (#23): core's RelayTransport POSTs an OutboundMessage to this
//     relay's /dispatch endpoint; the relay sends it via bring-your-own SMTP.
//
// Legacy: posting the SMTP-received message straight to the worker's /send
// endpoint (the pre-M3 behavior) is still supported when IngestURL is unset, so
// existing deployments keep working through the rename.
type Config struct {
	// SMTP listener (inbound intake).
	Listen  string // SMTP_LISTEN, comma-separated, default 127.0.0.1:2525
	MaxSize int64  // MAX_MESSAGE_BYTES, default 25 MiB

	// Inbound seam: where SMTP-received mail is delivered.
	IngestURL      string // POSTERN_INGEST_URL, the core .../ingest endpoint (preferred)
	TransportToken string // POSTERN_TRANSPORT_TOKEN, the transport-seam bearer (NOT the API token)

	// Legacy inbound fallback: post the parsed message to the worker /send
	// endpoint instead of /ingest. Used only when IngestURL is empty.
	WorkerURL string // EMAIL_WORKER_URL, the .../send endpoint
	Token     string // EMAIL_RELAY_TOKEN (== RELAY_TOKEN), the legacy send bearer

	// From rewriting (legacy /send path: the worker only accepts FromDomain).
	DefaultFrom string // DEFAULT_FROM, used when the sender is off-domain
	FromDomain  string // FROM_DOMAIN, the only domain the worker accepts

	// Outbound seam (BYO-SMTP dispatch bridge).
	HTTPListen   string     // POSTERN_RELAY_HTTP_LISTEN, e.g. 127.0.0.1:2526; empty disables /dispatch
	SMTPOut      SMTPOutCfg // upstream SMTP the relay sends OUTBOUND mail through
	OutboundFrom string     // POSTERN_OUTBOUND_FROM, fallback envelope From for dispatch

	HTTPTimeout time.Duration // HTTP_TIMEOUT_SECONDS, default 30 (outbound POSTs to core)

	// Submission seam (#68): authenticated SMTP submission for IMAP clients.
	// Unlike the inbound intake listener (loopback only), these listeners are
	// AUTH-required, so binding them publicly is correct. AUTH is offered ONLY
	// over TLS (go-smtp AllowInsecureAuth=false + TLSConfig), so a cert is required.
	Submission SubmissionCfg
}

// SMTPOutCfg describes the bring-your-own upstream SMTP server the relay relays
// OUTBOUND messages through (the #28 "not locked into CF" escape hatch).
type SMTPOutCfg struct {
	Host     string        // SMTP_OUT_HOST
	Port     int           // SMTP_OUT_PORT, default 587
	Username string        // SMTP_OUT_USERNAME (optional; PLAIN auth when set)
	Password string        // SMTP_OUT_PASSWORD
	StartTLS bool          // SMTP_OUT_STARTTLS, default true
	Timeout  time.Duration // SMTP_OUT_TIMEOUT_SECONDS, default 30
}

// SubmissionCfg describes the authenticated SMTP submission listeners (#68). The
// daemon serves an arbitrary, operator-configured set of (address, tls-mode)
// listeners (so it can dodge ISP/provider port-blocking, not just 587/465),
// authenticates each client login through the configured AuthProvider backend
// (native | ldap | system), enforces From == the bound identity, and bridges the
// message to the worker /api/send seam. Nothing here is domain-specific: the
// bound identity comes from the auth backend, so postern is self-hostable for any
// domain from a fresh clone.
type SubmissionCfg struct {
	// SUBMISSION_LISTENERS: comma-separated "<addr>:<mode>" entries, mode is
	// "starttls" or "implicit". A bare port is shorthand for ":<port>". Examples:
	// "587:starttls,465:implicit,2525:starttls", "0.0.0.0:587:starttls".
	Listeners string
	TLSCert   string // SUBMISSION_TLS_CERT, PEM certificate path (operator-provisioned)
	TLSKey    string // SUBMISSION_TLS_KEY, PEM private key path
	Hostname  string // SUBMISSION_HOSTNAME, the SMTP greeting name (cosmetic; default localhost)

	// AUTH_BACKEND selects how a login is verified: native (default) | ldap | system.
	Backend string

	// Send bridge (worker /api/send). Used for every backend: only the SENDER is
	// authenticated; sending always goes through the proven worker send seam.
	SendURL   string // POSTERN_SEND_URL
	SendToken string // POSTERN_SEND_TOKEN, the mailbox API token for /api/send

	// native backend: worker POST /api/smtp-auth, gated by the TRANSPORT token
	// (Config.TransportToken), checking the D1 smtp_credentials table.
	AuthURL string // POSTERN_SMTP_AUTH_URL

	// ldap backend (pure-Go go-ldap simple-bind or search+bind over TLS).
	LDAP LDAPCfg

	// system backend (local Unix accounts via PAM; cgo, build-tagged `pam`).
	SystemDomain  string // AUTH_SYSTEM_DOMAIN, bound identity = <user>@<this domain>
	SystemService string // AUTH_SYSTEM_PAM_SERVICE, PAM service name (default postern)
}

// LDAPCfg configures the ldap auth backend. TLS is mandatory (ldaps:// or
// StartTLS): a bind sends the password, so it must never cross cleartext.
type LDAPCfg struct {
	URL            string // LDAP_URL, ldaps://host:636 (preferred) or ldap://host:389
	StartTLS       bool   // LDAP_STARTTLS, upgrade an ldap:// connection before binding
	BindDNTemplate string // LDAP_BIND_DN_TEMPLATE, e.g. "uid=%s,ou=people,dc=example,dc=com" (simple bind)
	BindDN         string // LDAP_BIND_DN, service account DN for search+bind
	BindPassword   string // LDAP_BIND_PASSWORD, service account password
	SearchBase     string // LDAP_SEARCH_BASE, e.g. "ou=people,dc=example,dc=com"
	SearchFilter   string // LDAP_SEARCH_FILTER, e.g. "(uid=%s)"
	MailAttr       string // LDAP_MAIL_ATTR, the attribute holding the bound identity (default mail)
}

// enabled reports whether any submission listener is configured.
func (s SubmissionCfg) enabled() bool {
	return strings.TrimSpace(s.Listeners) != ""
}

// submissionListener is one parsed (address, tls-mode) pair.
type submissionListener struct {
	Addr     string // a Go listen address, e.g. ":587" or "0.0.0.0:2525"
	Implicit bool   // true = implicit TLS (465-style); false = STARTTLS upgrade (587-style)
}

// parseSubmissionListeners parses SUBMISSION_LISTENERS into listeners. Each entry
// is "<addr>:<mode>"; the LAST colon splits the mode off, so the address may be a
// bare port, host:port, or [ipv6]:port. mode is "starttls" or "implicit".
func parseSubmissionListeners(spec string) ([]submissionListener, error) {
	var out []submissionListener
	for _, raw := range strings.Split(spec, ",") {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		i := strings.LastIndex(entry, ":")
		if i < 0 {
			return nil, fmt.Errorf("submission listener %q must be <addr>:<mode> (mode = starttls|implicit)", entry)
		}
		addrPart := strings.TrimSpace(entry[:i])
		mode := strings.ToLower(strings.TrimSpace(entry[i+1:]))

		var implicit bool
		switch mode {
		case "starttls":
			implicit = false
		case "implicit", "tls":
			implicit = true
		default:
			return nil, fmt.Errorf("submission listener %q has unknown mode %q (want starttls|implicit)", entry, mode)
		}

		// A bare port (no host, no colon) is shorthand for all interfaces.
		addr := addrPart
		if !strings.Contains(addrPart, ":") {
			if _, err := strconv.Atoi(addrPart); err != nil {
				return nil, fmt.Errorf("submission listener %q: %q is not a port or host:port", entry, addrPart)
			}
			addr = ":" + addrPart
		}
		out = append(out, submissionListener{Addr: addr, Implicit: implicit})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("SUBMISSION_LISTENERS parsed to no listeners")
	}
	return out, nil
}

func loadConfig() (Config, error) {
	c := Config{
		Listen:         env("SMTP_LISTEN", "127.0.0.1:2525"),
		MaxSize:        int64(envInt("MAX_MESSAGE_BYTES", 25*1024*1024)),
		IngestURL:      os.Getenv("POSTERN_INGEST_URL"),
		TransportToken: os.Getenv("POSTERN_TRANSPORT_TOKEN"),
		WorkerURL:      os.Getenv("EMAIL_WORKER_URL"),
		Token:          os.Getenv("EMAIL_RELAY_TOKEN"),
		DefaultFrom:    env("DEFAULT_FROM", "noreply@example.com"),
		FromDomain:     env("FROM_DOMAIN", "example.com"),
		HTTPListen:     os.Getenv("POSTERN_RELAY_HTTP_LISTEN"),
		OutboundFrom:   os.Getenv("POSTERN_OUTBOUND_FROM"),
		HTTPTimeout:    time.Duration(envInt("HTTP_TIMEOUT_SECONDS", 30)) * time.Second,
		SMTPOut: SMTPOutCfg{
			Host:     os.Getenv("SMTP_OUT_HOST"),
			Port:     envInt("SMTP_OUT_PORT", 587),
			Username: os.Getenv("SMTP_OUT_USERNAME"),
			Password: os.Getenv("SMTP_OUT_PASSWORD"),
			StartTLS: envBool("SMTP_OUT_STARTTLS", true),
			Timeout:  time.Duration(envInt("SMTP_OUT_TIMEOUT_SECONDS", 30)) * time.Second,
		},
		Submission: SubmissionCfg{
			Listeners: os.Getenv("SUBMISSION_LISTENERS"),
			TLSCert:   os.Getenv("SUBMISSION_TLS_CERT"),
			TLSKey:    os.Getenv("SUBMISSION_TLS_KEY"),
			Hostname:  env("SUBMISSION_HOSTNAME", "localhost"),
			Backend:   strings.ToLower(env("AUTH_BACKEND", "native")),
			SendURL:   os.Getenv("POSTERN_SEND_URL"),
			SendToken: os.Getenv("POSTERN_SEND_TOKEN"),
			AuthURL:   os.Getenv("POSTERN_SMTP_AUTH_URL"),
			LDAP: LDAPCfg{
				URL:            os.Getenv("LDAP_URL"),
				StartTLS:       envBool("LDAP_STARTTLS", false),
				BindDNTemplate: os.Getenv("LDAP_BIND_DN_TEMPLATE"),
				BindDN:         os.Getenv("LDAP_BIND_DN"),
				BindPassword:   os.Getenv("LDAP_BIND_PASSWORD"),
				SearchBase:     os.Getenv("LDAP_SEARCH_BASE"),
				SearchFilter:   os.Getenv("LDAP_SEARCH_FILTER"),
				MailAttr:       env("LDAP_MAIL_ATTR", "mail"),
			},
			SystemDomain:  os.Getenv("AUTH_SYSTEM_DOMAIN"),
			SystemService: env("AUTH_SYSTEM_PAM_SERVICE", "postern"),
		},
	}

	// At least one inbound destination must be configured.
	switch {
	case c.IngestURL != "":
		if c.TransportToken == "" {
			return c, fmt.Errorf("POSTERN_TRANSPORT_TOKEN is required when POSTERN_INGEST_URL is set")
		}
	case c.WorkerURL != "":
		if c.Token == "" {
			return c, fmt.Errorf("EMAIL_RELAY_TOKEN is required when using the legacy EMAIL_WORKER_URL path")
		}
	default:
		return c, fmt.Errorf("set POSTERN_INGEST_URL (preferred) or EMAIL_WORKER_URL (legacy) so inbound mail has a destination")
	}

	// The outbound /dispatch bridge is opt-in. If it is enabled it needs a token
	// (so core's RelayTransport can authenticate) and an upstream SMTP host.
	if c.HTTPListen != "" {
		if c.TransportToken == "" {
			return c, fmt.Errorf("POSTERN_TRANSPORT_TOKEN is required when POSTERN_RELAY_HTTP_LISTEN is set (the /dispatch bridge is token-gated)")
		}
		if c.SMTPOut.Host == "" {
			return c, fmt.Errorf("SMTP_OUT_HOST is required when the /dispatch bridge is enabled")
		}
	}

	// Submission listeners are opt-in. When enabled they require TLS (AUTH is
	// never offered in cleartext), the send bridge, and a valid auth backend.
	if c.Submission.enabled() {
		if _, err := parseSubmissionListeners(c.Submission.Listeners); err != nil {
			return c, err
		}
		if c.Submission.TLSCert == "" || c.Submission.TLSKey == "" {
			return c, fmt.Errorf("SUBMISSION_TLS_CERT and SUBMISSION_TLS_KEY are required when a submission listener is set (AUTH is offered only over TLS)")
		}
		if c.Submission.SendURL == "" || c.Submission.SendToken == "" {
			return c, fmt.Errorf("POSTERN_SEND_URL and POSTERN_SEND_TOKEN are required for submission (the bridge to the worker /api/send seam)")
		}
		switch c.Submission.Backend {
		case "", "native":
			if c.Submission.AuthURL == "" || c.TransportToken == "" {
				return c, fmt.Errorf("native auth needs POSTERN_SMTP_AUTH_URL and POSTERN_TRANSPORT_TOKEN (the per-user /api/smtp-auth check)")
			}
		case "ldap":
			if c.Submission.LDAP.URL == "" {
				return c, fmt.Errorf("ldap auth needs LDAP_URL")
			}
			secure := strings.HasPrefix(strings.ToLower(c.Submission.LDAP.URL), "ldaps://") || c.Submission.LDAP.StartTLS
			if !secure {
				return c, fmt.Errorf("ldap auth requires TLS: use an ldaps:// LDAP_URL or set LDAP_STARTTLS=true")
			}
			if c.Submission.LDAP.BindDNTemplate == "" &&
				(c.Submission.LDAP.BindDN == "" || c.Submission.LDAP.SearchBase == "" || c.Submission.LDAP.SearchFilter == "") {
				return c, fmt.Errorf("ldap auth needs LDAP_BIND_DN_TEMPLATE (simple bind) or LDAP_BIND_DN + LDAP_SEARCH_BASE + LDAP_SEARCH_FILTER (search+bind)")
			}
		case "system":
			if c.Submission.SystemDomain == "" {
				return c, fmt.Errorf("system auth needs AUTH_SYSTEM_DOMAIN (bound identity = <user>@<domain>)")
			}
		default:
			return c, fmt.Errorf("unknown AUTH_BACKEND %q (want native|ldap|system)", c.Submission.Backend)
		}
	}

	return c, nil
}

// inboundMode reports whether the relay delivers inbound mail via the modern
// /ingest seam (true) or the legacy worker /send path (false).
func (c Config) inboundMode() string {
	if c.IngestURL != "" {
		return "ingest"
	}
	return "legacy-send"
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}

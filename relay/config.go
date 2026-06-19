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

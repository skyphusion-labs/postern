package main

import "fmt"

// OutboundMessage is the outbound transport contract (docs/CONTRACT.md section 3):
// a normalized, post-validation message ready to hand to a Transport. Field names
// and JSON tags map 1:1 to the TS OutboundMessage so core's RelayTransport can
// POST it here verbatim.
type OutboundMessage struct {
	MessageID string            `json:"messageId"` // core-generated, threads + stores the sent copy
	To        []string          `json:"to"`
	CC        []string          `json:"cc,omitempty"`
	BCC       []string          `json:"bcc,omitempty"`
	From      EmailAddress      `json:"from"` // already domain-checked by core's resolveFrom()
	ReplyTo   *EmailAddress     `json:"replyTo,omitempty"`
	Subject   string            `json:"subject"`
	HTML      string            `json:"html,omitempty"`
	Text      string            `json:"text,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"` // carries In-Reply-To / References on replies
}

// EmailAddress mirrors the TS {email, name} pair.
type EmailAddress struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

// recipients returns to+cc+bcc as the SMTP envelope RCPT TO list, de-duplicated
// while preserving order. BCC recipients are envelope-only (never headered).
func (m OutboundMessage) recipients() []string {
	seen := make(map[string]struct{})
	var out []string
	for _, group := range [][]string{m.To, m.CC, m.BCC} {
		for _, r := range group {
			if r == "" {
				continue
			}
			if _, dup := seen[r]; dup {
				continue
			}
			seen[r] = struct{}{}
			out = append(out, r)
		}
	}
	return out
}

// DispatchResult is what a Transport returns on success.
type DispatchResult struct {
	ProviderMessageID string `json:"providerMessageId,omitempty"`
}

// Transport is the outbound seam (CONTRACT section 3): Dispatch sends one
// already-validated OutboundMessage. The relay implements this with
// bring-your-own SMTP; core's own CfEmailTransport is the default that wraps
// env.EMAIL.send(). Both satisfy the same shape so a deployment swaps transports
// without touching the store or the API.
type Transport interface {
	Dispatch(msg OutboundMessage) (DispatchResult, error)
}

// newTransport selects the outbound transport from config. Today the relay only
// offers the bring-your-own SMTP transport (the reason it exists). The selector
// is the extension point for additional providers without touching callers.
func newTransport(cfg Config) (Transport, error) {
	if cfg.SMTPOut.Host == "" {
		return nil, fmt.Errorf("no outbound transport configured (set SMTP_OUT_HOST)")
	}
	return NewSMTPTransport(cfg.SMTPOut, cfg.OutboundFrom), nil
}

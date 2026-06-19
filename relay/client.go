package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const userAgent = "skyphusion-email-relay/0.2.0"

// EmailPayload mirrors the worker's legacy EmailRequest JSON shape (the pre-M3
// /send path, kept for back-compat).
type EmailPayload struct {
	To      []string `json:"to"`
	From    string   `json:"from,omitempty"`
	ReplyTo string   `json:"replyTo,omitempty"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html,omitempty"`
	Text    string   `json:"text,omitempty"`
}

// Client posts inbound mail to core. It targets the modern /ingest seam
// (ParsedInbound + transport token) when configured, and otherwise falls back to
// the legacy worker /send endpoint (EmailPayload + the legacy relay token).
type Client struct {
	ingestURL   string
	transportTk string
	legacyURL   string
	legacyTk    string
	hc          *http.Client
}

func NewClient(cfg Config) *Client {
	return &Client{
		ingestURL:   cfg.IngestURL,
		transportTk: cfg.TransportToken,
		legacyURL:   cfg.WorkerURL,
		legacyTk:    cfg.Token,
		hc:          &http.Client{Timeout: cfg.HTTPTimeout},
	}
}

// usesIngest reports whether the modern /ingest seam is configured.
func (c *Client) usesIngest() bool { return c.ingestURL != "" }

// PostIngest delivers a ParsedInbound to core's /ingest endpoint, gated by the
// transport token (CONTRACT section 2 + 5). This is the M3 inbound path.
func (c *Client) PostIngest(p ParsedInbound) error {
	return c.post(c.ingestURL, c.transportTk, p)
}

// Send posts a legacy EmailPayload to the worker /send endpoint (pre-M3 path).
func (c *Client) Send(p EmailPayload) error {
	return c.post(c.legacyURL, c.legacyTk, p)
}

func (c *Client) post(url, token string, v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	// urllib-style default UAs trip Cloudflare error 1010; always identify.
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("post to %s: %w", url, err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("core returned %d: %s", resp.StatusCode, bytes.TrimSpace(respBody))
	}
	return nil
}

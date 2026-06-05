package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const userAgent = "skyphusion-email-relay/0.1.0"

// EmailPayload mirrors the worker's EmailRequest JSON shape.
type EmailPayload struct {
	To      []string `json:"to"`
	From    string   `json:"from,omitempty"`
	ReplyTo string   `json:"replyTo,omitempty"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html,omitempty"`
	Text    string   `json:"text,omitempty"`
}

// Client POSTs payloads to the email worker's public /send endpoint.
type Client struct {
	url   string
	token string
	hc    *http.Client
}

func NewClient(cfg Config) *Client {
	return &Client{
		url:   cfg.WorkerURL,
		token: cfg.Token,
		hc:    &http.Client{Timeout: cfg.HTTPTimeout},
	}
}

func (c *Client) Send(p EmailPayload) error {
	body, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	// urllib-style default UAs trip Cloudflare error 1010; always identify.
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("post to worker: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("worker returned %d: %s", resp.StatusCode, bytes.TrimSpace(respBody))
	}
	return nil
}

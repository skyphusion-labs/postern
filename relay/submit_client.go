package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// errAuthFailed is returned by the SubmitClient when the worker accepts the
// transport token but rejects the user's credential (worker 200 {ok:false}). The
// submission session maps it to SMTP 535.
var errAuthFailed = errors.New("smtp-auth rejected the credential")

// sendError carries the worker /api/send HTTP status so the submission session
// can map it to the right SMTP reply code (permanent reject vs transient retry).
type sendError struct {
	status int
	msg    string
}

func (e *sendError) Error() string { return fmt.Sprintf("send failed (%d): %s", e.status, e.msg) }

// SendPayload mirrors the worker SendRequest JSON (inbound/src/mailbox.ts). The
// daemon sends from as a plain string (the bound identity); the worker's
// resolveFrom accepts a string and re-checks the domain.
type SendPayload struct {
	From    string            `json:"from"`
	To      []string          `json:"to"`
	CC      []string          `json:"cc,omitempty"`
	BCC     []string          `json:"bcc,omitempty"`
	Subject string            `json:"subject"`
	HTML    string            `json:"html,omitempty"`
	Text    string            `json:"text,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// SubmitClient talks to the worker for the submission seam (#68): it validates a
// client login at /api/smtp-auth (transport token) and bridges authenticated
// messages to /api/send (the mailbox API token). Two distinct tokens: an API
// token leak cannot inject the transport check and vice versa (CONTRACT 5/9).
type SubmitClient struct {
	authURL   string
	authToken string
	sendURL   string
	sendToken string
	hc        *http.Client
}

func NewSubmitClient(cfg Config) *SubmitClient {
	return &SubmitClient{
		authURL:   cfg.Submission.AuthURL,
		authToken: cfg.TransportToken,
		sendURL:   cfg.Submission.SendURL,
		sendToken: cfg.Submission.SendToken,
		hc:        &http.Client{Timeout: cfg.HTTPTimeout},
	}
}

// Authenticate validates {username, secret} via POST /api/smtp-auth. On success
// it returns the bound From identity the daemon then enforces on the message.
//
//   - returns (from, nil)            on a good credential
//   - returns ("", errAuthFailed)    on a bad credential (worker 200 {ok:false})
//   - returns ("", err)              on any infra failure (network, 401, 5xx)
func (c *SubmitClient) Authenticate(username, secret string) (string, error) {
	body, err := json.Marshal(map[string]string{"username": username, "secret": secret})
	if err != nil {
		return "", fmt.Errorf("marshal auth request: %w", err)
	}

	resp, err := c.do(c.authURL, c.authToken, body)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))

	// 401 means OUR transport token is wrong (a relay misconfig), not the user's
	// fault; surface it as an infra error so it is logged, not silently a 535.
	if resp.StatusCode == http.StatusUnauthorized {
		return "", fmt.Errorf("smtp-auth rejected the transport token (401): %s", bytes.TrimSpace(respBody))
	}
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("smtp-auth returned %d: %s", resp.StatusCode, bytes.TrimSpace(respBody))
	}

	var out struct {
		OK   bool   `json:"ok"`
		From string `json:"from"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		return "", fmt.Errorf("decode smtp-auth response: %w", err)
	}
	if !out.OK || out.From == "" {
		return "", errAuthFailed
	}
	return out.From, nil
}

// Send bridges an authenticated message to the worker /api/send seam (which
// DKIM-signs and stores the sent copy). A non-2xx returns a *sendError carrying
// the status so the caller can pick the right SMTP reply code.
func (c *SubmitClient) Send(p SendPayload) error {
	body, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal send payload: %w", err)
	}

	resp, err := c.do(c.sendURL, c.sendToken, body)
	if err != nil {
		// Network/connection failure reaching the worker: transient.
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))

	if resp.StatusCode/100 == 2 {
		return nil
	}
	return &sendError{status: resp.StatusCode, msg: string(bytes.TrimSpace(respBody))}
}

func (c *SubmitClient) do(url, token string, body []byte) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	// urllib-style default UAs trip Cloudflare error 1010; always identify.
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("post to %s: %w", url, err)
	}
	return resp, nil
}

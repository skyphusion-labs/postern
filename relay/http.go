package main

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// dispatchServer is the outbound bridge (CONTRACT section 3): core's
// RelayTransport POSTs an OutboundMessage here, and the relay sends it through
// the configured bring-your-own SMTP transport. It is gated by the transport
// token (POSTERN_TRANSPORT_TOKEN), never the mailbox API token (section 5/8).
type dispatchServer struct {
	transport Transport
	token     string
	maxBytes  int64
}

func newDispatchServer(transport Transport, token string, maxBytes int64) *dispatchServer {
	return &dispatchServer{transport: transport, token: token, maxBytes: maxBytes}
}

func (s *dispatchServer) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/dispatch", s.handleDispatch)
	return mux
}

func (s *dispatchServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *dispatchServer) handleDispatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.authorized(r) {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, s.maxBytes+1))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "read failed")
		return
	}
	if int64(len(body)) > s.maxBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "message too large")
		return
	}

	var msg OutboundMessage
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&msg); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid OutboundMessage JSON: "+err.Error())
		return
	}
	if len(msg.recipients()) == 0 {
		writeJSONError(w, http.StatusBadRequest, "no recipients (to/cc/bcc all empty)")
		return
	}
	if msg.Subject == "" && msg.Text == "" && msg.HTML == "" {
		writeJSONError(w, http.StatusBadRequest, "empty message (no subject, text, or html)")
		return
	}

	res, err := s.transport.Dispatch(msg)
	if err != nil {
		// 502: the upstream SMTP send failed; core may retry with backoff.
		log.Printf("dispatch failed messageId=%s to=%v: %v", msg.MessageID, msg.To, err)
		writeJSONError(w, http.StatusBadGateway, "dispatch failed: "+err.Error())
		return
	}
	log.Printf("dispatched messageId=%s to=%v", msg.MessageID, msg.To)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                true,
		"messageId":         msg.MessageID,
		"providerMessageId": res.ProviderMessageID,
	})
}

// authorized does a constant-time Bearer compare against the transport token.
// Length may leak (the token is high-entropy); the bytes must not.
func (s *dispatchServer) authorized(r *http.Request) bool {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	got := strings.TrimPrefix(h, prefix)
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"ok": false, "error": msg})
}

// startDispatchServer runs the /dispatch bridge until it errors. Returns a
// descriptive error when the listener exits.
func startDispatchServer(cfg Config, transport Transport) error {
	srv := newDispatchServer(transport, cfg.TransportToken, cfg.MaxSize)
	log.Printf("dispatch bridge listening on %s -> SMTP %s:%d", cfg.HTTPListen, cfg.SMTPOut.Host, cfg.SMTPOut.Port)
	hs := &http.Server{Addr: cfg.HTTPListen, Handler: srv.routes()}
	return fmt.Errorf("dispatch http server: %w", hs.ListenAndServe())
}

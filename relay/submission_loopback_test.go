package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/smtp"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// This is the aviation-grade end-to-end proof for the submission seam (#68/#76):
// it boots the REAL go-smtp submission server (the production newSubmissionServer
// + certReloader + native SubmitClient AuthProvider) on a loopback port with a
// self-signed cert, fronted by an httptest stand-in for the worker, and drives it
// with a stdlib net/smtp client over STARTTLS. It asserts on structured outcomes
// (SMTP reply codes + the recorded /api/send payload), never on prose:
//
//   - AUTH LOGIN over STARTTLS then send  -> message bridged to /api/send (250)
//   - send without AUTH                   -> rejected (502, auth required)
//   - AUTH with a bad credential          -> rejected (535)
//   - From header != bound identity       -> rejected (550, spoof guard)
//
// No public port, no real cert, no DNS: everything is 127.0.0.1 + a temp cert.

const (
	loopbackUser      = "alice"
	loopbackPass      = "correct-horse"
	loopbackBoundFrom = "alice@skyphusion.org"
	loopbackXportTok  = "transport-token-xyz"
	loopbackSendTok   = "send-token-abc"
)

// workerStub stands in for the Cloudflare worker: /api/smtp-auth (native login
// check, transport-token gated) and /api/send (the bridge target, API-token
// gated). It records the last send payload so the test can assert the bridge.
type workerStub struct {
	mu       sync.Mutex
	lastSend SendPayload
	sendHits int
}

func (w *workerStub) handler() http.Handler {
	mux := http.NewServeMux()

	// Native auth: validate {username, secret}; the bound From is returned on a
	// good credential. Gated by the TRANSPORT token (CONTRACT section 5/9).
	mux.HandleFunc("/api/smtp-auth", func(rw http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+loopbackXportTok {
			rw.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(rw).Encode(map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		var body struct{ Username, Secret string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Username == loopbackUser && body.Secret == loopbackPass {
			_ = json.NewEncoder(rw).Encode(map[string]any{"ok": true, "from": loopbackBoundFrom})
			return
		}
		_ = json.NewEncoder(rw).Encode(map[string]any{"ok": false, "error": "E_AUTH_FAILED"})
	})

	// Send bridge: gated by the mailbox API (send) token, NOT the transport token.
	mux.HandleFunc("/api/send", func(rw http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+loopbackSendTok {
			rw.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(rw).Encode(map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		var p SendPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			rw.WriteHeader(http.StatusBadRequest)
			return
		}
		w.mu.Lock()
		w.lastSend = p
		w.sendHits++
		w.mu.Unlock()
		_ = json.NewEncoder(rw).Encode(map[string]any{"ok": true, "messageId": "stub-id"})
	})

	return mux
}

func (w *workerStub) lastPayload() (SendPayload, int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.lastSend, w.sendHits
}

// writeSelfSignedCert generates a throwaway ECDSA cert for 127.0.0.1/localhost and
// writes cert+key PEMs to dir, returning their paths. This is the "self-signed for
// testing" path the daemon's cert reloader is built to read.
func writeSelfSignedCert(t *testing.T, dir string) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")

	certOut, _ := os.Create(certPath)
	_ = pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	_ = certOut.Close()

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyOut, _ := os.Create(keyPath)
	_ = pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	_ = keyOut.Close()
	return certPath, keyPath
}

// bootLoopbackSubmission stands up the real submission daemon (native backend)
// against the worker stub and returns the listen address. Mirrors startSubmission
// (cert reloader + TLS config + newSubmissionServer + NewSubmitClient) but on an
// ephemeral loopback port so the test owns the lifecycle.
func bootLoopbackSubmission(t *testing.T, ws *httptest.Server) string {
	t.Helper()
	dir := t.TempDir()
	certPath, keyPath := writeSelfSignedCert(t, dir)

	cfg := Config{
		MaxSize:        1 << 20,
		TransportToken: loopbackXportTok,
		HTTPTimeout:    10 * time.Second,
		Submission: SubmissionCfg{
			Hostname:  "localhost",
			Backend:   "native",
			TLSCert:   certPath,
			TLSKey:    keyPath,
			AuthURL:   ws.URL + "/api/smtp-auth",
			SendURL:   ws.URL + "/api/send",
			SendToken: loopbackSendTok,
		},
	}

	reloader, err := newCertReloader(cfg.Submission.TLSCert, cfg.Submission.TLSKey)
	if err != nil {
		t.Fatalf("cert reloader: %v", err)
	}
	tlsCfg := &tls.Config{GetCertificate: reloader.GetCertificate, MinVersion: tls.VersionTLS12}

	sc := NewSubmitClient(cfg)
	auth, err := selectAuthProvider(cfg, sc)
	if err != nil {
		t.Fatalf("select auth provider: %v", err)
	}
	be := &submissionBackend{cfg: cfg, auth: auth, sender: sc}

	srv := newSubmissionServer(be, tlsCfg, cfg)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().String()
}

// loginAuth implements AUTH LOGIN for the stdlib net/smtp client (which ships
// PLAIN + CRAM-MD5 but not LOGIN). This is the mechanism a real MUA commonly uses.
type loginAuth struct{ username, password string }

func (a loginAuth) Start(_ *smtp.ServerInfo) (string, []byte, error) {
	return "LOGIN", nil, nil
}

func (a loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	switch strings.ToLower(strings.TrimSpace(string(fromServer))) {
	case "username:":
		return []byte(a.username), nil
	case "password:":
		return []byte(a.password), nil
	default:
		return nil, fmt.Errorf("unexpected server challenge: %q", fromServer)
	}
}

func smtpErrCode(err error) int {
	var te *textproto.Error
	if errors.As(err, &te) {
		return te.Code
	}
	return 0
}

// dialSTARTTLS dials the loopback daemon and upgrades to TLS, the precondition for
// AUTH on every submission listener (AUTH is offered ONLY over TLS).
func dialSTARTTLS(t *testing.T, addr string) *smtp.Client {
	t.Helper()
	c, err := smtp.Dial(addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if err := c.Hello("localhost"); err != nil {
		t.Fatalf("EHLO: %v", err)
	}
	if ok, _ := c.Extension("STARTTLS"); !ok {
		t.Fatal("server did not advertise STARTTLS")
	}
	if err := c.StartTLS(&tls.Config{ServerName: "localhost", InsecureSkipVerify: true}); err != nil {
		t.Fatalf("STARTTLS: %v", err)
	}
	return c
}

func TestSubmissionLoopback_AuthThenSend(t *testing.T) {
	stub := &workerStub{}
	ws := httptest.NewServer(stub.handler())
	defer ws.Close()
	addr := bootLoopbackSubmission(t, ws)

	c := dialSTARTTLS(t, addr)
	defer c.Close()

	if err := c.Auth(loginAuth{loopbackUser, loopbackPass}); err != nil {
		t.Fatalf("AUTH LOGIN over STARTTLS: %v", err)
	}
	if err := c.Mail(loopbackBoundFrom); err != nil {
		t.Fatalf("MAIL FROM: %v", err)
	}
	if err := c.Rcpt("bob@example.com"); err != nil {
		t.Fatalf("RCPT TO: %v", err)
	}
	wc, err := c.Data()
	if err != nil {
		t.Fatalf("DATA: %v", err)
	}
	msg := "From: " + loopbackBoundFrom + "\r\n" +
		"To: bob@example.com\r\n" +
		"Subject: loopback hello\r\n" +
		"\r\n" +
		"sent through the real submission daemon\r\n"
	if _, err := wc.Write([]byte(msg)); err != nil {
		t.Fatalf("write DATA: %v", err)
	}
	if err := wc.Close(); err != nil {
		t.Fatalf("close DATA (server rejected the send): %v", err)
	}
	_ = c.Quit()

	payload, hits := stub.lastPayload()
	if hits != 1 {
		t.Fatalf("/api/send hit %d times, want 1", hits)
	}
	if payload.From != loopbackBoundFrom {
		t.Errorf("bridged From = %q, want %q", payload.From, loopbackBoundFrom)
	}
	if len(payload.To) != 1 || payload.To[0] != "bob@example.com" {
		t.Errorf("bridged To = %v, want [bob@example.com]", payload.To)
	}
	if payload.Subject != "loopback hello" {
		t.Errorf("bridged Subject = %q, want loopback hello", payload.Subject)
	}
}

func TestSubmissionLoopback_UnauthenticatedSendRejected(t *testing.T) {
	stub := &workerStub{}
	ws := httptest.NewServer(stub.handler())
	defer ws.Close()
	addr := bootLoopbackSubmission(t, ws)

	c := dialSTARTTLS(t, addr)
	defer c.Close()

	// No AUTH: MAIL FROM must be refused (go-smtp maps ErrAuthRequired to 502
	// "Please authenticate first"), and nothing bridged to the worker.
	err := c.Mail(loopbackBoundFrom)
	if err == nil {
		t.Fatal("MAIL FROM without AUTH succeeded; want rejection")
	}
	if code := smtpErrCode(err); code != 502 {
		t.Errorf("unauthenticated MAIL code = %d (err=%v), want 502 (auth required)", code, err)
	}
	if _, hits := stub.lastPayload(); hits != 0 {
		t.Errorf("/api/send hit %d times for an unauthenticated session, want 0", hits)
	}
}

func TestSubmissionLoopback_BadCredentialRejected(t *testing.T) {
	stub := &workerStub{}
	ws := httptest.NewServer(stub.handler())
	defer ws.Close()
	addr := bootLoopbackSubmission(t, ws)

	c := dialSTARTTLS(t, addr)
	defer c.Close()

	err := c.Auth(loginAuth{loopbackUser, "wrong-password"})
	if err == nil {
		t.Fatal("AUTH with a bad credential succeeded; want 535")
	}
	if code := smtpErrCode(err); code != 535 {
		t.Errorf("bad-credential AUTH code = %d (err=%v), want 535", code, err)
	}
}

func TestSubmissionLoopback_OffDomainFromRejected(t *testing.T) {
	stub := &workerStub{}
	ws := httptest.NewServer(stub.handler())
	defer ws.Close()
	addr := bootLoopbackSubmission(t, ws)

	c := dialSTARTTLS(t, addr)
	defer c.Close()

	if err := c.Auth(loginAuth{loopbackUser, loopbackPass}); err != nil {
		t.Fatalf("AUTH: %v", err)
	}
	if err := c.Mail(loopbackBoundFrom); err != nil {
		t.Fatalf("MAIL FROM: %v", err)
	}
	if err := c.Rcpt("bob@example.com"); err != nil {
		t.Fatalf("RCPT TO: %v", err)
	}
	wc, err := c.Data()
	if err != nil {
		t.Fatalf("DATA: %v", err)
	}
	// The header From spoofs a different identity than the authenticated one.
	msg := "From: evil@attacker.example\r\n" +
		"To: bob@example.com\r\n" +
		"Subject: spoof\r\n" +
		"\r\n" +
		"this From does not match the login\r\n"
	if _, err := wc.Write([]byte(msg)); err != nil {
		t.Fatalf("write DATA: %v", err)
	}
	err = wc.Close()
	if err == nil {
		t.Fatal("off-domain From accepted; want a 550 spoof rejection")
	}
	if code := smtpErrCode(err); code != 550 {
		t.Errorf("off-domain From code = %d (err=%v), want 550", code, err)
	}
	if _, hits := stub.lastPayload(); hits != 0 {
		t.Errorf("/api/send hit %d times for a spoofed From, want 0", hits)
	}
}

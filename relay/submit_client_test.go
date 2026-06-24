package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newSubmitClientFor(authURL, sendURL string) *SubmitClient {
	return &SubmitClient{
		authURL:   authURL,
		authToken: "transport-secret",
		sendURL:   sendURL,
		sendToken: "api-secret",
		hc:        &http.Client{Timeout: 5 * time.Second},
	}
}

func TestSubmitClient_Authenticate(t *testing.T) {
	t.Run("good credential returns bound From and sends the transport token", func(t *testing.T) {
		var gotAuth, gotBody string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			b, _ := io.ReadAll(r.Body)
			gotBody = string(b)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"from":"alice@skyphusion.org"}`))
		}))
		defer srv.Close()

		c := newSubmitClientFor(srv.URL, "")
		from, err := c.Authenticate("alice@skyphusion.org", "pw")
		if err != nil {
			t.Fatalf("Authenticate: %v", err)
		}
		if from != "alice@skyphusion.org" {
			t.Errorf("from = %q", from)
		}
		if gotAuth != "Bearer transport-secret" {
			t.Errorf("auth header = %q, want the TRANSPORT token", gotAuth)
		}
		var sent map[string]string
		if err := json.Unmarshal([]byte(gotBody), &sent); err != nil {
			t.Fatalf("body not JSON: %v", err)
		}
		if sent["username"] != "alice@skyphusion.org" || sent["secret"] != "pw" {
			t.Errorf("body = %v", sent)
		}
	})

	t.Run("bad credential -> errAuthFailed", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"ok":false}`))
		}))
		defer srv.Close()
		c := newSubmitClientFor(srv.URL, "")
		if _, err := c.Authenticate("x@skyphusion.org", "bad"); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed", err)
		}
	})

	t.Run("401 transport token -> infra error, not errAuthFailed", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"ok":false,"error":"unauthorized"}`))
		}))
		defer srv.Close()
		c := newSubmitClientFor(srv.URL, "")
		_, err := c.Authenticate("x@skyphusion.org", "pw")
		if err == nil || err == errAuthFailed {
			t.Errorf("err = %v, want a non-nil infra error (config problem, not a bad credential)", err)
		}
	})

	t.Run("ok:true but empty From -> errAuthFailed", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"ok":true,"from":""}`))
		}))
		defer srv.Close()
		c := newSubmitClientFor(srv.URL, "")
		if _, err := c.Authenticate("x@skyphusion.org", "pw"); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed", err)
		}
	})
}

func TestSubmitClient_Send(t *testing.T) {
	t.Run("2xx is success and carries the API token", func(t *testing.T) {
		var gotAuth string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			_, _ = w.Write([]byte(`{"ok":true,"messageId":"m@x"}`))
		}))
		defer srv.Close()
		c := newSubmitClientFor("", srv.URL)
		if err := c.Send(SendPayload{From: "a@skyphusion.org", To: []string{"d@x"}, Subject: "s", Text: "b"}); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if gotAuth != "Bearer api-secret" {
			t.Errorf("auth header = %q, want the API (send) token", gotAuth)
		}
	})

	t.Run("non-2xx returns a sendError carrying the status", func(t *testing.T) {
		for _, code := range []int{400, 403, 413, 500, 502} {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(code)
				_, _ = w.Write([]byte(`{"ok":false,"error":"E_X"}`))
			}))
			c := newSubmitClientFor("", srv.URL)
			err := c.Send(SendPayload{From: "a@skyphusion.org", To: []string{"d@x"}, Subject: "s", Text: "b"})
			se, ok := err.(*sendError)
			if !ok {
				srv.Close()
				t.Fatalf("status %d: err type = %T, want *sendError", code, err)
			}
			if se.status != code {
				t.Errorf("sendError.status = %d, want %d", se.status, code)
			}
			srv.Close()
		}
	})

	t.Run("network failure is a plain error (transient)", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		url := srv.URL
		srv.Close() // nothing is listening now
		c := newSubmitClientFor("", url)
		err := c.Send(SendPayload{From: "a@skyphusion.org", To: []string{"d@x"}, Subject: "s", Text: "b"})
		if err == nil {
			t.Fatal("want a network error, got nil")
		}
		if _, ok := err.(*sendError); ok {
			t.Errorf("network failure should not be a *sendError (it has no HTTP status): %v", err)
		}
	})
}

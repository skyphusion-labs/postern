package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubTransport records the last dispatched message and returns a canned result.
type stubTransport struct {
	last OutboundMessage
	err  error
}

func (s *stubTransport) Dispatch(msg OutboundMessage) (DispatchResult, error) {
	s.last = msg
	if s.err != nil {
		return DispatchResult{}, s.err
	}
	return DispatchResult{ProviderMessageID: "stub-" + msg.MessageID}, nil
}

const testToken = "transport-secret-token"

func newTestServer(tr Transport) http.Handler {
	return newDispatchServer(tr, testToken, 1<<20).routes()
}

func postDispatch(t *testing.T, h http.Handler, auth, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/dispatch", strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestDispatch_RequiresAuth(t *testing.T) {
	h := newTestServer(&stubTransport{})
	valid := `{"messageId":"m@x","to":["d@x"],"from":{"email":"n@skyphusion.org"},"subject":"s","text":"t"}`

	if rr := postDispatch(t, h, "", valid); rr.Code != http.StatusUnauthorized {
		t.Errorf("no auth: code = %d, want 401", rr.Code)
	}
	if rr := postDispatch(t, h, "Bearer wrong", valid); rr.Code != http.StatusUnauthorized {
		t.Errorf("wrong token: code = %d, want 401", rr.Code)
	}
	if rr := postDispatch(t, h, "Basic "+testToken, valid); rr.Code != http.StatusUnauthorized {
		t.Errorf("non-bearer scheme: code = %d, want 401", rr.Code)
	}
}

func TestDispatch_HappyPath(t *testing.T) {
	stub := &stubTransport{}
	h := newTestServer(stub)
	body := `{"messageId":"m@x","to":["d@x"],"cc":["c@x"],"from":{"email":"n@skyphusion.org","name":"Postern"},"subject":"hi","text":"body","headers":{"In-Reply-To":"<prev@x>"}}`

	rr := postDispatch(t, h, "Bearer "+testToken, body)
	if rr.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	if stub.last.MessageID != "m@x" {
		t.Errorf("transport got messageId %q", stub.last.MessageID)
	}
	if stub.last.From.Email != "n@skyphusion.org" {
		t.Errorf("transport got from %q", stub.last.From.Email)
	}
	if stub.last.Headers["In-Reply-To"] != "<prev@x>" {
		t.Errorf("In-Reply-To not carried: %#v", stub.last.Headers)
	}
	if !strings.Contains(rr.Body.String(), "stub-m@x") {
		t.Errorf("response missing providerMessageId: %s", rr.Body.String())
	}
}

func TestDispatch_RejectsBadInput(t *testing.T) {
	h := newTestServer(&stubTransport{})

	// no recipients
	if rr := postDispatch(t, h, "Bearer "+testToken, `{"messageId":"m@x","from":{"email":"n@x"},"subject":"s","text":"t"}`); rr.Code != http.StatusBadRequest {
		t.Errorf("no recipients: code = %d, want 400", rr.Code)
	}
	// empty content
	if rr := postDispatch(t, h, "Bearer "+testToken, `{"messageId":"m@x","to":["d@x"],"from":{"email":"n@x"}}`); rr.Code != http.StatusBadRequest {
		t.Errorf("empty content: code = %d, want 400", rr.Code)
	}
	// unknown field (DisallowUnknownFields catches contract drift)
	if rr := postDispatch(t, h, "Bearer "+testToken, `{"to":["d@x"],"subject":"s","text":"t","bogus":1}`); rr.Code != http.StatusBadRequest {
		t.Errorf("unknown field: code = %d, want 400", rr.Code)
	}
	// invalid JSON
	if rr := postDispatch(t, h, "Bearer "+testToken, `not json`); rr.Code != http.StatusBadRequest {
		t.Errorf("invalid json: code = %d, want 400", rr.Code)
	}
}

func TestDispatch_TransportFailureIs502(t *testing.T) {
	h := newTestServer(&stubTransport{err: errStub})
	body := `{"messageId":"m@x","to":["d@x"],"from":{"email":"n@x"},"subject":"s","text":"t"}`
	rr := postDispatch(t, h, "Bearer "+testToken, body)
	if rr.Code != http.StatusBadGateway {
		t.Errorf("transport error: code = %d, want 502", rr.Code)
	}
}

func TestHealthz(t *testing.T) {
	h := newTestServer(&stubTransport{})
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("healthz code = %d, want 200", rr.Code)
	}
}

var errStub = &stubErr{}

type stubErr struct{}

func (*stubErr) Error() string { return "upstream smtp down" }

package main

import (
	"testing"
	"time"

	"github.com/emersion/go-smtp"
)

// countingAuth counts Authenticate calls so a test can prove a throttled attempt
// is short-circuited BEFORE the backend (no work done on a locked account).
type countingAuth struct {
	calls int
	err   error
	from  string
}

func (c *countingAuth) Authenticate(_, _ string) (string, error) {
	c.calls++
	return c.from, c.err
}

func TestSubmission_ThrottleLocksAndShortCircuits(t *testing.T) {
	clock, cur := fixedClock(time.Unix(2_000_000, 0))
	th := newAuthThrottle(ThrottleCfg{
		Enabled: true, MaxFailures: 3, Lockout: 60 * time.Second,
		MaxLockout: 600 * time.Second, GlobalWindow: 60 * time.Second,
	}, clock)
	auth := &countingAuth{err: errAuthFailed}
	s := &submissionSession{auth: auth, throttle: th}

	// Three bad attempts: each reaches the backend and fails.
	for i := 0; i < 3; i++ {
		if err := s.authenticate("alice@skyphusion.org", "bad"); err != smtp.ErrAuthFailed {
			t.Fatalf("attempt %d err=%v, want ErrAuthFailed", i, err)
		}
	}
	if auth.calls != 3 {
		t.Fatalf("backend calls = %d, want 3", auth.calls)
	}

	// Fourth attempt is locked: SAME generic ErrAuthFailed, backend NOT called
	// (enumeration-safe + no work for the attacker).
	if err := s.authenticate("alice@skyphusion.org", "bad"); err != smtp.ErrAuthFailed {
		t.Fatalf("locked attempt err=%v, want ErrAuthFailed", err)
	}
	if auth.calls != 3 {
		t.Errorf("backend was called while locked: calls=%d, want 3", auth.calls)
	}

	// A case-variation of the same account is the SAME key, so also locked.
	if err := s.authenticate("ALICE@skyphusion.org", "bad"); err != smtp.ErrAuthFailed {
		t.Fatalf("case-variant err=%v", err)
	}
	if auth.calls != 3 {
		t.Errorf("case-variation bypassed the throttle: calls=%d, want 3", auth.calls)
	}

	// After the lockout window the backend is reachable again, and a good login works.
	*cur = cur.Add(61 * time.Second)
	auth.err = nil
	auth.from = "alice@skyphusion.org"
	if err := s.authenticate("alice@skyphusion.org", "good"); err != nil {
		t.Fatalf("post-lockout good auth err=%v", err)
	}
	if auth.calls != 4 {
		t.Errorf("post-lockout backend calls = %d, want 4", auth.calls)
	}
	if !s.authed || s.boundFrom != "alice@skyphusion.org" {
		t.Error("session should be authed + bound after the good post-lockout login")
	}
}

func TestSubmission_ThrottleInfraErrorDoesNotCount(t *testing.T) {
	// An infra error (backend down) is NOT a password guess, so it must not advance
	// the throttle -- an outage must never lock legitimate users out.
	th := newAuthThrottle(ThrottleCfg{
		Enabled: true, MaxFailures: 2, Lockout: 60 * time.Second,
		MaxLockout: 600 * time.Second, GlobalWindow: 60 * time.Second,
	}, nil)
	auth := &countingAuth{err: &sendError{status: 500, msg: "down"}}
	s := &submissionSession{auth: auth, throttle: th}

	for i := 0; i < 5; i++ {
		if err := s.authenticate("bob@skyphusion.org", "pw"); err != smtp.ErrAuthFailed {
			t.Fatalf("infra attempt %d err=%v, want ErrAuthFailed", i, err)
		}
	}
	// Never locked despite 5 infra errors: the backend was hit every time.
	if auth.calls != 5 {
		t.Errorf("backend calls = %d, want 5 (infra errors must not lock out)", auth.calls)
	}
}

func TestSubmission_ThrottleNilDisabledUnaffected(t *testing.T) {
	// A session with no throttle (nil) or a disabled one behaves exactly as before.
	auth := &countingAuth{err: errAuthFailed}
	s := &submissionSession{auth: auth} // throttle nil
	for i := 0; i < 10; i++ {
		if err := s.authenticate("x@skyphusion.org", "bad"); err != smtp.ErrAuthFailed {
			t.Fatalf("err=%v", err)
		}
	}
	if auth.calls != 10 {
		t.Errorf("nil throttle changed behavior: calls=%d, want 10", auth.calls)
	}
}

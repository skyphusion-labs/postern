package main

import (
	"fmt"
	"testing"
	"time"
)

func fixedClock(start time.Time) (func() time.Time, *time.Time) {
	cur := start
	return func() time.Time { return cur }, &cur
}

func baseThrottle(now func() time.Time) *authThrottle {
	return newAuthThrottle(ThrottleCfg{
		Enabled:      true,
		MaxFailures:  3,
		Lockout:      60 * time.Second,
		MaxLockout:   600 * time.Second,
		GlobalMax:    100,
		GlobalWindow: 60 * time.Second,
	}, now)
}

func TestThrottle_PerAccountLockout(t *testing.T) {
	clock, cur := fixedClock(time.Unix(1_000_000, 0))
	th := baseThrottle(clock)
	acct := "alice@x"

	// Two failures: still under the threshold of 3.
	th.fail(acct)
	th.fail(acct)
	if !th.allow(acct) {
		t.Fatal("account should not be locked at 2 failures (threshold 3)")
	}
	// Third failure locks it.
	th.fail(acct)
	if th.allow(acct) {
		t.Fatal("account should be locked after 3 failures")
	}
	// A different account is unaffected (per-account, not global).
	if !th.allow("bob@x") {
		t.Fatal("an unrelated account must not be locked")
	}
	// Still locked just before the 60s base window, unlocked just after.
	*cur = cur.Add(59 * time.Second)
	if th.allow(acct) {
		t.Fatal("should still be locked at 59s")
	}
	*cur = cur.Add(2 * time.Second)
	if !th.allow(acct) {
		t.Fatal("should be unlocked after the 60s window")
	}
}

func TestThrottle_SuccessResets(t *testing.T) {
	clock, _ := fixedClock(time.Unix(1_000_000, 0))
	th := baseThrottle(clock)
	acct := "carol@x"
	th.fail(acct)
	th.fail(acct)
	th.success(acct) // a correct password fully resets the counter
	th.fail(acct)
	th.fail(acct)
	if !th.allow(acct) {
		t.Fatal("should not be locked after reset + only 2 failures")
	}
	th.fail(acct)
	if th.allow(acct) {
		t.Fatal("should lock after 3 post-reset failures")
	}
}

func TestThrottle_BackoffGrowsAndCaps(t *testing.T) {
	clock, cur := fixedClock(time.Unix(1_000_000, 0))
	// MaxFailures 1 so every failure past the first extends the lockout.
	th := newAuthThrottle(ThrottleCfg{
		Enabled: true, MaxFailures: 1, Lockout: 100 * time.Second,
		MaxLockout: 300 * time.Second, GlobalWindow: 60 * time.Second,
	}, clock)
	acct := "dave@x"

	th.fail(acct) // 1st -> 100s
	if got := th.accounts[acct].lockedUntil.Sub(*cur); got != 100*time.Second {
		t.Fatalf("lockout 1 = %v, want 100s", got)
	}
	th.fail(acct) // 2nd -> 200s
	if got := th.accounts[acct].lockedUntil.Sub(*cur); got != 200*time.Second {
		t.Fatalf("lockout 2 = %v, want 200s", got)
	}
	th.fail(acct) // 3rd -> 400s, capped to 300s
	if got := th.accounts[acct].lockedUntil.Sub(*cur); got != 300*time.Second {
		t.Fatalf("lockout 3 = %v, want 300s (capped)", got)
	}
}

func TestThrottle_GlobalCooldown(t *testing.T) {
	clock, cur := fixedClock(time.Unix(1_000_000, 0))
	// Per-account threshold huge so ONLY the global ceiling can trip: this is the
	// spread-spraying case (one guess each across many accounts behind one IP).
	th := newAuthThrottle(ThrottleCfg{
		Enabled: true, MaxFailures: 1000, Lockout: 60 * time.Second,
		MaxLockout: 600 * time.Second, GlobalMax: 5, GlobalWindow: 60 * time.Second,
	}, clock)

	for i := 0; i < 6; i++ {
		th.fail(fmt.Sprintf("u%d@x", i))
	}
	if th.allow("fresh@x") {
		t.Fatal("global cooldown should deny even a never-seen account")
	}
	*cur = cur.Add(61 * time.Second)
	if !th.allow("fresh@x") {
		t.Fatal("global cooldown should expire after the window")
	}
}

func TestThrottle_DisabledAlwaysAllows(t *testing.T) {
	th := newAuthThrottle(ThrottleCfg{Enabled: false, MaxFailures: 1}, nil)
	for i := 0; i < 100; i++ {
		th.fail("x@x")
	}
	if !th.allow("x@x") {
		t.Fatal("a disabled throttle must always allow")
	}
}

func TestThrottle_NilSafe(t *testing.T) {
	var th *authThrottle
	if !th.allow("x") {
		t.Fatal("nil throttle must allow")
	}
	th.fail("x")    // must not panic
	th.success("x") // must not panic
}

func TestThrottleKey_Normalizes(t *testing.T) {
	if got := throttleKey("  Alice@X.com "); got != "alice@x.com" {
		t.Errorf("throttleKey = %q, want alice@x.com", got)
	}
}

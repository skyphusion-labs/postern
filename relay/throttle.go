package main

import (
	"strings"
	"sync"
	"time"
)

// authThrottle is the application-level online brute-force throttle for the
// submission auth door (#105, audit F2). It is keyed on the presented ACCOUNT, not
// the source IP: behind the bastion every public connection presents one
// source IP (the bastion masquerade), so per-IP throttling is blind. A second,
// GLOBAL layer bounds spread-account spraying (one guess each across many accounts)
// through that single IP.
//
// Properties:
//   - fail-CLOSED + enumeration-SAFE: a throttled attempt returns the SAME generic
//     auth failure as a wrong password, and existent + non-existent usernames are
//     throttled identically, so the throttle never reveals whether an account
//     exists (it only ever reveals "you have been failing on this name", which the
//     attacker already knows).
//   - only real password rejections count; an infra error (backend down) does NOT,
//     so an outage cannot lock users out.
//   - in-memory + per-process. The submission daemon is a single process, so this
//     is sufficient; a multi-instance deploy would need a shared store (documented).
//
// All methods are safe on a nil receiver and no-op when disabled, so a session
// built without a throttle (tests) behaves as before.
type authThrottle struct {
	enabled      bool
	maxFailures  int           // per-account consecutive failures before lockout
	lockout      time.Duration // base per-account lockout; doubles per failure past the threshold
	maxLockout   time.Duration // cap on the per-account backoff window (also the idle-decay window)
	globalMax    int           // aggregate failures within globalWindow before a global cooldown (0 = off)
	globalWindow time.Duration

	now func() time.Time // injectable clock (tests)

	mu          sync.Mutex
	accounts    map[string]*acctFailState
	globalCount int
	globalStart time.Time
	globalUntil time.Time
}

type acctFailState struct {
	failures    int
	lastFailure time.Time
	lockedUntil time.Time
}

// newAuthThrottle builds a throttle from config. A nil clock defaults to time.Now.
// Knobs are clamped to sane minimums so a misconfig cannot disable the control
// while leaving it "enabled".
func newAuthThrottle(cfg ThrottleCfg, now func() time.Time) *authThrottle {
	if now == nil {
		now = time.Now
	}
	maxFailures := cfg.MaxFailures
	if maxFailures < 1 {
		maxFailures = 5
	}
	lockout := cfg.Lockout
	if lockout <= 0 {
		lockout = 60 * time.Second
	}
	maxLockout := cfg.MaxLockout
	if maxLockout < lockout {
		maxLockout = lockout
	}
	globalWindow := cfg.GlobalWindow
	if globalWindow <= 0 {
		globalWindow = 60 * time.Second
	}
	return &authThrottle{
		enabled:      cfg.Enabled,
		maxFailures:  maxFailures,
		lockout:      lockout,
		maxLockout:   maxLockout,
		globalMax:    cfg.GlobalMax,
		globalWindow: globalWindow,
		now:          now,
		accounts:     make(map[string]*acctFailState),
	}
}

// throttleKey normalizes a username into the throttle's account key: lower-cased
// and trimmed, so trivial case variations cannot multiply the failure budget.
func throttleKey(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// allow reports whether an auth attempt for account may proceed to the backend. It
// returns false when a global cooldown is in effect OR the account is in a
// per-account lockout. A denial is treated by the caller as a generic auth failure.
func (t *authThrottle) allow(account string) bool {
	if t == nil || !t.enabled {
		return true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	if now.Before(t.globalUntil) {
		return false
	}
	st := t.accounts[account]
	if st == nil {
		return true
	}
	return !now.Before(st.lockedUntil)
}

// fail records a real password rejection for account and updates the per-account
// and global lockouts.
func (t *authThrottle) fail(account string) {
	if t == nil || !t.enabled {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()

	st := t.accounts[account]
	if st == nil {
		st = &acctFailState{}
		t.accounts[account] = st
	}
	// Idle decay: a long-quiet account starts fresh (bounds memory and avoids
	// escalating against failures spread hours apart).
	if !st.lastFailure.IsZero() && now.Sub(st.lastFailure) > t.maxLockout {
		st.failures = 0
		st.lockedUntil = time.Time{}
	}
	st.failures++
	st.lastFailure = now
	if st.failures >= t.maxFailures {
		st.lockedUntil = now.Add(t.backoff(st.failures))
	}

	// Global layer: count failures within a sliding window; once the ceiling is
	// crossed, cool down ALL auth for one window (spread-spraying backstop).
	if now.Sub(t.globalStart) > t.globalWindow {
		t.globalCount = 0
		t.globalStart = now
	}
	t.globalCount++
	if t.globalMax > 0 && t.globalCount > t.globalMax {
		t.globalUntil = now.Add(t.globalWindow)
	}

	t.pruneLocked(now)
}

// success clears an account's failure state (a correct password fully resets it).
func (t *authThrottle) success(account string) {
	if t == nil || !t.enabled {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.accounts, account)
}

// backoff is the per-account lockout duration: the base doubled once per failure
// beyond the threshold, capped at maxLockout.
func (t *authThrottle) backoff(failures int) time.Duration {
	d := t.lockout
	for i := 0; i < failures-t.maxFailures && d < t.maxLockout; i++ {
		d *= 2
	}
	if d > t.maxLockout {
		d = t.maxLockout
	}
	return d
}

// pruneLocked drops idle account entries so the map cannot grow unbounded under a
// username-spraying attack. Called under lock; only scans once the map is large.
func (t *authThrottle) pruneLocked(now time.Time) {
	if len(t.accounts) < 1024 {
		return
	}
	for k, st := range t.accounts {
		if now.Sub(st.lastFailure) > t.maxLockout && now.After(st.lockedUntil) {
			delete(t.accounts, k)
		}
	}
}

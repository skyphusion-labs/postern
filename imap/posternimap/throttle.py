"""Application-level online brute-force throttle for the IMAP auth door (#105).

The Python mirror of the SMTP relay's throttle (relay/throttle.go), built to the
RATIFIED cross-door contract (#105): identical AUTH_THROTTLE_* knobs (integer
seconds) and the two behavioural invariants both doors enforce:

  1. Only a real password rejection counts. An infra/backend error (store or
     directory down) must NOT count, so an outage can never lock users out. This
     module only advances state when the caller invokes fail(); the caller calls
     fail() solely on a genuine bad-credential result, never on a backend fault.
  2. A throttled/locked attempt must be INDISTINGUISHABLE from a normal auth
     failure (no account-existence leak). allow() only returns False; the caller
     returns the same generic UnauthorizedLogin it returns for a wrong password,
     and existent + non-existent usernames are throttled identically.

Keyed on the presented ACCOUNT, not the source IP: behind the bastion
every external connection presents one masqueraded source IP, so per-IP is blind.
A second GLOBAL layer bounds spread-account spraying through that single IP.

In-memory + per-process (one portal per proxy process), matching the Go side; a
multi-instance deploy would need a shared store (documented). Disabled = no-op.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, Optional


def throttle_key(username: str) -> str:
    """Normalize a username into the throttle key: trimmed + lower-cased, so case
    variations cannot multiply the failure budget (mirrors relay throttleKey)."""
    return username.strip().lower()


@dataclass
class _AcctState:
    failures: int = 0
    last_failure: Optional[float] = None  # None == never failed
    locked_until: float = 0.0


class AuthThrottle:
    """Per-account + global auth throttle. All methods are safe when disabled
    (no-op) so a portal built without throttling behaves as before."""

    def __init__(
        self,
        *,
        enabled: bool,
        max_failures: int,
        lockout_seconds: float,
        max_lockout_seconds: float,
        global_max_failures: int,
        global_window_seconds: float,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        # Clamp to sane minimums so a misconfig cannot leave the control "enabled"
        # but toothless (mirrors newAuthThrottle).
        self._enabled = enabled
        self._max_failures = max_failures if max_failures >= 1 else 5
        self._lockout = lockout_seconds if lockout_seconds > 0 else 60.0
        self._max_lockout = max_lockout_seconds if max_lockout_seconds >= self._lockout else self._lockout
        self._global_max = global_max_failures
        self._global_window = global_window_seconds if global_window_seconds > 0 else 60.0
        # Monotonic by default: immune to wall-clock jumps (NTP / DST).
        self._now = now or time.monotonic
        self._lock = threading.Lock()
        self._accounts: Dict[str, _AcctState] = {}
        self._global_count = 0
        self._global_start = 0.0
        self._global_until = 0.0

    def allow(self, account: str) -> bool:
        """True if an attempt for account may proceed to the backend. False under a
        global cooldown OR a per-account lockout; the caller treats False as a
        generic auth failure (invariant 2)."""
        if not self._enabled:
            return True
        with self._lock:
            now = self._now()
            if now < self._global_until:
                return False
            st = self._accounts.get(account)
            if st is None:
                return True
            return not (now < st.locked_until)

    def fail(self, account: str) -> None:
        """Record a real password rejection (invariant 1: callers never invoke this
        for an infra/backend fault) and update per-account + global lockouts."""
        if not self._enabled:
            return
        with self._lock:
            now = self._now()
            st = self._accounts.get(account)
            if st is None:
                st = _AcctState()
                self._accounts[account] = st
            # Idle decay: a long-quiet account starts fresh (bounds memory, avoids
            # escalating across failures spread hours apart).
            if st.last_failure is not None and (now - st.last_failure) > self._max_lockout:
                st.failures = 0
                st.locked_until = 0.0
            st.failures += 1
            st.last_failure = now
            if st.failures >= self._max_failures:
                st.locked_until = now + self._backoff(st.failures)
            # Global layer: failures within a sliding window; crossing the ceiling
            # cools down ALL auth for one window (spread-spraying backstop).
            if (now - self._global_start) > self._global_window:
                self._global_count = 0
                self._global_start = now
            self._global_count += 1
            if self._global_max > 0 and self._global_count > self._global_max:
                self._global_until = now + self._global_window
            self._prune_locked(now)

    def success(self, account: str) -> None:
        """A correct password fully resets the account's failure state."""
        if not self._enabled:
            return
        with self._lock:
            self._accounts.pop(account, None)

    def _backoff(self, failures: int) -> float:
        # base, doubled once per failure beyond the threshold, capped at maxLockout.
        d = self._lockout
        i = 0
        while i < failures - self._max_failures and d < self._max_lockout:
            d *= 2
            i += 1
        return min(d, self._max_lockout)

    def _prune_locked(self, now: float) -> None:
        # Drop idle entries so the map cannot grow unbounded under username spraying.
        if len(self._accounts) < 1024:
            return
        for k in list(self._accounts):
            st = self._accounts[k]
            if st.last_failure is not None and (now - st.last_failure) > self._max_lockout and now > st.locked_until:
                del self._accounts[k]


def build_throttle(cfg, now: Optional[Callable[[], float]] = None) -> AuthThrottle:
    """Construct the throttle from Config (AUTH_THROTTLE_* knobs)."""
    return AuthThrottle(
        enabled=cfg.throttle_enabled,
        max_failures=cfg.throttle_max_failures,
        lockout_seconds=cfg.throttle_lockout_seconds,
        max_lockout_seconds=cfg.throttle_max_lockout_seconds,
        global_max_failures=cfg.throttle_global_max_failures,
        global_window_seconds=cfg.throttle_global_window_seconds,
        now=now,
    )

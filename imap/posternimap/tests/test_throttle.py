"""Auth brute-force throttle (#105): unit behaviour + portal integration.

The unit tests drive a virtual clock (no real time). The integration tests prove
the two RATIFIED invariants through the real twisted.cred checker: a throttled
attempt is byte-identical to a normal auth failure, and an infra/backend error
never counts toward lockout.
"""

from __future__ import annotations

import unittest

from posternimap.config import Config
from posternimap.throttle import AuthThrottle, build_throttle, throttle_key


class _Clock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, d: float) -> None:
        self.t += d


def _throttle(clock, **over):
    base = dict(
        enabled=True,
        max_failures=3,
        lockout_seconds=60,
        max_lockout_seconds=900,
        global_max_failures=0,  # off unless a test opts in
        global_window_seconds=60,
        now=clock,
    )
    base.update(over)
    return AuthThrottle(**base)


class ThrottleUnitTest(unittest.TestCase):
    def test_disabled_is_always_allow_and_noop(self):
        c = _Clock()
        t = _throttle(c, enabled=False, max_failures=1)
        for _ in range(10):
            t.fail("a")
        self.assertTrue(t.allow("a"))

    def test_locks_after_max_failures_then_expires(self):
        c = _Clock()
        t = _throttle(c, max_failures=3, lockout_seconds=60)
        self.assertTrue(t.allow("u"))
        t.fail("u"); t.fail("u")
        self.assertTrue(t.allow("u"))   # under threshold
        t.fail("u")                      # 3rd failure -> locked
        self.assertFalse(t.allow("u"))
        c.advance(59)
        self.assertFalse(t.allow("u"))
        c.advance(1.1)
        self.assertTrue(t.allow("u"))    # lockout elapsed

    def test_backoff_doubles_past_threshold_capped(self):
        c = _Clock()
        t = _throttle(c, max_failures=2, lockout_seconds=10, max_lockout_seconds=40)
        t.fail("u"); t.fail("u")                       # failures=2 -> backoff 10
        self.assertEqual(t._accounts["u"].locked_until, c.t + 10)
        t.fail("u")                                    # 3 -> 20
        self.assertEqual(t._accounts["u"].locked_until, c.t + 20)
        t.fail("u")                                    # 4 -> 40 (cap)
        self.assertEqual(t._accounts["u"].locked_until, c.t + 40)
        t.fail("u")                                    # 5 -> still capped at 40
        self.assertEqual(t._accounts["u"].locked_until, c.t + 40)

    def test_success_resets_account(self):
        c = _Clock()
        t = _throttle(c, max_failures=2)
        t.fail("u"); t.fail("u")
        self.assertFalse(t.allow("u"))
        t.success("u")
        self.assertTrue(t.allow("u"))
        self.assertNotIn("u", t._accounts)

    def test_global_cooldown_across_accounts(self):
        c = _Clock()
        t = _throttle(c, max_failures=100, global_max_failures=3, global_window_seconds=60)
        for name in ("a", "b", "c", "d"):   # 4 failures > global max 3
            t.fail(name)
        self.assertFalse(t.allow("totally-fresh"))  # global cooldown locks everyone
        c.advance(60.1)
        self.assertTrue(t.allow("totally-fresh"))

    def test_idle_decay_does_not_escalate(self):
        c = _Clock()
        t = _throttle(c, max_failures=2, lockout_seconds=10, max_lockout_seconds=100)
        t.fail("u")               # failures=1, not locked
        c.advance(101)            # quiet longer than max_lockout -> decays
        t.fail("u")               # resets to 0 then +1 = 1, still NOT locked
        self.assertTrue(t.allow("u"))
        self.assertEqual(t._accounts["u"].failures, 1)

    def test_key_normalization(self):
        self.assertEqual(throttle_key("  Joan@Example.COM "), "joan@example.com")


# --- portal integration: the two ratified invariants through twisted.cred ---

try:
    from twisted.cred.credentials import UsernamePassword
    from twisted.cred import error as cred_error
    from twisted.mail import imap4

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False


def _sync(d):
    """Extract a synchronously-fired Deferred's result/failure."""
    box = {}
    d.addCallbacks(lambda r: box.__setitem__("ok", r), lambda f: box.__setitem__("err", f))
    return box


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ThrottlePortalTest(unittest.TestCase):
    def _login(self, portal, user, pw):
        return _sync(portal.login(UsernamePassword(user.encode(), pw.encode()), None, imap4.IAccount))

    def test_lockout_is_byte_identical_and_skips_backend(self):
        from posternimap.auth import build_portal

        clock = _Clock()
        cfg = Config(api_url="https://x", auth_mode="token", throttle_max_failures=2)
        throttle = build_throttle(cfg, now=clock)
        calls = []
        verify = lambda tok: (calls.append(tok), False)[1]  # every token is "bad"
        portal = build_portal(cfg, verify=verify, throttle=throttle)

        # Two real failures (backend consulted each time) -> account locks.
        b1 = self._login(portal, "joan", "wrong1")
        b2 = self._login(portal, "joan", "wrong2")
        self.assertIn("err", b1)
        self.assertIn("err", b2)
        self.assertEqual(len(calls), 2)

        # Third attempt: locked. Backend NOT consulted (calls stays 2) and the
        # failure is the SAME UnauthorizedLogin as a wrong password (no leak).
        b3 = self._login(portal, "joan", "wrong3")
        self.assertIn("err", b3)
        self.assertEqual(len(calls), 2)  # throttle short-circuited the backend
        self.assertTrue(b3["err"].check(cred_error.UnauthorizedLogin))
        self.assertEqual(str(b2["err"].value), str(b3["err"].value))  # byte-identical

        # After the lockout elapses the backend is consulted again.
        clock.advance(10_000)
        self._login(portal, "joan", "wrong4")
        self.assertEqual(len(calls), 3)

    def test_success_resets_then_allows(self):
        from posternimap.auth import build_portal

        clock = _Clock()
        cfg = Config(api_url="https://x", auth_mode="token", throttle_max_failures=2)
        throttle = build_throttle(cfg, now=clock)
        # token mode: a correct token verifies True.
        portal = build_portal(cfg, verify=lambda t: t == "good", throttle=throttle)
        self._login(portal, "joan", "bad")          # 1 failure
        ok = self._login(portal, "joan", "good")    # success resets
        self.assertIn("ok", ok)
        # A fresh run of failures is needed to lock again (state was cleared).
        self._login(portal, "joan", "bad")
        self.assertIn("ok", self._login(portal, "joan", "good"))

    def test_backend_fault_does_not_count_toward_lockout(self):
        from posternimap.auth import AuthBackendError, build_portal

        clock = _Clock()
        cfg = Config(api_url="https://x", auth_mode="native", service_token="svc", throttle_max_failures=2)
        throttle = build_throttle(cfg, now=clock)
        calls = []

        def authenticate(u, p):
            calls.append((u, p))
            raise AuthBackendError("store down")

        portal = build_portal(cfg, authenticate=authenticate, throttle=throttle)
        # Many backend faults (well past max_failures) must NEVER lock the account:
        # an outage cannot lock users out (invariant 1). The backend is consulted
        # every time (no throttle short-circuit).
        for i in range(6):
            box = self._login(portal, "joan", f"pw{i}")
            self.assertIn("err", box)
        self.assertEqual(len(calls), 6)
        self.assertNotIn("joan", throttle._accounts)


if __name__ == "__main__":
    unittest.main()

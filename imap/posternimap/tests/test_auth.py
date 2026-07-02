"""Tests for the auth mapping (resolve_token) and the #183 throttle keying.

Covers the #32 token/fixed modes and the #77 service-token modes
(native/ldap/system). Every backend call is an INJECTED callable so these run
with no live network and no optional dependency (ldap3 / python-pam). The
resolve_token tests are pure (no Twisted); the portal-level #183 test imports
Twisted (the portal IS Twisted cred plumbing).
"""

from __future__ import annotations

import unittest

from posternimap.auth import (
    AuthBackendError,
    AuthError,
    Identity,
    NativeVerifier,
    resolve_token,
)
from posternimap.config import Config, ConfigError


def _cfg(**over) -> Config:
    base = dict(api_url="https://postern.example", auth_mode="token")
    base.update(over)
    return Config(**base)


class TokenModeTest(unittest.TestCase):
    def test_password_is_the_token(self):
        ident = resolve_token(_cfg(), "agent@skyphusion.org", "the-token", verify=lambda t: True)
        self.assertEqual(ident, Identity(username="agent@skyphusion.org", token="the-token"))

    def test_empty_password_rejected(self):
        with self.assertRaises(AuthError):
            resolve_token(_cfg(), "agent", "", verify=lambda t: True)

    def test_empty_username_rejected(self):
        with self.assertRaises(AuthError):
            resolve_token(_cfg(), "", "tok", verify=lambda t: True)

    def test_verifier_rejects_bad_token(self):
        with self.assertRaises(AuthError):
            resolve_token(_cfg(), "agent", "bad", verify=lambda t: False)

    def test_no_verifier_skips_live_check(self):
        # verify=None means "do not call the API" (used in tests); still maps.
        ident = resolve_token(_cfg(), "agent", "tok", verify=None)
        self.assertEqual(ident.token, "tok")


class FixedModeTest(unittest.TestCase):
    def _cfg_fixed(self):
        return _cfg(auth_mode="fixed", fixed_username="conrad", fixed_token="api-tok-secret")

    def test_correct_username_password(self):
        ident = resolve_token(self._cfg_fixed(), "conrad", "api-tok-secret", verify=lambda t: True)
        self.assertEqual(ident.token, "api-tok-secret")

    def test_wrong_password_rejected(self):
        with self.assertRaises(AuthError):
            resolve_token(self._cfg_fixed(), "conrad", "nope", verify=lambda t: True)

    def test_wrong_username_rejected(self):
        with self.assertRaises(AuthError):
            resolve_token(self._cfg_fixed(), "mallory", "api-tok-secret", verify=lambda t: True)

    def test_empty_password_rejected(self):
        with self.assertRaises(AuthError):
            resolve_token(self._cfg_fixed(), "conrad", "", verify=lambda t: True)


class ServiceTokenModeTest(unittest.TestCase):
    """native / ldap / system all share resolve_token's authenticate-then-map path."""

    def _cfg_mode(self, mode):
        # service_token is what from_env sets from POSTERN_API_TOKEN.
        return _cfg(auth_mode=mode, service_token="svc-token-xyz")

    def test_success_maps_to_service_token(self):
        for mode in ("native", "ldap", "system"):
            with self.subTest(mode=mode):
                ident = resolve_token(
                    self._cfg_mode(mode),
                    "joan@skyphusion.org",
                    "user-secret",
                    authenticate=lambda u, p: True,
                )
                # The USER is preserved; the token is the proxy's service token,
                # NOT the user's password.
                self.assertEqual(
                    ident, Identity(username="joan@skyphusion.org", token="svc-token-xyz")
                )

    def test_bad_credential_raises_autherror(self):
        for mode in ("native", "ldap", "system"):
            with self.subTest(mode=mode):
                with self.assertRaises(AuthError):
                    resolve_token(
                        self._cfg_mode(mode), "joan", "wrong", authenticate=lambda u, p: False
                    )

    def test_empty_password_rejected(self):
        with self.assertRaises(AuthError):
            resolve_token(self._cfg_mode("native"), "joan", "", authenticate=lambda u, p: True)

    def test_empty_username_rejected(self):
        with self.assertRaises(AuthError):
            resolve_token(self._cfg_mode("ldap"), "", "secret", authenticate=lambda u, p: True)

    def test_missing_service_token_raises_configerror(self):
        cfg = _cfg(auth_mode="native", service_token=None)
        with self.assertRaises(ConfigError):
            resolve_token(cfg, "joan", "secret", authenticate=lambda u, p: True)

    def test_missing_authenticator_raises_configerror(self):
        with self.assertRaises(ConfigError):
            resolve_token(self._cfg_mode("system"), "joan", "secret", authenticate=None)

    def test_password_is_never_returned_as_token(self):
        # The whole point of the posture: the user's secret authenticates but is
        # never used as the API bearer.
        ident = resolve_token(
            self._cfg_mode("native"), "joan", "user-secret", authenticate=lambda u, p: True
        )
        self.assertNotEqual(ident.token, "user-secret")

    def test_authenticator_sees_full_username(self):
        seen = {}

        def capture(u, p):
            seen["u"], seen["p"] = u, p
            return True

        resolve_token(self._cfg_mode("system"), "joan@skyphusion.org", "pw", authenticate=capture)
        self.assertEqual(seen, {"u": "joan@skyphusion.org", "p": "pw"})


class NativeVerifierTest(unittest.TestCase):
    """The native backend POSTs to /api/smtp-auth; transport is injected."""

    def _cfg_native(self):
        return _cfg(
            auth_mode="native",
            service_token="svc",
            smtp_auth_url="https://postern.example/api/smtp-auth",
            transport_token="transport-secret",
        )

    def _verifier(self, response):
        # response: (status, body_bytes) or an exception to raise.
        captured = {}

        def transport(req):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["auth"] = req.get_header("Authorization")
            captured["body"] = req.data
            if isinstance(response, Exception):
                raise response
            return response

        return NativeVerifier(self._cfg_native(), transport=transport), captured

    def test_ok_true_authenticates(self):
        v, captured = self._verifier((200, b'{"ok":true,"from":"joan@skyphusion.org"}'))
        self.assertTrue(v("joan@skyphusion.org", "secret"))
        # Mirrors the Go relay: POST, transport-token bearer, {username, secret}.
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["auth"], "Bearer transport-secret")
        self.assertEqual(captured["url"], "https://postern.example/api/smtp-auth")
        self.assertIn(b'"secret": "secret"', captured["body"])

    def test_ok_false_is_bad_credential(self):
        v, _ = self._verifier((200, b'{"ok":false,"error":"E_AUTH_FAILED"}'))
        self.assertFalse(v("joan", "wrong"))

    def test_401_transport_token_is_backend_fault(self):
        # 401 = OUR transport token is wrong, a proxy misconfig, NOT a bad password.
        v, _ = self._verifier((401, b'{"ok":false,"error":"unauthorized"}'))
        with self.assertRaises(AuthBackendError):
            v("joan", "secret")

    def test_5xx_is_backend_fault(self):
        v, _ = self._verifier((503, b"upstream down"))
        with self.assertRaises(AuthBackendError):
            v("joan", "secret")

    def test_empty_credentials_short_circuit(self):
        v, _ = self._verifier((200, b'{"ok":true}'))
        self.assertFalse(v("", "secret"))
        self.assertFalse(v("joan", ""))


class ThrottleAccountKeyTest(unittest.TestCase):
    """#183: the throttle key per auth mode (pure function, no Twisted)."""

    def test_token_and_fixed_key_on_source(self):
        from posternimap.throttle import throttle_account

        for mode in ("token", "fixed"):
            with self.subTest(mode=mode):
                # The attacker-chosen username plays NO role in the key.
                a = throttle_account(mode, "alice@x", "203.0.113.9")
                b = throttle_account(mode, "bob@x", "203.0.113.9")
                self.assertEqual(a, b)
                # Distinct sources get distinct buckets.
                self.assertNotEqual(a, throttle_account(mode, "alice@x", "198.51.100.7"))

    def test_unknown_peer_shares_one_bucket(self):
        from posternimap.throttle import throttle_account

        # No peer (unit wiring, unix sockets): one shared bucket, never a fresh
        # budget per username.
        self.assertEqual(
            throttle_account("token", "alice@x", None),
            throttle_account("token", "bob@x", None),
        )

    def test_directory_modes_key_on_account(self):
        from posternimap.throttle import throttle_account

        for mode in ("native", "ldap", "system"):
            with self.subTest(mode=mode):
                self.assertEqual(throttle_account(mode, "  Joan ", "203.0.113.9"), "joan")

class ThrottleKeyingPortalTest(unittest.TestCase):
    """#183 end-to-end through the portal checker: rotating the username in token
    mode must NOT mint a fresh failure budget; the source IP is the budget."""

    def _portal(self, throttle):
        from posternimap.auth import build_portal

        cfg = _cfg()  # token mode
        calls = []

        def verify(token):
            calls.append(token)
            return False  # every token is rejected -> a genuine bad credential

        return build_portal(cfg, verify=verify, throttle=throttle), calls

    def _throttle(self):
        from posternimap.throttle import AuthThrottle

        return AuthThrottle(
            enabled=True,
            max_failures=3,
            lockout_seconds=60,
            max_lockout_seconds=900,
            global_max_failures=0,  # isolate the per-bucket layer
            global_window_seconds=60,
        )

    def _login(self, portal, username, peer_host):
        from twisted.cred import credentials
        from twisted.mail import imap4

        creds = credentials.UsernamePassword(username.encode(), b"bad-token")
        setattr(creds, "peer_host", peer_host)
        d = portal.login(creds, None, imap4.IAccount)
        failures = []
        d.addErrback(failures.append)  # consume; every attempt here fails
        return failures

    def test_username_rotation_does_not_evade_lockout(self):
        portal, calls = self._portal(self._throttle())
        # Three failures from one source, each under a FRESH username.
        for i in range(3):
            self._login(portal, f"user{i}@x", "203.0.113.9")
        self.assertEqual(len(calls), 3)
        # Fourth attempt from the same source: locked out BEFORE the backend is
        # consulted, even though the username has never been seen.
        self._login(portal, "user99@x", "203.0.113.9")
        self.assertEqual(len(calls), 3)  # backend NOT called
        # A different source still reaches the backend (its own budget).
        self._login(portal, "user99@x", "198.51.100.7")
        self.assertEqual(len(calls), 4)


if __name__ == "__main__":
    unittest.main()

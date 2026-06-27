"""Tests for the auth mapping (resolve_token), pure (no Twisted).

Covers the #32 token/fixed modes and the #77 service-token modes
(native/ldap/system). Every backend call is an INJECTED callable so these run
with no live network and no optional dependency (ldap3 / python-pam).
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


if __name__ == "__main__":
    unittest.main()

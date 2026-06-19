"""Tests for the #32 auth mapping (resolve_token), pure (no Twisted)."""

from __future__ import annotations

import unittest

from posternimap.auth import AuthError, Identity, resolve_token
from posternimap.config import Config


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


if __name__ == "__main__":
    unittest.main()

"""Tests for env-driven Config parsing (no Twisted)."""

from __future__ import annotations

import unittest

from posternimap.config import Config, ConfigError


class ConfigTest(unittest.TestCase):
    def test_minimal_token_mode(self):
        cfg = Config.from_env({"POSTERN_API_URL": "https://postern.example/"})
        self.assertEqual(cfg.api_url, "https://postern.example")  # trailing slash stripped
        self.assertEqual(cfg.auth_mode, "token")
        self.assertEqual(cfg.listen_host, "127.0.0.1")
        self.assertEqual(cfg.listen_port, 1143)

    def test_missing_url_errors(self):
        with self.assertRaises(ConfigError):
            Config.from_env({})

    def test_bad_url_scheme_errors(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "postern.example"})

    def test_fixed_mode_requires_username_and_token(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "https://x", "POSTERN_IMAP_AUTH_MODE": "fixed"})

    def test_fixed_mode_ok(self):
        cfg = Config.from_env(
            {
                "POSTERN_API_URL": "https://x",
                "POSTERN_IMAP_AUTH_MODE": "fixed",
                "POSTERN_IMAP_USERNAME": "conrad",
                "POSTERN_API_TOKEN": "secret",
            }
        )
        self.assertEqual(cfg.auth_mode, "fixed")
        self.assertEqual(cfg.fixed_username, "conrad")
        self.assertEqual(cfg.fixed_token, "secret")

    def test_bad_auth_mode_errors(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "https://x", "POSTERN_IMAP_AUTH_MODE": "weird"})

    def test_partial_tls_errors(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "https://x", "POSTERN_IMAP_TLS_CERT": "/c.pem"})

    def test_port_must_be_int(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "https://x", "POSTERN_IMAP_PORT": "abc"})

    def test_custom_listener(self):
        cfg = Config.from_env(
            {"POSTERN_API_URL": "https://x", "POSTERN_IMAP_HOST": "0.0.0.0", "POSTERN_IMAP_PORT": "993"}
        )
        self.assertEqual(cfg.listen_host, "0.0.0.0")
        self.assertEqual(cfg.listen_port, 993)


if __name__ == "__main__":
    unittest.main()

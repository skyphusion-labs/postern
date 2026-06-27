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

    def test_ldap_timeout_default_and_custom(self):
        cfg = Config.from_env({"POSTERN_API_URL": "https://x"})
        self.assertEqual(cfg.ldap_timeout, 10)  # shared default, matches the Go relay
        cfg = Config.from_env({"POSTERN_API_URL": "https://x", "LDAP_TIMEOUT": "25"})
        self.assertEqual(cfg.ldap_timeout, 25)

    def test_ldap_timeout_negative_rejected(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "https://x", "LDAP_TIMEOUT": "-1"})

    def test_ldap_timeout_must_be_int(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "https://x", "LDAP_TIMEOUT": "soon"})

    def test_throttle_defaults(self):
        cfg = Config.from_env({"POSTERN_API_URL": "https://x"})
        self.assertTrue(cfg.throttle_enabled)
        self.assertEqual(cfg.throttle_max_failures, 5)
        self.assertEqual(cfg.throttle_lockout_seconds, 60)
        self.assertEqual(cfg.throttle_max_lockout_seconds, 900)
        self.assertEqual(cfg.throttle_global_max_failures, 100)
        self.assertEqual(cfg.throttle_global_window_seconds, 60)

    def test_throttle_custom_and_disable(self):
        cfg = Config.from_env({
            "POSTERN_API_URL": "https://x",
            "AUTH_THROTTLE_ENABLED": "false",
            "AUTH_THROTTLE_MAX_FAILURES": "3",
            "AUTH_THROTTLE_LOCKOUT_SECONDS": "30",
        })
        self.assertFalse(cfg.throttle_enabled)
        self.assertEqual(cfg.throttle_max_failures, 3)
        self.assertEqual(cfg.throttle_lockout_seconds, 30)

    def test_throttle_negative_rejected(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "https://x", "AUTH_THROTTLE_MAX_FAILURES": "-1"})

    def test_port_must_be_int(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"POSTERN_API_URL": "https://x", "POSTERN_IMAP_PORT": "abc"})

    def test_custom_listener(self):
        cfg = Config.from_env(
            {"POSTERN_API_URL": "https://x", "POSTERN_IMAP_HOST": "0.0.0.0", "POSTERN_IMAP_PORT": "993"}
        )
        self.assertEqual(cfg.listen_host, "0.0.0.0")
        self.assertEqual(cfg.listen_port, 993)


class NativeModeConfigTest(unittest.TestCase):
    def _base(self, **over):
        e = {
            "POSTERN_API_URL": "https://postern.example",
            "POSTERN_IMAP_AUTH_MODE": "native",
            "POSTERN_API_TOKEN": "svc-token",
            "POSTERN_TRANSPORT_TOKEN": "transport-secret",
        }
        e.update(over)
        return e

    def test_native_ok_defaults_smtp_auth_url(self):
        cfg = Config.from_env(self._base())
        self.assertEqual(cfg.auth_mode, "native")
        self.assertEqual(cfg.service_token, "svc-token")
        self.assertEqual(cfg.transport_token, "transport-secret")
        # Defaults to the api_url origin + /api/smtp-auth (mirrors the relay).
        self.assertEqual(cfg.smtp_auth_url, "https://postern.example/api/smtp-auth")
        # fixed_token stays None: POSTERN_API_TOKEN is the SERVICE token here.
        self.assertIsNone(cfg.fixed_token)

    def test_native_explicit_smtp_auth_url(self):
        cfg = Config.from_env(self._base(POSTERN_SMTP_AUTH_URL="https://auth.example/api/smtp-auth"))
        self.assertEqual(cfg.smtp_auth_url, "https://auth.example/api/smtp-auth")

    def test_native_needs_transport_token(self):
        e = self._base()
        del e["POSTERN_TRANSPORT_TOKEN"]
        with self.assertRaises(ConfigError):
            Config.from_env(e)

    def test_native_needs_service_token(self):
        e = self._base()
        del e["POSTERN_API_TOKEN"]
        with self.assertRaises(ConfigError):
            Config.from_env(e)

    def test_native_bad_smtp_auth_url_scheme(self):
        with self.assertRaises(ConfigError):
            Config.from_env(self._base(POSTERN_SMTP_AUTH_URL="auth.example"))


class LdapModeConfigTest(unittest.TestCase):
    def _base(self, **over):
        e = {
            "POSTERN_API_URL": "https://x",
            "POSTERN_IMAP_AUTH_MODE": "ldap",
            "POSTERN_API_TOKEN": "svc-token",
            "LDAP_URL": "ldaps://dir.example:636",
            "LDAP_BIND_DN_TEMPLATE": "uid=%s,ou=people,dc=example,dc=com",
        }
        e.update(over)
        return e

    def test_ldap_simple_bind_ok(self):
        cfg = Config.from_env(self._base())
        self.assertEqual(cfg.auth_mode, "ldap")
        self.assertEqual(cfg.ldap_url, "ldaps://dir.example:636")
        self.assertEqual(cfg.ldap_bind_dn_template, "uid=%s,ou=people,dc=example,dc=com")
        self.assertEqual(cfg.ldap_mail_attr, "mail")  # default
        self.assertEqual(cfg.service_token, "svc-token")

    def test_ldap_search_bind_ok(self):
        e = self._base()
        del e["LDAP_BIND_DN_TEMPLATE"]
        e.update(
            {
                "LDAP_BIND_DN": "cn=svc,dc=example,dc=com",
                "LDAP_BIND_PASSWORD": "svcpw",
                "LDAP_SEARCH_BASE": "ou=people,dc=example,dc=com",
                "LDAP_SEARCH_FILTER": "(uid=%s)",
                "LDAP_MAIL_ATTR": "mailLocalAddress",
            }
        )
        cfg = Config.from_env(e)
        self.assertEqual(cfg.ldap_bind_dn, "cn=svc,dc=example,dc=com")
        self.assertEqual(cfg.ldap_search_filter, "(uid=%s)")
        self.assertEqual(cfg.ldap_mail_attr, "mailLocalAddress")

    def test_ldap_needs_url(self):
        e = self._base()
        del e["LDAP_URL"]
        with self.assertRaises(ConfigError):
            Config.from_env(e)

    def test_ldap_requires_tls(self):
        with self.assertRaises(ConfigError):
            Config.from_env(self._base(LDAP_URL="ldap://dir.example:389"))

    def test_ldap_starttls_satisfies_tls(self):
        cfg = Config.from_env(self._base(LDAP_URL="ldap://dir.example:389", LDAP_STARTTLS="true"))
        self.assertTrue(cfg.ldap_starttls)

    def test_ldap_needs_a_bind_strategy(self):
        e = self._base()
        del e["LDAP_BIND_DN_TEMPLATE"]
        with self.assertRaises(ConfigError):
            Config.from_env(e)


class SystemModeConfigTest(unittest.TestCase):
    def _base(self, **over):
        e = {
            "POSTERN_API_URL": "https://x",
            "POSTERN_IMAP_AUTH_MODE": "system",
            "POSTERN_API_TOKEN": "svc-token",
        }
        e.update(over)
        return e

    def test_system_ok_default_pam_service(self):
        cfg = Config.from_env(self._base())
        self.assertEqual(cfg.auth_mode, "system")
        self.assertEqual(cfg.pam_service, "postern")  # default
        self.assertEqual(cfg.service_token, "svc-token")

    def test_pam_alias_normalizes_to_system(self):
        cfg = Config.from_env(self._base(POSTERN_IMAP_AUTH_MODE="pam"))
        self.assertEqual(cfg.auth_mode, "system")

    def test_system_custom_pam_service(self):
        cfg = Config.from_env(self._base(AUTH_SYSTEM_PAM_SERVICE="imap"))
        self.assertEqual(cfg.pam_service, "imap")

    def test_system_needs_service_token(self):
        e = self._base()
        del e["POSTERN_API_TOKEN"]
        with self.assertRaises(ConfigError):
            Config.from_env(e)


if __name__ == "__main__":
    unittest.main()

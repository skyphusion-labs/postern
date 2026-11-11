"""Session-edge behaviour: wire-trace redaction, plaintext on 993, APPEND ownership."""

from __future__ import annotations

import unittest
from posternimap.config import Config, ConfigError


class WireTraceGuardTest(unittest.TestCase):
    def test_login_continuation_is_redacted(self):
        from posternimap.server import _trace_inbound

        shown, tag = _trace_inbound(b"a2 LOGIN {1}", None)
        self.assertEqual(tag, b"a2")
        self.assertNotIn(b"{1}", shown)
        self.assertIn(b"REDACTED", shown)
        nxt, tag2 = _trace_inbound(b'u "secret-value"', tag)
        self.assertEqual(tag2, b"a2")
        self.assertNotIn(b"secret-value", nxt)
        self.assertEqual(nxt, b"<REDACTED>")


class PlaintextPortTest(unittest.TestCase):
    def test_plaintext_on_993_is_refused(self):
        with self.assertRaises(ConfigError) as caught:
            Config.from_env({
                "POSTERN_API_URL": "https://x.example",
                "POSTERN_IMAP_HOST": "0.0.0.0",
                "POSTERN_IMAP_PORT": "993",
            })
        self.assertIn("143", str(caught.exception))

    def test_port_143_without_a_cert_is_allowed(self):
        cfg = Config.from_env({
            "POSTERN_API_URL": "https://x.example",
            "POSTERN_IMAP_PORT": "143",
        })
        self.assertEqual(cfg.listen_port, 143)
        self.assertIsNone(cfg.tls_cert)


class GlobalThrottleDefaultTest(unittest.TestCase):
    def test_global_layer_is_off_unless_set(self):
        cfg = Config.from_env({"POSTERN_API_URL": "https://x.example"})
        self.assertEqual(cfg.throttle_global_max_failures, 0)

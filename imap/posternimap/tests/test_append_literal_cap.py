"""APPEND refuses a literal over the configured ceiling before accepting the bytes."""

from __future__ import annotations

import unittest

from twisted.mail import imap4

from posternimap.config import Config
from posternimap.server import PosternIMAP4Server

# Same ceiling as inbound/src/api.ts MAX_IMPORT_MIME_BYTES.
_DEFAULT = 22 * 1024 * 1024


class _Cfg:
    def __init__(self, n: int) -> None:
        self.max_append_bytes = n


class AppendLiteralCapTest(unittest.TestCase):
    def test_default_ceiling(self):
        cfg = Config.from_env({"POSTERN_API_URL": "https://x.example"})
        self.assertEqual(cfg.max_append_bytes, _DEFAULT)

    def test_over_ceiling_is_refused(self):
        proto = PosternIMAP4Server()
        proto.factory = type("F", (), {"_cfg": _Cfg(1024)})()
        with self.assertRaises(imap4.IllegalOperation) as caught:
            proto.arg_append_literal(b"{2048}")
        self.assertIn("TOOBIG", str(caught.exception))
        self.assertIn("1024", str(caught.exception))

    def test_custom_ceiling_from_env(self):
        cfg = Config.from_env({
            "POSTERN_API_URL": "https://x.example",
            "POSTERN_IMAP_MAX_APPEND_BYTES": "4096",
        })
        self.assertEqual(cfg.max_append_bytes, 4096)

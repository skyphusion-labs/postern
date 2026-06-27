"""Tests for the CLI, driving main() with a patched client (no network)."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from postern_client.cli import build_parser, main
from postern_client.client import PosternClient
from postern_client.tests.test_client import FakeTransport


def run(argv, transport):
    """Run main(argv) with from_env patched to a client over `transport`.

    Captures (exit_code, stdout, stderr).
    """
    client = PosternClient("https://postern.example", "tok", transport=transport)
    out, err = io.StringIO(), io.StringIO()
    with mock.patch("postern_client.cli.from_env", return_value=client):
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
    return code, out.getvalue(), err.getvalue()


class SendCliTest(unittest.TestCase):
    def test_send_builds_body_and_prints_result(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m1","threadId":"t1"}')
        code, out, _ = run(
            ["send", "--to", "a@x.com", "--to", "b@x.com", "--subject", "Hi", "--text", "yo"], t
        )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["messageId"], "m1")
        body = json.loads(t.last.data.decode())
        self.assertEqual(body["to"], ["a@x.com", "b@x.com"])
        self.assertEqual(body["subject"], "Hi")
        self.assertEqual(body["text"], "yo")

    def test_send_requires_a_body(self):
        t = FakeTransport()
        with self.assertRaises(SystemExit):
            run(["send", "--to", "a@x.com", "--subject", "Hi"], t)

    def test_send_text_from_file(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
            fh.write("body from file")
            path = fh.name
        try:
            code, _, _ = run(["send", "--to", "a@x.com", "--subject", "S", "--text-file", path], t)
        finally:
            os.unlink(path)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(t.last.data.decode())["text"], "body from file")

    def test_bad_header_errors(self):
        t = FakeTransport(body=b'{"ok":true}')
        with self.assertRaises(SystemExit):
            run(["send", "--to", "a@x.com", "--subject", "S", "--text", "t", "--header", "noequals"], t)


class ReadCliTest(unittest.TestCase):
    def test_list(self):
        t = FakeTransport(body=b'{"ok":true,"items":[{"messageId":"m"}],"cursor":"c"}')
        code, out, _ = run(["list", "--direction", "inbound", "--limit", "5"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["cursor"], "c")
        self.assertIn("direction=inbound", t.last.full_url)

    def test_get_found(self):
        t = FakeTransport(body=b'{"ok":true,"message":{"messageId":"m","subject":"s"}}')
        code, out, _ = run(["get", "m"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["subject"], "s")

    def test_get_not_found_exit_1(self):
        t = FakeTransport(status=404, body=b'{"ok":false,"error":"E_NOT_FOUND"}')
        code, _, err = run(["get", "nope"], t)
        self.assertEqual(code, 1)
        self.assertIn("not found", err)

    def test_thread(self):
        t = FakeTransport(body=b'{"ok":true,"messages":[{"messageId":"a"}]}')
        code, out, _ = run(["thread", "t1"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)[0]["messageId"], "a")

    def test_search(self):
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        code, _, _ = run(["search", "invoice", "--mode", "fts"], t)
        self.assertEqual(code, 0)
        self.assertIn("q=invoice", t.last.full_url)
        self.assertIn("mode=fts", t.last.full_url)


class AttachmentCliTest(unittest.TestCase):
    def test_attachment_writes_file(self):
        t = FakeTransport(
            body=b"BYTES",
            headers={"content-type": "image/png", "content-disposition": 'attachment; filename="p.png"'},
        )
        with tempfile.TemporaryDirectory() as d:
            out_path = os.path.join(d, "got.png")
            code, _, err = run(["attachment", "m", "0", "-o", out_path], t)
            self.assertEqual(code, 0)
            with open(out_path, "rb") as fh:
                self.assertEqual(fh.read(), b"BYTES")
        self.assertIn("wrote 5 bytes", err)


class AuthCliTest(unittest.TestCase):
    def test_ping_ok(self):
        code, out, _ = run(["ping"], FakeTransport(body=b'{"ok":true,"items":[]}'))
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["ok"])

    def test_auth_failure_exit_2(self):
        t = FakeTransport(status=401, body=b'{"ok":false,"error":"unauthorized"}')
        code, _, err = run(["list"], t)
        self.assertEqual(code, 2)
        self.assertIn("auth failed", err)


class NoTokenArgTest(unittest.TestCase):
    def test_no_token_flag_exists(self):
        # The token must never be a CLI argument; the parser must reject --token.
        parser = build_parser()
        with self.assertRaises(SystemExit):
            parser.parse_args(["--token", "leak", "ping"])


if __name__ == "__main__":
    unittest.main()

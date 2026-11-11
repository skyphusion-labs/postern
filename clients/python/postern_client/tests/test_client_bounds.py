"""Bounds on what the Python client will send and what it will keep.

Cross-origin redirects drop Authorization. Message bodies are capped and flagged.
Ids that are empty, `.`, or `..` are refused before a path is built. A non-https
base is refused except on localhost, and a query on the base URL is not kept.
"""

from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from postern_client.client import PosternClient, PosternError
from postern_client.tests.test_client import FakeTransport, _client


class _QuietHandler(BaseHTTPRequestHandler):
    origin_port = 0
    other_port = 0

    def log_message(self, _fmt: str, *_args) -> None:
        return

    def _json(self, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        auth = self.headers.get("Authorization")
        if self.path == "/api/messages/away":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.other_port}/land")
            self.end_headers()
            return
        if self.path == "/api/messages/stay":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.origin_port}/land")
            self.end_headers()
            return
        self._json({"authorization": auth, "path": self.path, "message": {"messageId": "m"}})


def _serve() -> tuple[ThreadingHTTPServer, int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _QuietHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


class RedirectAuthTest(unittest.TestCase):
    def test_cross_origin_redirect_drops_authorization_and_same_origin_keeps_it(self):
        origin, origin_port = _serve()
        other, other_port = _serve()
        _QuietHandler.origin_port = origin_port
        _QuietHandler.other_port = other_port
        try:
            client = PosternClient(f"http://127.0.0.1:{origin_port}", "sekret-token")
            away = client._json("GET", "/api/messages/away")
            stay = client._json("GET", "/api/messages/stay")
        finally:
            origin.shutdown()
            other.shutdown()
            origin.server_close()
            other.server_close()
        self.assertIsNone(away["authorization"])
        self.assertEqual(stay["authorization"], "Bearer sekret-token")
        self.assertEqual(away["path"], "/land")


class BodyCapTest(unittest.TestCase):
    def test_long_body_is_capped_and_flagged(self):
        body = "x" * 70000
        t = FakeTransport(body=json.dumps({"message": {"messageId": "m", "bodyText": body, "bodyHtml": body}}).encode())
        message = _client(t).get_message("m1")
        assert message is not None
        self.assertTrue(message["bodyTruncated"])
        self.assertEqual(message["bodyTextLength"], 70000)
        self.assertEqual(message["bodyHtmlLength"], 70000)
        self.assertLessEqual(len(message["bodyText"]), 65536)
        self.assertLessEqual(len(message["bodyHtml"]), 65536)
        self.assertTrue(message["bodyTextTruncated"])


class IdPathTest(unittest.TestCase):
    def test_dot_and_empty_ids_are_refused_before_a_request(self):
        t = FakeTransport()
        client = _client(t)
        for value in ("", ".", ".."):
            with self.assertRaises(PosternError):
                client.get_message(value)
        self.assertEqual(t.calls, [])


class BaseUrlTest(unittest.TestCase):
    def test_plain_http_is_refused_off_localhost(self):
        with self.assertRaises(PosternError) as caught:
            PosternClient("http://postern.example/v1?token=sekret", "tok")
        self.assertNotIn("sekret", str(caught.exception))

    def test_localhost_http_is_accepted_and_the_query_is_not_kept(self):
        t = FakeTransport(body=b'{"ok":true,"items":[]}')
        client = PosternClient("http://127.0.0.1:9/root?token=sekret", "tok", transport=t)
        self.assertNotIn("sekret", client._base)
        client.ping()
        self.assertNotIn("sekret", t.last.full_url)

    def test_userinfo_is_refused_without_echoing_it(self):
        with self.assertRaises(PosternError) as caught:
            PosternClient("https://user:sekret@postern.example", "tok")
        self.assertNotIn("sekret", str(caught.exception))

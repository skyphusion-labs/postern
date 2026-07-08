"""Tests for the keep-alive _HttpTransport (the default PosternClient transport).

Uses a real loopback HTTP/1.1 server to prove connection reuse (one TCP connection
serves many requests) and correctness, plus a fake connection to prove the
retry-once-on-a-stale-keep-alive path. No Twisted, no network beyond loopback.
"""

from __future__ import annotations

import http.client
import http.server
import threading
import unittest
import urllib.request

from posternimap.client import PosternClient, PosternError, _HttpTransport


class _CountingHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # enable keep-alive
    connections = 0
    requests = 0

    def setup(self):  # called once per accepted TCP connection
        type(self).connections += 1
        super().setup()

    def _reply(self):
        type(self).requests += 1
        body = b'{"ok":true,"items":[],"cursor":null}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _reply
    do_POST = _reply

    def log_message(self, *a):  # keep the test output quiet
        pass


class KeepAliveTransportTest(unittest.TestCase):
    def setUp(self):
        _CountingHandler.connections = 0
        _CountingHandler.requests = 0
        # ThreadingHTTPServer: each keep-alive connection is handled in its own daemon
        # thread, so a still-open connection never blocks shutdown() (a single-threaded
        # server would deadlock waiting on the kept-alive socket).
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _CountingHandler)
        self.srv.daemon_threads = True
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def _req(self, path="/api/messages", method="GET"):
        return urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)

    def test_reuses_a_single_connection_across_requests(self):
        t = _HttpTransport(timeout=5)
        try:
            for _ in range(5):
                status, body = t(self._req())
                self.assertEqual(status, 200)
                self.assertIn(b'"ok":true', body)
            # Five requests, ONE TCP connection (keep-alive) -- the whole point.
            self.assertEqual(_CountingHandler.requests, 5)
            self.assertEqual(_CountingHandler.connections, 1)
        finally:
            t._close()

    def test_full_client_default_transport_reuses_connection(self):
        # End-to-end through PosternClient with NO injected transport (the real default
        # path): repeated list calls ride one connection.
        c = PosternClient(f"http://127.0.0.1:{self.port}", "tok")
        for _ in range(4):
            c.list_messages(limit=1)
        self.assertEqual(_CountingHandler.connections, 1)
        self.assertEqual(_CountingHandler.requests, 4)
        c._transport._close()

    def test_non_2xx_is_returned_not_raised(self):
        # A 4xx/5xx is returned as (status, bytes) like the old urllib transport, so the
        # caller maps it to a PosternError -- the transport itself does not raise on it.
        class _ErrHandler(_CountingHandler):
            def _reply(self):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = _reply

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _ErrHandler)
        srv.daemon_threads = True
        port = srv.server_address[1]
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            t = _HttpTransport(timeout=5)
            status, _ = t(urllib.request.Request(f"http://127.0.0.1:{port}/api/messages"))
            self.assertEqual(status, 404)
            t._close()
        finally:
            srv.shutdown()
            srv.server_close()


class RetryOnStaleTest(unittest.TestCase):
    """A reused keep-alive connection can be closed by the worker's idle timeout; the
    transport must drop it and retry ONCE on a fresh connection rather than fail."""

    def test_retries_once_on_a_broken_connection(self):
        made = []

        class _Conn:
            def __init__(self, host, port, timeout=None):
                self.host = host
                self.first = True
                made.append(self)

            def request(self, method, path, body=None, headers=None):
                # The stale connection (the first one made) raises on use; the retry
                # connection (the second) succeeds.
                if self is made[0]:
                    raise http.client.RemoteDisconnected("Remote end closed connection")

            def getresponse(self):
                class _R:
                    status = 200

                    def read(self_inner):
                        return b'{"ok":true}'

                return _R()

            def close(self):
                pass

        import posternimap.client as clientmod

        orig = clientmod.http.client.HTTPConnection
        clientmod.http.client.HTTPConnection = _Conn
        try:
            t = _HttpTransport(timeout=5)
            status, body = t(urllib.request.Request("http://x.example/api/messages"))
        finally:
            clientmod.http.client.HTTPConnection = orig
        self.assertEqual(status, 200)
        self.assertEqual(body, b'{"ok":true}')
        self.assertEqual(len(made), 2)  # stale one dropped, fresh one used

    def test_gives_up_and_raises_posternerror_after_the_retry(self):
        class _DeadConn:
            def __init__(self, host, port, timeout=None):
                pass

            def request(self, *a, **k):
                raise OSError("connection refused")

            def close(self):
                pass

        import posternimap.client as clientmod

        orig = clientmod.http.client.HTTPConnection
        clientmod.http.client.HTTPConnection = _DeadConn
        try:
            t = _HttpTransport(timeout=5)
            with self.assertRaises(PosternError):
                t(urllib.request.Request("http://x.example/api/messages"))
        finally:
            clientmod.http.client.HTTPConnection = orig


if __name__ == "__main__":
    unittest.main()

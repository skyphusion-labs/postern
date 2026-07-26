"""#416 part 2: the door must not do worker I/O on the reactor thread.

MEASURED PROBLEM (imap/bench/): blocking http.client on the single reactor thread meant
one slow worker call stalled EVERY connected client. The stall equalled the call duration
exactly, and api_timeout defaults to 15s, so the worst case was a fifteen-second freeze of
the whole door.

THIS SUITE IS THE PROPERTY, NOT THE MECHANISM. It does not assert that some function
calls deferToThread; it drives the REAL door over a REAL loopback socket with Twisted own
IMAP4 client and asserts, from the transport itself, that NO worker call ever ran on the
reactor thread. That is the one seam every API call must pass through, so nothing can slip
past it -- a new blocking call site added later fails this without anyone remembering to
update a list.

The second test is the corruption case, with real sockets: the transport keeps ONE
keep-alive connection per THREAD, and sharing a single connection across the pool was
measured (before the fix) to return 2 successes and 4 failures out of 6 concurrent calls.
"""

from __future__ import annotations

import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    from twisted.internet import defer, reactor
    from twisted.internet.protocol import ClientCreator
    from twisted.mail import imap4
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore

from posternimap.client import PosternClient
from posternimap.config import Config
from posternimap.tests.fakes import FakeTransport, make_message
from posternimap.tests.test_server_e2e import _patched_factory, _restore_account


class ThreadRecordingTransport:
    """The fake transport, wrapped so every call records the thread it ran on.

    This is the un-stubbable seam: PosternClient has exactly one way to reach the
    network, so a recording here sees every worker call the door makes, whatever new code
    path introduces it.
    """

    def __init__(self, inner) -> None:
        self._inner = inner
        self.threads: list = []
        self.calls: list = []
        self.expected_token = inner.expected_token

    def __call__(self, req):
        # Record the PATH beside the thread: a bare thread name tells you the invariant
        # broke, the path tells you which call site to fix.
        self.threads.append(threading.current_thread().name)
        self.calls.append((threading.current_thread().name, req.get_method(), req.full_url))
        return self._inner(req)

    def __getattr__(self, name):
        return getattr(self._inner, name)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ReactorNonBlockingTest(twisted_unittest.TestCase):
    def setUp(self):
        msgs = [
            make_message("m3", direction="outbound", subject="sent note"),
            make_message("m2", subject="meeting tuesday", body="lunch?"),
            make_message("m1", subject="welcome aboard", body="hello"),
        ]
        self.inner = FakeTransport(msgs, expected_token="tok", page_size=2)
        self.transport = ThreadRecordingTransport(self.inner)
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def _client(self):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_no_worker_call_runs_on_the_reactor_thread(self):
        reactor_thread = threading.current_thread().name
        proto = yield self._client()
        try:
            # A full working session: the login check, the folder listing, the mailbox
            # load behind SELECT, a FETCH, a SEARCH, and a \\Seen STORE.
            yield proto.login(b"agent@skyphusion.org", b"tok")
            yield proto.list("", "*")
            yield proto.select(b"INBOX")
            yield proto.fetchMessage("1")
            yield proto.search(imap4.Query(subject="meeting"))
            yield proto.setFlags("1", ["\\Seen"], uid=False)
        finally:
            yield proto.logout()

        # CONTROL: the session really did reach the worker, so an empty recording can
        # never make this test pass by accident.
        self.assertTrue(self.transport.threads, "no worker calls were recorded at all")

        # KNOWN RESIDUAL, deliberately asserted rather than hidden: per-message BODY
        # hydration during FETCH still runs on the reactor thread. Twisted renders a
        # FETCH response by calling IMessage accessors (getBodyFile, getHeaders) straight
        # from the protocol, with no Deferred seam to hang I/O on, and the door hydrates
        # bodies LAZILY on purpose so a header scan never pays for bodies (#102). Closing
        # it needs a body prefetch keyed on the requested parts, which is its own change;
        # tracked as a follow-up.
        residual = [c for c in self.transport.calls if c[0] == reactor_thread]
        for _thread, method, url in residual:
            self.assertTrue(
                method == "GET" and "/api/messages/" in url and "/attachments/" not in url,
                "a NEW reactor-thread worker call appeared: %s %s" % (method, url),
            )
        # No-stale assertion: if the residual is ever fixed, this fails and the exception
        # above must come out with it. A known gap that quietly stops existing is how a
        # workaround becomes permanent.
        self.assertTrue(
            residual,
            "the FETCH body-hydration residual is gone: remove this exception and the "
            "follow-up issue, and assert zero reactor-thread calls",
        )

        # Everything else -- login, LIST, the SELECT snapshot, SEARCH, STORE -- is off
        # the reactor, which is the whole-door freeze this change removes.
        non_residual = [
            c for c in self.transport.calls if c[0] != reactor_thread
        ]
        self.assertTrue(non_residual, "nothing ran in the pool: the fix is not wired")
        self.assertTrue(
            all(t.startswith("PoolThread") for t, _m, _u in non_residual),
            "worker calls ran off an unexpected thread: %r"
            % sorted({t for t, _m, _u in non_residual}),
        )


class _SleepyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    delay = 0.15

    def do_GET(self):
        time.sleep(self.delay)
        payload = json.dumps({"ok": True, "items": [], "cursor": None}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):
        pass


class _ThreadedHTTPServer(HTTPServer):
    daemon_threads = True

    def process_request(self, request, addr):
        threading.Thread(target=self._one, args=(request, addr), daemon=True).start()

    def _one(self, request, addr):
        try:
            self.finish_request(request, addr)
        finally:
            self.shutdown_request(request)


class ConcurrentTransportTest(unittest.TestCase):
    """REAL sockets: one client, many threads, no shared-connection corruption (#416).

    Before per-thread connections this returned 2 successes and 4 failures
    (NoneType.makefile, "Idle", a full timeout) because six threads drove one
    http.client connection. It is a regression test for the reason the fix is
    threading.local and not a mutex.
    """

    def setUp(self):
        self.server = _ThreadedHTTPServer(("127.0.0.1", 0), _SleepyHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_six_concurrent_calls_on_one_client_all_succeed(self):
        client = PosternClient(self.base, "tok", timeout=10)
        client.list_messages(limit=1)  # warm one keep-alive connection

        ok: list = []
        errors: list = []

        def call(i):
            try:
                client.list_messages(limit=1)
                ok.append(i)
            except Exception as exc:  # pragma: no cover - failure detail on regression
                errors.append("%s: %s" % (type(exc).__name__, exc))

        threads = [threading.Thread(target=call, args=(i,)) for i in range(6)]
        started = time.monotonic()
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        elapsed = time.monotonic() - started

        self.assertEqual(errors, [], "shared-connection corruption is back")
        self.assertEqual(len(ok), 6)
        # Concurrency CONTROL: six 150ms calls that truly overlap finish far inside the
        # ~0.9s a serialized run would take, so this also fails if a lock creeps back in.
        self.assertLess(elapsed, 0.9, "calls serialized (%.2fs): connections are shared" % elapsed)

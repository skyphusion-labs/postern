"""#416 part 2: the door must not do worker I/O on the reactor thread.

MEASURED PROBLEM (imap/bench/): blocking http.client on the single reactor thread meant
one slow worker call stalled EVERY connected client. The stall equalled the call duration
exactly, and api_timeout defaults to 15s, so the worst case was a fifteen-second freeze of
the whole door.

THIS SUITE IS THE PROPERTY, NOT THE MECHANISM. It does not assert that some function
calls deferToThread; it drives the REAL door over a REAL loopback socket with Twisted own
IMAP4 client and asserts, from the transport itself, that NO worker call ever ran on the
reactor thread.

WHAT THAT DOES AND DOES NOT BUY, stated exactly, because the earlier version of this
paragraph overstated it and the overstatement outlived two reviews. The recording seam IS
total: PosternClient has one way to reach the network, so nothing the door does can reach
a worker without passing through it. But a total seam only ever sees the traffic a test
GENERATES. The seam is total; the DRIVING is what bounds the claim.

This suite drives LOGIN, LIST, SELECT, FETCH, SEARCH, STORE and LOGOUT, against a default
token-mode Config with no viewer roles and no per_account. The zero below is therefore a
real property of THOSE paths and says nothing about any other. It is no longer the whole
claim: #468 closed the driving gap in test_reactor_surface.py, which drives the rest of
the command surface (APPEND, COPY, MOVE, restore, EXPUNGE/delete, STATUS, LSUB, the
drafts lifecycle, ID) plus per_account sessions and role folders, with a control on each
drive and a declaration test that fails when a new door command is driven by nobody. The
two files are complements: this one walks the FETCH render path shape by shape, that one
walks the command surface. Neither covers the other.

ONE path used to block and is now FIXED: the live poll refreshed on the reactor thread,
both from do_NOOP and from the timed LoopingCall tick, because the poll read the store AND
pushed untagged EXISTS to listeners and the push must stay on the reactor. #485 split the
two (PosternMailbox.refresh_now in the pool, PosternMailbox.notify_new_messages on the
reactor); test_reactor_surface.py drives both callers and asserts BOTH halves land where
they belong.

The driving gap was proven, not theorized. Working #438, joan mutated the role-membership
lookup to resolve on a cache MISS -- exactly the regression this file used to claim it
would catch -- and this suite stayed GREEN; her own tests caught it. A mutation is proof,
so the old sentence ("nothing can slip past it") was simply false, and it is corrected
here rather than defended. That same mutation is now an ASSERTED control in
test_reactor_surface.py: it is reproduced there and the harness is required to go red on
it, so the sensitivity of the new driving is measured instead of claimed.

#457 closed the last one. Per-message BODY hydration used to run on the reactor thread
because Twisted renders a FETCH by calling IMessage accessors straight from the protocol,
with no maybeDeferred seam. The door now PRE-RUNS those same accessor reads in the pool
(fetchwarm.fetch_reads + PosternIMAPMessage.prehydrate), so the render reads memory. The
assertion below is therefore ZERO reactor-thread worker calls, with no exception carved
out, across every FETCH shape a real client sends.

Two things must stay true while that is true, and both are pinned here, because a warm
that ignored them would pass a stall test by fetching everything:
  * #102 -- an ENVELOPE or header scan still fetches NO body.
  * #342 -- BODY[i] still pulls ONE attachment, not every attachment.

The last test is the corruption case, with real sockets: the transport keeps ONE
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
from posternimap.fetchwarm import fetch_reads
from posternimap.message import PosternIMAPMessage
from posternimap.tests.fakes import FakeTransport, make_message, make_summary
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

        # #457: NO exception. The FETCH body-hydration residual that #416 part 2 left
        # behind is closed, so this is a flat zero.
        on_reactor = [c for c in self.transport.calls if c[0] == reactor_thread]
        self.assertEqual(
            [],
            [(m, u) for _t, m, u in on_reactor],
            "a worker call ran on the reactor thread, which stalls every other client",
        )
        self.assertTrue(
            all(t.startswith("PoolThread") for t, _m, _u in self.transport.calls),
            "worker calls ran off an unexpected thread: %r"
            % sorted({t for t, _m, _u in self.transport.calls}),
        )


# Every FETCH shape a real mail client sends, as raw wire text. Thunderbird and Apple
# Mail between them use all of these: the scan shapes to build a list view, the body
# shapes to open a message, BODY[i] to save one attachment. Driving the RAW string keeps
# the battery honest -- Twisted own _FetchParser turns these into the query objects
# fetchwarm reads, so the test exercises the real parse, not a hand-built stand-in.
_SCAN_SHAPES = (
    b"(UID FLAGS)",
    b"(ENVELOPE)",
    b"(UID FLAGS INTERNALDATE ENVELOPE)",
    b"(BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])",
)

# RFC822.SIZE is deliberately NOT a scan shape. getSize prefers the projected size the
# list response carries (#342) and hydrates only on a MISS, and these fakes carry no
# projection, so every shape below takes the miss path and costs one message GET. That
# is pre-#457 behavior, unchanged; what #457 changes is that the GET happens in the pool.
# Keeping it separate is the point: folding it in with the scans would have quietly
# taught the suite that a body fetch during a list view is normal.
_SIZE_SHAPES = (
    b"(RFC822.SIZE)",
    b"(UID FLAGS INTERNALDATE ENVELOPE RFC822.SIZE)",
    b"ALL",
    b"FAST",
)

_BODY_SHAPES = (
    b"(RFC822)",
    b"(RFC822.TEXT)",
    b"(RFC822.HEADER)",
    b"(BODY[])",
    b"(BODY[TEXT])",
    b"(BODY[HEADER])",
    b"(BODY[1])",
    b"(BODY[2])",
    b"(BODY[1.MIME])",
    b"(BODY[2.MIME])",
    b"(BODYSTRUCTURE)",
    b"(BODY)",
    b"FULL",
)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class FetchShapeTest(twisted_unittest.TestCase):
    """#457: NO FETCH shape may hydrate on the reactor thread, and none may over-fetch.

    One test would not be enough. A warm that hydrated everything unconditionally would
    pass a stall assertion while regressing #102 (a header scan must not fetch a body)
    and #342 (BODY[i] must fetch ONE attachment). So the same battery is asserted from
    three sides: nothing on the reactor thread, scans stay body-free, per-part stays
    per-part. A wrong warm fails at least one of them.
    """

    def setUp(self):
        att_a = b"AAAA-attachment-one"
        att_b = b"BBBB-attachment-two"
        self.msgs = [
            make_message(
                "m1",
                subject="welcome aboard",
                body="hello there",
                attachments=[
                    {"filename": "a.bin", "mime": "application/octet-stream", "size": len(att_a)},
                    {"filename": "b.bin", "mime": "application/octet-stream", "size": len(att_b)},
                ],
                attachmentBytes=[att_a, att_b],
            ),
        ]
        self.inner = FakeTransport(self.msgs, expected_token="tok", page_size=10)
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
    def _fetch_shape(self, shape):
        """Run ONE raw FETCH on a fresh connection; return the calls it caused.

        Returns (reactor_thread_calls, message_gets, attachment_gets) for the FETCH
        alone: the mark is taken after SELECT, so login and the mailbox snapshot do not
        colour the numbers.
        """
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        reactor_thread = threading.current_thread().name
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            yield proto.select(b"INBOX")
            mark = len(self.transport.calls)
            # errbacks on a tagged NO/BAD, so a shape that fails fails the test rather
            # than passing with an empty recording.
            yield proto.sendCommand(
                imap4.Command(b"FETCH", b"1 " + shape, wantResponse=(b"FETCH",))
            )
            during = self.transport.calls[mark:]
        finally:
            yield proto.logout()

        on_reactor = [(m, u) for t, m, u in during if t == reactor_thread]
        msg_gets = [
            u
            for _t, m, u in during
            if m == "GET" and "/api/messages/" in u and "/attachments/" not in u
        ]
        att_gets = [u for _t, m, u in during if m == "GET" and "/attachments/" in u]
        defer.returnValue((on_reactor, msg_gets, att_gets))

    @defer.inlineCallbacks
    def test_no_fetch_shape_touches_the_worker_from_the_reactor_thread(self):
        offenders = {}
        hydrating = []
        for shape in _SCAN_SHAPES + _SIZE_SHAPES + _BODY_SHAPES:
            on_reactor, msg_gets, _att = yield self._fetch_shape(shape)
            if on_reactor:
                offenders[shape.decode()] = on_reactor
            if msg_gets:
                hydrating.append(shape.decode())

        self.assertEqual({}, offenders, "FETCH hydrated on the reactor thread")
        # CONTROL: an empty recording would satisfy the assertion above for free. The
        # body shapes MUST have reached the worker, in the pool, for it to mean anything.
        self.assertTrue(
            hydrating, "no shape fetched a body at all: the battery proves nothing"
        )

    @defer.inlineCallbacks
    def test_a_scan_still_fetches_no_body(self):
        """#102 preserved: the warm must not turn a list view into a body download."""
        for shape in _SCAN_SHAPES:
            _reactor, msg_gets, att_gets = yield self._fetch_shape(shape)
            self.assertEqual(
                [], msg_gets, "%s fetched a body: #102 regressed" % shape.decode()
            )
            self.assertEqual(
                [], att_gets, "%s fetched attachments: #102 regressed" % shape.decode()
            )

    @defer.inlineCallbacks
    def test_rfc822_size_without_a_projection_hydrates_once_in_the_pool(self):
        """#342 miss path, pinned: one message GET, no attachment bytes, off the reactor."""
        for shape in _SIZE_SHAPES:
            on_reactor, msg_gets, att_gets = yield self._fetch_shape(shape)
            self.assertEqual([], on_reactor, "%s stalled the reactor" % shape.decode())
            self.assertEqual(
                1,
                len(msg_gets),
                "%s made %d message GETs, expected exactly one"
                % (shape.decode(), len(msg_gets)),
            )
            self.assertEqual(
                [],
                att_gets,
                "%s downloaded attachment bytes to answer a size" % shape.decode(),
            )

    @defer.inlineCallbacks
    def test_a_body_shape_really_does_fetch_the_body(self):
        """The other side of the scan pin: these shapes MUST hydrate, exactly once."""
        for shape in (b"(RFC822.TEXT)", b"(BODY[])", b"(BODY[HEADER])", b"(BODYSTRUCTURE)"):
            _reactor, msg_gets, _att = yield self._fetch_shape(shape)
            self.assertEqual(
                1,
                len(msg_gets),
                "%s made %d message GETs, expected exactly one"
                % (shape.decode(), len(msg_gets)),
            )

    @defer.inlineCallbacks
    def test_a_per_part_fetch_pulls_one_attachment_not_all(self):
        """#342 preserved: saving one attachment must not download the other."""
        # IMAP part 1 is the text body, part 2 is the first attachment.
        _r, _m, one_part = yield self._fetch_shape(b"(BODY[2])")
        self.assertEqual(
            1, len(one_part), "BODY[2] pulled %d attachments, expected 1" % len(one_part)
        )
        self.assertIn("/attachments/0", one_part[0])

        # Fetching the TEXT part must not drag attachment bytes along with it.
        _rt, _mt, text_part = yield self._fetch_shape(b"(BODY[1])")
        self.assertEqual([], text_part, "BODY[1] (the text part) pulled attachments")

        # CONTROL: the message really does have a second attachment, so the count above
        # is a restriction and not just how many exist.
        _r2, _m2, whole = yield self._fetch_shape(b"(BODY[])")
        self.assertEqual(
            2, len(whole), "BODY[] pulled %d attachments, expected both" % len(whole)
        )

        # And structure-only never pulls bytes.
        _r3, _m3, structure = yield self._fetch_shape(b"(BODYSTRUCTURE)")
        self.assertEqual([], structure, "BODYSTRUCTURE downloaded attachment bytes")


class WarmFailureTest(unittest.TestCase):
    """A failed warm must be invisible: same outcome, and NO second worker call (#457).

    The warm swallows its own errors because the render is the authority on what a FETCH
    answers. That is only safe because the failure is MEMOIZED: without the memo the
    render would repeat the failing call on the reactor thread and re-open the exact
    stall this issue closed, on the worst possible path (a worker that is down, so every
    call costs the full api_timeout).
    """

    def _message(self, exc):
        calls = []

        def hydrate():
            calls.append(1)
            raise exc

        summary = _summary_for("m1")
        return PosternIMAPMessage(summary, uid=1, seq=1, hydrate=hydrate), calls

    def test_a_failed_warm_is_swallowed_and_the_accessor_raises_it(self):
        boom = RuntimeError("worker unreachable")
        msg, calls = self._message(boom)

        msg.prehydrate(fetch_reads(_parse_fetch(b"(RFC822.TEXT)")))
        self.assertEqual(1, len(calls), "the warm did not reach the worker")

        # The warm did not change the outcome: the accessor still raises, verbatim.
        with self.assertRaises(RuntimeError) as caught:
            msg.getBodyFile()
        self.assertIs(boom, caught.exception)

        # And it did NOT call the worker again, which is the whole point: the reactor
        # thread never waits on the network.
        self.assertEqual(1, len(calls), "the render repeated the failed worker call")

    def test_without_a_warm_the_accessor_still_calls_once(self):
        """CONTROL: the memo is not hiding a call that never happened."""
        boom = RuntimeError("worker unreachable")
        msg, calls = self._message(boom)
        with self.assertRaises(RuntimeError):
            msg.getBodyFile()
        self.assertEqual(1, len(calls))
        with self.assertRaises(RuntimeError):
            msg.getBodyFile()
        self.assertEqual(1, len(calls), "a repeated accessor re-called the worker")


def _parse_fetch(raw: bytes):
    parser = imap4._FetchParser()
    parser.parseString(raw.strip(b"()"))
    return parser.result


def _summary_for(message_id: str):
    from posternimap.client import MessageSummary

    return MessageSummary.from_json(make_summary(message_id, uid=1))


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


class FetchWarmMirrorsSpewBodyTest(unittest.TestCase):
    """fetchwarm must mirror the accessors twisted ACTUALLY calls, not the ones it
    used to call (#507).

    The module is only worth anything while it is a faithful mirror of
    imap4.IMAP4Server.spew_body. Since the door implements IMessageFile, spew_body and
    spew_rfc822 no longer walk getHeaders + getBodyFile for a whole-message fetch; they
    call open() and stream it. A mirror still naming the old pair would keep working by
    accident (both paths hydrate) while quietly ceasing to describe the render, which
    is the drift this module exists to prevent.
    """

    def _query(self, spec: bytes):
        from twisted.mail import imap4

        return imap4._FetchParser().parseString(spec) or imap4._FetchParser().parse(spec)

    def _reads(self, spec: bytes):
        from twisted.mail import imap4

        from posternimap.fetchwarm import fetch_reads

        parser = imap4._FetchParser()
        parser.parseString(spec)
        return fetch_reads(parser.result)

    def test_whole_body_fetch_warms_the_message_file(self):
        reads = self._reads(b"(BODY[])")
        self.assertEqual([r.kind for r in reads], ["file"])
        self.assertEqual(reads[0].path, ())

    def test_rfc822_fetch_warms_the_message_file(self):
        reads = self._reads(b"(RFC822)")
        self.assertEqual([r.kind for r in reads], ["file"])

    def test_per_part_and_section_fetches_are_unchanged(self):
        # CONTROL: only the whole-message path moved. A change that turned every shape
        # into a whole-message read would satisfy the two gates above and destroy #102
        # and #342, so pin the neighbours that must NOT have moved.
        self.assertEqual([r.kind for r in self._reads(b"(BODY[2])")], ["body"])
        self.assertEqual([r.kind for r in self._reads(b"(BODY[TEXT])")], ["body"])
        self.assertEqual([r.kind for r in self._reads(b"(BODYSTRUCTURE)")], ["structure"])
        self.assertEqual([r.kind for r in self._reads(b"(BODY[HEADER])")], ["headers"])
        self.assertEqual([r.kind for r in self._reads(b"(RFC822.SIZE)")], ["size"])
        self.assertEqual(self._reads(b"(UID FLAGS)"), ())

    def test_the_file_read_is_applied_by_calling_open(self):
        # The read is only useful if _apply_read actually drives open(); a kind the
        # applier does not understand would be a silent no-op and put the hydration
        # back on the reactor thread.
        from posternimap.fetchwarm import Read
        from posternimap.message import PosternIMAPMessage

        calls = []

        class Spy(PosternIMAPMessage):
            def open(self):
                calls.append("open")
                return None

        spy = Spy.__new__(Spy)
        PosternIMAPMessage._apply_read(spy, Read((), "file"))
        self.assertEqual(calls, ["open"])

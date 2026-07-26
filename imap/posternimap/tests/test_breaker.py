"""Tests for the Worker circuit breaker (#458).

Three things have to hold, and each one has a control that would catch the
opposite implementation:

  1. It opens on CONSECUTIVE TRANSPORT failures only. An HTTP status -- 401, 403,
     500, a Cloudflare 503 -- is the Worker answering, and it must never trip the
     circuit (the control drives twenty of them and asserts the circuit is still
     closed AND that every one of them still reached the transport).
  2. An OPEN breaker FAILS CLOSED. It raises, so the door answers the same honest
     tagged NO an unreachable Worker already produces. It never answers an empty
     mailbox: an empty INBOX because the breaker is open is exactly the #404 / #416
     failure class, and it is pinned here at the mailbox layer AND over the wire.
  3. It recovers on its own: one probe after the cooldown, closed on success,
     re-opened on failure, and never wedged if a probe never reports back.

The clock is injected everywhere, so nothing here sleeps.
"""

from __future__ import annotations

import unittest
import urllib.request

try:
    from twisted.internet import defer, reactor
    from twisted.internet.protocol import ClientCreator
    from twisted.mail import imap4
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore

from posternimap import breaker as breaker_mod
from posternimap.breaker import CLOSED, HALF_OPEN, OPEN, CircuitBreaker, breaker_for
from posternimap.client import PosternClient, PosternError
from posternimap.tests.fakes import ErrorTransport, FakeTransport, make_message


class _Clock:
    """A hand-cranked monotonic clock (no test ever sleeps)."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class DeadTransport:
    """A transport whose every call fails at the TRANSPORT layer.

    This is what a timeout or a refused connection looks like to PosternClient:
    _HttpTransport catches OSError / HTTPException and raises PosternError with NO
    status. The status being None is the whole distinction the breaker keys on.
    """

    expected_token = "tok"

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, req):
        self.calls += 1
        raise PosternError("request failed: [Errno 111] Connection refused")


def _breaker(clock, *, enabled=True, threshold=3, cooldown=30.0, log=None):
    return CircuitBreaker(
        enabled=enabled,
        threshold=threshold,
        cooldown=cooldown,
        endpoint="https://worker.test",
        now=clock,
        log=log if log is not None else (lambda msg: None),
    )


class BreakerStateMachineTest(unittest.TestCase):
    def setUp(self):
        self.clock = _Clock()
        self.lines = []
        self.b = _breaker(self.clock, log=self.lines.append)

    def test_stays_closed_below_the_threshold(self):
        # CONTROL for the open test below: one short of the threshold must still allow.
        for _ in range(2):
            self.assertTrue(self.b.allow())
            self.b.record_transport_failure()
        self.assertEqual(self.b.state, CLOSED)
        self.assertTrue(self.b.allow())

    def test_opens_on_the_threshold_failure_and_fails_fast(self):
        for _ in range(3):
            self.assertTrue(self.b.allow())
            self.b.record_transport_failure()
        self.assertEqual(self.b.state, OPEN)
        self.assertFalse(self.b.allow())
        self.assertGreater(self.b.retry_after(), 0.0)
        self.assertTrue(any("OPEN" in line for line in self.lines))

    def test_a_success_resets_the_consecutive_count(self):
        # The counter is CONSECUTIVE, not cumulative. This test fails against an
        # implementation that merely totals failures: 4 failures with one success in
        # the middle is over a threshold of 3 either way, and only the consecutive
        # reading leaves the circuit closed.
        self.b.record_transport_failure()
        self.b.record_transport_failure()
        self.b.record_success()
        self.b.record_transport_failure()
        self.b.record_transport_failure()
        self.assertEqual(self.b.state, CLOSED)
        self.assertTrue(self.b.allow())

    def test_cooldown_elapses_into_a_single_half_open_probe(self):
        for _ in range(3):
            self.b.record_transport_failure()
        self.clock.advance(29.0)
        self.assertFalse(self.b.allow())  # still cooling down
        self.clock.advance(2.0)
        self.assertTrue(self.b.allow())  # the probe
        self.assertEqual(self.b.state, HALF_OPEN)
        # Everyone else keeps failing fast while that one probe is in flight.
        self.assertFalse(self.b.allow())
        self.assertFalse(self.b.allow())

    def test_probe_success_closes_the_circuit(self):
        for _ in range(3):
            self.b.record_transport_failure()
        self.clock.advance(31.0)
        self.assertTrue(self.b.allow())
        self.b.record_success()
        self.assertEqual(self.b.state, CLOSED)
        self.assertTrue(self.b.allow())
        self.assertTrue(any("CLOSED" in line for line in self.lines))

    def test_probe_failure_reopens_for_another_cooldown(self):
        for _ in range(3):
            self.b.record_transport_failure()
        self.clock.advance(31.0)
        self.assertTrue(self.b.allow())
        self.b.record_transport_failure()
        self.assertEqual(self.b.state, OPEN)
        self.assertFalse(self.b.allow())
        self.assertTrue(any("RE-OPENED" in line for line in self.lines))

    def test_an_abandoned_probe_cannot_wedge_the_breaker(self):
        # A probe that never reports back (its thread died) would otherwise leave the
        # breaker in half_open refusing every call forever. After one more cooldown a
        # fresh probe is admitted.
        for _ in range(3):
            self.b.record_transport_failure()
        self.clock.advance(31.0)
        self.assertTrue(self.b.allow())  # probe admitted, never reported
        self.assertFalse(self.b.allow())
        self.clock.advance(31.0)
        self.assertTrue(self.b.allow())

    def test_disabled_breaker_never_opens(self):
        off = _breaker(self.clock, enabled=False)
        for _ in range(50):
            self.assertTrue(off.allow())
            off.record_transport_failure()
        self.assertEqual(off.state, CLOSED)
        # CONTROL: the identical sequence DOES open an enabled breaker, so this is
        # proving the switch, not proving that failures are never counted.
        on = _breaker(self.clock)
        for _ in range(50):
            on.allow()
            on.record_transport_failure()
        self.assertEqual(on.state, OPEN)

    def test_a_zero_threshold_or_zero_cooldown_disables_it(self):
        for kwargs in ({"threshold": 0}, {"cooldown": 0.0}):
            b = _breaker(self.clock, **kwargs)
            self.assertFalse(b.enabled)
            for _ in range(10):
                b.record_transport_failure()
            self.assertTrue(b.allow())


class BreakerRegistryTest(unittest.TestCase):
    class _Cfg:
        def __init__(self, url):
            self.api_url = url
            self.breaker_enabled = True
            self.breaker_threshold = 3
            self.breaker_cooldown = 30.0

    def setUp(self):
        breaker_mod.reset_registry()
        self.addCleanup(breaker_mod.reset_registry)

    def test_same_endpoint_is_the_same_breaker(self):
        # The account mints a client per mailbox and per session; they must all count
        # into ONE circuit or the threshold is never reached.
        a = breaker_for(self._Cfg("https://worker.test"))
        b = breaker_for(self._Cfg("https://worker.test"))
        self.assertIs(a, b)

    def test_a_different_endpoint_is_a_different_breaker(self):
        a = breaker_for(self._Cfg("https://worker.test"))
        b = breaker_for(self._Cfg("https://other.test"))
        self.assertIsNot(a, b)


class ClientIntegrationTest(unittest.TestCase):
    """The breaker as PosternClient actually uses it, through the real _send path."""

    def setUp(self):
        self.clock = _Clock()

    def _client(self, transport, breaker):
        return PosternClient("https://worker.test", "tok", transport=transport, breaker=breaker)

    def test_transport_failures_open_the_circuit(self):
        t = DeadTransport()
        b = _breaker(self.clock, threshold=3)
        c = self._client(t, b)
        for _ in range(3):
            with self.assertRaises(PosternError):
                c.list_messages(limit=1)
        self.assertEqual(b.state, OPEN)
        self.assertEqual(t.calls, 3)

    def test_open_circuit_does_not_dial_the_transport(self):
        t = DeadTransport()
        b = _breaker(self.clock, threshold=3)
        c = self._client(t, b)
        for _ in range(3):
            with self.assertRaises(PosternError):
                c.list_messages(limit=1)
        dialed = t.calls
        for _ in range(10):
            with self.assertRaises(PosternError) as ctx:
                c.list_messages(limit=1)
            self.assertIn("circuit breaker is OPEN", str(ctx.exception))
        # THE POINT of the whole feature: ten more commands cost zero timeouts.
        self.assertEqual(t.calls, dialed)

    def test_http_status_answers_never_open_the_circuit(self):
        # A 500 (or 401, or a CF edge 503) is the Worker ANSWERING. It arrives in
        # milliseconds, there is no timeout to save, and taking the mailbox offline
        # over it would be a self-inflicted outage.
        for status in (401, 403, 500, 503):
            t = ErrorTransport(status=status)
            b = _breaker(self.clock, threshold=3)
            c = self._client(t, b)
            for _ in range(20):
                with self.assertRaises(PosternError):
                    c.list_messages(limit=1)
            self.assertEqual(b.state, CLOSED, "status %d must not open the circuit" % status)
            # ... and every one of them actually reached the Worker.
            self.assertEqual(len(t.calls), 20)

    def test_a_successful_call_closes_a_half_open_circuit(self):
        msgs = [make_message("m1", subject="one")]
        dead = DeadTransport()
        live = FakeTransport(msgs, expected_token="tok", page_size=10)
        b = _breaker(self.clock, threshold=3)
        broken = self._client(dead, b)
        for _ in range(3):
            with self.assertRaises(PosternError):
                broken.list_messages(limit=1)
        self.assertEqual(b.state, OPEN)
        # The Worker comes back; the next call after the cooldown is the probe.
        healed = self._client(live, b)
        self.clock.advance(31.0)
        page = healed.list_messages(limit=10)
        self.assertEqual(len(page.items), 1)
        self.assertEqual(b.state, CLOSED)

    def test_a_client_without_a_breaker_is_unchanged(self):
        # The pre-#458 construction (no breaker argument) must never fail fast, no
        # matter how many transport failures it sees.
        t = DeadTransport()
        c = PosternClient("https://worker.test", "tok", transport=t)
        for _ in range(20):
            with self.assertRaises(PosternError):
                c.list_messages(limit=1)
        self.assertEqual(t.calls, 20)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class FailClosedMailboxTest(unittest.TestCase):
    """An open breaker must reach the client as an ERROR, never as an empty view."""

    def setUp(self):
        self.clock = _Clock()

    def _mailbox(self, client):
        from posternimap.mailbox import PosternMailbox

        return PosternMailbox(client, page_size=10)

    def test_open_breaker_raises_mailbox_load_error_not_an_empty_mailbox(self):
        from posternimap.mailbox import MailboxLoadError

        b = _breaker(self.clock, threshold=1)
        b.record_transport_failure()
        self.assertEqual(b.state, OPEN)
        client = PosternClient(
            "https://worker.test", "tok", transport=DeadTransport(), breaker=b
        )
        mb = self._mailbox(client)
        with self.assertRaises(MailboxLoadError):
            mb.getMessageCount()
        # Not "zero messages", not an empty list: the load never succeeded.
        with self.assertRaises(MailboxLoadError):
            mb.fetch((1, None), False)

    def test_positive_control_the_same_mailbox_serves_rows_when_closed(self):
        # Without this, the test above would pass against a mailbox that is simply
        # broken; here the ONLY difference is the state of the breaker.
        msgs = [make_message("m1", subject="one"), make_message("m2", subject="two")]
        b = _breaker(self.clock, threshold=1)
        client = PosternClient(
            "https://worker.test",
            "tok",
            transport=FakeTransport(msgs, expected_token="tok", page_size=10),
            breaker=b,
        )
        mb = self._mailbox(client)
        self.assertEqual(mb.getMessageCount(), 2)


def _patched_factory_with_breaker(cfg, transport, breaker):
    """The e2e harness of test_server_e2e, with the SHARED breaker threaded in.

    Mirrors _patched_factory there; the only difference is that the account builds
    its clients with this breaker, which is what the production account does.
    """
    from posternimap import account as account_mod
    from posternimap.auth import build_portal
    from posternimap.server import PosternIMAPFactory

    verify = lambda tok: tok == transport.expected_token
    orig_client = account_mod.PosternAccount._client

    def fake_client(self):
        return PosternClient(
            self._cfg.api_url, self._token, transport=transport, breaker=breaker
        )

    account_mod.PosternAccount._client = fake_client
    factory = PosternIMAPFactory.__new__(PosternIMAPFactory)
    factory._cfg = cfg
    factory._portal = build_portal(cfg, verify=verify)
    return factory, (account_mod.PosternAccount, "_client", orig_client)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class BreakerOverTheWireTest(twisted_unittest.TestCase):
    """The fail-closed guarantee at the only layer that counts: the IMAP wire.

    A client SELECTing INBOX while the breaker is open must get a tagged NO with
    [UNAVAILABLE], the same answer an unreachable Worker already produces -- never an
    OK with an empty mailbox.
    """

    def setUp(self):
        from posternimap.config import Config

        self.clock = _Clock()
        self.breaker = _breaker(self.clock, threshold=2, cooldown=60.0)
        self.transport = DeadTransport()
        cfg = Config(
            api_url="https://worker.test",
            auth_mode="token",
            api_timeout=5.0,
            imap_poll_seconds=0,
        )
        self.factory, self._restore = _patched_factory_with_breaker(
            cfg, self.transport, self.breaker
        )
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        cls, attr, orig = self._restore
        setattr(cls, attr, orig)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def _client(self):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_select_answers_a_tagged_no_while_the_breaker_is_open(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            # Two failed SELECTs trip the breaker (threshold 2). Each is already a NO.
            for _ in range(2):
                d = proto.select(b"INBOX")
                exc = yield self.assertFailure(d, imap4.IMAP4Exception)
                self.assertIn("UNAVAILABLE", str(exc))
            self.assertEqual(self.breaker.state, OPEN)
            dialed = self.transport.calls
            # The breaker is open. The answer must be the SAME honest NO, and it must
            # cost nothing: no dial, no timeout.
            d = proto.select(b"INBOX")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertIn("UNAVAILABLE", str(exc))
            self.assertIn("temporarily unavailable", str(exc))
            self.assertEqual(self.transport.calls, dialed)
        finally:
            yield proto.transport.loseConnection()


if __name__ == "__main__":
    unittest.main()

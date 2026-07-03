"""End-to-end: drive the real Twisted IMAP4 server with a real IMAP4 client.

Spins the actual PosternIMAPFactory (portal + auth + account + mailbox) on a
loopback port, connects Twisted's own IMAP4Client, and exercises the real wire
protocol: LOGIN -> LIST -> SELECT -> FETCH -> SEARCH -> LOGOUT. The Postern API
is faked via the injectable client transport (no network), but everything from
the IMAP socket down to the rendered RFC822 is the production code path.

Skipped cleanly if Twisted is not installed. Uses Twisted trial's
inlineCallbacks; runnable via `python -m twisted.trial` or stdlib unittest (trial
TestCase subclasses unittest.TestCase).
"""

from __future__ import annotations

import unittest

try:
    from twisted.cred import portal
    from twisted.internet import defer, reactor
    from twisted.internet.protocol import ClientCreator
    from twisted.mail import imap4
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore

from posternimap.config import Config
from posternimap.proxyproto import ProxyProtocolConfig, parse_trusted
from posternimap.tests.fakes import ErrorTransport, FakeTransport, make_message


def _patched_factory(cfg, transport):
    """Build the real factory but with the account's PosternClient transport
    swapped for the fake, so no network is touched."""
    from posternimap import account as account_mod
    from posternimap.auth import build_portal
    from posternimap.client import PosternClient
    from posternimap.server import PosternIMAPFactory

    # Verifier that accepts the fake's token without a live ping.
    verify = lambda tok: tok == transport.expected_token

    # Make PosternAccount build clients on the fake transport.
    orig_client = account_mod.PosternAccount._client

    def fake_client(self):
        return PosternClient(self._cfg.api_url, self._token, transport=transport)

    account_mod.PosternAccount._client = fake_client

    factory = PosternIMAPFactory.__new__(PosternIMAPFactory)
    factory._cfg = cfg
    factory._portal = build_portal(cfg, verify=verify)
    return factory, (account_mod.PosternAccount, "_client", orig_client)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerE2ETest(twisted_unittest.TestCase):
    def setUp(self):
        self.msgs = [
            make_message("m3", direction="outbound", subject="sent note"),
            make_message("m2", subject="meeting tuesday", body="lunch?"),
            make_message("m1", subject="welcome aboard", body="hello"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        # poll disabled: these exercise LOGIN/LIST/SELECT/FETCH, not live refresh,
        # so no LoopingCall is scheduled to dirty trial's reactor. The poll has
        # its own deterministic coverage in test_mailbox (via twisted Clock).
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
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
    def test_login_select_fetch(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            mailboxes = yield proto.list("", "*")
            names = {m[2] for m in mailboxes}
            self.assertIn("INBOX", names)
            self.assertIn("Sent", names)
            # RFC 6154 special-use: the Sent entry must carry the \\Sent attribute
            # (m[0] is the LIST flags) so a client auto-maps its Sent folder.
            flags_by_name = {m[2]: set(m[0]) for m in mailboxes}
            self.assertIn("\\Sent", flags_by_name["Sent"])
            self.assertIn("Drafts", names)
            self.assertIn("\\Drafts", flags_by_name["Drafts"])

            # INBOX is inbound-only (m1, m2); m3 is outbound -> in Sent.
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)

            # FETCH message 2 (oldest-first within INBOX: m1=1, m2=2).
            result = yield proto.fetchMessage("2")
            raw = result[2]["RFC822"]
            text = raw.decode() if isinstance(raw, bytes) else raw
            self.assertIn("meeting tuesday", text)
            self.assertIn("lunch?", text)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_bad_token_login_fails(self):
        proto = yield self._client()
        d = proto.login(b"agent", b"wrong-token")
        yield self.assertFailure(d, imap4.IMAP4Exception)
        yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_header_fields_fetch_returns_headers(self):
        # Regression for #179, at the wire: a client that scans with
        # BODY.PEEK[HEADER.FIELDS (...)] instead of ENVELOPE (the Gmail app's
        # dialect) must get the real headers back. Twisted's FETCH parser hands
        # the parenthesized field names to IMessagePart.getHeaders as BYTES; the
        # old str-only name matching returned an empty header block for EVERY
        # message, which Gmail rendered as "(no subject)" + a blank sender.
        proto = yield self._client()
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            yield proto.select(b"INBOX")
            # The Gmail-app scan shape (content-type forces the hydrated path;
            # a pure envelope subset is covered at the unit layer).
            result = yield proto.fetchSpecific(
                "1:*",
                headerType="HEADER.FIELDS",
                headerArgs=["DATE", "SUBJECT", "FROM", "CONTENT-TYPE", "TO", "CC"],
                peek=True,
            )
            self.assertEqual(len(result), 2)  # both INBOX messages answered
            for seq, parts in result.items():
                blob = "".join(
                    p.decode("utf-8", "replace") if isinstance(p, bytes) else str(p)
                    for part in parts
                    for p in part
                )
                self.assertIn("Subject", blob)
                self.assertIn("From", blob)
            # And the values are the stored ones, not an empty block.
            flat = repr(result)
            self.assertIn("meeting tuesday", flat)
            self.assertIn("welcome aboard", flat)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_sent_mailbox_is_outbound_only(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"Sent")
            self.assertEqual(info["EXISTS"], 1)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_placeholder_folder_selectable_and_empty(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"Drafts")
            self.assertEqual(info["EXISTS"], 0)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_append_to_sent_succeeds(self):
        # Thunderbird APPENDs its own copy of a sent message into Sent after
        # submission; this must succeed (no-op), not error.
        import io

        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            msg = io.BytesIO(b"From: a@example.com\r\nSubject: copy\r\n\r\nbody\r\n")
            # IMAP4Client.append returns a Deferred that fires on a positive tagged
            # response; assertFailure is NOT expected here -- it must succeed.
            yield proto.append("Sent", msg, ("\\Seen",))
        finally:
            yield proto.logout()


    @defer.inlineCallbacks
    def test_append_to_placeholder_folder_is_rejected(self):
        # #109 end-to-end: APPEND into a placeholder (Drafts) returns a tagged NO
        # with a clear reason, NOT a fake OK that silently drops the message.
        import io

        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            msg = io.BytesIO(b"From: a@example.com\r\nSubject: draft\r\n\r\nbody\r\n")
            d = proto.append("Drafts", msg, ("\\Seen",))
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertIn("does not store", str(exc))
        finally:
            yield proto.logout()


    @defer.inlineCallbacks
    def test_uid_fetch_returns_ascending_and_stable_uids(self):
        # F9 end-to-end: a UID FETCH over the real wire must return UIDs that are
        # strictly ascending and equal to the store rowids (the All folder is
        # unfiltered, so all three: rowids 1, 2, 3), and the SAME UIDs across a
        # re-SELECT -- the stability a client relies on to reconcile its cache.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"All")
            self.assertEqual(info["EXISTS"], 3)
            result = yield proto.fetchUID("1:*")
            # result maps sequence number -> {"UID": <value>}; key in seq order.
            uids = [int(result[seq]["UID"]) for seq in sorted(result, key=int)]
            self.assertEqual(uids, [1, 2, 3])
            self.assertEqual(uids, sorted(uids))  # strictly ascending (RFC 3501)
            # Re-SELECT and re-fetch: identical UIDs (stable within UIDVALIDITY).
            yield proto.select(b"All")
            again = yield proto.fetchUID("1:*")
            self.assertEqual(
                [int(again[seq]["UID"]) for seq in sorted(again, key=int)], [1, 2, 3]
            )
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_search_all_over_the_wire(self):
        # Regression: SEARCH used to crash the server. PosternMailbox is not an
        # ISearchableMailbox, so IMAP4Server.do_SEARCH takes its manual-search
        # fallback (__cbManualSearch), which subscripts the IMailbox.fetch result
        # (result[-1][0]). fetch() returned a GENERATOR, so the server raised
        # `TypeError: 'generator' object is not subscriptable` and answered
        # `BAD [SEARCH failed: ...]`. The fix materializes fetch() to a list. This
        # asserts a plain SEARCH ALL completes and returns the sequence numbers.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"All")
            self.assertEqual(info["EXISTS"], 3)
            # SEARCH ALL -> message sequence numbers (1-based, oldest-first).
            seqs = yield proto.search(imap4.Query(all=True))
            self.assertEqual(sorted(int(n) for n in seqs), [1, 2, 3])
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_uid_search_all_over_the_wire(self):
        # The exact failure Conrad's --phase-on run hit: `UID SEARCH` returned
        # `BAD [SEARCH failed: 'generator' object is not subscriptable']`. With the
        # fetch()-returns-a-list fix the manual-search path can subscript/slice the
        # result, so UID SEARCH ALL completes and returns the store UIDs (the All
        # folder is unfiltered: rowids 1, 2, 3).
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"All")
            self.assertEqual(info["EXISTS"], 3)
            uids = yield proto.search(imap4.Query(all=True), uid=True)
            self.assertEqual(sorted(int(n) for n in uids), [1, 2, 3])
        finally:
            yield proto.logout()


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerErrorPathE2ETest(twisted_unittest.TestCase):
    """#143/#144 over the wire: a failing upstream store read on SELECT or STATUS must
    return a clean tagged NO (no server-side TypeError, no unhandled traceback), not a
    BAD 'Server error' or a str/bytes crash in __ebStatus."""

    def _spin(self, status):
        transport = ErrorTransport(status=status)
        cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        factory, restore = _patched_factory(cfg, transport)
        port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        self._restore = restore
        self._port = port
        return port.getHost(), transport

    def tearDown(self):
        cls, attr, orig = self._restore
        setattr(cls, attr, orig)
        return self._port.stopListening()

    @defer.inlineCallbacks
    def _client(self, addr):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_select_upstream_401_returns_tagged_no(self):
        # #144: SELECT INBOX with a stale read token (upstream 401) must be a tagged NO
        # the client can retry, not a BAD 'Server error' + logged traceback.
        addr, _ = self._spin(401)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            d = proto.select(b"INBOX")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            msg = str(exc)
            self.assertIn("UNAVAILABLE", msg)
            self.assertIn("temporarily unavailable", msg)
            self.assertNotIn("Server error", msg)
        finally:
            yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_select_upstream_5xx_returns_tagged_no(self):
        addr, _ = self._spin(503)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            d = proto.select(b"INBOX")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertIn("UNAVAILABLE", str(exc))
        finally:
            yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_status_upstream_error_returns_tagged_no_no_crash(self):
        # #143: STATUS INBOX whose backend read FAILS must NOT trip the Twisted 26.4.0
        # __ebStatus str/bytes TypeError; it returns a clean tagged NO. (Pre-fix this
        # raised `can't concat str to bytes` in the errback and produced no clean
        # response.) Trial fails the test if any error is logged and unflushed, which is
        # exactly the "no unhandled traceback" guarantee the issue asks for.
        addr, _ = self._spin(401)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            d = proto.status(b"INBOX", "MESSAGES", "UIDNEXT")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            msg = str(exc)
            self.assertIn("UNAVAILABLE", msg)
            self.assertIn("STATUS", msg)
        finally:
            yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_status_5xx_returns_tagged_no(self):
        addr, _ = self._spin(502)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            d = proto.status(b"INBOX", "MESSAGES")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertIn("UNAVAILABLE", str(exc))
        finally:
            yield proto.transport.loseConnection()


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerEnvelopeUnicodeE2ETest(twisted_unittest.TestCase):
    """#161 over the wire: a FETCH (ENVELOPE) scan over a mailbox holding a message
    with non-ASCII envelope fields (U+2026 + CJK in Subject + display-name) must NOT
    raise Twisted's UnicodeEncodeError and drop the connection. It must return valid
    RFC 2047 encoded-words. This is the exact failure that aborted Conrad's live 0.6
    measurement scan (every MUA runs `1:* (ENVELOPE ...)` on folder open)."""

    UNICODE_SUBJECT = "Re: café … 日本語 meeting"
    UNICODE_FROM = "Élodie Café … <elodie@example.com>"

    def setUp(self):
        self.msgs = [
            make_message("m2", subject=self.UNICODE_SUBJECT, **{"from": self.UNICODE_FROM}),
            make_message("m1", subject="plain ascii", body="hello"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
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
    def test_fetch_envelope_over_unicode_mailbox_does_not_crash(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)
            # The whole-mailbox ENVELOPE scan every MUA does on folder open. Pre-fix
            # this raised UnicodeEncodeError server-side and the client saw socket EOF.
            result = yield proto.fetchEnvelope("1:*")
            self.assertEqual(len(result), 2)
            # The unicode message is seq 2 (oldest-first: m1=1, m2=2). Its ENVELOPE
            # subject (index 1) must be an ASCII RFC 2047 encoded-word.
            envelope = result[2]["ENVELOPE"]
            subject = envelope[1]
            subject_s = subject.decode() if isinstance(subject, bytes) else str(subject)
            self.assertIn("=?", subject_s)  # RFC 2047 encoded-word
            self.assertTrue(all(ord(c) < 128 for c in subject_s))
            # And it decodes back to the original Subject.
            from email.header import decode_header, make_header

            self.assertEqual(str(make_header(decode_header(subject_s))), self.UNICODE_SUBJECT)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_fetch_full_envelope_specific_unicode_message(self):
        # A direct ENVELOPE fetch of just the unicode message (a client opening it).
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"INBOX")
            result = yield proto.fetchEnvelope("2")
            envelope = result[2]["ENVELOPE"]
            # from (index 2) is a list of (name, source-route, mailbox, host); the
            # display-name carries the encoded-word, the mailbox/host stay ASCII.
            from_field = envelope[2]
            flat = repr(from_field)
            self.assertIn("=?", flat)
            self.assertIn("elodie", flat)
        finally:
            yield proto.logout()


if HAVE_TWISTED:
    class _ProxyHeaderIMAP4Client(imap4.IMAP4Client):
        """An IMAP4 client that prepends a PROXY protocol v1 header on connect, the
        way the L4 load balancer would. Server-speaks-first, so writing the header
        before waiting for the greeting is correct (the wrapper strips it, then the
        real IMAP greeting flows)."""

        PROXY_HEADER = b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\r\n"

        def connectionMade(self):
            self.transport.write(self.PROXY_HEADER)
            imap4.IMAP4Client.connectionMade(self)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerProxyProtocolE2ETest(twisted_unittest.TestCase):
    """#155 over a real socket: with PROXY require + a trusted loopback source, a
    client that prepends a v1 PROXY header logs in and selects normally. This proves
    the header is stripped off the raw stream BEFORE the IMAP parser sees a byte (a
    leftover header byte would corrupt the very first IMAP command), end to end with
    real TCP segmentation -- not just the unit-level wrapper."""

    def setUp(self):
        self.msgs = [
            make_message("m2", subject="meeting tuesday", body="lunch?"),
            make_message("m1", subject="welcome aboard", body="hello"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        # require + loopback trusted; a generous timeout that resolve() cancels the
        # instant the (immediately-sent) header is parsed, so no callLater is left to
        # dirty trial's reactor.
        self.cfg = Config(
            api_url="https://x",
            auth_mode="token",
            api_timeout=5.0,
            imap_poll_seconds=0,
            proxy_protocol=ProxyProtocolConfig(
                mode="require", trusted=parse_trusted("127.0.0.0/8"), timeout=5.0
            ),
        )
        factory, self._restore = _patched_factory(self.cfg, self.transport)
        from posternimap.proxywrap import wrap_listener_factory

        wrapped = wrap_listener_factory(self.cfg.proxy_protocol, factory, reactor=reactor)
        self.port = reactor.listenTCP(0, wrapped, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        cls, attr, orig = self._restore
        setattr(cls, attr, orig)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def test_login_select_through_proxy_header(self):
        cc = ClientCreator(reactor, _ProxyHeaderIMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)
        finally:
            yield proto.logout()


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ProxyOverTLSChainTest(unittest.TestCase):
    """#155 on the real 993 path (PROXY then implicit TLS): prove the composed chain
    raw -> PROXY strip -> TLS engages a real handshake. The wrapper hands `self` to
    the TLSMemoryBIOProtocol as its transport, so this confirms the wrapper-as-
    transport delegation (write/registerProducer/disconnecting) works for the TLS
    protocol too, not just the IMAP LineReceiver covered by the socket e2e above. In
    memory (no reactor): feed a real ClientHello after the header and assert the TLS
    server wrote a handshake response back through the wrapper."""

    def setUp(self):
        try:
            from OpenSSL import SSL  # noqa: F401
            from posternimap.tests.test_tls import _gen_self_signed
        except ImportError:
            self.skipTest("pyOpenSSL / TLS extra not installed")
        import tempfile

        from twisted.internet import reactor

        self._reactor = reactor
        # Snapshot pre-existing reactor timers so tearDown cancels ONLY the ones this
        # in-memory test creates (a real TLS engine + the inner IMAP server schedule
        # real-reactor calls: the TLS small-write flush and the IMAP idle timeout).
        # We drive no real socket, so nothing here runs them; cancelling our own keeps
        # the reactor clean for the next test without touching anyone else's timers.
        self._pre_calls = {id(c) for c in reactor.getDelayedCalls()}
        self._proto = None
        self._dir = tempfile.TemporaryDirectory()
        self.cert, self.key = _gen_self_signed(self._dir.name)

    def tearDown(self):
        from twisted.internet import protocol

        if self._proto is not None:
            # Tear the wrapper down: this propagates connectionLost into the TLS
            # protocol and the inner IMAP server, cancelling the IMAP idle timeout.
            self._proto.connectionLost(protocol.connectionDone)
        for call in list(self._reactor.getDelayedCalls()):
            if id(call) not in self._pre_calls and call.active():
                call.cancel()
        self._dir.cleanup()

    def test_proxy_then_tls_engages_handshake(self):
        import ssl as stdssl
        from twisted.internet.address import IPv4Address
        from twisted.internet.task import Clock
        from twisted.internet.testing import StringTransport
        from twisted.protocols.tls import TLSMemoryBIOFactory

        from posternimap.proxyproto import ProxyProtocolConfig, parse_trusted
        from posternimap.proxywrap import ProxyProtocolWrappingFactory
        from posternimap.server import _build_tls_context_factory

        msgs = [make_message("m1", subject="x", body="y")]
        fake = FakeTransport(msgs, expected_token="tok", page_size=2)
        cfg = Config(api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0)
        factory, restore = _patched_factory(cfg, fake)
        self.addCleanup(lambda: setattr(restore[0], restore[1], restore[2]))

        ctx = _build_tls_context_factory(self.cert, self.key)
        tls_factory = TLSMemoryBIOFactory(ctx, False, factory)
        proxy_cfg = ProxyProtocolConfig(
            mode="require", trusted=parse_trusted("127.0.0.0/8"), timeout=5.0
        )
        wf = ProxyProtocolWrappingFactory(proxy_cfg, tls_factory, reactor=Clock())
        proto = wf.buildProtocol(None)
        self._proto = proto
        st = StringTransport(peerAddress=IPv4Address("TCP", "127.0.0.1", 5000))
        proto.makeConnection(st)

        # A real TLS ClientHello from a stdlib memory-BIO client. PROTOCOL_TLS_CLIENT
        # is the recommended secure constant (no deprecated SSLv2/SSLv3/TLSv1/TLSv1.1),
        # and the 1.2 floor matches the server floor _build_tls_context_factory enforces
        # (#106), so only TLS 1.2+ is ever offered. Verification is off: this client
        # only needs to emit a ClientHello to drive the server handshake through the
        # wrapper, not to trust the self-signed test cert.
        client_ctx = stdssl.SSLContext(stdssl.PROTOCOL_TLS_CLIENT)
        client_ctx.minimum_version = stdssl.TLSVersion.TLSv1_2
        client_ctx.check_hostname = False
        client_ctx.verify_mode = stdssl.CERT_NONE
        incoming, outgoing = stdssl.MemoryBIO(), stdssl.MemoryBIO()
        client = client_ctx.wrap_bio(incoming, outgoing, server_hostname="postern.test")
        try:
            client.do_handshake()
        except stdssl.SSLWantReadError:
            pass
        client_hello = outgoing.read()

        header = b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\r\n"
        proto.dataReceived(header + client_hello)

        # The TLS server, reached through the wrapper transport, must have written a
        # handshake response (ServerHello, ...) back out. Empty output would mean the
        # header was not stripped (TLS saw garbage) or the wrapper transport failed.
        self.assertGreater(len(st.value()), 0)
        # And the wrapper presents the recovered client to everything downstream.
        self.assertEqual(proto.getPeer().host, "198.51.100.7")


if HAVE_TWISTED:
    class _RecordingIMAP4Client(imap4.IMAP4Client):
        """Captures unsolicited EXISTS (the IMailboxListener.newMessages callback the
        client fires when the server pushes an untagged EXISTS)."""

        def __init__(self, *a, **k):
            imap4.IMAP4Client.__init__(self, *a, **k)
            self.exists_events = []

        def newMessages(self, exists, recent):
            if exists is not None:
                self.exists_events.append(int(exists))


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerNoopRefreshE2ETest(twisted_unittest.TestCase):
    """#102 over the wire: a NOOP must surface mail that arrived mid-session as an
    untagged EXISTS, EVEN with the timed poll disabled (poll_seconds=0). Proves the
    do_NOOP override drives mailbox.poll_now()."""

    def setUp(self):
        self.msgs = [
            make_message("m2", subject="meeting tuesday", body="lunch?"),
            make_message("m1", subject="welcome aboard", body="hello"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        # poll_seconds=0: no LoopingCall (keeps trial's reactor clean); NOOP must still
        # surface new mail via the synchronous poll_now.
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        cls, attr, orig = self._restore
        setattr(cls, attr, orig)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def _client(self):
        cc = ClientCreator(reactor, _RecordingIMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_noop_surfaces_new_mail_mid_session(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)
            # New inbound mail arrives at the newest end AFTER the snapshot loaded.
            self.transport.messages.insert(0, make_message("m3", subject="fresh", body="new"))
            # noop() returns the untagged status the server pushed during NOOP; the
            # refresh must have surfaced the new arrival as an untagged EXISTS = 3.
            lines = yield proto.noop()
            exists = [ln for ln in lines if len(ln) == 2 and ln[1] == b"EXISTS"]
            self.assertTrue(exists, "no untagged EXISTS on NOOP: %r" % (lines,))
            self.assertEqual(int(exists[-1][0]), 3)
        finally:
            yield proto.logout()


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerIdleCapabilityE2ETest(twisted_unittest.TestCase):
    """#102 RFC 2177: advertise IDLE only when a live push path (the timed poll) exists.
    With the poll off, advertising IDLE while never pushing would be non-compliant.
    CAPABILITY needs no SELECT, so no LoopingCall is started (reactor stays clean)."""

    def _spin(self, poll_seconds):
        transport = FakeTransport([make_message("m1", subject="x", body="y")],
                                  expected_token="tok", page_size=2)
        cfg = Config(api_url="https://x", auth_mode="token", api_timeout=5.0,
                     imap_poll_seconds=poll_seconds)
        factory, self._restore = _patched_factory(cfg, transport)
        self._port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        return self._port.getHost()

    def tearDown(self):
        cls, attr, orig = self._restore
        setattr(cls, attr, orig)
        return self._port.stopListening()

    @defer.inlineCallbacks
    def _caps(self, addr):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", addr.port)
        try:
            caps = yield proto.getCapabilities()
        finally:
            yield proto.transport.loseConnection()
        defer.returnValue(caps)

    @defer.inlineCallbacks
    def test_idle_advertised_when_poll_enabled(self):
        caps = yield self._caps(self._spin(30))
        self.assertIn(b"IDLE", caps)

    @defer.inlineCallbacks
    def test_idle_not_advertised_when_poll_disabled(self):
        caps = yield self._caps(self._spin(0))
        self.assertNotIn(b"IDLE", caps)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerIdlePushTest(unittest.TestCase):
    """#102 RFC 2177: while a client IDLEs, the timed poll's new-mail push must reach it
    as an untagged EXISTS. do_IDLE keeps the connection selected (still a registered
    mailbox listener), so a poll tick that finds new mail forwards an EXISTS straight to
    the idling client. Deterministic: a StringTransport + a manual poll tick, no reactor,
    no LoopingCall (mailbox default poll_seconds=0, so addListener starts no loop)."""

    def test_poll_pushes_exists_to_a_client_in_idle(self):
        from twisted.internet.testing import StringTransport
        from posternimap.server import PosternIMAP4Server
        from posternimap.mailbox import PosternMailbox
        from posternimap.client import PosternClient

        fake = FakeTransport(
            [make_message("m1", subject="a", body="x")], expected_token="tok", page_size=2
        )
        client = PosternClient("https://x", "tok", transport=fake)
        mbox = PosternMailbox(client, page_size=2, direction="inbound")
        self.assertEqual(mbox.getMessageCount(), 1)  # load the snapshot

        proto = PosternIMAP4Server()
        proto.makeConnection(StringTransport())
        # makeConnection schedules the IMAP idle-timeout on the real reactor; cancel it
        # so this reactor-less test leaves no DelayedCall for the next trial test.
        self.addCleanup(proto.setTimeout, None)
        # What SELECT wires up: the mailbox and the server-as-listener.
        proto.mbox = mbox
        mbox.addListener(proto)
        proto.do_IDLE(b"t1")  # enter IDLE (continuation request)
        proto.transport.clear()  # drop greeting + continuation; keep only the push

        # New inbound mail arrives; a poll tick surfaces it and pushes to the idler.
        fake.messages.insert(0, make_message("m2", subject="b", body="y"))
        mbox._poll_tick()

        wire = proto.transport.value()
        self.assertIn(b"EXISTS", wire)
        self.assertIn(b"2", wire)  # the new mailbox size

        mbox.removeListener(proto)  # clean teardown (no loop was running)


if __name__ == "__main__":
    unittest.main()

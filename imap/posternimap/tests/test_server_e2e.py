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

    UNICODE_SUBJECT = "Re: caf\u00e9 \u2026 \u65e5\u672c\u8a9e meeting"
    UNICODE_FROM = "\u00c9lodie Caf\u00e9 \u2026 <elodie@example.com>"

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


if __name__ == "__main__":
    unittest.main()

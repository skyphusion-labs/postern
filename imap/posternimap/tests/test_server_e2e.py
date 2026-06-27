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
from posternimap.tests.fakes import FakeTransport, make_message


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
        self.cfg = Config(api_url="https://x", auth_mode="token", api_timeout=5.0)
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


if __name__ == "__main__":
    unittest.main()

"""#504 RFC 6855 UTF8=ACCEPT at the wire.

WHY EVERY GATE HERE IS AN E2E GATE. Twisted has no ENABLE at all (26.4.0 contains zero
occurrences of ENABLE, 5161, 6855 or UTF8), and it cannot put UTF-8 on the wire:
collapseNestedLists does i.encode("ascii") and _formatHeaders ends in networkString().
Both of those run INSIDE the protocol as it writes the response, so a unit test cannot
reach them. Measured during development, with the serve gate in place but before the
wire overrides existed: FETCH (ENVELOPE) over a non-ASCII identifier died with
UnicodeEncodeError inside collapseNestedLists and the client got a dropped connection,
while every unit suite was green. That is the #500 lesson and it is why this file talks
to a real socket.

THE CENTRAL CLAIM, and the one that gates the ship decision: a connection that has NOT
run ENABLE cannot be served a different byte than it was before this feature existed.
That is guaranteed by the GATE (a per-connection flag defaulting False), not by the
population, and it is proven here by asserting the exact pre-existing folded bytes.
"""

from __future__ import annotations

import re
import socket
import unittest

try:
    from twisted.internet import defer, reactor, threads
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore

from posternimap.config import Config
from posternimap.tests.fakes import FakeTransport, make_message
from posternimap.tests.test_server_e2e import _patched_factory, _restore_account

IRT_NONASCII = "parent-café-日本語@example.com"
SUBJECT_NONASCII = "café … 日本語"
IMAP_TOKEN = "imap-tok"

# The EXACT bytes a non-enabled connection has always been served for IRT_NONASCII.
# Pinned as a constant on purpose: this is the "no byte moves" contract, and a change
# to it must be a deliberate edit to this line, never a quiet drift.
FOLDED_IRT = b"<parent-caf?-???@example.com>"
RAW_IRT = ("<" + IRT_NONASCII + ">").encode("utf-8")

QUOTE = bytes([34])
ENV_IRT = re.compile(QUOTE + b"(<parent[^" + QUOTE + b"]*>)" + QUOTE)
HDR_IRT = re.compile(b"In-Reply-To: (<parent[^>]*>)")


def _talk(port, commands, literal=None):
    sock = socket.create_connection(("127.0.0.1", port), timeout=15)
    sock.settimeout(15)
    try:
        buf = sock.recv(65536)
        for command in commands:
            sock.sendall(command.encode("utf-8") + b"\r\n")
            tag = command.split(" ", 1)[0].encode("ascii")
            sent = False
            for _ in range(600):
                if re.search(b"^" + tag + b" (OK|NO|BAD)", buf, re.M):
                    break
                if literal is not None and not sent and re.search(b"^\\+ ", buf, re.M):
                    sock.sendall(literal + b"\r\n")
                    sent = True
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                buf += chunk
        return buf
    finally:
        sock.close()


class _DoorTest(twisted_unittest.TestCase):
    def setUp(self):
        self.msgs = [
            make_message("m-subj@example.com", subject=SUBJECT_NONASCII, body="hi"),
            make_message("m-irt@example.com", inReplyTo=IRT_NONASCII, body="hi"),
        ]
        self.transport = FakeTransport(
            self.msgs, expected_token="tok", page_size=20,
            token_scopes={"tok": "both", IMAP_TOKEN: "imap"},
        )
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0,
            imap_poll_seconds=0, service_imap_token=IMAP_TOKEN,
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self.port.stopListening()

    def _plain(self, *commands):
        return threads.deferToThread(
            _talk, self.addr.port,
            ["a1 LOGIN agent tok", "a2 SELECT INBOX"] + list(commands), None,
        )

    def _enabled(self, *commands):
        return threads.deferToThread(
            _talk, self.addr.port,
            ["a1 LOGIN agent tok", "a2 ENABLE UTF8=ACCEPT", "a3 SELECT INBOX"]
            + list(commands), None,
        )


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class EnableCommandTest(_DoorTest):
    """RFC 5161 ENABLE, which twisted does not have at all."""

    @defer.inlineCallbacks
    def test_capability_advertises_utf8_accept(self):
        raw = yield threads.deferToThread(_talk, self.addr.port, ["a1 CAPABILITY"], None)
        self.assertIn(b"UTF8=ACCEPT", raw)

    @defer.inlineCallbacks
    def test_enable_in_authenticated_state_is_accepted_and_echoed(self):
        raw = yield threads.deferToThread(
            _talk, self.addr.port, ["a1 LOGIN agent tok", "a2 ENABLE UTF8=ACCEPT"], None
        )
        text = raw.decode("latin-1")
        self.assertIn("* ENABLED UTF8=ACCEPT", text)
        self.assertRegex(text, r"(?m)^a2 OK")

    @defer.inlineCallbacks
    def test_enable_before_login_is_BAD(self):
        """RFC 5161 section 3.1: ENABLE is valid only in the authenticated state."""
        raw = yield threads.deferToThread(_talk, self.addr.port, ["a1 ENABLE UTF8=ACCEPT"], None)
        self.assertRegex(raw.decode("latin-1"), r"(?m)^a1 BAD")

    @defer.inlineCallbacks
    def test_enable_after_select_is_BAD(self):
        """RFC 5161 section 3.1: a client MUST NOT issue ENABLE once a mailbox is
        selected, and the server SHOULD reply BAD. We get that by binding auth_ENABLE
        only, so this test is what stops someone helpfully adding select_ENABLE."""
        raw = yield threads.deferToThread(
            _talk, self.addr.port,
            ["a1 LOGIN agent tok", "a2 SELECT INBOX", "a3 ENABLE UTF8=ACCEPT"], None,
        )
        self.assertRegex(raw.decode("latin-1"), r"(?m)^a3 BAD")

    @defer.inlineCallbacks
    def test_unknown_capability_is_silently_not_enabled_and_still_OK(self):
        raw = yield threads.deferToThread(
            _talk, self.addr.port, ["a1 LOGIN agent tok", "a2 ENABLE FROBOZZ"], None
        )
        text = raw.decode("latin-1")
        self.assertRegex(text, r"(?m)^a2 OK")
        self.assertNotIn("FROBOZZ", text)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServeGateTest(_DoorTest):
    @defer.inlineCallbacks
    def test_a_connection_that_did_not_enable_sees_the_pre_existing_bytes(self):
        """THE no-byte-moves contract, asserted as literal bytes."""
        raw = yield self._plain("a3 FETCH 1 (ENVELOPE)")
        found = ENV_IRT.search(raw)
        self.assertIsNotNone(found)
        self.assertEqual(found.group(1), FOLDED_IRT)
        self.assertNotIn(IRT_NONASCII.encode("utf-8"), raw)

    @defer.inlineCallbacks
    def test_an_enabled_connection_is_served_the_identifier_as_it_is_stored(self):
        raw = yield self._enabled("a4 FETCH 1 (ENVELOPE)")
        found = ENV_IRT.search(raw)
        self.assertIsNotNone(found)
        self.assertEqual(found.group(1), RAW_IRT)

    @defer.inlineCallbacks
    def test_an_enabled_connection_gets_ONE_string_across_seams(self):
        """#517 must not be rebuilt inside the extension: the ENVELOPE quoted-string and
        the BODY[HEADER] literal must still agree once UTF-8 is flowing."""
        raw = yield self._enabled(
            "a4 FETCH 1 (ENVELOPE)",
            "a5 FETCH 1 (BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO)])",
        )
        env = ENV_IRT.search(raw)
        hdr = HDR_IRT.search(raw)
        self.assertIsNotNone(env)
        self.assertIsNotNone(hdr)
        self.assertEqual(env.group(1), hdr.group(1))
        self.assertEqual(env.group(1), RAW_IRT)

    @defer.inlineCallbacks
    def test_enabling_does_not_decode_rfc2047(self):
        """RFC 6855 permits SENDING UTF-8; it does not require undoing a sender
        encoding. The 241 non-ASCII Subject rows on prod must not move."""
        raw = yield self._enabled("a4 FETCH 2 (ENVELOPE)")
        self.assertIn(b"=?utf-8?b?", raw)
        self.assertNotIn(SUBJECT_NONASCII.encode("utf-8"), raw)

    @defer.inlineCallbacks
    def test_two_concurrent_connections_do_not_leak_state_into_each_other(self):
        """The stamp is per-FETCH on per-connection message objects. If that were ever
        shared, one client enabling the extension would change what ANOTHER client is
        served, which is the worst failure this design could have."""
        enabled = yield self._enabled("a4 FETCH 1 (ENVELOPE)")
        plain = yield self._plain("a3 FETCH 1 (ENVELOPE)")
        again = yield self._enabled("a4 FETCH 1 (ENVELOPE)")
        self.assertEqual(ENV_IRT.search(enabled).group(1), RAW_IRT)
        self.assertEqual(ENV_IRT.search(plain).group(1), FOLDED_IRT)
        self.assertEqual(ENV_IRT.search(again).group(1), RAW_IRT)

    @defer.inlineCallbacks
    def test_header_field_order_is_deterministic_and_matches_the_projection(self):
        """Found while building the byte-equality harness for this feature: the summary
        path iterated a SET, so BODY[HEADER.FIELDS] came back in Python string-hash
        order, which is randomised per process. The door served a different byte order
        on every restart and disagreed with the hydrated path, which yields message
        order. Both now follow the projection's order."""
        cold = yield self._plain(
            "a3 FETCH 1 (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM IN-REPLY-TO)])"
        )
        hot = yield self._plain(
            "a3 FETCH 1 (RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM IN-REPLY-TO)])"
        )

        def names(raw):
            block = raw.split(b"HEADER.FIELDS", 1)[1]
            return [
                line.split(b":", 1)[0].lower()
                for line in block.split(b"\r\n")
                if b":" in line and not line.startswith(b"*")
            ]

        self.assertEqual(names(cold), names(hot))
        self.assertEqual(
            names(cold), [b"from", b"subject", b"message-id", b"in-reply-to"]
        )


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class AppendGateTest(_DoorTest):
    @staticmethod
    def _mime(msgid, subject):
        return (
            "Message-ID: <" + msgid + ">\r\n"
            "Subject: " + subject + "\r\n"
            "From: agent@skyphusion.org\r\n"
            "To: b@example.com\r\n"
            "Date: Thu, 18 Jun 2026 12:00:00 +0000\r\n"
            "\r\nhi\r\n"
        ).encode("utf-8")

    @defer.inlineCallbacks
    def test_8bit_append_is_refused_without_enable(self):
        body = self._mime("id-café@example.com", "café")
        raw = yield threads.deferToThread(
            _talk, self.addr.port,
            ["a1 LOGIN agent@skyphusion.org tok", "a2 APPEND Archive {%d}" % len(body)],
            body,
        )
        text = raw.decode("latin-1")
        self.assertRegex(text, r"(?m)^a2 NO")
        self.assertIn("UTF8=ACCEPT", text)
        self.assertIsNone(self.transport.last_import_payload)

    @defer.inlineCallbacks
    def test_8bit_append_is_accepted_once_enabled(self):
        """The other half of the gate. A refusal suite with no accepting case cannot
        tell a working gate from a door that refuses everything."""
        body = self._mime("id-café@example.com", "café")
        raw = yield threads.deferToThread(
            _talk, self.addr.port,
            [
                "a1 LOGIN agent@skyphusion.org tok",
                "a2 ENABLE UTF8=ACCEPT",
                "a3 APPEND Archive {%d}" % len(body),
            ],
            body,
        )
        self.assertRegex(raw.decode("latin-1"), r"(?m)^a3 OK")
        self.assertIsNotNone(self.transport.last_import_payload)

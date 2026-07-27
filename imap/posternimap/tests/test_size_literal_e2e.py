"""#507 at the wire: RFC822.SIZE must byte-match the BODY[] literal it labels.

WHY THIS IS AN E2E TEST AND NOT A UNIT TEST. The number the door announces and the
bytes the door serves are produced by different machinery, and only the socket sees
both. Before #507 the door handed Twisted a PARSED tree and Twisted re-serialized it
(imap4.MessageProducer), so BODY[] was a second serialization that the projected size
had never described: headers came out CRLF, the body came out with bare LF, and the
announced size was short by the header count plus one. Every unit suite was green
throughout, because no unit test can see a serializer that runs inside the protocol.

So these gates read the announced values off the RESPONSE BYTES on a raw socket, the
way strummer measured the bug, against the real PosternIMAPFactory and the real
twisted IMAP4Server. The only thing faked is the Postern API transport.

The chain that makes SIZE trustworthy end to end has three links, and each is gated:
  1. the worker projects a size into D1  (inbound/projected-size.test.ts)
  2. the worker projection and the door projection are byte-identical
     (the shared golden constants, this repo, both suites)
  3. the door SERVES exactly what it projected  -- this file.
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

DATA = b"%PDF-1.4\n" + bytes(range(256))
HTML = "<p>hi there</p>"
BODY = "line one\nline two\nline three"


def _talk(port: int, commands):
    """Drive a raw IMAP session and return every byte the server sent."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=15)
    sock.settimeout(15)
    try:
        buf = sock.recv(65536)
        for command in commands:
            sock.sendall(command.encode("ascii") + b"\r\n")
            tag = command.split(" ", 1)[0].encode("ascii")
            while not re.search(b"^" + tag + b" (OK|NO|BAD)", buf, re.M):
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buf += chunk
        return buf
    finally:
        sock.close()


def _announced(raw: bytes):
    """Pull the announced SIZE, the announced literal length, and the literal bytes."""
    size = re.search(b"RFC822\\.SIZE (\\d+)", raw)
    lit = re.search(b"BODY\\[\\] \\{(\\d+)\\}", raw)
    if not size or not lit:
        raise AssertionError("no RFC822.SIZE / BODY[] literal in the response: %r" % raw[-400:])
    length = int(lit.group(1))
    start = raw.index(lit.group(0)) + len(lit.group(0)) + 2
    return int(size.group(1)), length, raw[start : start + length]


def _shapes():
    """The four projection shapes, which are four DIFFERENT serializer paths."""
    att = {"id": "a1", "filename": "inv.pdf", "mime": "application/pdf", "size": len(DATA)}
    return {
        "plain": make_message("m1", body=BODY),
        "html": make_message("m1", body=BODY, bodyHtml=HTML),
        "attachment": make_message(
            "m1", body=BODY, attachments=[att], attachmentBytes=[DATA]
        ),
        "html+attachment": make_message(
            "m1", body=BODY, bodyHtml=HTML, attachments=[att], attachmentBytes=[DATA]
        ),
    }


class SizeMatchesLiteralE2ETest(twisted_unittest.TestCase):
    """The #507 invariant, on the wire, for every projection shape."""

    def _spin(self, message):
        transport = FakeTransport([message], expected_token="tok", page_size=10)
        cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        factory, restore = _patched_factory(cfg, transport)
        port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        return port, restore

    @defer.inlineCallbacks
    def _fetch(self, message, command):
        port, restore = self._spin(message)
        try:
            raw = yield threads.deferToThread(
                _talk,
                port.getHost().port,
                ["a LOGIN agent@skyphusion.org tok", "b SELECT INBOX", command],
            )
        finally:
            _restore_account(restore)
            yield port.stopListening()
        return _announced(raw)

    @defer.inlineCallbacks
    def test_announced_size_equals_the_literal_for_every_shape(self):
        for label, message in _shapes().items():
            size, length, payload = yield self._fetch(
                message, "c FETCH 1 (RFC822.SIZE BODY.PEEK[])"
            )
            self.assertEqual(
                size,
                length,
                "%s: announced RFC822.SIZE %d but served a {%d} literal" % (label, size, length),
            )
            # Controls: the assertion above must be about a real, fully read message,
            # not an empty literal or a truncated read that happens to agree.
            self.assertEqual(len(payload), length, "%s: short read" % label)
            self.assertGreater(length, 100, "%s: suspiciously small literal" % label)
            self.assertIn(b"Subject:", payload, "%s: that is not a rendered message" % label)

    @defer.inlineCallbacks
    def test_served_literal_has_no_bare_lf_for_every_shape(self):
        # RFC 5322 section 2.1. Before #507 the body went out with bare LF on every
        # single-part message, because twisted copied the body file through verbatim.
        for label, message in _shapes().items():
            _size, _length, payload = yield self._fetch(
                message, "c FETCH 1 (RFC822.SIZE BODY.PEEK[])"
            )
            self.assertEqual(
                payload.count(b"\n"),
                payload.count(b"\r\n"),
                "%s: bare LF on the wire" % label,
            )
            self.assertEqual(
                payload.count(b"\r"), payload.count(b"\r\n"), "%s: bare CR on the wire" % label
            )
            # Control: a message with no line breaks at all would pass the two counts
            # above trivially, so require that the literal really is multi-line.
            self.assertGreater(payload.count(b"\r\n"), 3, "%s: no CRLF at all" % label)

    @defer.inlineCallbacks
    def test_rfc822_fetch_literal_also_matches_the_announced_size(self):
        # RFC822 is a second twisted code path (spew_rfc822), and it prefers
        # IMessageFile exactly as spew_body does. If only one of the two were wired,
        # this gate would catch it.
        for label, message in _shapes().items():
            port, restore = self._spin(message)
            try:
                raw = yield threads.deferToThread(
                    _talk,
                    port.getHost().port,
                    [
                        "a LOGIN agent@skyphusion.org tok",
                        "b SELECT INBOX",
                        "c FETCH 1 (RFC822.SIZE RFC822)",
                    ],
                )
            finally:
                _restore_account(restore)
                yield port.stopListening()
            size = re.search(b"RFC822\\.SIZE (\\d+)", raw)
            lit = re.search(b"RFC822 \\{(\\d+)\\}", raw)
            self.assertTrue(size and lit, "%s: no RFC822 literal in %r" % (label, raw[-300:]))
            self.assertEqual(
                int(size.group(1)),
                int(lit.group(1)),
                "%s: RFC822.SIZE %s but RFC822 literal {%s}"
                % (label, size.group(1), lit.group(1)),
            )

    @defer.inlineCallbacks
    def test_cached_projected_size_also_matches_the_literal(self):
        # The path a real client takes on a warm mailbox: SIZE comes from the D1 cache
        # (summary projectedSize) and never re-renders, while BODY[] comes from the
        # renderer. That is the #342 seam where a drift hides, so it gets its own gate.
        # The cached number here is the PYTHON projection; the golden constants shared
        # with inbound/projected-size.test.ts are what tie it to the worker value.
        from posternimap.client import Attachment, Message
        from posternimap.rfc822 import PROJECTION_VERSION, project_rfc822_size

        message = make_message("m1", body=BODY)
        projected = project_rfc822_size(
            Message(
                message_id="m1",
                direction="inbound",
                thread_id="m1",
                from_addr="m1@example.com",
                to_addr="agent@skyphusion.org",
                subject="Subject m1",
                date="2026-06-18T12:00:00Z",
                in_reply_to=None,
                body_text=BODY,
                trusted=True,
                received_at="2026-06-18T12:00:01Z",
                attachments=[],
            )
        )
        message["projectedSize"] = projected
        message["projectionVersion"] = PROJECTION_VERSION
        size, length, _payload = yield self._fetch(
            message, "c FETCH 1 (RFC822.SIZE BODY.PEEK[])"
        )
        # Control: the cache really was the source, not a re-render that happened to
        # agree, so the announced number must be the number that was cached.
        self.assertEqual(size, projected, "the cached projected size was not used")
        self.assertEqual(size, length, "cached SIZE %d but a {%d} literal" % (size, length))


if not HAVE_TWISTED:  # pragma: no cover
    SizeMatchesLiteralE2ETest = unittest.skip("twisted not installed")(  # type: ignore
        SizeMatchesLiteralE2ETest
    )

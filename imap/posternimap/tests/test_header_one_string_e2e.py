"""#517 at the wire: ONE stored header value must be served as ONE string.

WHY THIS IS AN E2E TEST. The ENVELOPE quoted-string and the BODY[HEADER] literal are
produced by two different code paths over two different in-memory representations of
the same stored value (a real `str` from the list summary, an `email.header.Header`
from re-parsing our own rendered bytes), and WHICH path runs depends on whether
something else in the same FETCH forced hydration. No unit test can see that, because
the choice is made by the protocol as it renders the response. The bug was measured on
a raw socket and it is pinned on a raw socket.

Measured on main at 9f7a768, before the fix, for ONE stored In-Reply-To:

    ENVELOPE (bare query)          <parent-caf?-???@example.com>
    ENVELOPE (query with SIZE)     <parent-caf??-?????????@example.com>
    BODY[HEADER]                   <parent-caf?-???@example.com>
    BODY[]                         <parent-cafe-acute...@example.com>   (raw UTF-8)

Three strings for one value, and the ENVELOPE form moved with the query shape.

WHAT THIS FILE PINS, and each is a separate way the fix can rot:
  1. every seam that ASCII-folds agrees, byte for byte;
  2. the folded form does NOT move with the FETCH query shape (the hydration seam);
  3. BODY[] still carries the raw bytes and RFC822.SIZE still byte-matches it (#507);
  4. an RFC 2047 encoded-word is NOT decoded (the 241-row Subject population must not
     move; RFC 6855 permits sending UTF-8, it does not require decoding 2047);
  5. an APPEND with 8-bit headers is refused as a tagged NO naming RFC 6855, never a
     BAD and never an internal AttributeError.
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
from posternimap.rfc822 import header_text
from posternimap.tests.fakes import FakeTransport, make_message
from posternimap.tests.test_server_e2e import _patched_factory, _restore_account

# A wide spread on purpose: a 2-byte sequence, a 3-byte sequence, and a run of them,
# because the two lossy folds differed by BYTE COUNT and a single-character sample
# cannot tell a per-character fold from a per-byte one (they agree at 1 byte).
IRT_NONASCII = "parent-café-日本語@example.com"
SUBJECT_NONASCII = "café … 日本語"
IMAP_TOKEN = "imap-tok"

QUOTE = bytes([34])
ENV_IRT = re.compile(QUOTE + b"(<parent[^" + QUOTE + b"]*>)" + QUOTE)
HDR_IRT = re.compile(b"In-Reply-To: (<parent[^>]*>)")
LITERAL = re.compile(b"BODY\\[\\] \\{(\\d+)\\}\r\n")
SIZE = re.compile(b"RFC822\\.SIZE (\\d+)")


def _talk(port, commands, literal=None):
    """Drive a raw IMAP session and return every byte the server sent."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=15)
    sock.settimeout(15)
    try:
        buf = sock.recv(65536)
        for command in commands:
            sock.sendall(command.encode("utf-8") + b"\r\n")
            tag = command.split(" ", 1)[0].encode("ascii")
            sent = False
            for _ in range(400):
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


class HeaderTextUnitTest(unittest.TestCase):
    """header_text is the single canonicaliser; these are its three input shapes."""

    def _parsed(self, raw: bytes, name: str):
        import email

        return email.message_from_bytes(raw)[name]

    def test_raw_8bit_header_recovers_the_original_text(self):
        raw = b"In-Reply-To: <p-caf\xc3\xa9-\xe6\x97\xa5@example.com>\r\n\r\nx"
        value = self._parsed(raw, "In-Reply-To")
        # POSITIVE CONTROL: the stdlib really did hand back a Header, not a str, or this
        # test is exercising the passthrough branch and proves nothing about the fix.
        self.assertNotIsInstance(value, str)
        self.assertEqual(header_text(value), "<p-café-日@example.com>")

    def test_plain_str_passes_through_untouched(self):
        self.assertEqual(header_text("<plain@example.com>"), "<plain@example.com>")

    def test_rfc2047_encoded_word_is_NOT_decoded(self):
        raw = b"Subject: =?utf-8?b?Y2Fmw6k=?=\r\n\r\nx"
        value = self._parsed(raw, "Subject")
        self.assertIsInstance(value, str)  # ASCII, so never a Header
        self.assertEqual(header_text(value), "=?utf-8?b?Y2Fmw6k=?=")


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class OneStringPerHeaderE2ETest(twisted_unittest.TestCase):
    def setUp(self):
        # The fake serves the list newest-first and the mailbox presents oldest-first,
        # so this order puts the In-Reply-To message at sequence 1 and the encoded-word
        # Subject message at sequence 2. setUp asserts that rather than assuming it.
        self.msgs = [
            make_message("m-subj@example.com", subject=SUBJECT_NONASCII, body="hi"),
            make_message("m-irt@example.com", inReplyTo=IRT_NONASCII, body="hi"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=10)
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

    def _session(self, *commands, literal=None):
        return threads.deferToThread(
            _talk, self.addr.port,
            ["x1 LOGIN agent tok", "x2 SELECT INBOX"] + list(commands),
            literal,
        )

    @defer.inlineCallbacks
    def test_every_seam_and_hydration_state_serves_one_identical_string(self):
        """The matrix, and the ONLY honest form of this check.

        A weaker version of this test (bare ENVELOPE compared against a bare
        HEADER.FIELDS fetch) PASSES against the unfixed code, because both of those
        queries answer from the list summary and so both take the same path. The bug
        only appears when one observation is served from the summary and the other from
        the re-parsed projection. So the matrix must cross BOTH seams with BOTH hydration
        states, on a FRESH connection each time so one observation cannot warm the next.

        Verified by reverting header_text: this test fails, the weaker one does not.
        """
        observations = {}

        raw = yield self._session("x3 FETCH 1 (ENVELOPE)")
        observations["envelope/cold"] = ENV_IRT.search(raw)

        raw = yield self._session("x3 FETCH 1 (ENVELOPE RFC822.SIZE)")
        observations["envelope/hydrated"] = ENV_IRT.search(raw)

        raw = yield self._session("x3 FETCH 1 (BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO)])")
        observations["header-fields/cold"] = HDR_IRT.search(raw)

        raw = yield self._session("x3 FETCH 1 (BODY.PEEK[HEADER])")
        observations["whole-header/hydrated"] = HDR_IRT.search(raw)

        for label, found in observations.items():
            self.assertIsNotNone(found, "no In-Reply-To observed at %s" % label)
        served = {label: found.group(1) for label, found in observations.items()}
        self.assertEqual(
            len(set(served.values())), 1,
            "one stored value served as several strings: %r" % served,
        )

    @defer.inlineCallbacks
    def test_the_served_form_does_not_move_with_the_query_shape(self):
        """The hydration seam alone, held separately so a regression says WHICH half
        broke. Pre-fix these three returned two different strings."""
        forms = []
        for query in (
            "x3 FETCH 1 (ENVELOPE)",
            "x3 FETCH 1 (ENVELOPE RFC822.SIZE)",
            "x3 FETCH 1 (ENVELOPE BODY.PEEK[TEXT])",
        ):
            raw = yield self._session(query)
            found = ENV_IRT.search(raw)
            self.assertIsNotNone(found, "no ENVELOPE id for %r" % query)
            forms.append(found.group(1))
        self.assertEqual(len(set(forms)), 1, "query shape changed the served id: %r" % forms)

    @defer.inlineCallbacks
    def test_body_literal_still_carries_raw_bytes_and_size_still_matches(self):
        """#507 must not regress: BODY[] is the projection and SIZE describes it."""
        raw = yield self._session("x3 FETCH 1 (RFC822.SIZE BODY.PEEK[])")
        lit = LITERAL.search(raw)
        size = SIZE.search(raw)
        self.assertIsNotNone(lit)
        self.assertIsNotNone(size)
        announced = int(lit.group(1))
        body = raw[lit.end():lit.end() + announced]
        self.assertEqual(len(body), announced)
        self.assertEqual(int(size.group(1)), announced)
        # The literal is the honest projection: the raw UTF-8 id, not a folded one.
        self.assertIn(IRT_NONASCII.encode("utf-8"), body)

    @defer.inlineCallbacks
    def test_encoded_word_subject_is_served_unchanged(self):
        """The 241-row prod population. Folding must not start decoding RFC 2047."""
        raw = yield self._session("x3 FETCH 2 (ENVELOPE)")
        self.assertIn(b"=?utf-8?b?", raw)
        self.assertNotIn(SUBJECT_NONASCII.encode("utf-8"), raw)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class Append8BitRefusalE2ETest(twisted_unittest.TestCase):
    """RFC 6855: 8-bit headers on a connection that has not enabled UTF8=ACCEPT are a
    tagged NO. A 5xx-style BAD is not acceptable here and never was."""

    def setUp(self):
        self.transport = FakeTransport(
            [make_message("m1", body="hello")], expected_token="tok", page_size=10,
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

    @staticmethod
    def _mime(msgid, subject, body="hi"):
        return (
            "Message-ID: <" + msgid + ">\r\n"
            "Subject: " + subject + "\r\n"
            "From: agent@skyphusion.org\r\n"
            "To: b@example.com\r\n"
            "Date: Thu, 18 Jun 2026 12:00:00 +0000\r\n"
            "\r\n" + body + "\r\n"
        ).encode("utf-8")

    @defer.inlineCallbacks
    def test_ascii_append_still_succeeds(self):
        """POSITIVE CONTROL. Without this the refusal below proves nothing: a harness
        that cannot APPEND at all would answer NO to everything."""
        body = self._mime("ctl@example.com", "plain ascii")
        raw = yield threads.deferToThread(
            _talk, self.addr.port,
            ["a1 LOGIN agent@skyphusion.org tok", "a2 APPEND Archive {%d}" % len(body)],
            body,
        )
        self.assertRegex(raw.decode("latin-1"), r"(?m)^a2 OK")
        self.assertIsNotNone(self.transport.last_import_payload)

    @defer.inlineCallbacks
    def test_8bit_header_append_is_a_tagged_NO_naming_the_extension(self):
        body = self._mime("id-café@example.com", "café 日本語")
        self.assertTrue(any(b > 127 for b in body))
        raw = yield threads.deferToThread(
            _talk, self.addr.port,
            ["a1 LOGIN agent@skyphusion.org tok", "a2 APPEND Archive {%d}" % len(body)],
            body,
        )
        text = raw.decode("latin-1")
        self.assertRegex(text, r"(?m)^a2 NO")
        self.assertNotRegex(text, r"(?m)^a2 BAD")
        self.assertIn("UTF8=ACCEPT", text)
        # The old accidental refusal leaked an internal AttributeError as the reason.
        self.assertNotIn("has no attribute", text)
        self.assertIsNone(self.transport.last_import_payload)

    @defer.inlineCallbacks
    def test_8bit_BODY_is_still_accepted(self):
        """The gate is scoped to HEADERS. An 8-bit body is ordinary 8BITMIME mail and
        refusing it would break normal traffic; this is the negative control on scope."""
        body = self._mime("ascii-hdr@example.com", "plain ascii", body="café 日")
        self.assertTrue(any(b > 127 for b in body))
        raw = yield threads.deferToThread(
            _talk, self.addr.port,
            ["a1 LOGIN agent@skyphusion.org tok", "a2 APPEND Archive {%d}" % len(body)],
            body,
        )
        self.assertRegex(raw.decode("latin-1"), r"(?m)^a2 OK")

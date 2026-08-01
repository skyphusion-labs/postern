"""#531 over the wire: an attachment's BODYSTRUCTURE filename parameter must equal
the stored filename exactly, not the filename wrapped in an extra layer of RFC 2822
quoted-string quoting.

WHY THIS IS AN E2E TEST AND NOT A UNIT TEST. Twisted's own Content-Disposition parser
(_MessageStructure._disposition in twisted.mail.imap4, a documented "XXX Poorly tested
parser") never strips the quoted-string wrapper it is handed, unlike its Content-Type
parameter handling (_unquotedAttrs, which DOES call unquote()) -- so before the fix,
("filename" "repro-4096.bin") went out on the wire as ("filename" "\"repro-4096.bin\"").
The rendered Content-Disposition HEADER and the Content-Type name= parameter were both
already correct; only this one BODYSTRUCTURE field was wrong. Only a real socket sees the
actual serialized parenthesized list Twisted produces (see rfc822.fix_bodystructure_disposition
and server.py PosternIMAP4Server.spew_bodystructure for the fix itself).

Three shapes, so the fix strips exactly the wrapper rather than mangling the filename: a
plain filename (the original repro), one containing a space (which genuinely requires RFC
2822 quoting to render at all), and one containing a literal quote character (which
requires quoting AND backslash-escaping -- a blanket quote-deleting fix would corrupt
this case; a byte-exact reversal of rfc822._quote_filename does not).
"""

from __future__ import annotations

import re
import socket
import unittest

try:
    from twisted.internet import defer, reactor, threads
    from twisted.mail import imap4
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore

from posternimap.config import Config
from posternimap.tests.fakes import FakeTransport, make_message
from posternimap.tests.test_server_e2e import _patched_factory, _restore_account

DATA = b"x" * 4096


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


class BodyStructureFilenameE2ETest(twisted_unittest.TestCase):
    def _spin(self, filename):
        att = {
            "id": "a1",
            "filename": filename,
            "mime": "application/octet-stream",
            "size": len(DATA),
        }
        # Body-only, no HTML: the attachment is the top-level multipart/mixed's
        # SECOND part, index 1 -- keeps the structure navigation below fixed and
        # simple regardless of which filename is under test.
        message = make_message("m1", body="hello", attachments=[att], attachmentBytes=[DATA])
        transport = FakeTransport([message], expected_token="tok", page_size=10)
        cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        factory, restore = _patched_factory(cfg, transport)
        port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        return port, restore

    @defer.inlineCallbacks
    def _disposition_filename(self, filename):
        port, restore = self._spin(filename)
        try:
            raw = yield threads.deferToThread(
                _talk,
                port.getHost().port,
                [
                    "a LOGIN agent@skyphusion.org tok",
                    "b SELECT INBOX",
                    "c FETCH 1 (BODYSTRUCTURE)",
                ],
            )
        finally:
            _restore_account(restore)
            yield port.stopListening()
        m = re.search(rb"BODYSTRUCTURE (\(.*\))\r\nc OK", raw)
        self.assertIsNotNone(m, "no BODYSTRUCTURE in the response: %r" % raw[-300:])
        # [:-1] drops the ONE trailing paren that closes the untagged FETCH
        # response itself ("* 1 FETCH (BODYSTRUCTURE (...))"), not the
        # BODYSTRUCTURE list -- parseNestedParens wants a balanced s-expression.
        parsed = imap4.parseNestedParens(m.group(1)[:-1])
        top = parsed[0]
        attachment_part = top[1]
        # Basic fields (7) + [md5, disposition, language, location]: disposition
        # is index 8 -- see rfc822.fix_bodystructure_disposition's docstring for
        # why this offset is fixed regardless of message shape.
        disposition = attachment_part[8]
        self.assertEqual(
            disposition[0], b"attachment", "not the attachment part: %r" % (attachment_part,)
        )
        params = disposition[1]
        self.assertEqual(params[0], b"filename")
        return params[1].decode()

    @defer.inlineCallbacks
    def test_plain_filename_round_trips_exactly(self):
        # The literal reported repro (#531): a filename with nothing that needs
        # RFC 2822 quoted-string escaping.
        got = yield self._disposition_filename("repro-4096.bin")
        self.assertEqual(got, "repro-4096.bin")

    @defer.inlineCallbacks
    def test_filename_with_a_space_round_trips_exactly(self):
        # A space forces the rendered header into quoted-string form; the fix
        # must strip exactly that wrapper, not merely happen to work when the
        # renderer chooses not to quote.
        got = yield self._disposition_filename("repro 4096.bin")
        self.assertEqual(got, "repro 4096.bin")

    @defer.inlineCallbacks
    def test_filename_with_a_legitimate_quote_character_round_trips_exactly(self):
        # A literal quote in the filename forces BOTH quoting and backslash
        # escaping of that quote in the rendered header. A blanket "delete every
        # quote character" fix would turn this into "repro4096.bin" (wrong); the
        # correct fix reverses the escaping and leaves the real quote intact.
        got = yield self._disposition_filename('repro"4096.bin')
        self.assertEqual(got, 'repro"4096.bin')


if not HAVE_TWISTED:  # pragma: no cover
    BodyStructureFilenameE2ETest = unittest.skip("twisted not installed")(  # type: ignore
        BodyStructureFilenameE2ETest
    )

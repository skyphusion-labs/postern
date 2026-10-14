"""#531 / #534 over the wire: BODYSTRUCTURE attachment filename AND Content-Type name
must equal the stored filename exactly.

#531 -- Content-Disposition `filename`: Twisted's _disposition never strips the
RFC 2822 quoted-string wrapper, so ("filename" "repro-4096.bin") went out as
("filename" "\"repro-4096.bin\"").

#534 -- Content-Type `name`: _unquotedAttrs DOES call unquote(), which strips the
outer wrapper only. A filename with a literal quote still carries a residual
backslash on the name parameter (disposition is already correct after #531).

Only a real socket sees the serialized parenthesized list Twisted produces (see
rfc822.fix_bodystructure_disposition and server.py spew_bodystructure).

Three shapes so the fix reverses quoting/escaping rather than mangling: plain
filename, one with a space, one with a literal quote (the #534 failing case).
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
from posternimap.tests.settle import wait_for_server_connections_to_close
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
    def _attachment_bodystructure_params(self, filename):
        """Return (disposition_filename, content_type_name) from the wire BODYSTRUCTURE."""
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
            yield wait_for_server_connections_to_close()
        m = re.search(rb"BODYSTRUCTURE (\(.*\))\r\nc OK", raw)
        self.assertIsNotNone(m, "no BODYSTRUCTURE in the response: %r" % raw[-300:])
        # [:-1] drops the ONE trailing paren that closes the untagged FETCH
        # response itself ("* 1 FETCH (BODYSTRUCTURE (...))"), not the
        # BODYSTRUCTURE list -- parseNestedParens wants a balanced s-expression.
        parsed = imap4.parseNestedParens(m.group(1)[:-1])
        top = parsed[0]
        attachment_part = top[1]
        # Single-part attachment: basic fields put Content-Type params at index 2
        # (type, subtype, params, ...). Disposition is index 8 once the 4
        # extension fields are appended -- see fix_bodystructure_disposition.
        ct_params = attachment_part[2]
        self.assertIsInstance(ct_params, list, "no Content-Type params: %r" % (attachment_part,))
        name_val = None
        for i in range(0, len(ct_params) - 1, 2):
            if ct_params[i] == b"name":
                name_val = ct_params[i + 1].decode()
                break
        self.assertIsNotNone(name_val, "no name= in Content-Type params: %r" % (ct_params,))

        disposition = attachment_part[8]
        self.assertEqual(
            disposition[0], b"attachment", "not the attachment part: %r" % (attachment_part,)
        )
        disp_params = disposition[1]
        self.assertEqual(disp_params[0], b"filename")
        return disp_params[1].decode(), name_val

    @defer.inlineCallbacks
    def test_plain_filename_round_trips_exactly(self):
        # The literal reported repro (#531): a filename with nothing that needs
        # RFC 2822 quoted-string escaping. Both parameters are controls for #534.
        disp, name = yield self._attachment_bodystructure_params("repro-4096.bin")
        self.assertEqual(disp, "repro-4096.bin")
        self.assertEqual(name, "repro-4096.bin")

    @defer.inlineCallbacks
    def test_filename_with_a_space_round_trips_exactly(self):
        # A space forces the rendered header into quoted-string form; the fix
        # must strip exactly that wrapper, not merely happen to work when the
        # renderer chooses not to quote.
        disp, name = yield self._attachment_bodystructure_params("repro 4096.bin")
        self.assertEqual(disp, "repro 4096.bin")
        self.assertEqual(name, "repro 4096.bin")

    @defer.inlineCallbacks
    def test_filename_with_a_legitimate_quote_character_round_trips_exactly(self):
        # A literal quote forces quoting AND backslash-escaping. Disposition
        # (#531) and Content-Type name (#534) must both reverse that and leave
        # the real quote intact -- a blanket quote-delete would yield
        # "repro4096.bin".
        disp, name = yield self._attachment_bodystructure_params('repro"4096.bin')
        self.assertEqual(disp, 'repro"4096.bin')
        self.assertEqual(name, 'repro"4096.bin')


if not HAVE_TWISTED:  # pragma: no cover
    BodyStructureFilenameE2ETest = unittest.skip("twisted not installed")(  # type: ignore
        BodyStructureFilenameE2ETest
    )

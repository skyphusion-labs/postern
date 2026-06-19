"""Tests for the RFC822 renderer (pure stdlib email parsing, no Twisted)."""

from __future__ import annotations

import email
import unittest

from posternimap.client import Attachment, Message
from posternimap.rfc822 import render_rfc822


def _msg(**over) -> Message:
    base = dict(
        message_id="abc123",
        direction="inbound",
        thread_id="abc123",
        from_addr="alice@example.com",
        to_addr="agent@skyphusion.org",
        subject="Hello",
        date="2026-06-18T12:00:00Z",
        in_reply_to=None,
        body_text="line one\nline two",
        trusted=True,
        received_at="2026-06-18T12:00:01Z",
        attachments=[],
    )
    base.update(over)
    return Message(**base)


class RenderTest(unittest.TestCase):
    def test_headers_and_body_roundtrip(self):
        raw = render_rfc822(_msg())
        parsed = email.message_from_bytes(raw)
        self.assertEqual(parsed["From"], "alice@example.com")
        self.assertEqual(parsed["To"], "agent@skyphusion.org")
        self.assertEqual(parsed["Subject"], "Hello")
        self.assertEqual(parsed["Message-ID"], "<abc123>")
        self.assertIsNotNone(parsed["Date"])
        body = parsed.get_payload(decode=True).decode()
        self.assertIn("line one", body)
        self.assertIn("line two", body)

    def test_in_reply_to_header(self):
        parsed = email.message_from_bytes(render_rfc822(_msg(in_reply_to="parent-id")))
        self.assertEqual(parsed["In-Reply-To"], "<parent-id>")

    def test_attachment_note_has_real_newlines(self):
        m = _msg(attachments=[Attachment(filename="report.pdf", mime="application/pdf", size=10)])
        body = email.message_from_bytes(render_rfc822(m)).get_payload(decode=True).decode()
        self.assertIn("report.pdf", body)
        self.assertIn("1 attachment(s)", body)
        # The note must use a real newline, not the literal backslash-n bug.
        self.assertNotIn("\\n", body)

    def test_header_injection_is_neutralized(self):
        # A subject with CRLF + a fake header must not inject a second header.
        m = _msg(subject="Evil\r\nBcc: victim@example.com")
        parsed = email.message_from_bytes(render_rfc822(m))
        self.assertIsNone(parsed["Bcc"])

    def test_bad_date_falls_back(self):
        parsed = email.message_from_bytes(render_rfc822(_msg(date="not-a-date")))
        # Either a parsed date or the raw fallback, but never a crash / empty msg.
        self.assertIsNotNone(parsed.get_payload())


if __name__ == "__main__":
    unittest.main()

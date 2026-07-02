"""Tests for the RFC822 renderer (pure stdlib email parsing, no Twisted)."""

from __future__ import annotations

import email
import unittest

from posternimap.client import Attachment, Message, MessageSummary
from posternimap.rfc822 import envelope_headers, render_rfc822


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

    def test_bracketed_identifiers_are_not_double_wrapped(self):
        # #179 transcript: the store keeps In-Reply-To VERBATIM (with its angle
        # brackets; only messageId is stripped at ingest), so wrapping again put
        # "<<...>>" on the wire and broke client threading. Wrapping must be
        # idempotent for both identifier fields, in the render AND the body-free
        # envelope scan.
        m = _msg(in_reply_to="<parent@github.com>", message_id="<abc123>")
        parsed = email.message_from_bytes(render_rfc822(m))
        self.assertEqual(parsed["In-Reply-To"], "<parent@github.com>")
        self.assertEqual(parsed["Message-ID"], "<abc123>")
        h = envelope_headers(_summary(in_reply_to="<parent@github.com>"))
        self.assertEqual(h["in-reply-to"], "<parent@github.com>")
        self.assertEqual(h["message-id"], "<abc123>")

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


def _summary(**over) -> MessageSummary:
    base = dict(
        uid=1,
        message_id="abc123",
        direction="inbound",
        thread_id="abc123",
        from_addr="alice@example.com",
        to_addr="agent@skyphusion.org",
        subject="Hello",
        date="2026-06-18T12:00:00Z",
        in_reply_to=None,
        trusted=True,
        received_at="2026-06-18T12:00:01Z",
        attachment_count=0,
    )
    base.update(over)
    return MessageSummary(**base)


def _is_ascii(s: str) -> bool:
    return all(ord(c) < 128 for c in s)


class EnvelopeUnicodeTest(unittest.TestCase):
    """#161: non-ASCII envelope fields must be RFC 2047 encoded-words (pure ASCII,
    single line), so the IMAP ENVELOPE serializer never hits an implicit-ASCII
    encode crash that drops the connection on a folder scan."""

    # U+2026 (the exact char from the live crash) + a CJK run + a Latin-1 accent.
    UNICODE_SUBJECT = "Re: café … 日本語 meeting"
    UNICODE_FROM = "Élodie Café … <elodie@example.com>"

    def test_envelope_headers_are_ascii_encoded_words(self):
        h = envelope_headers(_summary(subject=self.UNICODE_SUBJECT, from_addr=self.UNICODE_FROM))
        for k, v in h.items():
            self.assertTrue(_is_ascii(v), f"{k} not ASCII: {v!r}")
            self.assertNotIn("\n", v)
            self.assertNotIn("\r", v)
        # The non-ASCII fields became RFC 2047 encoded-words.
        self.assertIn("=?utf-8?", h["subject"].lower())
        self.assertIn("=?utf-8?", h["from"].lower())
        # The address spec stays a parseable bare ASCII addr-spec next to the
        # encoded display name, so a client still resolves the mailbox.
        self.assertIn("<elodie@example.com>", h["from"])

    def test_envelope_subject_roundtrips_back_to_unicode(self):
        # A client decoding the encoded-word must recover the original text.
        from email.header import decode_header, make_header

        h = envelope_headers(_summary(subject=self.UNICODE_SUBJECT))
        decoded = str(make_header(decode_header(h["subject"])))
        self.assertEqual(decoded, self.UNICODE_SUBJECT)

    def test_long_unicode_subject_stays_single_line(self):
        # A long non-ASCII subject would fold across lines when serialized; the
        # ENVELOPE value must be unfolded to one line (a raw newline in an ENVELOPE
        # quoted-string would desync the IMAP response).
        long_subject = ("café … 日本語 " * 12).strip()
        h = envelope_headers(_summary(subject=long_subject))
        self.assertTrue(_is_ascii(h["subject"]))
        self.assertNotIn("\n", h["subject"])
        self.assertNotIn("\r", h["subject"])

    def test_render_rfc822_encodes_unicode_headers(self):
        raw = render_rfc822(_msg(subject=self.UNICODE_SUBJECT, from_addr=self.UNICODE_FROM))
        # The serialized message is pure ASCII on the header lines (encoded-words).
        header_block = raw.split(b"\r\n\r\n", 1)[0].split(b"\n\n", 1)[0]
        self.assertTrue(all(b < 128 for b in header_block))
        from email.header import decode_header, make_header

        parsed = email.message_from_bytes(raw)
        decoded = str(make_header(decode_header(parsed["Subject"])))
        self.assertEqual(decoded, self.UNICODE_SUBJECT)

    def test_empty_and_plain_subjects_unaffected(self):
        self.assertEqual(envelope_headers(_summary(subject="Hello"))["subject"], "Hello")
        self.assertEqual(envelope_headers(_summary(subject=""))["subject"], "")


if __name__ == "__main__":
    unittest.main()

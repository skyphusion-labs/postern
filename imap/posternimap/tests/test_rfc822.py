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

    def test_attachment_note_without_bytes(self):
        m = _msg(attachments=[Attachment(filename="report.pdf", mime="application/pdf", size=10)])
        body = email.message_from_bytes(render_rfc822(m)).get_payload(decode=True).decode()
        self.assertIn("report.pdf", body)
        self.assertIn("1 attachment(s)", body)
        self.assertIn("Postern API", body)
        # The note must use a real newline, not the literal backslash-n bug.
        self.assertNotIn("\\n", body)

    def test_attachment_inlined_as_multipart_when_bytes_supplied(self):
        data = b'{"report":"ok"}'
        m = _msg(
            attachments=[Attachment(filename="report.json.gz", mime="application/gzip", size=len(data))],
        )
        raw = render_rfc822(m, attachment_bytes=[data])
        parsed = email.message_from_bytes(raw)
        self.assertTrue(parsed.is_multipart())
        self.assertEqual(parsed.get_content_type(), "multipart/mixed")
        parts = parsed.get_payload()
        self.assertEqual(len(parts), 2)
        self.assertEqual(parts[0].get_content_type(), "text/plain")
        body = parts[0].get_payload(decode=True).decode()
        self.assertNotIn("Postern API", body)
        self.assertEqual(parts[1].get_content_type(), "application/gzip")
        self.assertEqual(parts[1].get_filename(), "report.json.gz")
        self.assertEqual(parts[1].get_payload(decode=True), data)
        self.assertEqual((parts[1].get("Content-Transfer-Encoding") or "").lower(), "base64")

    def test_attachment_imap_body_serves_base64_wire(self):
        """#210 on attachment parts: IMAP FETCH must return base64 wire bytes."""
        import base64

        data = b"%PDF-1.4\n" + bytes(range(256)) * 60
        m = _msg(
            attachments=[Attachment(filename="inv.pdf", mime="application/pdf", size=len(data))],
        )
        parsed = email.message_from_bytes(render_rfc822(m, attachment_bytes=[data]))
        att = [p for p in parsed.walk() if p.get_content_type() == "application/pdf"][0]
        self.assertEqual((att.get("Content-Transfer-Encoding") or "").lower(), "base64")
        from posternimap.message import _RFC822Part

        wire = _RFC822Part(att).getBodyFile().read()
        self.assertNotEqual(wire, data)
        self.assertEqual(base64.b64decode(wire), data)

    def test_attachment_content_type_has_name_param(self):
        data = b"%PDF-1.4\n"
        m = _msg(
            attachments=[Attachment(filename="invoice.pdf", mime="application/pdf", size=len(data))],
        )
        parsed = email.message_from_bytes(render_rfc822(m, attachment_bytes=[data]))
        att = [p for p in parsed.walk() if p.get_content_type() == "application/pdf"][0]
        self.assertEqual(att.get_param("name", header="Content-Type"), "invoice.pdf")
        from twisted.mail.imap4 import getBodyStructure
        from posternimap.message import _RFC822Part

        struct = getBodyStructure(_RFC822Part(att), True)
        self.assertEqual(struct[2], ["name", "invoice.pdf"])

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


class EnvelopeV2Test(unittest.TestCase):
    """Envelope fidelity v2 (#189, CONTRACT 10.3): the IMAP projection renders
    Cc/Bcc/Sender/Reply-To from the stored RAW RFC 5322 header strings when present,
    and leaves them ABSENT (== ENVELOPE NIL) for old rows that carry NULL."""

    # A Cc with a quoted display name that CONTAINS a comma: the raw string must be
    # carried verbatim, never naively split on commas into two mailboxes.
    COMMA_CC = '"Doe, John" <john@x.com>, jane@y.com'

    def test_render_sets_cc_and_reply_to_from_raw_strings(self):
        m = _msg(cc=self.COMMA_CC, reply_to="Support List <list@example.com>")
        parsed = email.message_from_bytes(render_rfc822(m))
        self.assertEqual(parsed["Cc"], self.COMMA_CC)
        self.assertEqual(parsed["Reply-To"], "Support List <list@example.com>")
        # The comma-bearing display name stays ONE mailbox (comma inside it), plus
        # the second address: two recipients parsed, not three.
        from email.utils import getaddresses

        self.assertEqual(
            getaddresses([parsed["Cc"]]),
            [("Doe, John", "john@x.com"), ("", "jane@y.com")],
        )

    def test_envelope_headers_carry_cc_and_reply_to(self):
        h = envelope_headers(_summary(cc=self.COMMA_CC, reply_to="list@example.com"))
        self.assertEqual(h["cc"], self.COMMA_CC)
        self.assertEqual(h["reply-to"], "list@example.com")

    def test_sender_and_bcc_render_when_present(self):
        m = _msg(sender="secretary@example.com", bcc="hidden@example.com")
        parsed = email.message_from_bytes(render_rfc822(m))
        self.assertEqual(parsed["Sender"], "secretary@example.com")
        self.assertEqual(parsed["Bcc"], "hidden@example.com")

    def test_null_fidelity_fields_are_absent_old_row_parity(self):
        # An old row carries None in every fidelity column: the headers must be
        # ABSENT (the IMAP server then renders ENVELOPE NIL), byte-identical to the
        # pre-v2 render. This holds in the full render AND the body-free scan.
        parsed = email.message_from_bytes(render_rfc822(_msg()))
        for name in ("Cc", "Bcc", "Sender", "Reply-To"):
            self.assertIsNone(parsed[name])
        h = envelope_headers(_summary())
        for k in ("cc", "bcc", "sender", "reply-to"):
            self.assertNotIn(k, h)

    def test_render_and_scan_agree_on_cc_bytes(self):
        # The hydrated render and the body-free scan must produce the SAME Cc value,
        # so a summary-served ENVELOPE is byte-for-byte a hydrated FETCH.
        rendered = email.message_from_bytes(render_rfc822(_msg(cc=self.COMMA_CC)))["Cc"]
        scanned = envelope_headers(_summary(cc=self.COMMA_CC))["cc"]
        self.assertEqual(rendered, scanned)


class BodyEncodingTest(unittest.TestCase):
    """#210: the IMAP door serves the DECODED body (message.getBodyFile) but under the
    Content-Transfer-Encoding the render declared. If the render used quoted-printable
    or base64, the client honours that header and decodes the raw bytes a SECOND time,
    corrupting them. Every body is therefore rendered with cte=8bit (identity), so the
    served bytes equal what the header declares and the client decodes exactly once."""

    # The exact failure shape: a tracking URL whose "=abc" / "=def" runs are valid
    # quoted-printable escapes, plus non-ASCII, plus a long line -- all triggers that
    # would push EmailMessage to quoted-printable under the old render.
    NASTY = "Don\u2019t worry \u2014 verify https://x.example/v?token=abc=def&u=1 " + ("word " * 20)

    def _part_cte(self, parsed):
        return (parsed.get("content-transfer-encoding") or "").lower()

    def test_plain_body_is_8bit_not_quoted_printable(self):
        parsed = email.message_from_bytes(render_rfc822(_msg(body_text=self.NASTY)))
        self.assertFalse(parsed.is_multipart())
        self.assertEqual(self._part_cte(parsed), "8bit")

    def test_render_8bit_is_identity_on_long_lines(self):
        # #210 rider: 8bit carries the RFC 5322 <=998-octet line expectation and HTML
        # mail routinely exceeds it. The renderer must NOT let EmailMessage re-pick
        # quoted-printable/base64 for a very long line -- that would make the served
        # bytes differ from the declared CTE and re-introduce the double-decode. Hard
        # invariant: declared CTE == served bytes (identity), whatever the line length.
        long_line = "x" * 1500 + " token=abc=def"  # a single >998-octet line
        for field in ("body_text", "body_html"):
            parsed = email.message_from_bytes(render_rfc822(_msg(**{field: long_line})))
            if field == "body_html":
                self.assertEqual(parsed.get_content_type(), "multipart/alternative")
                plain, html = parsed.get_payload()
                for part in (plain, html):
                    cte = (part.get("content-transfer-encoding") or "").lower()
                    self.assertEqual(cte, "8bit", "%s re-encoded to %r" % (field, cte))
                served = html.get_payload(decode=True).decode("utf-8")
            else:
                cte = (parsed.get("content-transfer-encoding") or "").lower()
                self.assertEqual(cte, "8bit", "%s re-encoded to %r" % (field, cte))
                served = parsed.get_payload(decode=True).decode("utf-8")
            # Identity under 8bit: the served bytes ARE the declared bytes.
            self.assertIn("token=abc=def", served)
            self.assertIn("x" * 1500, served)

    def test_served_body_survives_a_client_decode(self):
        # Simulate the client: read the declared CTE, decode the served (decoded) body.
        # With 8bit (identity) the second decode is a no-op and the bytes are intact;
        # under the old quoted-printable header "token=abc=def" corrupted to "token?c?f".
        import quopri
        import base64

        parsed = email.message_from_bytes(render_rfc822(_msg(body_text=self.NASTY)))
        served = parsed.get_payload(decode=True)  # what getBodyFile returns
        cte = self._part_cte(parsed)
        if cte == "quoted-printable":
            client = quopri.decodestring(served)
        elif cte == "base64":
            client = base64.b64decode(served)
        else:
            client = served
        self.assertEqual(client.decode("utf-8").rstrip("\n"), self.NASTY.rstrip("\n"))
        self.assertIn("token=abc=def", client.decode("utf-8"))


class HtmlProjectionTest(unittest.TestCase):
    """#220: HTML mail is projected as multipart/alternative (text/plain fallback +
    text/html, RFC 2046 order) so text-only clients see readable text. hasHtml on the
    summary lets envelope_headers serve Content-Type body-free (#102)."""

    HTML = "<html><body><h1>H\u00e9llo</h1><p>token=abc=def " + ("x" * 90) + "</p></body></html>"

    def _html_part(self, parsed):
        self.assertTrue(parsed.is_multipart())
        self.assertEqual(parsed.get_content_type(), "multipart/alternative")
        parts = parsed.get_payload()
        self.assertEqual(parts[0].get_content_type(), "text/plain")
        self.assertEqual(parts[1].get_content_type(), "text/html")
        return parts[1]

    def test_html_message_is_multipart_alternative_8bit(self):
        parsed = email.message_from_bytes(render_rfc822(_msg(body_html=self.HTML)))
        self.assertEqual(parsed.get_content_type(), "multipart/alternative")
        plain, html = parsed.get_payload()
        self.assertEqual(plain.get_content_type(), "text/plain")
        self.assertEqual((plain.get("content-transfer-encoding") or "").lower(), "8bit")
        self.assertEqual(html.get_content_type(), "text/html")
        self.assertEqual((html.get("content-transfer-encoding") or "").lower(), "8bit")

    def test_html_body_is_intact_after_a_client_decode(self):
        parsed = email.message_from_bytes(render_rfc822(_msg(body_html=self.HTML)))
        html = self._html_part(parsed)
        body = html.get_payload(decode=True).decode("utf-8")
        self.assertEqual(body.rstrip("\n"), self.HTML)
        self.assertIn("token=abc=def", body)

    def test_html_alternative_includes_plain_fallback(self):
        m = _msg(body_text="stripped soup fallback", body_html=self.HTML)
        parsed = email.message_from_bytes(render_rfc822(m))
        plain, html = parsed.get_payload()
        self.assertIn("stripped soup fallback", plain.get_payload(decode=True).decode("utf-8"))
        self.assertIn("<h1>", html.get_payload(decode=True).decode("utf-8"))

    def test_envelope_headers_html_omits_mime_until_hydrate(self):
        h = envelope_headers(_summary(has_html=True))
        self.assertNotIn("content-type", h)

    def test_no_html_stays_text_plain(self):
        parsed = email.message_from_bytes(render_rfc822(_msg(body_html=None)))
        self.assertFalse(parsed.is_multipart())
        self.assertEqual(parsed.get_content_type(), "text/plain")
        self.assertEqual((parsed.get("content-transfer-encoding") or "").lower(), "8bit")

    def test_empty_html_stays_text_plain(self):
        # A whitespace-only HTML body is treated as absent (no empty text/html part).
        parsed = email.message_from_bytes(render_rfc822(_msg(body_html="   \n  ")))
        self.assertFalse(parsed.is_multipart())
        self.assertEqual(parsed.get_content_type(), "text/plain")

    def test_attachment_note_appears_in_both_alternative_parts_without_bytes(self):
        m = _msg(
            body_html=self.HTML,
            attachments=[Attachment(filename="report.pdf", mime="application/pdf", size=10)],
        )
        parsed = email.message_from_bytes(render_rfc822(m))
        plain, html = parsed.get_payload()
        plain_body = plain.get_payload(decode=True).decode("utf-8")
        html_body = html.get_payload(decode=True).decode("utf-8")
        self.assertIn("report.pdf", plain_body)
        self.assertIn("report.pdf", html_body)

    def test_html_with_attachment_bytes_is_multipart_mixed(self):
        data = b"%PDF-1.4"
        m = _msg(
            body_html=self.HTML,
            attachments=[Attachment(filename="report.pdf", mime="application/pdf", size=len(data))],
        )
        parsed = email.message_from_bytes(render_rfc822(m, attachment_bytes=[data]))
        self.assertTrue(parsed.is_multipart())
        self.assertEqual(parsed.get_content_type(), "multipart/mixed")
        alt = parsed.get_payload()[0]
        self.assertEqual(alt.get_content_type(), "multipart/alternative")
        self.assertEqual(alt.get_payload()[1].get_content_type(), "text/html")
        self.assertEqual(parsed.get_payload()[1].get_payload(decode=True), data)


if __name__ == "__main__":
    unittest.main()

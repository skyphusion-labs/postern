"""Tests for the RFC822 renderer (pure stdlib email parsing, no Twisted)."""

from __future__ import annotations

import email
import unittest

from posternimap.client import Attachment, Message, MessageSummary
from posternimap.rfc822 import (
    PROJECTION_VERSION,
    envelope_headers,
    project_rfc822_size,
    render_rfc822,
)


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
        # The served body is CRLF on the wire (#507), so compare CONTENT with the
        # terminators normalized, and pin the terminator itself rather than papering
        # over it: a bare LF here would mean the projection regressed.
        self.assertNotIn(b"\n", served.replace(b"\r\n", b""))
        text = client.decode("utf-8").replace("\r\n", "\n")
        self.assertEqual(text.rstrip("\n"), self.NASTY.rstrip("\n"))
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


class ProjectedSizeTest(unittest.TestCase):
    """#342: deterministic boundaries + placeholder SIZE matches live BODY[]."""

    def test_boundaries_are_deterministic_for_message_id(self):
        data = b"A" * 40
        m = _msg(
            message_id="mid-42",
            attachments=[Attachment(filename="a.bin", mime="application/octet-stream", size=40)],
        )
        a = render_rfc822(m, attachment_bytes=[data])
        b = render_rfc822(m, attachment_bytes=[b"B" * 40])
        self.assertEqual(len(a), len(b))
        ba = email.message_from_bytes(a).get_boundary()
        bb = email.message_from_bytes(b).get_boundary()
        self.assertEqual(ba, bb)
        self.assertTrue(ba.startswith("b"))
        self.assertEqual(len(ba), 33)

    def test_project_size_matches_real_attachment_render(self):
        data = b"%PDF-1.4\n" + bytes(range(256))
        m = _msg(
            attachments=[Attachment(filename="inv.pdf", mime="application/pdf", size=len(data))],
        )
        self.assertEqual(project_rfc822_size(m), len(render_rfc822(m, attachment_bytes=[data])))
        self.assertEqual(PROJECTION_VERSION, 3)

    def test_unicode_projection_sizes_match_worker_goldens(self):
        # Lockstep with inbound/projected-size.test.ts (projection v3, CRLF #507).
        cases = [
            (
                _msg(message_id="u1", subject="café", body_text="hi"),
                240,
            ),
            (
                _msg(
                    message_id="u2",
                    from_addr="José <jose@example.com>",
                    subject="Hello",
                    body_text="hi",
                ),
                247,
            ),
            (
                _msg(
                    message_id="u3",
                    subject="Hello",
                    body_text="hi",
                    attachments=[Attachment(filename="résumé.pdf", mime="application/pdf", size=10)],
                ),
                633,
            ),
            (
                _msg(message_id="u4", subject=("Long " * 40) + "café", body_text="hi"),
                508,
            ),
            (
                _msg(message_id="u5", subject="Hello café world", body_text="hi"),
                256,
            ),
        ]
        for msg, expected in cases:
            with self.subTest(message_id=msg.message_id):
                self.assertEqual(project_rfc822_size(msg), expected)
                if msg.attachments:
                    placeholders = [b"\0" * a.size for a in msg.attachments]
                    self.assertEqual(
                        project_rfc822_size(msg),
                        len(render_rfc822(msg, attachment_bytes=placeholders)),
                    )


class StructuredIdentifierTest(unittest.TestCase):
    """#500: `Message-ID` / `In-Reply-To` are never RFC 2047 encoded.

    Both are `msg-id` (RFC 5322 section 3.6.4), a STRUCTURED field body, and RFC 2047
    section 5 forbids an encoded-word in one. Measured before the fix against this
    renderer and a real client: the id went out as
    `=?utf-8?b?PG5hw692ZS1yb290QGV4YW1wbGUuY29tPg==?=` (angle brackets inside the
    base64) and Mutt 2.2.12 quoted it back verbatim, matching no stored message_id.
    """

    NONASCII = "naïve-root@example.com"

    def test_non_ascii_message_id_is_served_as_stored(self):
        raw = render_rfc822(_msg(message_id=self.NONASCII))
        self.assertIn(f"Message-ID: <{self.NONASCII}>".encode("utf-8"), raw)
        self.assertNotIn(b"=?utf-8?b?", raw)

    def test_non_ascii_in_reply_to_is_served_as_stored(self):
        raw = render_rfc822(_msg(in_reply_to=self.NONASCII))
        self.assertIn(f"In-Reply-To: <{self.NONASCII}>".encode("utf-8"), raw)
        self.assertNotIn(b"=?utf-8?b?", raw)

    def test_envelope_scan_agrees_with_the_render(self):
        # The body-free ENVELOPE path formats identically by contract, so it must not
        # encode either. _to_wire still keeps the ENVELOPE ASCII-safe on the wire
        # (RFC 6855, see #504): what it produces is not the raw id, and that seam is
        # tracked there, not here.
        h = envelope_headers(_summary(message_id=self.NONASCII))
        self.assertNotIn("=?utf-8?b?", h["message-id"])

    def test_CONTROL_subject_is_still_rfc2047_encoded(self):
        # Subject IS unstructured, so 2047 applies and must keep applying. Without this
        # control the change could have disabled encoding everywhere and still passed.
        raw = render_rfc822(_msg(subject="naïve subject"))
        self.assertIn(b"Subject: =?utf-8?b?", raw)

    def test_CONTROL_ascii_identifiers_are_unchanged(self):
        raw = render_rfc822(_msg(message_id="ascii-root@example.com",
                                 in_reply_to="parent@example.com"))
        self.assertIn(b"Message-ID: <ascii-root@example.com>", raw)
        self.assertIn(b"In-Reply-To: <parent@example.com>", raw)


class ProjectionLockstepTest(unittest.TestCase):
    """Byte-length parity with inbound/src/rfc822Project.ts.

    The worker caches projected_size from D1 metadata while the door serves BODY[] from
    this renderer, so a drift makes RFC822.SIZE disagree with the literal it labels: the
    one combination that breaks size-validating clients. Measured live against the pair
    before this change (worker projectedSize 279 == door RFC822.SIZE 279; 251 == 251).
    The TypeScript half asserts the SAME constants in
    inbound/message-id-nonascii.test.ts -- change one, change both.
    """

    BASE = dict(
        from_addr="sender@example.net",
        to_addr="conrad@example.com",
        date="2026-07-27T00:00:00Z",
        body_text="root body\n",
    )

    def test_nonascii_id(self):
        m = _msg(message_id="naïve-root@example.com", subject="non-ascii id root", **self.BASE)
        self.assertEqual(len(render_rfc822(m)), 264)
        self.assertEqual(project_rfc822_size(m), 264)

    def test_ascii_id(self):
        m = _msg(message_id="ascii-root@example.com", subject="ascii id root", **self.BASE)
        self.assertEqual(len(render_rfc822(m)), 259)
        self.assertEqual(project_rfc822_size(m), 259)

    def test_nonascii_in_reply_to(self):
        m = _msg(message_id="reply@example.net", subject="Re: non-ascii id root",
                 in_reply_to="naïve-root@example.com", **self.BASE)
        self.assertEqual(len(render_rfc822(m)), 302)
        self.assertEqual(project_rfc822_size(m), 302)


if __name__ == "__main__":
    unittest.main()


class CrlfProjectionTest(unittest.TestCase):
    """#507: RFC 5322 line endings, and the invariant that makes SIZE honest.

    RFC 5322 section 2.1: a line ends with CRLF, and CR and LF "MUST NOT appear
    independently". The projection used to emit bare LF, so the door served a body
    the RFC does not allow and announced a size that could not match it. These gates
    fail against the pre-#507 renderer (they were written and watched fail first).
    """

    DATA = b"%PDF-1.4\n" + bytes(range(256))
    HTML = "<p>hi</p>"

    def _shapes(self):
        att = Attachment(filename="inv.pdf", mime="application/pdf", size=len(self.DATA))
        return {
            "plain": (_msg(), None),
            "html": (_msg(body_html=self.HTML), None),
            "attachment": (_msg(attachments=[att]), [self.DATA]),
            "html+attachment": (_msg(body_html=self.HTML, attachments=[att]), [self.DATA]),
        }

    def test_no_bare_lf_in_any_projection_shape(self):
        for label, (msg, atts) in self._shapes().items():
            with self.subTest(shape=label):
                raw = render_rfc822(msg, attachment_bytes=atts)
                self.assertEqual(
                    raw.count(b"\n"),
                    raw.count(b"\r\n"),
                    "bare LF in the %s projection: every LF must be preceded by CR" % label,
                )

    def test_no_bare_cr_in_any_projection_shape(self):
        for label, (msg, atts) in self._shapes().items():
            with self.subTest(shape=label):
                raw = render_rfc822(msg, attachment_bytes=atts)
                self.assertEqual(raw.count(b"\r"), raw.count(b"\r\n"), "bare CR in %s" % label)

    def test_body_text_line_endings_are_normalized_not_passed_through(self):
        # The stored body carries LF (that is how it lands in D1). A projector that
        # only changed its JOIN separators would leave these interior newlines bare,
        # which is the half-fix this gate exists to refuse.
        raw = render_rfc822(_msg(body_text="one\ntwo\nthree"))
        self.assertIn(b"one\r\ntwo\r\nthree", raw)
        self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"))

    def test_mixed_input_line_endings_normalize_idempotently(self):
        # CRLF, bare CR and bare LF in one body all land as CRLF, and no CR doubles.
        raw = render_rfc822(_msg(body_text="a\r\nb\rc\nd"))
        self.assertIn(b"a\r\nb\r\nc\r\nd", raw)
        self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"))
        self.assertEqual(raw.count(b"\r"), raw.count(b"\r\n"))

    def test_placeholder_and_real_attachment_renders_stay_the_same_length(self):
        # The #342 contract SIZE depends on, restated under CRLF: a same-size
        # placeholder must project to the same byte count as the real payload.
        att = Attachment(filename="inv.pdf", mime="application/pdf", size=len(self.DATA))
        m = _msg(attachments=[att])
        self.assertEqual(project_rfc822_size(m), len(render_rfc822(m, attachment_bytes=[self.DATA])))

    def test_projection_version_is_bumped_for_the_crlf_change(self):
        # Every projected byte moved, so the cached projected_size from an earlier
        # version must not be trusted (message.py getSize gates on this).
        self.assertEqual(PROJECTION_VERSION, 3)

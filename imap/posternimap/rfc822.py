"""Render a Postern stored Message as an RFC822 byte string for IMAP FETCH.

Pure stdlib (email.message), so it is unit-testable without Twisted. Postern
stores cleaned plain-text bodies; we project them back into a minimal but valid
RFC822 message: the stored headers we have (From/To/Subject/Date/Message-ID, plus
In-Reply-To when threaded) and the text body. Attachments are surfaced as a short
note line (their bytes live behind the API; the reference frontend lists them
rather than re-downloading), keeping this projection faithful and lightweight.
"""

from __future__ import annotations

import email
import re
from html import escape as _html_escape
from typing import Optional
from email.message import EmailMessage
from email.utils import format_datetime, parsedate_to_datetime

from .client import Message, MessageSummary

# Collapses RFC 5322 header folding (a CRLF/LF followed by leading whitespace) back
# to a single space, so a value handed to the IMAP ENVELOPE serializer is one line:
# a raw newline inside an ENVELOPE quoted-string would desync the IMAP response.
_WIRE_FOLD_RE = re.compile(r"\r?\n[ \t]+")


def _fmt_date(iso: str) -> str:
    if not iso:
        return ""
    try:
        return format_datetime(parsedate_to_datetime(iso))
    except (TypeError, ValueError):
        # Stored dates are ISO-8601; email.utils wants RFC2822. If parsing the
        # stored value fails, fall back to the raw string rather than dropping it.
        try:
            from datetime import datetime

            return format_datetime(datetime.fromisoformat(iso.replace("Z", "+00:00")))
        except ValueError:
            return iso


def _angle(value: str) -> str:
    """Wrap a message identifier in RFC 5322 angle brackets exactly once. The
    store strips <> from messageId but keeps In-Reply-To verbatim (WITH its
    brackets), so unconditional wrapping emitted "<<...>>" on the wire and broke
    client-side threading (#179 transcript). Idempotent for either form."""
    v = value.strip()
    if v.startswith("<") and v.endswith(">"):
        return v
    return f"<{v}>"


def _hdr(value: str) -> str:
    """Strip CR/LF from a header value. EmailMessage rejects embedded newlines
    (raising ValueError), so a malicious stored Subject/From could otherwise
    crash the render; collapsing them to spaces keeps the projection robust and
    injection-safe regardless of what the store holds.
    """
    return value.replace("\r", " ").replace("\n", " ")


def _to_wire(value: str) -> str:
    """Make a header value safe to hand the IMAP ENVELOPE/FETCH serializer: a single
    ASCII line. Twisted's collapseNestedLists implicitly ASCII-encodes ENVELOPE
    fields, so a raw non-ASCII str (e.g. a U+2026 in a Subject) raises
    UnicodeEncodeError and drops the connection mid-scan (#161). Callers pass values
    already RFC 2047 encoded (pure ASCII encoded-words) via EmailMessage; this unfolds
    them and is a belt-and-suspenders guarantee that the result is ASCII and one line.
    Never raises -- a pathological value degrades to ASCII (lossy) rather than crashing
    the FETCH and dropping the client.
    """
    try:
        v = _WIRE_FOLD_RE.sub(" ", value).replace("\r", " ").replace("\n", " ")
        v.encode("ascii")
        return v
    except (UnicodeEncodeError, AttributeError):
        try:
            return (
                value.encode("ascii", "replace")
                .decode("ascii")
                .replace("\r", " ")
                .replace("\n", " ")
            )
        except Exception:
            return ""


def _apply_envelope_headers(
    em: EmailMessage,
    *,
    from_addr: Optional[str],
    to_addr: Optional[str],
    subject: str,
    date_iso: str,
    message_id: Optional[str],
    in_reply_to: Optional[str],
    cc: Optional[str] = None,
    bcc: Optional[str] = None,
    sender: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> None:
    """Set the stored envelope headers on `em`. Shared by render_rfc822 (the full
    message) and envelope_headers (the body-free scan), so a header is encoded
    IDENTICALLY both ways: EmailMessage's modern policy RFC 2047-encodes any
    non-ASCII field as ASCII encoded-words on serialization (what real MUAs expect
    on the wire), which is exactly the IMAP ENVELOPE wire form.

    Cc/Bcc/Sender/Reply-To are the envelope v2 fidelity fields (CONTRACT 10.3): the
    RAW RFC 5322 header strings as they arrived (display names and all). We set them
    EXACTLY as we set To -- hand the raw string to EmailMessage, which folds/encodes
    it on serialization -- and never parse or re-split the address list (a display
    name may contain a comma). When a field is absent/None the header is simply not
    set, so the IMAP server renders it NIL: byte-identical to the v1 render for old
    rows, which carry NULL in these columns."""
    if from_addr:
        em["From"] = _hdr(from_addr)
    if to_addr:
        em["To"] = _hdr(to_addr)
    if cc:
        em["Cc"] = _hdr(cc)
    if bcc:
        em["Bcc"] = _hdr(bcc)
    if sender:
        em["Sender"] = _hdr(sender)
    if reply_to:
        em["Reply-To"] = _hdr(reply_to)
    em["Subject"] = _hdr(subject or "")
    date = _fmt_date(date_iso)
    if date:
        em["Date"] = date
    if message_id:
        em["Message-ID"] = _hdr(_angle(message_id))
    if in_reply_to:
        em["In-Reply-To"] = _hdr(_angle(in_reply_to))


def render_rfc822(msg: Message) -> bytes:
    """Build a valid RFC822 message from a stored Message. Header values are set
    via EmailMessage, which folds/encodes them safely (no header injection)."""
    em = EmailMessage()
    _apply_envelope_headers(
        em,
        from_addr=msg.from_addr,
        to_addr=msg.to_addr,
        subject=msg.subject or "",
        date_iso=msg.date,
        message_id=msg.message_id,
        in_reply_to=msg.in_reply_to,
        cc=msg.cc,
        bcc=msg.bcc,
        sender=msg.sender,
        reply_to=msg.reply_to,
    )

    html = (msg.body_html or "").strip()
    names = ""
    if msg.attachments:
        names = ", ".join(a.filename or "(unnamed)" for a in msg.attachments)

    # cte="8bit" is load-bearing (#210). EmailMessage otherwise picks
    # quoted-printable/base64 for any non-ASCII, long-line, or "="-bearing body
    # (every HTML/marketing mail), but the IMAP door serves the DECODED payload
    # (message.getBodyFile) under that declared encoding, so a client honours the
    # header and decodes the raw bytes a SECOND time, corrupting them ("=ab" run,
    # multibyte soup). 8bit is the identity encoding: the served body equals what the
    # header declares, so the client decodes exactly once. IMAP literals are 8-bit
    # clean (RFC 3501 counts octets), so an 8bit body is wire-safe.
    #
    # Line-length deviation (deliberate, noted): 8bit carries the RFC 5322/5321
    # <=998-octet line expectation, and HTML mail routinely has multi-kilobyte lines.
    # We do NOT re-wrap (that would corrupt HTML); IMAP BODY[] is an octet-counted
    # literal so transport is safe, and MUAs render long 8bit lines fine. The hard
    # invariant we DO keep: the declared CTE always matches the served bytes (identity),
    # so the client never double-decodes -- test_render_8bit_is_identity_on_long_lines
    # fails if EmailMessage ever silently re-picks quoted-printable for some payload.
    if html:
        # The message carried an HTML part: project it as text/html so an HTML client
        # renders the real message, not the lossy stripped-text (htmlToText) derivation
        # that landed in body_text. We keep the door SINGLE-PART on purpose: a
        # multipart/alternative would need the top Content-Type (with boundary) served
        # in the body-free header path that ENVELOPE scans use (#102), and the summary
        # carries no "has HTML" signal to compute it without a body fetch. Serving the
        # HTML alone is a faithful, valid single-representation projection; a
        # text/plain fallback via multipart/alternative is a future enhancement gated
        # on a summary hasHtml flag.
        if msg.attachments:
            html = html + (
                f"<p>[{len(msg.attachments)} attachment(s): "
                f"{_html_escape(names)}; fetch via the Postern API]</p>"
            )
        em.set_content(html, subtype="html", cte="8bit")
    else:
        text = msg.body_text or ""
        if msg.attachments:
            text = text + (
                f"\n\n[{len(msg.attachments)} attachment(s): {names}; fetch via the Postern API]"
            )
        em.set_content(text, cte="8bit")
    return em.as_bytes()


def envelope_headers(summary: MessageSummary) -> dict[str, str]:
    """The IMAP ENVELOPE / scan-relevant headers for a summary, body-free.

    Returns a lowercase-keyed map of the headers an IMAP client needs to render
    a row (From/To/Cc/Sender/Reply-To/Subject/Date/Message-ID/In-Reply-To) formatted
    IDENTICALLY to render_rfc822 above, so a header served from the list summary is
    byte-for-byte what a hydrated FETCH would return (#102: serve ENVELOPE from the
    list response, never a per-message body fetch). Only headers the summary actually
    carries are included: the envelope v2 fidelity fields (Cc/Bcc/Sender/Reply-To)
    appear when the store holds them and are simply omitted when NULL, so the IMAP
    server renders those NIL for old rows -- byte-identical to the pre-v2 render.
    Subject is always present (render_rfc822 always sets it), matching the rendered
    form for an empty subject.
    """
    try:
        em = EmailMessage()
        _apply_envelope_headers(
            em,
            from_addr=summary.from_addr,
            to_addr=summary.to_addr,
            subject=summary.subject or "",
            date_iso=summary.date,
            message_id=summary.message_id,
            in_reply_to=summary.in_reply_to,
            cc=summary.cc,
            bcc=summary.bcc,
            sender=summary.sender,
            reply_to=summary.reply_to,
        )
        parsed = email.message_from_bytes(em.as_bytes())
        return {k.lower(): _to_wire(v) for k, v in parsed.items()}
    except Exception:
        # Fail-safe (#161): a pathological stored value must never raise into the
        # ENVELOPE scan and drop the connection. Degrade to a raw, ASCII-forced map
        # (lossy on non-ASCII, but safe) built straight from the summary.
        h: dict[str, str] = {}
        if summary.from_addr:
            h["from"] = _to_wire(_hdr(summary.from_addr))
        if summary.to_addr:
            h["to"] = _to_wire(_hdr(summary.to_addr))
        if summary.cc:
            h["cc"] = _to_wire(_hdr(summary.cc))
        if summary.bcc:
            h["bcc"] = _to_wire(_hdr(summary.bcc))
        if summary.sender:
            h["sender"] = _to_wire(_hdr(summary.sender))
        if summary.reply_to:
            h["reply-to"] = _to_wire(_hdr(summary.reply_to))
        h["subject"] = _to_wire(_hdr(summary.subject or ""))
        date = _fmt_date(summary.date)
        if date:
            h["date"] = _to_wire(date)
        if summary.message_id:
            h["message-id"] = _to_wire(_hdr(_angle(summary.message_id)))
        if summary.in_reply_to:
            h["in-reply-to"] = _to_wire(_hdr(_angle(summary.in_reply_to)))
        return h

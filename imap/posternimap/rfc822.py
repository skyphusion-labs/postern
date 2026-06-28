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
) -> None:
    """Set the stored envelope headers on `em`. Shared by render_rfc822 (the full
    message) and envelope_headers (the body-free scan), so a header is encoded
    IDENTICALLY both ways: EmailMessage's modern policy RFC 2047-encodes any
    non-ASCII field as ASCII encoded-words on serialization (what real MUAs expect
    on the wire), which is exactly the IMAP ENVELOPE wire form."""
    if from_addr:
        em["From"] = _hdr(from_addr)
    if to_addr:
        em["To"] = _hdr(to_addr)
    em["Subject"] = _hdr(subject or "")
    date = _fmt_date(date_iso)
    if date:
        em["Date"] = date
    if message_id:
        em["Message-ID"] = _hdr(f"<{message_id}>")
    if in_reply_to:
        em["In-Reply-To"] = _hdr(f"<{in_reply_to}>")


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
    )

    body = msg.body_text or ""
    if msg.attachments:
        names = ", ".join(a.filename or "(unnamed)" for a in msg.attachments)
        note = f"\n\n[{len(msg.attachments)} attachment(s): {names}; fetch via the Postern API]"
        body = body + note
    em.set_content(body)
    return em.as_bytes()


def envelope_headers(summary: MessageSummary) -> dict[str, str]:
    """The IMAP ENVELOPE / scan-relevant headers for a summary, body-free.

    Returns a lowercase-keyed map of the headers an IMAP client needs to render
    a row (From/To/Subject/Date/Message-ID/In-Reply-To) formatted IDENTICALLY to
    render_rfc822 above, so a header served from the list summary is byte-for-byte
    what a hydrated FETCH would return (#102: serve ENVELOPE from the list response,
    never a per-message body fetch). Only headers the summary actually carries are
    included; Cc/Bcc/Sender/Reply-To are absent from the store, so the IMAP server
    correctly renders them NIL whether or not we hydrate. Subject is always present
    (render_rfc822 always sets it), matching the rendered form for an empty subject.
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
        h["subject"] = _to_wire(_hdr(summary.subject or ""))
        date = _fmt_date(summary.date)
        if date:
            h["date"] = _to_wire(date)
        if summary.message_id:
            h["message-id"] = _to_wire(_hdr(f"<{summary.message_id}>"))
        if summary.in_reply_to:
            h["in-reply-to"] = _to_wire(_hdr(f"<{summary.in_reply_to}>"))
        return h

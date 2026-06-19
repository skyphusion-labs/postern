"""Render a Postern stored Message as an RFC822 byte string for IMAP FETCH.

Pure stdlib (email.message), so it is unit-testable without Twisted. Postern
stores cleaned plain-text bodies; we project them back into a minimal but valid
RFC822 message: the stored headers we have (From/To/Subject/Date/Message-ID, plus
In-Reply-To when threaded) and the text body. Attachments are surfaced as a short
note line (their bytes live behind the API; the reference frontend lists them
rather than re-downloading), keeping this projection faithful and lightweight.
"""

from __future__ import annotations

from email.message import EmailMessage
from email.utils import format_datetime, parsedate_to_datetime

from .client import Message


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


def render_rfc822(msg: Message) -> bytes:
    """Build a valid RFC822 message from a stored Message. Header values are set
    via EmailMessage, which folds/encodes them safely (no header injection)."""
    em = EmailMessage()
    if msg.from_addr:
        em["From"] = _hdr(msg.from_addr)
    if msg.to_addr:
        em["To"] = _hdr(msg.to_addr)
    em["Subject"] = _hdr(msg.subject or "")
    date = _fmt_date(msg.date)
    if date:
        em["Date"] = date
    if msg.message_id:
        em["Message-ID"] = _hdr(f"<{msg.message_id}>")
    if msg.in_reply_to:
        em["In-Reply-To"] = _hdr(f"<{msg.in_reply_to}>")

    body = msg.body_text or ""
    if msg.attachments:
        names = ", ".join(a.filename or "(unnamed)" for a in msg.attachments)
        note = f"\n\n[{len(msg.attachments)} attachment(s): {names}; fetch via the Postern API]"
        body = body + note
    em.set_content(body)
    return em.as_bytes()

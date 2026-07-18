"""Render a Postern stored Message as an RFC822 byte string for IMAP FETCH.

Canonical projection (#342): deterministic MIME boundaries derived from
message-id + part path, and a hand-rolled serializer shared (by contract) with
inbound/src/rfc822Project.ts. SIZE and BODY[] are the same byte length when
attachment payloads are replaced by same-size placeholders, so the Worker can
cache projected_size from D1 metadata with no R2 reads.
"""

from __future__ import annotations

import base64
import hashlib
import re
from datetime import datetime, timezone
from html import escape as _html_escape
from typing import Optional, Sequence
from email.header import Header
from email.utils import format_datetime, formataddr, parseaddr, parsedate_to_datetime

from .client import Message, MessageSummary

PROJECTION_VERSION = 1

# Collapses RFC 5322 header folding (a CRLF/LF followed by leading whitespace) back
# to a single space, so a value handed to the IMAP ENVELOPE serializer is one line:
# a raw newline inside an ENVELOPE quoted-string would desync the IMAP response.
_WIRE_FOLD_RE = re.compile(r"\r?\n[ \t]+")

_NL = "\n"


def _fmt_date(iso: str) -> str:
    if not iso:
        return ""
    try:
        return format_datetime(parsedate_to_datetime(iso))
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return format_datetime(dt)
        except ValueError:
            return iso


def _angle(value: str) -> str:
    """Wrap a message identifier in RFC 5322 angle brackets exactly once."""
    v = value.strip()
    if v.startswith("<") and v.endswith(">"):
        return v
    return f"<{v}>"


def _hdr(value: str) -> str:
    """Strip CR/LF from a header value."""
    return value.replace("\r", " ").replace("\n", " ")


def _encode_header_value(value: str) -> str:
    """RFC 2047-encode a unstructured header when it is non-ASCII."""
    v = _hdr(value)
    try:
        v.encode("ascii")
        return v
    except UnicodeEncodeError:
        return Header(v, "utf-8").encode()


def _encode_address_header(value: str) -> str:
    """Encode a display-name without wrapping the addr-spec (ENVELOPE parity)."""
    v = _hdr(value)
    try:
        v.encode("ascii")
        return v
    except UnicodeEncodeError:
        name, addr = parseaddr(v)
        if addr:
            enc_name = Header(name, "utf-8").encode() if name else ""
            return formataddr((enc_name, addr)) if enc_name else addr
        return Header(v, "utf-8").encode()


def _to_wire(value: str) -> str:
    """Make a header value safe to hand the IMAP ENVELOPE/FETCH serializer."""
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


def _boundary_token(message_id: str, path: str) -> str:
    digest = hashlib.sha256(f"{message_id}\0{path}".encode("utf-8")).hexdigest()
    return f"b{digest[:32]}"


def _split_mime(mime: Optional[str]) -> tuple[str, str]:
    if not mime:
        return "application", "octet-stream"
    main, _, rest = mime.partition("/")
    if not rest:
        return "application", main
    return main, rest.split(";", 1)[0].strip()


def _mime_from_filename(filename: Optional[str]) -> Optional[str]:
    if not filename or "." not in filename:
        return None
    ext = filename.rsplit(".", 1)[-1].lower()
    by_ext = {
        "pdf": "application/pdf",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "txt": "text/plain",
        "html": "text/html",
        "htm": "text/html",
        "json": "application/json",
        "gz": "application/gzip",
        "zip": "application/zip",
    }
    return by_ext.get(ext)


def _quote_filename(name: str) -> str:
    return _hdr(name).replace("\\", "\\\\").replace('"', '\\"')


def _ensure_trailing_nl(text: str) -> str:
    return text if text.endswith("\n") else text + "\n"


def _attachment_note(msg: Message) -> str:
    names = ", ".join(a.filename or "(unnamed)" for a in msg.attachments)
    return f"[{len(msg.attachments)} attachment(s): {names}; fetch via the Postern API]"


def _html_attachment_note(msg: Message) -> str:
    names = ", ".join(_html_escape(a.filename or "(unnamed)") for a in msg.attachments)
    return (
        f"<p>[{len(msg.attachments)} attachment(s): "
        f"{names}; fetch via the Postern API]</p>"
    )


def _inline_attachments(msg: Message, attachment_bytes: Sequence[bytes]) -> bool:
    return bool(msg.attachments) and len(attachment_bytes) == len(msg.attachments)


def _envelope_lines(msg: Message) -> list[str]:
    lines: list[str] = []
    if msg.from_addr:
        lines.append(f"From: {_encode_address_header(msg.from_addr)}")
    if msg.to_addr:
        lines.append(f"To: {_encode_address_header(msg.to_addr)}")
    if msg.cc:
        lines.append(f"Cc: {_encode_address_header(msg.cc)}")
    if msg.bcc:
        lines.append(f"Bcc: {_encode_address_header(msg.bcc)}")
    if msg.sender:
        lines.append(f"Sender: {_encode_address_header(msg.sender)}")
    if msg.reply_to:
        lines.append(f"Reply-To: {_encode_address_header(msg.reply_to)}")
    lines.append(f"Subject: {_encode_header_value(msg.subject or '')}")
    date = _fmt_date(msg.date)
    if date:
        lines.append(f"Date: {date}")
    if msg.message_id:
        lines.append(f"Message-ID: {_encode_header_value(_angle(msg.message_id))}")
    if msg.in_reply_to:
        lines.append(f"In-Reply-To: {_encode_header_value(_angle(msg.in_reply_to))}")
    lines.append("MIME-Version: 1.0")
    return lines


def _part(headers: list[str], body: bytes) -> bytes:
    return ("\n".join(headers) + "\n\n").encode("ascii", "replace") + body


def _text_body(text: str) -> bytes:
    return _ensure_trailing_nl(text).encode("utf-8")


def _wrap_multipart(boundary: str, parts: list[bytes]) -> bytes:
    chunks: list[bytes] = []
    for part in parts:
        chunks.append(f"--{boundary}\n".encode("ascii"))
        chunks.append(part)
        if not part.endswith(b"\n"):
            chunks.append(b"\n")
    chunks.append(f"--{boundary}--\n".encode("ascii"))
    return b"".join(chunks)


def _base64_wire(data: bytes) -> bytes:
    b64 = base64.b64encode(data).decode("ascii")
    if not b64:
        return b"\n"
    lines = [b64[i : i + 76] for i in range(0, len(b64), 76)]
    return ("\n".join(lines) + "\n").encode("ascii")


def _attachment_part(filename: Optional[str], mime: Optional[str], data: bytes) -> bytes:
    name = filename or "attachment"
    resolved = mime or _mime_from_filename(filename) or "application/octet-stream"
    maintype, subtype = _split_mime(resolved)
    q = _quote_filename(name)
    return _part(
        [
            f'Content-Type: {maintype}/{subtype}; name="{q}"',
            "Content-Transfer-Encoding: base64",
            f'Content-Disposition: attachment; filename="{q}"',
            "MIME-Version: 1.0",
        ],
        _base64_wire(data),
    )


def _alternative_part(message_id: str, path: str, plain: str, html: str) -> bytes:
    boundary = _boundary_token(message_id, path)
    parts = [
        _part(
            [
                'Content-Type: text/plain; charset="utf-8"',
                "Content-Transfer-Encoding: 8bit",
            ],
            _text_body(plain),
        ),
        _part(
            [
                'Content-Type: text/html; charset="utf-8"',
                "Content-Transfer-Encoding: 8bit",
                "MIME-Version: 1.0",
            ],
            _text_body(html),
        ),
    ]
    return _part(
        [f'Content-Type: multipart/alternative; boundary="{boundary}"'],
        _wrap_multipart(boundary, parts),
    )


def render_rfc822(msg: Message, *, attachment_bytes: Optional[Sequence[bytes]] = None) -> bytes:
    """Build a valid RFC822 message from a stored Message.

    When `attachment_bytes` is supplied with one entry per stored attachment, the
    render becomes multipart/mixed with real attachment parts. Without bytes (or
    when the count does not match), attachments are noted in the body text only.
    """
    mid = msg.message_id or "unknown"
    html = (msg.body_html or "").strip()
    inline = attachment_bytes is not None and _inline_attachments(msg, attachment_bytes)

    plain = msg.body_text or ""
    html_part = html
    if msg.attachments and not inline:
        plain = plain + "\n\n" + _attachment_note(msg)
        if html:
            html_part = html + _html_attachment_note(msg)

    env = _envelope_lines(msg)
    atts = msg.attachments if inline else []

    if not atts and not html_part:
        env.append('Content-Type: text/plain; charset="utf-8"')
        env.append("Content-Transfer-Encoding: 8bit")
        return ("\n".join(env) + "\n\n").encode("ascii", "replace") + _text_body(plain)

    if not atts and html_part:
        boundary = _boundary_token(mid, "0")
        env.append(f'Content-Type: multipart/alternative; boundary="{boundary}"')
        parts = [
            _part(
                [
                    'Content-Type: text/plain; charset="utf-8"',
                    "Content-Transfer-Encoding: 8bit",
                ],
                _text_body(plain),
            ),
            _part(
                [
                    'Content-Type: text/html; charset="utf-8"',
                    "Content-Transfer-Encoding: 8bit",
                    "MIME-Version: 1.0",
                ],
                _text_body(html_part),
            ),
        ]
        return ("\n".join(env) + "\n\n").encode("ascii", "replace") + _wrap_multipart(
            boundary, parts
        )

    assert attachment_bytes is not None
    boundary = _boundary_token(mid, "0")
    env.append(f'Content-Type: multipart/mixed; boundary="{boundary}"')
    if html_part:
        first = _alternative_part(mid, "0.0", plain, html_part)
    else:
        first = _part(
            [
                'Content-Type: text/plain; charset="utf-8"',
                "Content-Transfer-Encoding: 8bit",
            ],
            _text_body(plain),
        )
    parts = [first]
    for att, data in zip(msg.attachments, attachment_bytes):
        parts.append(_attachment_part(att.filename, att.mime, data))
    return ("\n".join(env) + "\n\n").encode("ascii", "replace") + _wrap_multipart(
        boundary, parts
    )


def project_rfc822_size(msg: Message) -> int:
    """Projected RFC822 length using same-size zero attachment placeholders (#342)."""
    if msg.attachments:
        placeholders = [b"\0" * max(0, int(a.size)) for a in msg.attachments]
        return len(render_rfc822(msg, attachment_bytes=placeholders))
    return len(render_rfc822(msg))


def envelope_headers(summary: MessageSummary) -> dict[str, str]:
    """The IMAP ENVELOPE / scan-relevant headers for a summary, body-free.

    Returns a lowercase-keyed map formatted IDENTICALLY to render_rfc822 above.
    """
    try:
        lines: list[str] = []
        if summary.from_addr:
            lines.append(f"From: {_encode_address_header(summary.from_addr)}")
        if summary.to_addr:
            lines.append(f"To: {_encode_address_header(summary.to_addr)}")
        if summary.cc:
            lines.append(f"Cc: {_encode_address_header(summary.cc)}")
        if summary.bcc:
            lines.append(f"Bcc: {_encode_address_header(summary.bcc)}")
        if summary.sender:
            lines.append(f"Sender: {_encode_address_header(summary.sender)}")
        if summary.reply_to:
            lines.append(f"Reply-To: {_encode_address_header(summary.reply_to)}")
        lines.append(f"Subject: {_encode_header_value(summary.subject or '')}")
        date = _fmt_date(summary.date)
        if date:
            lines.append(f"Date: {date}")
        if summary.message_id:
            lines.append(f"Message-ID: {_encode_header_value(_angle(summary.message_id))}")
        if summary.in_reply_to:
            lines.append(f"In-Reply-To: {_encode_header_value(_angle(summary.in_reply_to))}")
        out: dict[str, str] = {}
        for line in lines:
            k, sep, v = line.partition(": ")
            if k and sep:
                out[k.lower()] = _to_wire(v)
        return out
    except Exception:
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

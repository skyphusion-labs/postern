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
from email.header import decode_header
from email.utils import format_datetime, parsedate_to_datetime

from .client import Message, MessageSummary

# v3: CRLF line endings end to end (#507). v2 was the hand-rolled RFC 2047 B-encoding
# (no email.header.Header Q/fold) + B-encoded non-ASCII filenames.
# Must stay byte-length identical to inbound/src/rfc822Project.ts.
PROJECTION_VERSION = 3

# Collapses RFC 5322 header folding (a CRLF/LF followed by leading whitespace) back
# to a single space, so a value handed to the IMAP ENVELOPE serializer is one line:
# a raw newline inside an ENVELOPE quoted-string would desync the IMAP response.
_WIRE_FOLD_RE = re.compile(r"\r?\n[ \t]+")

# The wire line terminator. RFC 5322 section 2.1: a line is terminated by CRLF, and CR
# and LF "MUST NOT appear independently". Before #507 this constant existed but was
# DEAD: every newline below was a hard-coded literal, so the projection emitted bare LF,
# the door served a body the RFC does not permit, and RFC822.SIZE described bytes that
# were not the bytes on the wire. It is now the single source for every terminator in
# this file, and inbound/src/rfc822Project.ts NL is its byte-for-byte counterpart.
_NL = "\r\n"


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


def _b64_word(value: str) -> str:
    """One RFC 2047 encoded-word using UTF-8 Base64 (matches rfc822Project.ts)."""
    return "=?utf-8?b?" + base64.b64encode(value.encode("utf-8")).decode("ascii") + "?="


def _encode_header_value(value: str) -> str:
    """RFC 2047-encode an unstructured header when it is non-ASCII."""
    v = _hdr(value)
    try:
        v.encode("ascii")
        return v
    except UnicodeEncodeError:
        return _b64_word(v)


def _id_header_value(value: str) -> str:
    """A message identifier header, emitted as stored and NEVER RFC 2047 encoded.

    `Message-ID` and `In-Reply-To` are STRUCTURED field bodies (RFC 5322 section 3.6.4
    defines them as `msg-id`). RFC 2047 section 5: an encoded-word "MUST NOT be used ...
    in any structured field body except within a comment or phrase" (#500). Measured
    before this changed: Mutt 2.2.12 quoted our encoded-word back verbatim, matched no
    stored message_id, and forked the thread.

    _hdr() still neutralizes CR and LF; #494 collapses such an id to its sha256 at the
    store, so that is defence in depth, not the round-trip guarantee.

    Must stay byte-for-byte identical to inbound/src/rfc822Project.ts idHeaderValue.
    """
    return _hdr(_angle(value))


def _encode_address_header(value: str) -> str:
    """Encode a display-name without wrapping the addr-spec (ENVELOPE parity)."""
    v = _hdr(value)
    try:
        v.encode("ascii")
        return v
    except UnicodeEncodeError:
        # Same shape as inbound/src/rfc822Project.ts encodeAddressHeader.
        m = re.match(r"^(.*)<([^<>]+)>\s*$", v)
        if m:
            name = m.group(1).strip().strip('"')
            addr = m.group(2).strip()
            if not name:
                return addr
            return f"{_b64_word(name)} <{addr}>"
        return _b64_word(v)


def header_text(value) -> str:
    """The CANONICAL text of a parsed header value, whatever the stdlib handed back.

    This is the one place that turns what `email` gives us into a `str`, and every
    consumer must come through it, because the stdlib gives us TWO representations of
    the same header depending on its bytes (#517):

      * A header whose value is pure ASCII comes back as a plain `str`.
      * A header carrying raw 8-bit bytes comes back as an `email.header.Header` over
        the `unknown-8bit` charset, because compat32 `_sanitize_header` wraps any value
        holding surrogates. `str()` of that Header is LOSSY: it renders every escaped
        byte as U+FFFD, so a UTF-8 sequence becomes one replacement character PER BYTE.

    Calling `str()` on both is what produced #517. The summary path held real text and
    folded to ASCII per CHARACTER; the hydrated path held a Header and folded per BYTE;
    the same stored In-Reply-To was therefore served as two different strings, and WHICH
    one a client got depended on whether something else in the same FETCH had forced
    hydration. `decode_header` on the Header OBJECT (not on its lossy `str()`) hands back
    the original bytes, so the two representations reconcile to one canonical string.

    This deliberately does NOT decode RFC 2047 encoded-words, on ANY path, and the
    guarantee holds for two independent reasons rather than one:

      * A header that is PURE ASCII never becomes a Header at all. compat32 wraps a value
        only when it holds surrogates, i.e. only for genuine 8-bit bytes, so an
        encoded-word arrives as a plain `str` and hits the early return above untouched.
      * A MIXED header (an encoded-word AND raw 8-bit bytes on the same line) DOES arrive
        as a Header, so `decode_header` runs on it, and it STILL does not decode the
        encoded-word. compat32 wraps the whole raw value as ONE `unknown-8bit` chunk, so
        `decode_header` on the Header object returns that single chunk verbatim and never
        RFC 2047-parses it. Measured:

            Subject: =?utf-8?b?Y2Fmw6k=?= plus raw caf<0xc3><0xa9>
            chunks  [('=?utf-8?b?Y2Fmw6k=?= plus raw caf\udcc3\udca9', unknown-8bit)]
            result  '=?utf-8?b?Y2Fmw6k=?= plus raw caf<e-acute>'

        Only the raw bytes are turned back into text; the encoded-word survives as
        written. (`decode_header` is perfectly capable of parsing encoded-words when
        handed a `str`, which is the control on that claim, so this is a property of the
        Header path and not a dead call.)

    So there is no asymmetry between the two paths: a Subject the projection encoded stays
    encoded on the wire in every case. Anyone widening `representableId` later can rely on
    that. Pinned by test_header_one_string_e2e.HeaderTextUnitTest.
    """
    if isinstance(value, str):
        return value
    try:
        parts = decode_header(value)
    except Exception:
        parts = None
    if parts:
        out: list[str] = []
        for data, charset in parts:
            if isinstance(data, (bytes, bytearray)):
                # unknown-8bit is the compat32 marker for "these are the raw bytes",
                # and our own projection writes UTF-8, which is what those bytes are.
                codec = "utf-8" if not charset or charset == "unknown-8bit" else charset
                try:
                    out.append(bytes(data).decode(codec, "replace"))
                except (LookupError, UnicodeDecodeError):
                    out.append(bytes(data).decode("utf-8", "replace"))
            else:
                out.append(data)
        return "".join(out)
    try:
        return str(value)
    except Exception:
        return ""


def _to_wire(value, allow_utf8: bool = False) -> str:
    """Make a header value safe to hand the IMAP ENVELOPE/FETCH serializer.

    Accepts whatever the stdlib parser hands back, not only `str`. A header line
    carrying non-ASCII parses to an `email.header.Header` under the compat32 policy,
    and this function is the last thing between a stored value and the serializer:
    it must never be the reason a FETCH dies. Measured (#500): with an identifier
    emitted as stored, a `Header` reached here and BOTH `spew_envelope` and
    `spew_body` raised TypeError, so the FETCH never completed and the client hung.

    #517: `header_text` runs FIRST, so both representations of one stored value reduce
    to one canonical string and the fold below runs over that ONE string. The non-ASCII
    branch also folds `v`, not the raw input, so a folded header collapses its
    continuation identically on both branches instead of only on the ASCII one.

    `allow_utf8` is the RFC 6855 lever (#504) and it is the ONLY connection-dependent
    thing in this file. FALSE (the default, and what every caller gets unless a
    connection has run ENABLE UTF8=ACCEPT) keeps the ASCII fold exactly as it was, so a
    client that exists today cannot be served a different byte. TRUE returns the
    canonical text unfolded, which is legal only once the client has asked for it.

    NOTE what this does NOT do even when TRUE: it does not decode RFC 2047. An
    encoded-word arrives as a plain `str` and is returned as it stands. RFC 6855 permits
    a server to SEND UTF-8; it does not require it to undo a sender encoding.
    """
    text = header_text(value)
    v = _WIRE_FOLD_RE.sub(" ", text).replace("\r", " ").replace("\n", " ")
    if allow_utf8:
        return v
    try:
        v.encode("ascii")
        return v
    except (UnicodeEncodeError, AttributeError):
        try:
            return v.encode("ascii", "replace").decode("ascii")
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
    """Quote a Content-Disposition/Type filename; B-encode when non-ASCII."""
    v = _hdr(name)
    try:
        v.encode("ascii")
        encoded = v
    except UnicodeEncodeError:
        encoded = _b64_word(v)
    return encoded.replace("\\", "\\\\").replace('"', '\\"')


def _to_crlf(text: str) -> str:
    """Normalize any mix of CRLF, bare CR and bare LF to the wire terminator.

    Idempotent: CRLF is collapsed to LF first, so a body that already carries CRLF
    never gains a second CR. Stored bodies land in D1 with LF, so without this a
    projector that changed only its JOIN separators would still emit bare LF inside
    the body text, which is the half-fix the #507 gates refuse.

    Must stay byte-for-byte identical to inbound/src/rfc822Project.ts toCrlf.
    """
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", _NL)


def _ensure_trailing_nl(text: str) -> str:
    return text if text.endswith(_NL) else text + _NL


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
        lines.append(f"Message-ID: {_id_header_value(msg.message_id)}")
    if msg.in_reply_to:
        lines.append(f"In-Reply-To: {_id_header_value(msg.in_reply_to)}")
    lines.append("MIME-Version: 1.0")
    return lines


def _part(headers: list[str], body: bytes) -> bytes:
    # Headers are ASCII after RFC 2047 encoding; fail loud if a bug leaks Unicode.
    return (_NL.join(headers) + _NL + _NL).encode("ascii") + body


def _text_body(text: str) -> bytes:
    return _ensure_trailing_nl(_to_crlf(text)).encode("utf-8")


def _wrap_multipart(boundary: str, parts: list[bytes]) -> bytes:
    chunks: list[bytes] = []
    for part in parts:
        chunks.append(f"--{boundary}{_NL}".encode("ascii"))
        chunks.append(part)
        # Every part this renderer builds already ends in the terminator; the guard is
        # for an empty body. Testing the final LF byte is equivalent to testing the full
        # CRLF here, and matches the 0x0a check in rfc822Project.ts wrapMultipart.
        if not part.endswith(b"\n"):
            chunks.append(_NL.encode("ascii"))
    chunks.append(f"--{boundary}--{_NL}".encode("ascii"))
    return b"".join(chunks)


def _base64_wire(data: bytes) -> bytes:
    b64 = base64.b64encode(data).decode("ascii")
    if not b64:
        return _NL.encode("ascii")
    lines = [b64[i : i + 76] for i in range(0, len(b64), 76)]
    return (_NL.join(lines) + _NL).encode("ascii")


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
        return (_NL.join(env) + _NL + _NL).encode("utf-8") + _text_body(plain)

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
        return (_NL.join(env) + _NL + _NL).encode("utf-8") + _wrap_multipart(
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
    return (_NL.join(env) + _NL + _NL).encode("utf-8") + _wrap_multipart(
        boundary, parts
    )


def project_rfc822_size(msg: Message) -> int:
    """Projected RFC822 length using same-size zero attachment placeholders (#342)."""
    if msg.attachments:
        placeholders = [b"\0" * max(0, int(a.size)) for a in msg.attachments]
        return len(render_rfc822(msg, attachment_bytes=placeholders))
    return len(render_rfc822(msg))


def envelope_headers(summary: MessageSummary, allow_utf8: bool = False) -> dict[str, str]:
    """The IMAP ENVELOPE / scan-relevant headers for a summary, body-free.

    Returns a lowercase-keyed map formatted IDENTICALLY to render_rfc822 above.

    `allow_utf8` is passed straight through to `_to_wire` (#504). It changes nothing
    about WHICH headers are produced or how they are formatted, only whether a value
    that cannot be represented in ASCII is folded on the way out.
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
            lines.append(f"Message-ID: {_id_header_value(summary.message_id)}")
        if summary.in_reply_to:
            lines.append(f"In-Reply-To: {_id_header_value(summary.in_reply_to)}")
        out: dict[str, str] = {}
        for line in lines:
            k, sep, v = line.partition(": ")
            if k and sep:
                out[k.lower()] = _to_wire(v, allow_utf8)
        return out
    except Exception:
        h: dict[str, str] = {}
        if summary.from_addr:
            h["from"] = _to_wire(_hdr(summary.from_addr), allow_utf8)
        if summary.to_addr:
            h["to"] = _to_wire(_hdr(summary.to_addr), allow_utf8)
        if summary.cc:
            h["cc"] = _to_wire(_hdr(summary.cc), allow_utf8)
        if summary.bcc:
            h["bcc"] = _to_wire(_hdr(summary.bcc), allow_utf8)
        if summary.sender:
            h["sender"] = _to_wire(_hdr(summary.sender), allow_utf8)
        if summary.reply_to:
            h["reply-to"] = _to_wire(_hdr(summary.reply_to), allow_utf8)
        h["subject"] = _to_wire(_hdr(summary.subject or ""), allow_utf8)
        date = _fmt_date(summary.date)
        if date:
            h["date"] = _to_wire(date, allow_utf8)
        if summary.message_id:
            h["message-id"] = _to_wire(_hdr(_angle(summary.message_id)), allow_utf8)
        if summary.in_reply_to:
            h["in-reply-to"] = _to_wire(_hdr(_angle(summary.in_reply_to)), allow_utf8)
        return h

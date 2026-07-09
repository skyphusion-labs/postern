"""Twisted IMessage / IMessagePart adapter over a Postern stored message.

Twisted's IMAP server fetches a message through the IMessage interface (flags,
internal date, uid) which extends IMessagePart (headers, body, size, multipart).

Lazy hydration (#102 Stage 1): a SELECT scan (ENVELOPE / FLAGS / INTERNALDATE /
header-field FETCH) must NOT pull a body. The Postern list response already
carries every ENVELOPE field (from/to/subject/date/in-reply-to/message-id), so we
answer those from the list `MessageSummary` with NO network call. We hydrate the
full message (one /api/messages/{id} GET, rendered to RFC822 and parsed) only when
a client actually needs the body, the size, the MIME structure, or a header the
summary cannot supply (opening a message, RFC822.SIZE, BODYSTRUCTURE). That
collapses a "FETCH 1:* ENVELOPE" over a large mailbox from one GET per message to
zero. Hydration is memoized, so opening a message costs exactly one GET.

Header serving rule (see getHeaders): the rendered message carries
From/To/Subject/Date/Message-ID/In-Reply-To plus the envelope v2 fidelity headers
Cc/Bcc/Sender/Reply-To WHEN the store holds them (CONTRACT 10.3), all from the
summary, plus the MIME headers render_rfc822 adds for the body. A fidelity field is
set only when present, so a row without it (an old pre-v2 row carrying NULL) has the
header absent and the IMAP server renders it NIL -- byte-identical to the old render;
the ENVELOPE scan is therefore fully serviceable from the summary. A full-header
fetch (RFC822.HEADER) before the message is opened returns the envelope headers
body-free; the body-derived MIME headers appear once the message is hydrated
(opened), which is when they matter.

Read-only: there are no mutable flags in v1, so getFlags reflects the stored
trust/direction as informational keywords plus \\Seen (inbound mail in the store
has already been delivered/read by the agent path).
"""

from __future__ import annotations

import email
from email.message import Message as PyMessage
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from io import BytesIO
from typing import Callable, Iterable, Optional, Sequence

from zope.interface import implementer

from twisted.mail import imap4

from .client import Message, MessageSummary
from .measure import Meter
from .rfc822 import _to_wire, envelope_headers, render_rfc822

# Header names the summary can answer authoritatively WITHOUT a body fetch: the
# core headers the store carries plus the envelope v2 fidelity fields (Cc/Bcc/
# Sender/Reply-To, CONTRACT 10.3). envelope_headers emits each fidelity field only
# when the store holds it and omits it when NULL, so an absent one is served as NIL
# (old-row parity) with no body fetch either way.
_ENVELOPE_NAMES = frozenset(
    {"from", "to", "subject", "date", "message-id", "in-reply-to", "cc", "bcc", "sender", "reply-to"}
)


def _imap_body_bytes(parsed: PyMessage) -> bytes:
    """Bytes to serve for an IMAP BODY[] FETCH on this MIME part (#210).

    Text bodies are rendered as 8bit (identity). Attachment parts stay base64 on the
    wire; the IMAP server must serve those encoded bytes, not the decoded payload,
    so the client performs exactly one decode. Using cte=binary on attachments is
    unsafe: EmailMessage normalizes bare CR out of binary payloads and corrupts PDFs.
    """
    cte = (parsed.get("Content-Transfer-Encoding") or "7bit").lower()
    if cte in ("base64", "quoted-printable"):
        raw = parsed.get_payload(decode=False)
        if isinstance(raw, bytes):
            return raw
        if isinstance(raw, str):
            return raw.encode("ascii")
        return b""
    payload = parsed.get_payload(decode=True)
    if isinstance(payload, bytes):
        return payload
    text = parsed.get_payload(decode=False)
    return (text if isinstance(text, str) else "").encode("utf-8", "replace")


@implementer(imap4.IMessagePart)
class _RFC822Part:
    """One MIME subpart from a hydrated, rendered message."""

    def __init__(self, parsed: PyMessage) -> None:
        self._parsed = parsed
        self._body = _imap_body_bytes(parsed)

    def getHeaders(self, negate: bool, *names):
        names_lower = {
            (n.decode("ascii", "replace") if isinstance(n, (bytes, bytearray)) else n).lower()
            for n in names
        }
        result = {}
        for key, value in self._parsed.items():
            in_set = key.lower() in names_lower
            if (not negate and in_set) or (negate and not in_set):
                result[key.lower()] = _to_wire(value)
        return result

    def getBodyFile(self) -> BytesIO:
        return BytesIO(self._body)

    def getSize(self) -> int:
        return len(self._body)

    def isMultipart(self) -> bool:
        return self._parsed.is_multipart()

    def getSubPart(self, part: int):
        if not self._parsed.is_multipart():
            raise TypeError("Requested subpart of non-multipart message")
        subparts = self._parsed.get_payload()
        if not isinstance(subparts, list):
            raise IndexError(part)
        if part < 0 or part >= len(subparts):
            raise IndexError(part)
        child = subparts[part]
        if not isinstance(child, PyMessage):
            raise IndexError(part)
        return _RFC822Part(child)


@implementer(imap4.IMessage)
class PosternIMAPMessage:
    """One stored message presented to the IMAP server, hydrated on demand.

    `summary` is the list-view row (no body); `hydrate` is a zero-arg callable that
    fetches the full Message (typically client.get_message bound to the id), called
    at most once and only when a body / size / structure / non-envelope header is
    requested. `uid` is the mailbox-assigned identifier; `seq` is the 1-based
    sequence number within the current SELECT view. Both are ints, as Twisted
    requires.
    """

    def __init__(
        self,
        summary: MessageSummary,
        uid: int,
        seq: int,
        hydrate: Callable[[], Optional[Message]],
        meter: Optional[Meter] = None,
        fetch_attachment: Optional[Callable[[int], bytes]] = None,
    ) -> None:
        self._summary = summary
        self._uid = uid
        self._seq = seq
        self._hydrate_cb = hydrate
        self._fetch_attachment_cb = fetch_attachment
        # A disabled Meter by default: the hydrate hook is a no-op unless an enabled
        # meter is injected (threaded in from the mailbox / account).
        self._meter = meter or Meter(False)
        self._loaded = False
        self._rendered: bytes = b""
        self._parsed: Optional[PyMessage] = None

    # --- hydration ---

    def _placeholder(self) -> Message:
        # The list said this message exists but the per-message GET returned None
        # (raced/deleted between list and open). Render a faithful stub from the
        # summary so the client gets the headers it already saw plus a clear note,
        # rather than a dropped or malformed message.
        s = self._summary
        return Message(
            message_id=s.message_id,
            direction=s.direction,
            thread_id=s.thread_id,
            from_addr=s.from_addr,
            to_addr=s.to_addr,
            subject=s.subject,
            date=s.date,
            in_reply_to=s.in_reply_to,
            body_text="[message body unavailable]",
            trusted=s.trusted,
            received_at=s.received_at,
            attachments=[],
        )

    def _hydrate(self) -> None:
        if self._loaded:
            return
        # One @measure line per body ACTUALLY fetched: an ENVELOPE / header scan that
        # stays body-free never reaches here, so a "FETCH 1:* ENVELOPE" over the window
        # emits zero hydrate lines -- the #102 lazy-hydration claim, made checkable.
        # uid + rendered size only, never the body itself.
        with self._meter.timed("hydrate", uid=self._uid) as span:
            full = self._hydrate_cb()
            placeholder = full is None
            if full is None:
                full = self._placeholder()
            attachment_bytes: Optional[Sequence[bytes]] = None
            if full.attachments and self._fetch_attachment_cb is not None:
                fetched: list[bytes] = []
                for i in range(len(full.attachments)):
                    fetched.append(self._fetch_attachment_cb(i))
                attachment_bytes = fetched
            self._rendered = render_rfc822(full, attachment_bytes=attachment_bytes)
            self._parsed = email.message_from_bytes(self._rendered)
            self._loaded = True
            span.set(bytes=len(self._rendered), placeholder=placeholder)

    # --- IMessage ---

    def getUID(self) -> int:
        return self._uid

    def getFlags(self) -> Iterable[str]:
        # Served from the summary (no body). \Seen reflects the STORED read state
        # (#seen): present when the message has been read, ABSENT when it is still
        # unread, so a client shows unread mail as new. It is flipped by a STORE
        # +/-FLAGS (\Seen) round-tripped to POST /api/messages/seen (see mailbox.store).
        # Trust and direction ride as informational keywords (clients show them; they
        # do not affect anything server-side).
        flags = []
        if self._summary.seen:
            flags.append("\\Seen")
        if self._summary.deleted:
            flags.append("\\Deleted")
        flags.append("Trusted" if self._summary.trusted else "Untrusted")
        flags.append(self._summary.direction.capitalize())  # Inbound / Outbound
        return flags

    def getInternalDate(self) -> str:
        # Served from the summary (no body). RFC822 date string of when Postern
        # received the message.
        src = self._summary.received_at or self._summary.date
        dt = _parse_dt(src)
        # Twisted accepts an RFC822-style date string here.
        return dt.strftime("%d-%b-%Y %H:%M:%S %z") if dt else ""

    # --- IMessagePart ---

    def getHeaders(self, negate: bool, *names):
        # Twisted's FETCH parser hands BODY[HEADER.FIELDS (...)] field names to
        # getHeaders as BYTES (the wire is bytes; imap4._FetchParser.state_section
        # -> spew_body), while its SEARCH handlers pass str. Normalize every name
        # to a lowercase str BEFORE comparing against our str header keys: the
        # bytes/str mismatch made every HEADER.FIELDS FETCH return an EMPTY header
        # block, which a client that scans with HEADER.FIELDS instead of ENVELOPE
        # (the Gmail app; Thunderbird scans ENVELOPE and was fine) rendered as
        # "(no subject)" + a blank sender for every message (#179). Header names
        # are ASCII by RFC 5322; "replace" keeps a pathological name from raising
        # into the FETCH and dropping the connection.
        names_lower = {
            (n.decode("ascii", "replace") if isinstance(n, (bytes, bytearray)) else n).lower()
            for n in names
        }

        # Once hydrated, the parsed message is the authoritative source.
        if self._loaded:
            return self._headers_from_parsed(negate, names_lower)

        # Specific header lookups (e.g. BODY[HEADER.FIELDS (From To Date)] or a
        # per-header spew): serve from the body-free summary when envelope_headers
        # carries the requested names. Includes MIME headers (Content-Type) when
        # hasHtml (#220) without a body fetch.
        if not negate and names_lower:
            env = envelope_headers(self._summary)
            if names_lower <= set(env.keys()):
                return {n: env[n] for n in names_lower if n in env}

        # The whole-header request (negate=True, no names) is read two ways. Twisted's
        # getEnvelope does per-key lookups (headers.get("subject"), .get("cc"), ...) and
        # never touches a MIME header, so an ENVELOPE / folder scan must stay a
        # zero-body-fetch pass (#102). The whole-message serializers (RFC822,
        # RFC822.HEADER, BODY[]) instead ITERATE the map via .items(). _EnvelopeHeaders
        # serves per-key access from the body-free summary and hydrates only on
        # iteration, so a cold whole-message fetch still carries Content-Type /
        # Content-Transfer-Encoding (e.g. text/html) that the envelope subset omits --
        # without which the client defaulted to text/plain and rendered HTML as markup
        # (#210). Once the message is already loaded, serve the full parsed headers.
        if negate and not names_lower:
            if self._loaded:
                return self._headers_from_parsed(True, set())
            return _EnvelopeHeaders(envelope_headers(self._summary), self._full_headers)

        # Anything else (a specific non-envelope header like Content-Type, or a
        # negate-with-exclusions request) needs the rendered message.
        self._hydrate()
        return self._headers_from_parsed(negate, names_lower)

    def _headers_from_parsed(self, negate: bool, names_lower: set):
        assert self._parsed is not None
        result = {}
        for key, value in self._parsed.items():
            in_set = key.lower() in names_lower
            # negate=True means "all headers EXCEPT names"; the no-names case
            # (FETCH of all headers) is negate=True with an empty set.
            if (not negate and in_set) or (negate and not in_set):
                # Twisted reads header maps with lowercase keys (getEnvelope does
                # headers.get("subject"); _formatHeaders title-cases for output).
                # Returning upper-cased keys (the pre-#102 behaviour) silently
                # produced blank ENVELOPEs for clients that FETCH ENVELOPE.
                # _to_wire: a hydrated message's headers are already RFC 2047
                # encoded-words (render_rfc822 -> EmailMessage), but may be FOLDED
                # across lines; unfold + ASCII-guard so the ENVELOPE/FETCH serializer
                # gets one safe ASCII line and never crashes the connection (#161).
                result[key.lower()] = _to_wire(value)
        return result

    def _full_headers(self) -> dict:
        # Hydrate and return every rendered header (the whole-message serializers need
        # the body-derived MIME headers, not just the envelope subset).
        self._hydrate()
        return self._headers_from_parsed(True, set())

    def getBodyFile(self) -> BytesIO:
        self._hydrate()
        assert self._parsed is not None
        if self._parsed.is_multipart():
            sep = b"\r\n\r\n"
            start = self._rendered.find(sep)
            if start < 0:
                sep = b"\n\n"
                start = self._rendered.find(sep)
            body = self._rendered[start + len(sep):] if start >= 0 else b""
            return BytesIO(body)
        payload = self._parsed.get_payload(decode=True)
        if isinstance(payload, bytes):
            return BytesIO(payload)
        # Fallback: the body as text if get_payload(decode) gave nothing usable.
        text = self._parsed.get_payload()
        if not isinstance(text, str):
            text = ""
        return BytesIO(text.encode("utf-8", "replace"))

    def getSize(self) -> int:
        # RFC822.SIZE. RFC 3501 requires SIZE to byte-match the BODY[] literal the
        # server would return, and this door serves a rendered PROJECTION as BODY[]
        # (raw wire bytes are deliberately NOT stored, CONTRACT 10.7). So SIZE MUST be
        # the projected length -- hydrate and measure -- and must NOT use the stored
        # wire_size, which would disagree with the literal and break the exact clients
        # (size-validating ones) it looks like it would help. wire_size is stored
        # fidelity for API consumers only (kept on the models), until a future
        # byte-exact FETCH milestone gives BODY[] real wire bytes. Do NOT "optimize"
        # this to prefer wire_size (#189/#207).
        self._hydrate()
        return len(self._rendered)

    def isMultipart(self) -> bool:
        self._hydrate()
        assert self._parsed is not None
        return self._parsed.is_multipart()

    def getSubPart(self, part: int):
        self._hydrate()
        assert self._parsed is not None
        if not self._parsed.is_multipart():
            raise IndexError("postern-imap messages are single-part")
        subparts = self._parsed.get_payload()
        if not isinstance(subparts, list):
            raise IndexError(part)
        if part < 0 or part >= len(subparts):
            raise IndexError(part)
        child = subparts[part]
        if not isinstance(child, PyMessage):
            raise IndexError(part)
        return _RFC822Part(child)


class _EnvelopeHeaders(dict):
    """Header map for the whole-header request on a message not yet hydrated (#210).

    Seeded with the body-free ENVELOPE headers. A per-key lookup -- what Twisted's
    getEnvelope does (headers.get("subject"), .get("cc"), ...) -- reads straight from
    that seed, so an ENVELOPE / folder scan stays a zero-body-fetch pass (#102);
    getEnvelope never reads a MIME header and never iterates.

    Iterating the map -- what the RFC822 / RFC822.HEADER / whole-message serializers do
    via .items()/.keys() -- hydrates the message and yields the FULL rendered headers,
    so a cold BODY[]/RFC822 fetch carries Content-Type / Content-Transfer-Encoding /
    MIME-Version (e.g. multipart/alternative for an HTML mail), which the envelope
    subset omits. Per-key MIME header lookups on this map also hydrate (#220): a
    placeholder Content-Type boundary would disagree with the rendered body, so MIME
    headers always come from the full render once a client asks for them."""

    _MIME_KEYS = frozenset({"content-type", "content-transfer-encoding", "mime-version"})

    def __init__(self, envelope: dict, full) -> None:
        super().__init__(envelope)
        self._full = full

    def _key(self, key: str) -> str:
        return key.lower() if isinstance(key, str) else key

    def __getitem__(self, key):
        k = self._key(key)
        if k in self._MIME_KEYS:
            return self._full()[key]
        return super().__getitem__(key)

    def get(self, key, default=None):
        k = self._key(key)
        if k in self._MIME_KEYS:
            return self._full().get(key, default)
        return super().get(key, default)

    def items(self):
        return self._full().items()

    def keys(self):
        return self._full().keys()

    def values(self):
        return self._full().values()

    def __iter__(self):
        return iter(self._full())


def _parse_dt(src: str):
    if not src:
        return None
    try:
        return parsedate_to_datetime(src)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(src.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None

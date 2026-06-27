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

Header serving rule (see getHeaders): the rendered message only ever carries
From/To/Subject/Date/Message-ID/In-Reply-To (from the store) plus the MIME headers
render_rfc822 adds for the body. Cc/Bcc/Sender/Reply-To never exist, so the IMAP
server renders them NIL whether or not we hydrate; the ENVELOPE scan is therefore
fully serviceable from the summary. A full-header fetch (RFC822.HEADER) before the
message is opened returns the envelope headers body-free; the body-derived MIME
headers appear once the message is hydrated (opened), which is when they matter.

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
from typing import Callable, Iterable, Optional

from zope.interface import implementer

from twisted.mail import imap4

from .client import Message, MessageSummary
from .rfc822 import envelope_headers, render_rfc822

# Header names the summary can answer authoritatively WITHOUT a body fetch: the
# ones the store carries, plus the four the store never has (Cc/Bcc/Sender/Reply-To
# are always absent == NIL, so "we have no body fetch to add them" is the truth).
_ENVELOPE_NAMES = frozenset(
    {"from", "to", "subject", "date", "message-id", "in-reply-to", "cc", "bcc", "sender", "reply-to"}
)


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
    ) -> None:
        self._summary = summary
        self._uid = uid
        self._seq = seq
        self._hydrate_cb = hydrate
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
        full = self._hydrate_cb()
        if full is None:
            full = self._placeholder()
        self._rendered = render_rfc822(full)
        self._parsed = email.message_from_bytes(self._rendered)
        self._loaded = True

    # --- IMessage ---

    def getUID(self) -> int:
        return self._uid

    def getFlags(self) -> Iterable[str]:
        # Served from the summary (no body): inbound mail has been processed, so
        # mark it Seen. Trust and direction ride as informational keywords (clients
        # show them; they do not affect anything server-side).
        flags = ["\\Seen"]
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

    def getHeaders(self, negate: bool, *names: str):
        names_lower = {n.lower() for n in names}

        # Once hydrated, the parsed message is the authoritative source.
        if self._loaded:
            return self._headers_from_parsed(negate, names_lower)

        # Specific envelope/scan headers (e.g. BODY[HEADER.FIELDS (From To Date)]
        # or the per-header spew lookups): serve from the summary, no body fetch.
        if not negate and names_lower and names_lower <= _ENVELOPE_NAMES:
            env = envelope_headers(self._summary)
            return {n: env[n] for n in names_lower if n in env}

        # The whole-header request (negate=True, no names): ENVELOPE and the
        # pre-open RFC822.HEADER both land here. Serve the envelope headers
        # body-free so an ENVELOPE scan never hydrates; the body-derived MIME
        # headers appear once the message is opened (see class docstring).
        if negate and not names_lower:
            env = envelope_headers(self._summary)
            return dict(env)

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
                result[key.lower()] = value
        return result

    def getBodyFile(self) -> BytesIO:
        self._hydrate()
        assert self._parsed is not None
        payload = self._parsed.get_payload(decode=True)
        if isinstance(payload, bytes):
            return BytesIO(payload)
        # Fallback: the body as text if get_payload(decode) gave nothing usable.
        text = self._parsed.get_payload()
        if not isinstance(text, str):
            text = ""
        return BytesIO(text.encode("utf-8", "replace"))

    def getSize(self) -> int:
        self._hydrate()
        return len(self._rendered)

    def isMultipart(self) -> bool:
        self._hydrate()
        assert self._parsed is not None
        return self._parsed.is_multipart()

    def getSubPart(self, part: int):
        # v1 messages are single-part text; no subparts to address.
        raise IndexError("postern-imap messages are single-part in v1")


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

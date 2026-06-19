"""Twisted IMessage / IMessagePart adapter over a Postern stored Message.

Twisted's IMAP server fetches a message through the IMessage interface (flags,
internal date, uid) which extends IMessagePart (headers, body, size, multipart).
We render the stored Message to RFC822 bytes once (rfc822.render_rfc822), parse
it back with stdlib email so we can answer header / body / size queries, and
adapt that to the Twisted shapes.

Read-only: there are no mutable flags in v1, so getFlags reflects the stored
trust/direction as informational keywords plus \\Seen (inbound mail in the store
has already been delivered/read by the agent path). This module imports Twisted
interfaces only for @implementer; the rendering is stdlib, so the parsing logic
stays testable on its own.
"""

from __future__ import annotations

import email
from email.message import Message as PyMessage
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from io import BytesIO
from typing import Iterable

from zope.interface import implementer

from twisted.mail import imap4

from .client import Message
from .rfc822 import render_rfc822


@implementer(imap4.IMessage)
class PosternIMAPMessage:
    """One stored message presented to the IMAP server.

    `uid` is the sequence-stable identifier the mailbox assigns; `seq` is the
    1-based sequence number within the current SELECT view. Both are ints, as
    Twisted requires.
    """

    def __init__(self, msg: Message, uid: int, seq: int) -> None:
        self._msg = msg
        self._uid = uid
        self._seq = seq
        self._rendered = render_rfc822(msg)
        self._parsed: PyMessage = email.message_from_bytes(self._rendered)

    # --- IMessage ---

    def getUID(self) -> int:
        return self._uid

    def getFlags(self) -> Iterable[str]:
        # Read-only store: inbound mail has been processed, so mark it Seen. Trust
        # and direction ride as informational keywords (clients show them; they do
        # not affect anything server-side).
        flags = ["\\Seen"]
        flags.append("Trusted" if self._msg.trusted else "Untrusted")
        flags.append(self._msg.direction.capitalize())  # Inbound / Outbound
        return flags

    def getInternalDate(self) -> str:
        # RFC822 date string of when Postern received the message.
        src = self._msg.received_at or self._msg.date
        dt = _parse_dt(src)
        # Twisted accepts an RFC822-style date string here.
        return dt.strftime("%d-%b-%Y %H:%M:%S %z") if dt else ""

    # --- IMessagePart ---

    def getHeaders(self, negate: bool, *names: str):
        names_lower = {n.lower() for n in names}
        result = {}
        for key, value in self._parsed.items():
            in_set = key.lower() in names_lower
            # negate=True means "all headers EXCEPT names"; the no-names case
            # (FETCH of all headers) is negate=True with an empty set.
            if (not negate and in_set) or (negate and not in_set):
                result[key.upper()] = value
        return result

    def getBodyFile(self) -> BytesIO:
        payload = self._parsed.get_payload(decode=True)
        if isinstance(payload, bytes):
            return BytesIO(payload)
        # Fallback: the body as text if get_payload(decode) gave nothing usable.
        text = self._parsed.get_payload()
        if not isinstance(text, str):
            text = ""
        return BytesIO(text.encode("utf-8", "replace"))

    def getSize(self) -> int:
        return len(self._rendered)

    def isMultipart(self) -> bool:
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

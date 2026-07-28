"""Twisted IMessage / IMessagePart adapter over a Postern stored message.

Twisted's IMAP server fetches a message through the IMessage interface (flags,
internal date, uid) which extends IMessagePart (headers, body, size, multipart).

Lazy hydration (#102 Stage 1, #342): a SELECT scan (ENVELOPE / FLAGS / INTERNALDATE /
header-field FETCH) must NOT pull a body. The Postern list response already
carries every ENVELOPE field (from/to/subject/date/in-reply-to/message-id), so we
answer those from the list `MessageSummary` with NO network call. We hydrate the
full message (one /api/messages/{id} GET, rendered to RFC822 and parsed) only when
a client actually needs the body, the MIME structure, or a header the summary
cannot supply. RFC822.SIZE prefers summary `projectedSize` (#342) and never
downloads attachment bytes. Attachment GETs are per-part on BODY[i] / getBodyFile
of an attachment subpart; whole BODY[] still pulls every attachment (correctness).

Hydration is memoized, so opening a message costs exactly one message GET. Failures are
memoized too (#457): the FETCH warm below runs the accessors ahead of the render and
swallows what they raise, so without an error memo the render would repeat the failed
worker call on the reactor thread, which is the stall #457 exists to remove.

WHERE THE HYDRATION RUNS (#457). Twisted renders a FETCH by calling these accessors
straight from the protocol, on the reactor thread, with no Deferred seam. So the door
pre-runs the reads a given FETCH needs in the reactor threadpool (`prehydrate` below,
driven by `fetchwarm.fetch_reads`) before the messages reach Twisted, and the render
then reads memory. Lazy hydration is unchanged by this: the warm calls the SAME
accessors, which apply the SAME rules, so a scan still fetches no body.
"""

from __future__ import annotations

import email
from email.message import Message as PyMessage
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from io import BytesIO
from typing import Callable, Iterable, List, Optional

from zope.interface import implementer

from twisted.mail import imap4

from .client import Message, MessageSummary
from .measure import Meter
from .rfc822 import PROJECTION_VERSION, _to_wire, envelope_headers, render_rfc822

# Header names the summary can answer authoritatively WITHOUT a body fetch.
_ENVELOPE_NAMES = frozenset(
    {"from", "to", "subject", "date", "message-id", "in-reply-to", "cc", "bcc", "sender", "reply-to"}
)


def _imap_body_bytes(parsed: PyMessage) -> bytes:
    """Bytes to serve for an IMAP BODY[] FETCH on this MIME part (#210)."""
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

    def __init__(
        self,
        parsed: PyMessage,
        *,
        attachment_index: Optional[int] = None,
        ensure_attachment: Optional[Callable[[int], None]] = None,
        root: Optional["PosternIMAPMessage"] = None,
        utf8_accept: bool = False,
    ) -> None:
        self._parsed = parsed
        # Inherited from the parent so a nested part is not folded differently from the
        # message containing it (#504). A subpart serving one form while its parent
        # serves another is the #517 divergence rebuilt one level down.
        self._utf8_accept = utf8_accept
        self._attachment_index = attachment_index
        self._ensure_attachment = ensure_attachment
        self._root = root
        self._body: Optional[bytes] = None

    def getHeaders(self, negate: bool, *names):
        names_lower = {
            (n.decode("ascii", "replace") if isinstance(n, (bytes, bytearray)) else n).lower()
            for n in names
        }
        result = {}
        for key, value in self._parsed.items():
            in_set = key.lower() in names_lower
            if (not negate and in_set) or (negate and not in_set):
                result[key.lower()] = _to_wire(value, self._utf8_accept)
        return result

    def getBodyFile(self) -> BytesIO:
        if self._attachment_index is not None and self._ensure_attachment is not None:
            self._ensure_attachment(self._attachment_index)
            if self._root is not None:
                # Re-bind to the re-rendered part after the real bytes land.
                refreshed = self._root._part_by_attachment_index(self._attachment_index)
                if refreshed is not None:
                    return BytesIO(_imap_body_bytes(refreshed))
        if self._body is None:
            self._body = _imap_body_bytes(self._parsed)
        return BytesIO(self._body)

    def getSize(self) -> int:
        if self._body is None:
            self._body = _imap_body_bytes(self._parsed)
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
        return _RFC822Part(child, utf8_accept=self._utf8_accept)


@implementer(imap4.IMessage, imap4.IMessageFile)
class PosternIMAPMessage:
    """One stored message presented to the IMAP server, hydrated on demand."""

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
        self._meter = meter or Meter(False)
        self._loaded = False
        # Hydration failures are memoized alongside successes (#457). The render is the
        # authority on what a FETCH answers, so the prehydrate pass swallows errors and
        # lets the accessor raise; without this the accessor would REPEAT the failed
        # worker call on the reactor thread, which is the exact stall #457 removes. The
        # memo lives on the message, and a message lives for one FETCH, so a later
        # command still retries the worker.
        # RFC 6855 (#504). A message lives for ONE FETCH (see the memo note below), and
        # the protocol stamps this from the connection's ENABLE state before the render.
        # It is therefore per-connection state that never outlives the response it
        # shapes, which is the whole point: representability is a STORAGE question and
        # stays in the worker, while what THIS connection may receive is a WIRE question
        # and stays here. False means the ASCII fold that predates the extension.
        self._utf8_accept = False
        self._hydrate_error: Optional[BaseException] = None
        self._attachment_errors: dict = {}
        self._full: Optional[Message] = None
        self._rendered: bytes = b""
        self._parsed: Optional[PyMessage] = None
        # Per-index real attachment bytes; None means placeholder still in render.
        self._real_attachments: List[Optional[bytes]] = []

    def _placeholder(self) -> Message:
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

    def _render_current(self) -> None:
        assert self._full is not None
        full = self._full
        if full.attachments:
            bytes_list: list[bytes] = []
            for i, att in enumerate(full.attachments):
                real = self._real_attachments[i] if i < len(self._real_attachments) else None
                if real is not None:
                    bytes_list.append(real)
                else:
                    bytes_list.append(b"\0" * max(0, int(att.size)))
            self._rendered = render_rfc822(full, attachment_bytes=bytes_list)
        else:
            self._rendered = render_rfc822(full)
        self._parsed = email.message_from_bytes(self._rendered)

    def _hydrate(self) -> None:
        """Fetch message metadata/body and render with attachment placeholders (#342)."""
        if self._loaded:
            return
        if self._hydrate_error is not None:
            raise self._hydrate_error
        with self._meter.timed("hydrate", uid=self._uid) as span:
            try:
                full = self._hydrate_cb()
            except BaseException as exc:
                self._hydrate_error = exc
                raise
            placeholder = full is None
            if full is None:
                full = self._placeholder()
            self._full = full
            self._real_attachments = [None] * len(full.attachments)
            self._render_current()
            self._loaded = True
            span.set(bytes=len(self._rendered), placeholder=placeholder)

    def _ensure_attachment(self, index: int) -> None:
        self._hydrate()
        assert self._full is not None
        if index < 0 or index >= len(self._full.attachments):
            raise IndexError(index)
        if self._real_attachments[index] is not None:
            return
        prior = self._attachment_errors.get(index)
        if prior is not None:
            raise prior
        if self._fetch_attachment_cb is None:
            self._real_attachments[index] = b""
        else:
            try:
                self._real_attachments[index] = self._fetch_attachment_cb(index)
            except BaseException as exc:
                self._attachment_errors[index] = exc
                raise
        self._render_current()

    def _ensure_all_attachments(self) -> None:
        self._hydrate()
        assert self._full is not None
        for i in range(len(self._full.attachments)):
            self._ensure_attachment(i)

    def _attachment_indices(self) -> dict[int, int]:
        """Map top-level mixed subpart index -> attachment index."""
        assert self._parsed is not None and self._full is not None
        if not self._full.attachments or not self._parsed.is_multipart():
            return {}
        if (self._parsed.get_content_type() or "") != "multipart/mixed":
            return {}
        # First part is body (text or alternative); attachments follow in order.
        out: dict[int, int] = {}
        for i, att_i in enumerate(range(len(self._full.attachments)), start=1):
            out[i] = att_i
        return out

    def _part_by_attachment_index(self, att_index: int) -> Optional[PyMessage]:
        self._hydrate()
        assert self._parsed is not None
        mapping = self._attachment_indices()
        for part_i, a_i in mapping.items():
            if a_i == att_index:
                subparts = self._parsed.get_payload()
                if isinstance(subparts, list) and part_i < len(subparts):
                    child = subparts[part_i]
                    if isinstance(child, PyMessage):
                        return child
        return None

    def prehydrate(self, reads) -> None:
        """Run the FETCH render accessor reads HERE, off the reactor thread (#457).

        `reads` comes from fetchwarm.fetch_reads(query): the same accessors, with the
        same arguments, on the same subparts, that IMAP4Server is about to call while it
        writes the response. Every accessor on this class memoizes, so pre-running them
        turns the render into memory reads.

        This pass is INVISIBLE by construction. It never changes what a FETCH answers,
        only where the waiting happens, so a failure is swallowed and left to the render:
        the render calls the same accessor, gets the memoized error (no second worker
        call, no reactor stall), and behaves exactly as it did before this existed.
        """
        for read in reads:
            try:
                self._apply_read(read)
            except Exception:
                continue

    def _apply_read(self, read) -> None:
        target = self
        for index in read.path:
            if not target.isMultipart():
                # spew_body: a non-multipart message has an implicit part 1 and no
                # others. Stop here and let the render raise its own TypeError.
                break
            target = target.getSubPart(index)
        kind = read.kind
        if kind == "size":
            target.getSize()
        elif kind == "structure":
            imap4.getBodyStructure(target, True)
        elif kind == "headers":
            headers = target.getHeaders(read.negate, *read.fields)
            # The whole-header map is lazy (_EnvelopeHeaders); _formatHeaders is what
            # forces it, via .items(). Force it here or the hydration stays on the
            # reactor thread with the read looking done.
            headers.items()
        elif kind == "body":
            target.getBodyFile()
        elif kind == "file":
            # Whole-message BODY[] / RFC822: twisted streams IMessageFile.open() (#507),
            # so that is the accessor to warm. It hydrates AND pulls every attachment,
            # which is what a whole-message fetch legitimately needs.
            target.open()

    def set_utf8_accept(self, enabled: bool) -> None:
        """Stamp the connection's RFC 6855 state onto this one-FETCH message (#504)."""
        self._utf8_accept = bool(enabled)

    def getUID(self) -> int:
        return self._uid

    def getFlags(self) -> Iterable[str]:
        flags = []
        if self._summary.seen:
            flags.append("\\Seen")
        if self._summary.deleted:
            flags.append("\\Deleted")
        if getattr(self._summary, "flagged", False):
            flags.append("\\Flagged")
        if getattr(self._summary, "answered", False):
            flags.append("\\Answered")
        if getattr(self._summary, "mailbox", None) == "drafts":
            flags.append("\\Draft")
        flags.append("Trusted" if self._summary.trusted else "Untrusted")
        flags.append(self._summary.direction.capitalize())
        return flags

    def getInternalDate(self) -> str:
        src = self._summary.received_at or self._summary.date
        dt = _parse_dt(src)
        return dt.strftime("%d-%b-%Y %H:%M:%S %z") if dt else ""

    def getHeaders(self, negate: bool, *names):
        names_lower = {
            (n.decode("ascii", "replace") if isinstance(n, (bytes, bytearray)) else n).lower()
            for n in names
        }

        if self._loaded:
            return self._headers_from_parsed(negate, names_lower)

        if not negate and names_lower:
            env = envelope_headers(self._summary, self._utf8_accept)
            if names_lower <= set(env.keys()):
                # Iterate `env`, NOT `names_lower`. names_lower is a SET, so iterating it
                # ordered the served headers by Python string hash, which is randomised
                # PER PROCESS: the same door served BODY[HEADER.FIELDS] in a different
                # order on every restart, and that order also disagreed with the hydrated
                # path, which yields message order. Found while building the byte-equality
                # harness for #504, where it made a pre/post comparison impossible because
                # there was no stable "before" to compare against. `env` is built in the
                # projection's own header order, which is exactly the order
                # _headers_from_parsed yields (both come from render_rfc822), so this
                # makes the two seams agree on ORDER as well as on VALUE (#517).
                return {n: env[n] for n in env if n in names_lower}

        if negate and not names_lower:
            if self._loaded:
                return self._headers_from_parsed(True, set())
            return _EnvelopeHeaders(
                envelope_headers(self._summary, self._utf8_accept), self._full_headers
            )

        self._hydrate()
        return self._headers_from_parsed(negate, names_lower)

    def _headers_from_parsed(self, negate: bool, names_lower: set):
        assert self._parsed is not None
        result = {}
        for key, value in self._parsed.items():
            in_set = key.lower() in names_lower
            if (not negate and in_set) or (negate and not in_set):
                result[key.lower()] = _to_wire(value, self._utf8_accept)
        return result

    def _full_headers(self) -> dict:
        self._hydrate()
        return self._headers_from_parsed(True, set())

    def getBodyFile(self) -> BytesIO:
        # Whole-message body needs real attachment bytes (#342 correctness).
        self._ensure_all_attachments()
        assert self._parsed is not None
        if self._parsed.is_multipart():
            sep = b"\r\n\r\n"
            start = self._rendered.find(sep)
            if start < 0:
                sep = b"\n\n"
                start = self._rendered.find(sep)
            body = self._rendered[start + len(sep) :] if start >= 0 else b""
            return BytesIO(body)
        payload = self._parsed.get_payload(decode=True)
        if isinstance(payload, bytes):
            return BytesIO(payload)
        text = self._parsed.get_payload()
        if not isinstance(text, str):
            text = ""
        return BytesIO(text.encode("utf-8", "replace"))

    def open(self) -> BytesIO:
        """IMessageFile: the exact bytes to serve for BODY[] and RFC822 (#507).

        THIS IS WHAT MAKES RFC822.SIZE HONEST. Without an IMessageFile, twisted falls
        back to imap4.MessageProducer, which RE-SERIALIZES the message from the parsed
        tree: it re-joins the headers with CRLF, copies the body file through verbatim,
        and writes its own multipart boundary lines. That is a SECOND serializer, and
        the projected size has never described its output. Measured on a raw socket
        before this existed: a plain message announced 226 and served {235}, an html
        message announced 518 and served {540}.

        Implementing IMessageFile makes twisted serve the rendered projection verbatim
        (imap4.py spew_body / spew_rfc822 both prefer it), so there is ONE serializer
        and the size agreeing with the literal is a consequence rather than a
        coincidence to be maintained.

        Real attachment bytes, like getBodyFile: BODY[] is the whole message.
        """
        self._ensure_all_attachments()
        return BytesIO(self._rendered)

    def getSize(self) -> int:
        # RFC822.SIZE must byte-match BODY[], which since #507 is exactly what open()
        # returns. Prefer the cached projection (#342); never use wire_size
        # (#189/#207). Cached hit = zero network (no message GET, no attachment GETs).
        # Miss = hydrate with placeholders (message GET only): the placeholder render
        # is the same LENGTH as the real one, which is the #342 contract and is gated
        # in test_rfc822.CrlfProjectionTest.
        cached = getattr(self._summary, "projected_size", None)
        version = getattr(self._summary, "projection_version", None)
        if (
            cached is not None
            and version is not None
            and int(version) == PROJECTION_VERSION
            and int(cached) >= 0
        ):
            return int(cached)
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
        att_index = self._attachment_indices().get(part)
        return _RFC822Part(
            child,
            attachment_index=att_index,
            ensure_attachment=self._ensure_attachment if att_index is not None else None,
            root=self if att_index is not None else None,
            utf8_accept=self._utf8_accept,
        )


class _EnvelopeHeaders(dict):
    """Header map for the whole-header request on a message not yet hydrated (#210)."""

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

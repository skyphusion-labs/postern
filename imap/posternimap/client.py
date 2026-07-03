"""HTTP client for the Postern structured mailbox API (CONTRACT section 4).

The IMAP proxy is a *client* of the mailbox API, never a second store owner: it
reads through the token-gated read endpoints (#24) and renders the result as
IMAP. This module is pure stdlib (urllib) so it has zero runtime dependencies
and is unit-testable without Twisted.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

from .measure import Meter

# Identify the proxy to the Postern API. The default urllib User-Agent
# ("Python-urllib/x.y") is a known-bot signature that Cloudflare blocks with HTTP
# 403 "error code: 1010" (browser-signature ban) in front of the worker, which would
# break every store read (SELECT/LIST) even with a valid token. Send a real UA.
USER_AGENT = "postern-imap (+https://github.com/skyphusion-labs/postern)"


class PosternError(Exception):
    """A non-2xx response or transport failure from the Postern API."""

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


class PosternAuthError(PosternError):
    """401 from the Postern API: the bearer token is missing or wrong."""


def _delivered_to(d: dict[str, Any], to_addr: str) -> list[str]:
    """The envelope-semantics delivered-recipient set (CONTRACT 10.3).

    The v2 API returns `deliveredTo` on every message-shaped response (v1 rows fall
    back to [to_addr] server-side). We mirror that fallback here so an older API that
    omits the field, or an old row, still yields the single envelope recipient rather
    than an empty set. Only string entries are kept; a bare `to_addr` seeds the set
    when nothing else is available.
    """
    raw = d.get("deliveredTo")
    if isinstance(raw, list):
        vals = [x for x in raw if isinstance(x, str) and x]
        if vals:
            return vals
    return [to_addr] if to_addr else []


def _wire_size(d: dict[str, Any]) -> Optional[int]:
    """The raw RFC822 wire byte size (CONTRACT 10.3), or None for old/outbound rows.

    Null stays null (we do not know the size); a present value is coerced to int so a
    JSON number or numeric string both land as an int for RFC822.SIZE.
    """
    v = d.get("wireSize")
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


@dataclass
class MessageSummary:
    """A list-view row (no body), mirroring the API StoredMessageSummary."""

    # Monotonic insertion key (#103): the store's AUTOINCREMENT rowid (messages.id),
    # assigned strictly ascending at ARRIVAL and never reused. The mailbox orders by
    # it and surfaces it as the durable IMAP UID (RFC 3501). Contract-guaranteed
    # present and > 0 on every summary (StoredMessageSummary.uid), so we read it
    # strictly: a missing value is a backend contract violation, not a soft case.
    uid: int
    message_id: str
    direction: str
    thread_id: str
    from_addr: str
    to_addr: str
    subject: str
    date: str
    in_reply_to: Optional[str]
    trusted: bool
    received_at: str
    attachment_count: int
    # Envelope fidelity v2 (CONTRACT section 10.3). All nullable: an old row (pre-0006)
    # carries None/[] here and renders exactly as v1. cc/bcc/sender/reply_to are the RAW
    # RFC 5322 header strings (display names and all, never parsed or re-split -- a
    # display name may contain a comma). delivered_to is the normalized set of bare
    # lower-cased delivered recipients (semantics, what views filter on), defaulting to
    # [to_addr] for a v1 row exactly like the API's fallback. wire_size is the raw
    # RFC822 byte size at intake (None for old rows and for outbound).
    cc: Optional[str] = None
    bcc: Optional[str] = None
    sender: Optional[str] = None
    reply_to: Optional[str] = None
    delivered_to: list[str] = field(default_factory=list)
    wire_size: Optional[int] = None

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "MessageSummary":
        to_addr = d.get("to", "")
        return cls(
            uid=int(d["uid"]),
            message_id=d["messageId"],
            direction=d.get("direction", "inbound"),
            thread_id=d.get("threadId", d["messageId"]),
            from_addr=d.get("from", ""),
            to_addr=to_addr,
            subject=d.get("subject", ""),
            date=d.get("date", ""),
            in_reply_to=d.get("inReplyTo"),
            trusted=bool(d.get("trusted", False)),
            received_at=d.get("receivedAt", ""),
            attachment_count=int(d.get("attachmentCount", 0)),
            cc=d.get("cc"),
            bcc=d.get("bcc"),
            sender=d.get("sender"),
            reply_to=d.get("replyTo"),
            delivered_to=_delivered_to(d, to_addr),
            wire_size=_wire_size(d),
        )


@dataclass
class Attachment:
    filename: Optional[str]
    mime: Optional[str]
    size: int


@dataclass
class Message:
    """A full message + attachment metadata, mirroring the API StoredMessage."""

    message_id: str
    direction: str
    thread_id: str
    from_addr: str
    to_addr: str
    subject: str
    date: str
    in_reply_to: Optional[str]
    body_text: str
    trusted: bool
    received_at: str
    attachments: list[Attachment] = field(default_factory=list)
    # Envelope fidelity v2 (CONTRACT section 10.3); see MessageSummary for semantics.
    cc: Optional[str] = None
    bcc: Optional[str] = None
    sender: Optional[str] = None
    reply_to: Optional[str] = None
    delivered_to: list[str] = field(default_factory=list)
    wire_size: Optional[int] = None

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "Message":
        to_addr = d.get("to", "")
        return cls(
            message_id=d["messageId"],
            direction=d.get("direction", "inbound"),
            thread_id=d.get("threadId", d["messageId"]),
            from_addr=d.get("from", ""),
            to_addr=to_addr,
            subject=d.get("subject", ""),
            date=d.get("date", ""),
            in_reply_to=d.get("inReplyTo"),
            body_text=d.get("bodyText", ""),
            trusted=bool(d.get("trusted", False)),
            received_at=d.get("receivedAt", ""),
            attachments=[
                Attachment(filename=a.get("filename"), mime=a.get("mime"), size=int(a.get("size", 0)))
                for a in d.get("attachments", [])
            ],
            cc=d.get("cc"),
            bcc=d.get("bcc"),
            sender=d.get("sender"),
            reply_to=d.get("replyTo"),
            delivered_to=_delivered_to(d, to_addr),
            wire_size=_wire_size(d),
        )


@dataclass
class Page:
    items: list[MessageSummary]
    cursor: Optional[str]


# Injectable transport so tests can supply a fake without a live server. Takes a
# fully-formed urllib Request, returns (status, body_bytes).
class _UrllibTransport:
    def __init__(self, timeout: float) -> None:
        self._timeout = timeout

    def __call__(self, req: urllib.request.Request) -> tuple[int, bytes]:
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except urllib.error.URLError as e:
            raise PosternError(f"request failed: {e.reason}") from e


class PosternClient:
    """Read-only client over the Postern mailbox API.

    base_url is the worker origin (e.g. https://postern.example); token is the
    Postern API token sent as Authorization: Bearer. The token is never logged.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = 15.0,
        transport: Any = None,
        meter: Optional[Meter] = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._transport = transport or _UrllibTransport(timeout)
        # A disabled Meter by default: all measurement hooks are no-ops unless an
        # enabled meter is injected (POSTERN_IMAP_MEASURE, threaded in from the account).
        self._meter = meter or Meter(False)

    # --- API surface (mirrors CONTRACT section 4 read half) ---

    def list_messages(
        self,
        *,
        to: Optional[str] = None,
        from_addr: Optional[str] = None,
        thread: Optional[str] = None,
        direction: Optional[str] = None,
        q: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Page:
        params: dict[str, str] = {}
        if to:
            params["to"] = to
        if from_addr:
            params["from"] = from_addr
        if thread:
            params["thread"] = thread
        if direction:
            params["direction"] = direction
        if q:
            params["q"] = q
        if limit is not None:
            params["limit"] = str(limit)
        if cursor:
            params["cursor"] = cursor
        body = self._get("/api/messages", params)
        return Page(
            items=[MessageSummary.from_json(m) for m in body.get("items", [])],
            cursor=body.get("cursor"),
        )

    def get_message(self, message_id: str) -> Optional[Message]:
        try:
            body = self._get(f"/api/messages/{urllib.parse.quote(message_id, safe='')}", {})
        except PosternError as e:
            if e.status == 404:
                return None
            raise
        msg = body.get("message")
        return Message.from_json(msg) if msg else None

    def get_thread(self, thread_id: str) -> list[Message]:
        body = self._get(f"/api/threads/{urllib.parse.quote(thread_id, safe='')}", {})
        return [Message.from_json(m) for m in body.get("messages", [])]

    def search(
        self,
        q: str,
        *,
        mode: Optional[str] = None,
        field: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[MessageSummary]:
        params: dict[str, str] = {"q": q}
        if mode:
            params["mode"] = mode
        if field:
            # substr only (#212/#216): which column(s) the substring matches
            # (subject|body|text). Ignored by the non-substr modes; the worker
            # validates it strictly.
            params["field"] = field
        if limit is not None:
            params["limit"] = str(limit)
        body = self._get("/api/search", params)
        return [MessageSummary.from_json(h["message"]) for h in body.get("items", []) if h.get("message")]

    def ping(self) -> bool:
        """Validate the token by hitting an authed endpoint; True if accepted."""
        try:
            self._get("/api/messages", {"limit": "1"})
            return True
        except PosternAuthError:
            return False

    # --- internals ---

    def _get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        # urlencode quotes every value, so caller-supplied filters/queries cannot
        # smuggle extra query params or break the URL (injection-safe).
        url = self._base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", USER_AGENT)
        # Measure only the transport round-trip (the blocking-urllib I/O cost). The
        # path is the API endpoint, never a token or message content; on a transport
        # error the timed block still records the latency it took to fail.
        with self._meter.timed("api_request", path=path) as span:
            status, raw = self._transport(req)
            span.set(status=status, bytes=len(raw))
        if status == 401:
            raise PosternAuthError("Postern API rejected the token", status=401)
        if status >= 400:
            raise PosternError(f"Postern API error (HTTP {status})", status=status)
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError) as e:
            raise PosternError(f"invalid JSON from Postern API: {e}") from e

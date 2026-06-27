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

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "MessageSummary":
        return cls(
            uid=int(d["uid"]),
            message_id=d["messageId"],
            direction=d.get("direction", "inbound"),
            thread_id=d.get("threadId", d["messageId"]),
            from_addr=d.get("from", ""),
            to_addr=d.get("to", ""),
            subject=d.get("subject", ""),
            date=d.get("date", ""),
            in_reply_to=d.get("inReplyTo"),
            trusted=bool(d.get("trusted", False)),
            received_at=d.get("receivedAt", ""),
            attachment_count=int(d.get("attachmentCount", 0)),
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

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "Message":
        return cls(
            message_id=d["messageId"],
            direction=d.get("direction", "inbound"),
            thread_id=d.get("threadId", d["messageId"]),
            from_addr=d.get("from", ""),
            to_addr=d.get("to", ""),
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

    def __init__(self, base_url: str, token: str, timeout: float = 15.0, transport: Any = None) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._transport = transport or _UrllibTransport(timeout)

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

    def search(self, q: str, *, mode: Optional[str] = None, limit: Optional[int] = None) -> list[MessageSummary]:
        params: dict[str, str] = {"q": q}
        if mode:
            params["mode"] = mode
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
        status, raw = self._transport(req)
        if status == 401:
            raise PosternAuthError("Postern API rejected the token", status=401)
        if status >= 400:
            raise PosternError(f"Postern API error (HTTP {status})", status=status)
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError) as e:
            raise PosternError(f"invalid JSON from Postern API: {e}") from e

"""Dependency-light client for the Postern mailbox API (CONTRACT section 4).

Postern is a token-gated HTTP mailbox API served by the inbound/store worker.
This client is the reusable Python surface over it so crew agents and humans hit
the same API without rebuilding tooling each session. It is pure stdlib (urllib),
mirroring the IMAP proxy's client, so it has zero runtime dependencies and is
unit-testable without a live server (the transport is injectable).

PER-USER OWN KEY: the API origin and token come from the environment
(POSTERN_API_URL / POSTERN_API_TOKEN) or are passed explicitly; this module never
hardcodes either and never logs the token. Each user brings their own key.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence, Union

__all__ = [
    "PosternClient",
    "PosternError",
    "PosternAuthError",
    "Attachment",
    "from_env",
]

# A recipient field accepts a single address or a list; mirrors SendRequest.
Addresses = Union[str, Sequence[str]]


class PosternError(Exception):
    """A non-2xx response or transport failure from the Postern API.

    `code` is the API's stable error code (e.g. E_NOT_FOUND) when present.
    """

    def __init__(self, message: str, status: Optional[int] = None, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class PosternAuthError(PosternError):
    """401 from the Postern API: the bearer token is missing or wrong."""


@dataclass
class Attachment:
    """The bytes + metadata of one fetched attachment."""

    body: bytes
    mime: str
    filename: str


# Injectable transport so tests supply a fake without a live server. Takes a
# fully-formed urllib Request, returns (status, headers, body_bytes).
class _UrllibTransport:
    def __init__(self, timeout: float) -> None:
        self._timeout = timeout

    def __call__(self, req: urllib.request.Request) -> tuple[int, Mapping[str, str], bytes]:
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers or {}), e.read()
        except urllib.error.URLError as e:
            raise PosternError(f"request failed: {e.reason}") from e


def _addr_list(value: Optional[Addresses]) -> Optional[list[str]]:
    if value is None:
        return None
    if isinstance(value, str):
        return [value]
    return list(value)


class PosternClient:
    """Client over the Postern mailbox API (read + write halves).

    base_url is the worker origin (e.g. https://postern.example); token is the
    Postern API token sent as Authorization: Bearer. The token is never logged.
    Methods return the API's parsed JSON (dicts/lists) so the shapes match the
    CONTRACT exactly; callers read the documented keys.
    """

    def __init__(self, base_url: str, token: str, timeout: float = 30.0, transport: Any = None) -> None:
        if not base_url:
            raise PosternError("base_url (POSTERN_API_URL) is required")
        if not token:
            raise PosternError("token (POSTERN_API_TOKEN) is required")
        self._base = base_url.rstrip("/")
        self._token = token
        self._transport = transport or _UrllibTransport(timeout)
        self._ua = "postern-client"

    # --- write half ---------------------------------------------------------

    def send(
        self,
        to: Addresses,
        subject: str,
        *,
        text: Optional[str] = None,
        html: Optional[str] = None,
        from_addr: Optional[str] = None,
        reply_to: Optional[str] = None,
        cc: Optional[Addresses] = None,
        bcc: Optional[Addresses] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> dict[str, Any]:
        """POST /api/send. Returns the SendResult ({messageId, threadId, ...})."""
        body: dict[str, Any] = {"to": _addr_list(to), "subject": subject}
        if text is not None:
            body["text"] = text
        if html is not None:
            body["html"] = html
        if from_addr is not None:
            body["from"] = from_addr
        if reply_to is not None:
            body["replyTo"] = reply_to
        if cc is not None:
            body["cc"] = _addr_list(cc)
        if bcc is not None:
            body["bcc"] = _addr_list(bcc)
        if headers:
            body["headers"] = dict(headers)
        return self._json("POST", "/api/send", body=body)

    def reply(
        self,
        message_id: str,
        *,
        text: Optional[str] = None,
        html: Optional[str] = None,
        from_addr: Optional[str] = None,
        cc: Optional[Addresses] = None,
        bcc: Optional[Addresses] = None,
    ) -> dict[str, Any]:
        """POST /api/reply to a stored message. Returns the SendResult."""
        body: dict[str, Any] = {"messageId": message_id}
        if text is not None:
            body["text"] = text
        if html is not None:
            body["html"] = html
        if from_addr is not None:
            body["from"] = from_addr
        if cc is not None:
            body["cc"] = _addr_list(cc)
        if bcc is not None:
            body["bcc"] = _addr_list(bcc)
        return self._json("POST", "/api/reply", body=body)

    # --- read half ----------------------------------------------------------

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
    ) -> dict[str, Any]:
        """GET /api/messages. Returns {items: [summary...], cursor: str|None}."""
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
        return self._json("GET", "/api/messages", params=params)

    def get_message(self, message_id: str) -> Optional[dict[str, Any]]:
        """GET /api/messages/{id}. Returns the message dict, or None if absent."""
        try:
            body = self._json("GET", f"/api/messages/{urllib.parse.quote(message_id, safe='')}")
        except PosternError as e:
            if e.status == 404:
                return None
            raise
        msg = body.get("message")
        return msg if isinstance(msg, dict) else None

    def get_thread(self, thread_id: str) -> list[dict[str, Any]]:
        """GET /api/threads/{id}. Returns the list of message dicts in the thread."""
        body = self._json("GET", f"/api/threads/{urllib.parse.quote(thread_id, safe='')}")
        msgs = body.get("messages", [])
        return list(msgs) if isinstance(msgs, list) else []

    def search(
        self,
        q: str,
        *,
        mode: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> dict[str, Any]:
        """GET /api/search. Returns {items: [{message, ...}], cursor: str|None}."""
        params: dict[str, str] = {"q": q}
        if mode:
            params["mode"] = mode
        if limit is not None:
            params["limit"] = str(limit)
        if cursor:
            params["cursor"] = cursor
        return self._json("GET", "/api/search", params=params)

    def get_attachment(self, message_id: str, index: int) -> Attachment:
        """GET /api/messages/{id}/attachments/{i}. Returns the raw Attachment bytes."""
        path = f"/api/messages/{urllib.parse.quote(message_id, safe='')}/attachments/{int(index)}"
        status, hdrs, raw = self._request("GET", path)
        if status == 401:
            raise PosternAuthError("Postern API rejected the token", status=401)
        if status >= 400:
            raise PosternError(f"Postern API error (HTTP {status})", status=status)
        mime = hdrs.get("content-type") or hdrs.get("Content-Type") or "application/octet-stream"
        disp = hdrs.get("content-disposition") or hdrs.get("Content-Disposition") or ""
        filename = _filename_from_disposition(disp) or f"attachment-{index}"
        return Attachment(body=raw, mime=mime, filename=filename)

    def ping(self) -> bool:
        """Validate the token by hitting an authed endpoint; True if accepted."""
        try:
            self._json("GET", "/api/messages", params={"limit": "1"})
            return True
        except PosternAuthError:
            return False

    # --- internals ----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, str]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> tuple[int, Mapping[str, str], bytes]:
        url = self._base + path
        if params:
            # urlencode quotes every value, so caller-supplied filters cannot
            # smuggle extra query params or break the URL (injection-safe).
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        # urllib's default User-Agent trips Cloudflare error 1010; identify.
        req.add_header("User-Agent", self._ua)
        return self._transport(req)

    def _json(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, str]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        status, _hdrs, raw = self._request(method, path, params=params, body=body)
        parsed: dict[str, Any] = {}
        if raw:
            try:
                loaded = json.loads(raw.decode("utf-8"))
                if isinstance(loaded, dict):
                    parsed = loaded
            except (ValueError, UnicodeDecodeError) as e:
                if status < 400:
                    raise PosternError(f"invalid JSON from Postern API: {e}") from e
        if status == 401:
            raise PosternAuthError(
                parsed.get("message") or "Postern API rejected the token",
                status=401,
                code=parsed.get("error"),
            )
        if status >= 400:
            raise PosternError(
                parsed.get("message") or f"Postern API error (HTTP {status})",
                status=status,
                code=parsed.get("error"),
            )
        return parsed


def _filename_from_disposition(disp: str) -> Optional[str]:
    # content-disposition: attachment; filename="safe-name.ext"
    marker = "filename="
    i = disp.find(marker)
    if i < 0:
        return None
    name = disp[i + len(marker):].strip()
    if name.startswith('"'):
        end = name.find('"', 1)
        return name[1:end] if end > 0 else name[1:]
    return name.split(";")[0].strip() or None


def from_env(
    env: Optional[Mapping[str, str]] = None,
    *,
    base_url: Optional[str] = None,
    transport: Any = None,
) -> PosternClient:
    """Build a PosternClient from POSTERN_API_URL / POSTERN_API_TOKEN.

    Per-user own key: both come from the environment, never hardcoded. The token
    is ALWAYS read from POSTERN_API_TOKEN (never an argument), so it cannot leak
    into argv; only the non-secret origin may be overridden via `base_url`. Raises
    PosternError naming the missing variable so the user knows what to export.
    """
    e = os.environ if env is None else env
    base = (base_url if base_url is not None else (e.get("POSTERN_API_URL") or "")).strip()
    token = e.get("POSTERN_API_TOKEN") or ""
    if not base:
        raise PosternError("POSTERN_API_URL is not set (export the Postern API origin)")
    if not base.startswith(("http://", "https://")):
        raise PosternError("POSTERN_API_URL must start with http:// or https://")
    if not token:
        raise PosternError("POSTERN_API_TOKEN is not set (export your Postern API token)")
    timeout_raw = (e.get("POSTERN_API_TIMEOUT") or "").strip()
    timeout = 30.0
    if timeout_raw:
        try:
            timeout = float(timeout_raw)
        except ValueError as exc:
            raise PosternError("POSTERN_API_TIMEOUT must be a number") from exc
    return PosternClient(base, token, timeout=timeout, transport=transport)

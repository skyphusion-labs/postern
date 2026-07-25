"""Dependency-light client for the Postern mailbox API (CONTRACT section 4).

Postern is a token-gated HTTP mailbox API served by the inbound/store worker.
This client is the reusable Python surface over it so crew agents and humans hit
the same API without rebuilding tooling each session. It is pure stdlib (urllib),
mirroring the IMAP proxy's client, so it has zero runtime dependencies and is
unit-testable without a live server (the transport is injectable).

PER-USER OWN KEY: the API origin and token come from the environment
(POSTERN_API_URL / POSTERN_API_TOKEN) or are passed explicitly; this module never
hardcodes either and never logs the token. Each user brings their own key.

SCOPES (docs/AUTH-CONTRACT.md): reads and read-state writes (seen / flags / move)
need `read`; send / reply / drafts need `send`; DELETE needs `delete`. Drafts are
identity-owned, so they additionally require a token that BINDS an identity (a
per-identity send credential); a static operator token gets a clean
E_IDENTITY_REQUIRED rather than a silent estate-wide draft box.
"""

from __future__ import annotations

import base64
import json
import mimetypes
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
    "OutboundAttachment",
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


@dataclass
class OutboundAttachment:
    """One attachment to SEND (mailbox.ts SendAttachment).

    The worker takes attachment bytes as standard base64 over JSON (#70 send,
    #363 reply); this holds the raw bytes and does the encoding at emit time, so
    a caller never hand-rolls base64. filename / mime_type are optional and the
    transport fills sane defaults. The worker caps attachment count and total
    decoded bytes and answers an over-cap send with E_PAYLOAD_TOO_LARGE, so the
    caps stay server-authoritative and are deliberately NOT duplicated here.
    """

    content: bytes
    filename: Optional[str] = None
    mime_type: Optional[str] = None

    @classmethod
    def from_path(
        cls,
        path: str,
        *,
        filename: Optional[str] = None,
        mime_type: Optional[str] = None,
    ) -> "OutboundAttachment":
        """Read a file into an attachment, guessing the MIME type from its name."""
        with open(path, "rb") as fh:
            content = fh.read()
        name = filename or os.path.basename(path)
        mime = mime_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        return cls(content=content, filename=name, mime_type=mime)

    def to_json(self) -> dict[str, Any]:
        """The wire shape: {content: base64, filename?, mimeType?} (camelCase)."""
        out: dict[str, Any] = {"content": base64.b64encode(self.content).decode("ascii")}
        if self.filename is not None:
            out["filename"] = self.filename
        if self.mime_type is not None:
            out["mimeType"] = self.mime_type
        return out


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


def _attachment_list(value: Optional[Sequence[OutboundAttachment]]) -> Optional[list[dict[str, Any]]]:
    """Serialize outbound attachments, refusing anything that is not one.

    A wrong type here would otherwise reach the worker as malformed JSON and come
    back as an opaque 400, so it fails loudly and locally instead.
    """
    if value is None:
        return None
    out: list[dict[str, Any]] = []
    for i, att in enumerate(value):
        if not isinstance(att, OutboundAttachment):
            raise PosternError(f"attachments[{i}] must be an OutboundAttachment")
        out.append(att.to_json())
    return out


def _bool_param(value: bool) -> str:
    # The worker accepts 0|1|true|false on hasAttachment / seen; send the
    # explicit spelling so a logged URL reads unambiguously.
    return "true" if value else "false"


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


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
        attachments: Optional[Sequence[OutboundAttachment]] = None,
        forward_message_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """POST /api/send. Returns the SendResult ({messageId, threadId, ...}).

        `attachments` are base64-encoded over JSON (the worker contract);
        `forward_message_id` quotes a stored message as a forward, with the
        recipients still caller-selected.
        """
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
        if attachments is not None:
            body["attachments"] = _attachment_list(attachments)
        if forward_message_id is not None:
            body["forwardMessageId"] = forward_message_id
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
        mode: Optional[str] = None,
        quote_original: Optional[bool] = None,
        attachments: Optional[Sequence[OutboundAttachment]] = None,
    ) -> dict[str, Any]:
        """POST /api/reply to a stored message. Returns the SendResult.

        `mode` is reply|replyAll (replyAll derives the original To/Cc
        server-side, excluding the sender); `quote_original` appends a
        server-built quote from stored state; `attachments` use the same shape
        as send (#363).
        """
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
        if mode is not None:
            body["mode"] = mode
        if quote_original is not None:
            body["quoteOriginal"] = quote_original
        if attachments is not None:
            body["attachments"] = _attachment_list(attachments)
        return self._json("POST", "/api/reply", body=body)

    # --- read half ----------------------------------------------------------

    def list_messages(
        self,
        *,
        to: Optional[str] = None,
        from_addr: Optional[str] = None,
        thread: Optional[str] = None,
        direction: Optional[str] = None,
        lens: Optional[str] = None,
        mailbox: Optional[str] = None,
        seen_for: Optional[str] = None,
        q: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> dict[str, Any]:
        """GET /api/messages. Returns {items: [summary...], cursor: str|None}.

        `direction` filters the STORED wire fact (inbound|outbound), so
        to=X + direction=inbound is what actually ARRIVED for X and never the
        stored sent copy. `lens` (inbox|sent) asks for X's own VIEW instead; it
        needs `to` and cannot be combined with `direction` (CONTRACT 10.9).
        `mailbox` (archive|trash|junk|all) scopes the durable folders; omit it
        for the direction-default INBOX/Sent view. `seen_for` sets WHOSE read
        state is projected (#404) without touching which rows come back, which
        is what a shared role queue needs (to=the role, seen_for=the human).
        """
        params: dict[str, str] = {}
        if to:
            params["to"] = to
        if from_addr:
            params["from"] = from_addr
        if thread:
            params["thread"] = thread
        if direction:
            params["direction"] = direction
        if lens:
            params["lens"] = lens
        if mailbox:
            params["mailbox"] = mailbox
        if seen_for:
            params["seenFor"] = seen_for
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
            body = self._json("GET", f"/api/messages/{_quote(message_id)}")
        except PosternError as e:
            if e.status == 404:
                return None
            raise
        msg = body.get("message")
        return msg if isinstance(msg, dict) else None

    def get_thread(self, thread_id: str) -> list[dict[str, Any]]:
        """GET /api/threads/{id}. Returns the list of message dicts in the thread."""
        body = self._json("GET", f"/api/threads/{_quote(thread_id)}")
        msgs = body.get("messages", [])
        return list(msgs) if isinstance(msgs, list) else []

    def search(
        self,
        q: str,
        *,
        mode: Optional[str] = None,
        field: Optional[str] = None,
        direction: Optional[str] = None,
        lens: Optional[str] = None,
        to: Optional[str] = None,
        from_addr: Optional[str] = None,
        mailbox: Optional[str] = None,
        seen_for: Optional[str] = None,
        after: Optional[str] = None,
        before: Optional[str] = None,
        has_attachment: Optional[bool] = None,
        seen: Optional[bool] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> dict[str, Any]:
        """GET /api/search. Returns {items: [{message, ...}], cursor: str|None}.

        `mode` is fts|substr|semantic|hybrid; `field` (subject|body|text) is the
        substr column selector and is ignored by the other modes. The remaining
        filters mirror /api/messages exactly: `direction` is the stored wire
        fact, `lens` the viewer view (needs `to`, refuses `direction`),
        `mailbox` scopes a durable folder so a Trash search cannot match
        arrival-view rows, `seen_for` sets the read-state projection key.
        `after` / `before` bound the date range; `has_attachment` and `seen` are
        booleans. The worker validates all of these strictly, so a typo is a
        clean 400 rather than a silently-dropped filter.
        """
        params: dict[str, str] = {"q": q}
        if mode:
            params["mode"] = mode
        if field:
            params["field"] = field
        if direction:
            params["direction"] = direction
        if lens:
            params["lens"] = lens
        if to:
            params["to"] = to
        if from_addr:
            params["from"] = from_addr
        if mailbox:
            params["mailbox"] = mailbox
        if seen_for:
            params["seenFor"] = seen_for
        if after:
            params["after"] = after
        if before:
            params["before"] = before
        if has_attachment is not None:
            params["hasAttachment"] = _bool_param(has_attachment)
        if seen is not None:
            params["seen"] = _bool_param(seen)
        if limit is not None:
            params["limit"] = str(limit)
        if cursor:
            params["cursor"] = cursor
        return self._json("GET", "/api/search", params=params)

    def get_attachment(self, message_id: str, index: int) -> Attachment:
        """GET /api/messages/{id}/attachments/{i}. Returns the raw Attachment bytes."""
        path = f"/api/messages/{_quote(message_id)}/attachments/{int(index)}"
        status, hdrs, raw = self._request("GET", path, accept="*/*")
        if status == 401:
            raise PosternAuthError("Postern API rejected the token", status=401)
        if status >= 400:
            raise PosternError(f"Postern API error (HTTP {status})", status=status)
        mime = hdrs.get("content-type") or hdrs.get("Content-Type") or "application/octet-stream"
        disp = hdrs.get("content-disposition") or hdrs.get("Content-Disposition") or ""
        filename = _filename_from_disposition(disp) or f"attachment-{index}"
        return Attachment(body=raw, mime=mime, filename=filename)

    def get_folders(self, *, to: Optional[str] = None) -> list[dict[str, Any]]:
        """GET /api/folders. Server-authoritative folder list + unread counts.

        `to` scopes the unread counts to one viewer, mirroring list/search; a
        bound session identity wins over it server-side.
        """
        params = {"to": to} if to else {}
        body = self._json("GET", "/api/folders", params=params)
        folders = body.get("folders", [])
        return list(folders) if isinstance(folders, list) else []

    # --- read state + placement ---------------------------------------------

    def set_seen(
        self,
        message_ids: Sequence[str],
        seen: bool,
        *,
        for_addr: Optional[str] = None,
    ) -> int:
        """POST /api/messages/seen. Returns the number of rows the worker changed.

        `read`-scoped (marking read is a side effect of reading), idempotent, and
        unknown ids are skipped server-side. `for_addr` makes the mark a
        per-recipient override (message_seen_by) instead of the row-level estate
        write. An empty id list is a local no-op that never hits the network.
        """
        ids = list(message_ids)
        if not ids:
            return 0
        body: dict[str, Any] = {"ids": ids, "seen": seen}
        if for_addr:
            body["for"] = for_addr
        return _updated_count(self._json("POST", "/api/messages/seen", body=body))

    def set_flags(
        self,
        message_ids: Sequence[str],
        *,
        flagged: Optional[bool] = None,
        answered: Optional[bool] = None,
    ) -> int:
        """POST /api/messages/flags. Durable Flagged / Answered; returns updated count.

        At least one of flagged / answered must be given; neither is a local
        no-op (the worker would answer 400).
        """
        ids = list(message_ids)
        if not ids or (flagged is None and answered is None):
            return 0
        flags: dict[str, Any] = {}
        if flagged is not None:
            flags["flagged"] = flagged
        if answered is not None:
            flags["answered"] = answered
        return _updated_count(self._json("POST", "/api/messages/flags", body={"ids": ids, "set": flags}))

    def move_messages(self, message_ids: Sequence[str], mailbox: Optional[str]) -> int:
        """POST /api/messages/move. Returns the updated count.

        mailbox is archive|trash|junk, or None to restore the message to its
        direction-default view. Trash here is the SOFT delete; delete_message is
        the hard one.
        """
        ids = list(message_ids)
        if not ids:
            return 0
        return _updated_count(self._json("POST", "/api/messages/move", body={"ids": ids, "mailbox": mailbox}))

    def delete_message(self, message_id: str) -> None:
        """DELETE /api/messages/{id}. Hard delete; needs a `delete`-scoped token.

        Raises PosternError with status 403 when the token lacks the scope and
        404 when the message is not there.
        """
        self._json("DELETE", f"/api/messages/{_quote(message_id)}")

    # --- drafts (identity-owned) --------------------------------------------
    #
    # Server-side drafts belong to an identity, so these need a token that BINDS
    # one (a per-identity send credential, docs/SEND-IDENTITIES.md). A static
    # operator token is deliberately insufficient and gets E_IDENTITY_REQUIRED:
    # no trustworthy owner can be derived from it.

    def list_drafts(self) -> list[dict[str, Any]]:
        """GET /api/drafts. The bound identity's drafts."""
        body = self._json("GET", "/api/drafts")
        drafts = body.get("drafts", [])
        return list(drafts) if isinstance(drafts, list) else []

    def get_draft(self, draft_id: str) -> Optional[dict[str, Any]]:
        """GET /api/drafts/{id}. The draft dict, or None if absent."""
        try:
            body = self._json("GET", f"/api/drafts/{_quote(draft_id)}")
        except PosternError as e:
            if e.status == 404:
                return None
            raise
        draft = body.get("draft")
        return draft if isinstance(draft, dict) else None

    def create_draft(
        self,
        *,
        to: Optional[str] = None,
        cc: Optional[str] = None,
        bcc: Optional[str] = None,
        subject: Optional[str] = None,
        body_text: Optional[str] = None,
        body_html: Optional[str] = None,
        in_reply_to: Optional[str] = None,
        thread_id: Optional[str] = None,
        compose_mode: Optional[str] = None,
        source_message_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """POST /api/drafts. Returns {id, draft}; the worker mints the id.

        Recipient fields are the raw compose STRINGS (the worker splits them on
        comma / newline / semicolon at send time), not lists. `compose_mode` is
        new|reply|replyAll|forward.
        """
        return self._json("POST", "/api/drafts", body=_draft_body(
            to, cc, bcc, subject, body_text, body_html, in_reply_to, thread_id, compose_mode, source_message_id,
        ))

    def update_draft(
        self,
        draft_id: str,
        *,
        to: Optional[str] = None,
        cc: Optional[str] = None,
        bcc: Optional[str] = None,
        subject: Optional[str] = None,
        body_text: Optional[str] = None,
        body_html: Optional[str] = None,
        in_reply_to: Optional[str] = None,
        thread_id: Optional[str] = None,
        compose_mode: Optional[str] = None,
        source_message_id: Optional[str] = None,
        updated_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """PUT /api/drafts/{id}. Full-document autosave; returns {draft}.

        `updated_at` is REQUIRED to update an EXISTING draft and must equal the
        draft's current updatedAt: the worker treats any other value, including
        an absent one, as a conflict (409 / E_CONFLICT) and changes nothing. So
        the call is always read-modify-write: get_draft, edit, PUT back with the
        updatedAt you just read. Omit it only when PUTting an id that does not
        exist yet, which creates the draft.

        The worker stores the document as given, so a field left unset here is
        CLEARED on the stored draft. That is the same reason to read first.
        """
        body = _draft_body(
            to, cc, bcc, subject, body_text, body_html, in_reply_to, thread_id, compose_mode, source_message_id,
        )
        if updated_at is not None:
            body["updatedAt"] = updated_at
        return self._json("PUT", f"/api/drafts/{_quote(draft_id)}", body=body)

    def delete_draft(self, draft_id: str) -> None:
        """DELETE /api/drafts/{id}."""
        self._json("DELETE", f"/api/drafts/{_quote(draft_id)}")

    def send_draft(self, draft_id: str) -> dict[str, Any]:
        """POST /api/drafts/{id}/send. Returns the SendResult.

        The worker sends (or replies, for a reply/replyAll draft) with the
        staged attachments and only then deletes the draft, so a failure leaves
        it retryable.
        """
        return self._json("POST", f"/api/drafts/{_quote(draft_id)}/send")

    def list_draft_attachments(self, draft_id: str) -> list[dict[str, Any]]:
        """GET /api/drafts/{id}/attachments. The staged attachment metadata."""
        body = self._json("GET", f"/api/drafts/{_quote(draft_id)}/attachments")
        atts = body.get("attachments", [])
        return list(atts) if isinstance(atts, list) else []

    def add_draft_attachment(
        self,
        draft_id: str,
        content: bytes,
        *,
        filename: Optional[str] = None,
        mime_type: Optional[str] = None,
    ) -> dict[str, Any]:
        """POST /api/drafts/{id}/attachments. Stages one attachment; returns it.

        This route takes the RAW bytes (not base64): the body is the file, the
        Content-Type is its MIME type, and the filename rides percent-encoded in
        X-Postern-Filename because a header cannot carry arbitrary bytes.
        """
        headers = {"Content-Type": mime_type or "application/octet-stream"}
        if filename:
            headers["X-Postern-Filename"] = _quote(filename)
        path = f"/api/drafts/{_quote(draft_id)}/attachments"
        body = self._json("POST", path, data=content, headers=headers)
        att = body.get("attachment")
        return att if isinstance(att, dict) else {}

    def delete_draft_attachment(self, draft_id: str, attachment_id: str) -> None:
        """DELETE /api/drafts/{id}/attachments/{attachmentId}."""
        self._json("DELETE", f"/api/drafts/{_quote(draft_id)}/attachments/{_quote(attachment_id)}")

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
        data: Optional[bytes] = None,
        headers: Optional[Mapping[str, str]] = None,
        accept: str = "application/json",
    ) -> tuple[int, Mapping[str, str], bytes]:
        if body is not None and data is not None:
            raise PosternError("internal: pass a JSON body or raw data, never both")
        url = self._base + path
        if params:
            # urlencode quotes every value, so caller-supplied filters cannot
            # smuggle extra query params or break the URL (injection-safe).
            url += "?" + urllib.parse.urlencode(params)
        payload = json.dumps(body).encode("utf-8") if body is not None else data
        req = urllib.request.Request(url, data=payload, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", accept)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
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
        data: Optional[bytes] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> dict[str, Any]:
        status, _hdrs, raw = self._request(
            method, path, params=params, body=body, data=data, headers=headers,
        )
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


def _updated_count(body: Mapping[str, Any]) -> int:
    updated = body.get("updated", 0)
    return int(updated) if isinstance(updated, (int, float)) else 0


def _draft_body(
    to: Optional[str],
    cc: Optional[str],
    bcc: Optional[str],
    subject: Optional[str],
    body_text: Optional[str],
    body_html: Optional[str],
    in_reply_to: Optional[str],
    thread_id: Optional[str],
    compose_mode: Optional[str],
    source_message_id: Optional[str],
) -> dict[str, Any]:
    """The draft document in the worker's camelCase shape (api.ts draftInput).

    Only the fields the caller set are emitted; the worker reads an absent field
    as null, which is what clears it on a PUT.
    """
    fields: dict[str, Any] = {}
    for key, value in (
        ("to", to),
        ("cc", cc),
        ("bcc", bcc),
        ("subject", subject),
        ("bodyText", body_text),
        ("bodyHtml", body_html),
        ("inReplyTo", in_reply_to),
        ("threadId", thread_id),
        ("composeMode", compose_mode),
        ("sourceMessageId", source_message_id),
    ):
        if value is not None:
            fields[key] = value
    return fields


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

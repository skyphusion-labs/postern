"""HTTP client for the Postern structured mailbox API (CONTRACT section 4).

The IMAP proxy is a *client* of the mailbox API, never a second store owner: it
reads through the token-gated read endpoints (#24) and renders the result as
IMAP. This module is pure stdlib (urllib) so it has zero runtime dependencies
and is unit-testable without Twisted.
"""

from __future__ import annotations

import http.client
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional, Tuple

from .measure import Meter

_log = logging.getLogger(__name__)

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


class MissingFolderUidError(ValueError):
    """A durable-folder row (trash/junk/archive) has no valid folderUid (#352 review).

    FAIL CLOSED: never fall back to messages.id for a durable-folder UID. Reusing
    the arrival id would silently collide with a DIFFERENT message's real UID in
    that same per-folder UID space (they are minted from unrelated counters), which
    is a correctness hazard worse than dropping the row. Callers drop the offending
    row from the presented view rather than crash the whole SELECT/SEARCH.
    """


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
    # Read state (#seen): False = unread. Drives the IMAP \Seen flag (message.py) and
    # the UNSEEN counts (mailbox.py). Defaults to True when the API omits it, so an
    # OLDER worker that predates the seen field renders exactly as before (everything
    # \Seen); a current worker returns the real per-message value.
    seen: bool = True
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
    # True when the store holds a non-empty HTML body (#220). Drives multipart/alternative
    # projection and a body-free Content-Type on the IMAP ENVELOPE scan path.
    has_html: bool = False
    # Session-local \Deleted flag (#278): set by STORE, cleared on EXPUNGE or when the
    # message is removed from the snapshot. Not persisted in the Postern API until EXPUNGE.
    deleted: bool = False
    # Durable organize flags (#352): \Flagged / \Answered via POST /api/messages/flags.
    flagged: bool = False
    answered: bool = False
    # Durable folder placement (#352): None = direction-default INBOX/Sent view.
    mailbox: Optional[str] = None
    trashed_at: Optional[str] = None
    # Per-folder IMAP UID for trash/junk/archive (#352 §2.6). When set, the IMAP door
    # exposes this as the mailbox UID instead of messages.id.
    folder_uid: Optional[int] = None

    @classmethod
    def from_json(cls, d: dict[str, Any], *, use_folder_uid: bool = False) -> "MessageSummary":
        to_addr = d.get("to", "")
        folder_uid = d.get("folderUid")
        folder_uid_i = int(folder_uid) if folder_uid is not None else None
        # Placed folders (trash/junk/archive) use folder_uid as the IMAP UID; arrival
        # views keep messages.id. #352 review: FAIL CLOSED when a durable-folder row
        # has no folderUid -- never fall back to messages.id (a different, unrelated
        # UID space that could collide with another message's real per-folder UID).
        if use_folder_uid:
            if folder_uid_i is None or folder_uid_i <= 0:
                raise MissingFolderUidError(
                    f"durable-folder row {d.get('messageId')!r} has no folderUid"
                )
            uid = folder_uid_i
        else:
            uid = int(d["uid"])
        return cls(
            uid=uid,
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
            seen=bool(d.get("seen", True)),
            cc=d.get("cc"),
            bcc=d.get("bcc"),
            sender=d.get("sender"),
            reply_to=d.get("replyTo"),
            delivered_to=_delivered_to(d, to_addr),
            wire_size=_wire_size(d),
            has_html=bool(d.get("hasHtml", False)),
            flagged=bool(d.get("flagged", False)),
            answered=bool(d.get("answered", False)),
            mailbox=d.get("mailbox"),
            trashed_at=d.get("trashedAt"),
            folder_uid=folder_uid_i,
        )


def _summaries_fail_closed(
    raw_items: list[dict[str, Any]], *, use_folder_uid: bool
) -> list["MessageSummary"]:
    """Parse a page of raw summary dicts, dropping (not crashing on) any durable-
    folder row that fails MessageSummary.from_json's fail-closed folderUid check."""
    out: list[MessageSummary] = []
    for m in raw_items:
        try:
            out.append(MessageSummary.from_json(m, use_folder_uid=use_folder_uid))
        except MissingFolderUidError:
            _log.warning(
                "postern-imap: dropping durable-folder row %r with no folderUid "
                "(#352 fail-closed; never reused messages.id)",
                m.get("messageId"),
            )
    return out


@dataclass
class Attachment:
    filename: Optional[str]
    mime: Optional[str]
    size: int


@dataclass
class AttachmentBytes:
    """Raw attachment payload from GET /api/messages/{id}/attachments/{i}."""

    body: bytes
    mime: str
    filename: str


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
    # The raw HTML body when the message carried an HTML part (CONTRACT: StoredMessage
    # .bodyHtml, served by GET /api/messages/{id}). None for a text-only message or an
    # old row. The renderer projects this as the text/html alternative so an HTML mail
    # renders as HTML in a client, not as the lossy stripped-text derivation (#210).
    body_html: Optional[str] = None
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
            body_html=d.get("bodyHtml"),
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


@dataclass
class FolderInfo:
    """One row of GET /api/folders (#352 core unblocker 4).

    The AUTHORITATIVE source for durable-folder UIDVALIDITY: uid_validity is the
    worker's mailbox_uid_counter value for archive/trash/junk/drafts, None for the
    arrival views (inbox/sent/all) which use the config UIDVALIDITY instead.
    """

    id: str
    label: str
    count: int
    unread: int
    uid_validity: Optional[int] = None

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "FolderInfo":
        uv = d.get("uidValidity")
        return cls(
            id=d.get("id", ""),
            label=d.get("label", ""),
            count=int(d.get("count", 0)),
            unread=int(d.get("unread", 0)),
            uid_validity=int(uv) if uv is not None else None,
        )


@dataclass
class Draft:
    """Identity-owned server-side draft (CONTRACT /api/drafts, #352)."""

    id: str
    identity: str
    uid: int
    to_addr: Optional[str] = None
    cc: Optional[str] = None
    bcc: Optional[str] = None
    subject: Optional[str] = None
    body_text: Optional[str] = None
    body_html: Optional[str] = None
    in_reply_to: Optional[str] = None
    thread_id: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "Draft":
        return cls(
            id=d["id"],
            identity=d.get("identity", ""),
            uid=int(d["uid"]),
            to_addr=d.get("to"),
            cc=d.get("cc"),
            bcc=d.get("bcc"),
            subject=d.get("subject"),
            body_text=d.get("bodyText"),
            body_html=d.get("bodyHtml"),
            in_reply_to=d.get("inReplyTo"),
            thread_id=d.get("threadId"),
            created_at=d.get("createdAt", ""),
            updated_at=d.get("updatedAt", ""),
        )

    def as_summary(self) -> MessageSummary:
        """Project a draft as a mailbox list row (IMAP Drafts folder)."""
        return MessageSummary(
            uid=self.uid,
            message_id=self.id,
            direction="outbound",
            thread_id=self.thread_id or self.id,
            from_addr=self.identity,
            to_addr=self.to_addr or "",
            subject=self.subject or "",
            date=self.updated_at or self.created_at,
            in_reply_to=self.in_reply_to,
            trusted=True,
            received_at=self.updated_at or self.created_at,
            attachment_count=0,
            seen=True,
            has_html=bool(self.body_html and str(self.body_html).strip()),
            mailbox="drafts",
        )


# The default transport: reuse ONE persistent HTTP(S) connection to the worker across
# requests (keep-alive) instead of opening a fresh TCP+TLS connection per call like
# urllib.urlopen did. During a session's message backfill that is one handshake instead
# of one-per-message; on the live door (directory host -> CF edge over HTTPS) each avoided
# handshake is ~2 RTT + a TLS negotiation, so this is a real per-message win over the
# network even though it is ~invisible on loopback (#229 follow-up).
#
# It keeps the SAME injectable-transport contract as before -- called with a fully-formed
# urllib.request.Request, returns (status, body_bytes), raises PosternError on a transport
# failure -- so every test fake (FakeTransport / ErrorTransport) and the NativeVerifier
# in auth.py are unchanged. A non-2xx HTTP response is returned as (status, bytes), NOT
# raised (the caller maps status -> error), matching the old urllib behavior.
#
# Thread-safety: ONE connection, no lock. Safe under the proxy's current model -- every
# call runs on the single reactor thread (blocking urllib was already reactor-blocking),
# and one PosternClient is scoped to one mailbox/session, so its calls are serialized. A
# future deferToThread change MUST add a lock or a per-thread connection before sharing a
# transport across threads.
class _HttpTransport:
    def __init__(self, timeout: float) -> None:
        self._timeout = timeout
        self._conn: Optional[http.client.HTTPConnection] = None
        self._key: Optional[Tuple[str, str, Optional[int]]] = None
        self.last_headers: dict[str, str] = {}

    def __call__(self, req: urllib.request.Request) -> Tuple[int, bytes]:
        # A reused keep-alive connection may have been closed by the worker's idle
        # timeout since the last call; if the attempt fails at the transport layer, drop
        # the connection and retry ONCE on a fresh one. Every request we make is
        # idempotent (GET, or an idempotent seen/auth POST), so a single retry is safe.
        try:
            return self._attempt(req)
        except (http.client.HTTPException, OSError):
            self._close()
            try:
                return self._attempt(req)
            except (http.client.HTTPException, OSError) as exc:
                self._close()
                raise PosternError(f"request failed: {exc}") from exc

    def _attempt(self, req: urllib.request.Request) -> Tuple[int, bytes]:
        parts = urllib.parse.urlsplit(req.full_url)
        host = parts.hostname or ""
        key = (parts.scheme, host, parts.port)
        if self._conn is None or self._key != key:
            self._close()
            if parts.scheme == "https":
                self._conn = http.client.HTTPSConnection(host, parts.port or 443, timeout=self._timeout)
            else:
                self._conn = http.client.HTTPConnection(host, parts.port or 80, timeout=self._timeout)
            self._key = key
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        self._conn.request(req.get_method(), path, body=req.data, headers=dict(req.header_items()))
        resp = self._conn.getresponse()
        try:
            self.last_headers = {k.lower(): v for k, v in resp.getheaders()}
        except AttributeError:
            self.last_headers = {}
        # MUST fully read the body so the connection is left clean for reuse.
        return resp.status, resp.read()

    def _close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
        self._conn = None
        self._key = None


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
        self._transport = transport or _HttpTransport(timeout)
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
        mailbox: Optional[str] = None,
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
        # #352: mailbox=archive|trash|junk|all scopes durable folder views; omit for
        # direction-default INBOX/Sent (worker applies mailbox IS NULL).
        if mailbox:
            params["mailbox"] = mailbox
        if q:
            params["q"] = q
        if limit is not None:
            params["limit"] = str(limit)
        if cursor:
            params["cursor"] = cursor
        body = self._get("/api/messages", params)
        use_folder_uid = mailbox in ("trash", "junk", "archive")
        return Page(
            items=_summaries_fail_closed(body.get("items", []), use_folder_uid=use_folder_uid),
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

    def get_attachment(self, message_id: str, index: int) -> AttachmentBytes:
        """GET /api/messages/{id}/attachments/{i}. Returns the raw attachment bytes."""
        path = (
            f"/api/messages/{urllib.parse.quote(message_id, safe='')}"
            f"/attachments/{int(index)}"
        )
        status, hdrs, raw = self._get_raw(path)
        if status == 401:
            raise PosternAuthError("Postern API rejected the token", status=401)
        if status >= 400:
            raise PosternError(f"Postern API error (HTTP {status})", status=status)
        mime = hdrs.get("content-type") or hdrs.get("Content-Type") or "application/octet-stream"
        disp = hdrs.get("content-disposition") or hdrs.get("Content-Disposition") or ""
        filename = _filename_from_disposition(disp) or f"attachment-{index}"
        return AttachmentBytes(body=raw, mime=mime, filename=filename)

    def get_thread(self, thread_id: str) -> list[Message]:
        body = self._get(f"/api/threads/{urllib.parse.quote(thread_id, safe='')}", {})
        return [Message.from_json(m) for m in body.get("messages", [])]

    def search_page(
        self,
        q: str,
        *,
        mode: Optional[str] = None,
        field: Optional[str] = None,
        direction: Optional[str] = None,
        to: Optional[str] = None,
        from_addr: Optional[str] = None,
        mailbox: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Page:
        """One page of /api/search: the hits plus the next cursor (None when the
        result set is exhausted). A caller that needs the COMPLETE set (IMAP SEARCH
        must return every match, never a silent first-page cap) loops this cursor.

        `field` is the substr column selector (#212/#216); `direction` scopes the
        search to one folder's mail server-side (inbound|outbound), so a folder search
        pages only over its own matches. `mailbox` (#352 review) scopes a durable-folder
        SEARCH the same way list_messages does -- a Trash SEARCH must only match Trash,
        never leak arrival-view hits under a colliding UID. Ignored by the non-substr
        modes; the worker validates all three strictly.
        """
        params: dict[str, str] = {"q": q}
        if mode:
            params["mode"] = mode
        if field:
            params["field"] = field
        if direction:
            params["direction"] = direction
        # #357: a viewer-scoped search (to=V) applies the same recipient-relative
        # predicate + effective seen the list path does (CONTRACT 10.9); estate
        # searches pass to=None and are unchanged.
        if to:
            params["to"] = to
        # #366: Sent lens pushes from=V server-side (same semantics as /api/messages).
        if from_addr:
            params["from"] = from_addr
        if mailbox:
            params["mailbox"] = mailbox
        if cursor:
            params["cursor"] = cursor
        if limit is not None:
            params["limit"] = str(limit)
        body = self._get("/api/search", params)
        use_folder_uid = mailbox in ("trash", "junk", "archive")
        hits = [h["message"] for h in body.get("items", []) if h.get("message")]
        return Page(
            items=_summaries_fail_closed(hits, use_folder_uid=use_folder_uid),
            cursor=body.get("cursor"),
        )

    def search(
        self,
        q: str,
        *,
        mode: Optional[str] = None,
        field: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[MessageSummary]:
        """First page of /api/search as a plain list (back-compat convenience). For the
        complete, paginated result set use search_page and loop its cursor."""
        return self.search_page(q, mode=mode, field=field, limit=limit).items

    def set_seen(
        self, message_ids: list[str], seen: bool, for_addr: Optional[str] = None
    ) -> int:
        """Mark a set of messages (un)read via POST /api/messages/seen (#seen).

        Backs the IMAP \\Seen flag: the proxy's store() calls this when a client
        STOREs +/- \\Seen. Returns the number of rows the worker actually changed
        (idempotent; unknown ids are skipped server-side). An empty id list is a
        no-op that never hits the network. The endpoint is read-scoped, so a read-only
        token (the common IMAP credential) can persist read state.

        `for_addr` (a bare address) makes the write per-recipient (#357): the worker
        upserts a (id, for) override only, never touching row-level messages.seen
        (CONTRACT 10.9). Omitted (estate callers) keeps the legacy row-level write.
        """
        if not message_ids:
            return 0
        payload: dict = {"ids": message_ids, "seen": seen}
        if for_addr:
            payload["for"] = for_addr
        body = self._post("/api/messages/seen", payload)
        updated = body.get("updated", 0)
        return int(updated) if isinstance(updated, (int, float)) else 0

    def delete_message(self, message_id: str) -> None:
        """Hard-delete one message via DELETE /api/messages/{id} (#278).

        Backs IMAP EXPUNGE after a client STOREs \\Deleted. Requires an admin-scoped
        (`both`) API token; a read-only token gets HTTP 403.
        """
        path = "/api/messages/" + urllib.parse.quote(message_id, safe="")
        self._delete(path)

    def set_flags(
        self,
        message_ids: list[str],
        *,
        flagged: Optional[bool] = None,
        answered: Optional[bool] = None,
    ) -> int:
        """Set durable \\Flagged / \\Answered via POST /api/messages/flags (#352)."""
        if not message_ids or (flagged is None and answered is None):
            return 0
        payload: dict[str, Any] = {"ids": message_ids, "set": {}}
        if flagged is not None:
            payload["set"]["flagged"] = flagged
        if answered is not None:
            payload["set"]["answered"] = answered
        body = self._post("/api/messages/flags", payload)
        updated = body.get("updated", 0)
        return int(updated) if isinstance(updated, (int, float)) else 0

    def move_messages(self, message_ids: list[str], mailbox: Optional[str]) -> int:
        """Soft-move via POST /api/messages/move (#352).

        mailbox is archive|trash|junk, or None to restore to the direction-default view.
        Trash is soft-delete (trashed_at); EXPUNGE remains the hard delete.
        """
        if not message_ids:
            return 0
        body = self._post("/api/messages/move", {"ids": message_ids, "mailbox": mailbox})
        updated = body.get("updated", 0)
        return int(updated) if isinstance(updated, (int, float)) else 0

    def list_imap_drafts(self, identity: str) -> list[Draft]:
        """GET /api/imap/drafts?identity= -- the IMAP-service seam (#352 core

        unblocker 2). Unlike the session-bound /api/drafts, the IMAP door has no
        ambient identity, so it is asserted explicitly on every call.
        """
        body = self._get("/api/imap/drafts", {"identity": identity})
        return [Draft.from_json(d) for d in body.get("drafts", [])]

    def get_imap_draft(self, identity: str, draft_id: str) -> Optional[Draft]:
        try:
            path = f"/api/imap/drafts/{urllib.parse.quote(draft_id, safe='')}"
            body = self._get(path, {"identity": identity})
        except PosternError as e:
            if e.status == 404:
                return None
            raise
        draft = body.get("draft")
        return Draft.from_json(draft) if draft else None

    def create_imap_draft(self, identity: str, fields: dict[str, Any]) -> Draft:
        """POST /api/imap/drafts -- create a durable draft (APPEND Drafts)."""
        payload = dict(fields)
        payload["identity"] = identity
        body = self._post("/api/imap/drafts", payload, expect_status=(200, 201))
        draft = body.get("draft")
        if not draft:
            raise PosternError("draft create returned no draft")
        return Draft.from_json(draft)

    def update_imap_draft(
        self,
        identity: str,
        draft_id: str,
        fields: dict[str, Any],
        *,
        updated_at: Optional[str] = None,
    ) -> Draft:
        """PUT /api/imap/drafts/{id} -- autosave revision (contract 2.4.1): mints a
        fresh, higher per-folder UID for the SAME draft id (optimistic concurrency
        via updated_at); the caller (mailbox._append_draft) presents this to the
        IMAP client as EXPUNGE(old uid) + the new higher UID, never a second draft.
        """
        payload = dict(fields)
        payload["identity"] = identity
        if updated_at is not None:
            payload["updatedAt"] = updated_at
        path = f"/api/imap/drafts/{urllib.parse.quote(draft_id, safe='')}"
        url = self._base + path
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="PUT")
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "application/json")
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", USER_AGENT)
        with self._meter.timed("api_request", path=path) as span:
            status, raw = self._transport(req)
            span.set(status=status, bytes=len(raw))
        if status == 401:
            raise PosternAuthError("Postern API rejected the token", status=401)
        if status == 409:
            raise PosternError("draft conflict (stale updatedAt)", status=409)
        if status >= 400:
            raise PosternError(f"Postern API error (HTTP {status})", status=status)
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError) as e:
            raise PosternError(f"invalid JSON from Postern API: {e}") from e
        draft = body.get("draft")
        if not draft:
            raise PosternError("draft update returned no draft")
        return Draft.from_json(draft)

    def delete_imap_draft(self, identity: str, draft_id: str) -> None:
        path = "/api/imap/drafts/" + urllib.parse.quote(draft_id, safe="")
        self._delete(path, params={"identity": identity})

    def import_message(self, identity: str, folder: str, raw_mime: bytes) -> None:
        """POST /api/imap/import -- persist an APPEND miss (#352 core unblocker 3).

        Backs Sent-matcher misses and new Trash/Junk/Archive APPENDs: instead of
        refusing (the old, honest-but-lossy behavior), the message is persisted
        server-side via the IMAP-service seam. folder is sent|archive|trash|junk.
        """
        import base64

        payload = {
            "identity": identity,
            "folder": folder,
            "rawMime": base64.b64encode(raw_mime).decode("ascii"),
        }
        self._post("/api/imap/import", payload, expect_status=(200, 201))

    def get_folders(self, *, to: Optional[str] = None) -> list[FolderInfo]:
        """GET /api/folders -- server-authoritative counts + durable UIDVALIDITY

        (#352 core unblocker 4). `to` scopes the unread counts for a per_account
        viewer, mirroring list/search; UIDVALIDITY itself is estate-wide.
        """
        params = {"to": to} if to else {}
        body = self._get("/api/folders", params)
        return [FolderInfo.from_json(f) for f in body.get("folders", [])]

    def ping(self) -> bool:
        """Validate the token by hitting an authed endpoint; True if accepted."""
        try:
            self._get("/api/messages", {"limit": "1"})
            return True
        except PosternAuthError:
            return False

    # --- internals ---

    def _get_raw(self, path: str) -> tuple[int, dict[str, str], bytes]:
        url = self._base + path
        req = urllib.request.Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "*/*")
        req.add_header("User-Agent", USER_AGENT)
        with self._meter.timed("api_request", path=path) as span:
            status, raw = self._transport(req)
            span.set(status=status, bytes=len(raw))
        hdrs: dict[str, str] = {}
        if hasattr(self._transport, "last_headers"):
            hdrs = dict(getattr(self._transport, "last_headers") or {})
        return status, hdrs, raw

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

    def _post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        expect_status: Tuple[int, ...] = (200,),
    ) -> dict[str, Any]:
        # A JSON POST to the write half of the API (seen / flags / move / drafts).
        # Mirrors _get: Bearer auth, the real UA, measured round-trip, and the same
        # status -> PosternError mapping so a 401/5xx surfaces identically.
        url = self._base + path
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "application/json")
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", USER_AGENT)
        with self._meter.timed("api_request", path=path) as span:
            status, raw = self._transport(req)
            span.set(status=status, bytes=len(raw))
        if status == 401:
            raise PosternAuthError("Postern API rejected the token", status=401)
        if status not in expect_status and status >= 400:
            raise PosternError(f"Postern API error (HTTP {status})", status=status)
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError) as e:
            raise PosternError(f"invalid JSON from Postern API: {e}") from e

    def _delete(self, path: str, *, params: Optional[dict[str, str]] = None) -> None:
        url = self._base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, method="DELETE")
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", USER_AGENT)
        with self._meter.timed("api_request", path=path) as span:
            status, raw = self._transport(req)
            span.set(status=status, bytes=len(raw))
        if status == 401:
            raise PosternAuthError("Postern API rejected the token", status=401)
        if status == 403:
            raise PosternError("Postern API denied delete (requires admin scope)", status=403)
        if status == 404:
            raise PosternError("message not found", status=404)
        if status >= 400:
            raise PosternError(f"Postern API error (HTTP {status})", status=status)


def _filename_from_disposition(disp: str) -> Optional[str]:
    marker = "filename="
    i = disp.find(marker)
    if i < 0:
        return None
    name = disp[i + len(marker):].strip()
    if name.startswith('"'):
        end = name.find('"', 1)
        return name[1:end] if end > 0 else name[1:]
    return name.split(";")[0].strip() or None

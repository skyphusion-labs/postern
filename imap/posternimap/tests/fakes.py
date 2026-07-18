"""Test doubles for postern-imap: a fake HTTP transport and sample messages.

The fake transport plugs into PosternClient (its injectable `transport`) so the
client + everything above it can be tested without a live Postern API or network.
It speaks the real wire shapes from CONTRACT section 4.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.parse
from typing import Any, Dict, List, Optional

# Mirrors inbound/src/api.ts requiredScope() for the routes this door calls (#352
# core unblocker 6): scope-faithful fakes so a test using the WRONG token for a
# route gets the same 403 the real worker would give, instead of silently working.
def _required_scope(method: str, path: str) -> Optional[str]:
    if method == "POST" and path == "/api/messages/seen":
        return "read"
    if method == "POST" and path in ("/api/messages/flags", "/api/messages/move"):
        return "read"
    if path == "/api/imap/drafts" or path.startswith("/api/imap/drafts/"):
        return "imap"
    if method == "POST" and path == "/api/imap/import":
        return "imap"
    if method == "DELETE" and path.startswith("/api/messages/") and "/attachments/" not in path:
        return "delete"
    if method == "GET" and path in ("/api/messages", "/api/messages/"):
        return "read"
    if method == "GET" and path == "/api/search":
        return "read"
    if method == "GET" and path == "/api/folders":
        return "read"
    if method == "GET" and path.startswith("/api/messages/"):
        return "read"
    if method == "GET" and path.startswith("/api/threads/"):
        return "read"
    return None


def _scope_satisfies(have: str, need: str) -> bool:
    return have == "both" or have == need


_HEADER_RE = re.compile(rb"^([A-Za-z-]+):[ \t]*(.*)$")


def _parse_raw_mime(raw: bytes) -> Dict[str, str]:
    """Minimal header/body split good enough for the fake's import route (no need
    to pull in a real MIME parser -- rawMime bodies in tests are simple)."""
    head, _, body = raw.partition(b"\r\n\r\n")
    if not body and b"\n\n" in raw:
        head, _, body = raw.partition(b"\n\n")
    headers: Dict[str, str] = {}
    for line in head.splitlines():
        m = _HEADER_RE.match(line)
        if m:
            headers[m.group(1).decode("ascii").lower()] = m.group(2).decode("utf-8", "replace").strip()
    headers["_body"] = body.decode("utf-8", "replace")
    return headers


def _bare_address(value: str) -> str:
    m = re.search(r"<([^<>]+)>", value or "")
    addr = m.group(1) if m else (value or "")
    return addr.strip().lower()


def make_summary(message_id: str, *, direction: str = "inbound", **over: Any) -> Dict[str, Any]:
    d = {
        "messageId": message_id,
        "direction": direction,
        "threadId": message_id,
        "from": f"{message_id}@example.com",
        "to": "agent@skyphusion.org",
        "subject": f"Subject {message_id}",
        "date": "2026-06-18T12:00:00Z",
        "inReplyTo": None,
        "trusted": True,
        "receivedAt": "2026-06-18T12:00:01Z",
        "attachmentCount": 0,
    }
    d.update(over)
    return d


def make_message(message_id: str, *, body: str = "hello body", **over: Any) -> Dict[str, Any]:
    d = dict(make_summary(message_id, **over))
    d.pop("attachmentCount", None)
    d["bodyText"] = body
    d["attachments"] = over.get("attachments", [])
    return d


class FakeTransport:
    """Mimics PosternClient's transport: (urllib.request.Request) -> (status, bytes).

    Seeded with a list of message dicts (newest-first, as the API returns). It
    routes GET /api/messages (with cursor paging), /api/messages/{id},
    /api/threads/{id}, and /api/search. `expected_token` enforces auth: a wrong or
    missing Bearer returns 401, so token-mode auth + ping() are exercised.
    """

    def __init__(
        self,
        messages: Optional[List[Dict[str, Any]]] = None,
        *,
        expected_token: Optional[str] = "good-token",
        page_size: int = 2,
        token_scopes: Optional[Dict[str, str]] = None,
    ) -> None:
        self.messages = messages or []
        self.expected_token = expected_token
        self.page_size = page_size
        # Scope-faithful auth (#352 core unblocker 6): token -> scope ("both" /
        # "read" / "send" / "delete" / "imap"), mirroring inbound/src/api.ts
        # resolveToken. Back-compat default: a bare `expected_token=...` (the
        # overwhelming majority of call sites) still means "this one token, and
        # it can do anything" -- i.e. scope "both" -- so every pre-#352 test is
        # unaffected. Pass token_scopes explicitly to exercise real 403s.
        self.token_scopes: Dict[str, str] = dict(token_scopes or {})
        if expected_token is not None and expected_token not in self.token_scopes:
            self.token_scopes[expected_token] = "both"
        self.calls: List[str] = []
        # count of per-message body fetches (GET /api/messages/{id}); the #102 proof
        # is that an ENVELOPE/header scan never increments this.
        self.body_fetches = 0
        self.attachment_fetches = 0
        self.last_headers: dict[str, str] = {}
        # last decoded POST /api/messages/seen body (#357 per-recipient assert)
        self.last_seen_payload: Optional[Dict[str, Any]] = None
        # #352 durable folders: in-memory drafts + move/flags call log
        self.drafts: List[Dict[str, Any]] = []
        self.last_move_payload: Optional[Dict[str, Any]] = None
        self.last_flags_payload: Optional[Dict[str, Any]] = None
        self.last_import_payload: Optional[Dict[str, Any]] = None
        self._draft_uid = 1
        # Durable-folder UIDVALIDITY (#352 core unblocker 4): minted once per
        # folder on first touch, like the worker's mailbox_uid_counter, so
        # account.py's GET /api/folders read-through has something real to
        # source instead of a client-side hardcoded constant. Deliberately a
        # DIFFERENT numbering than the old _DURABLE_UIDVALIDITY constants so a
        # test that still asserts the old values would fail loudly.
        self._folder_uidvalidity: Dict[str, int] = {}
        self._next_folder_uidvalidity = 900000001

    def _uidvalidity_for(self, folder: str) -> int:
        if folder not in self._folder_uidvalidity:
            self._folder_uidvalidity[folder] = self._next_folder_uidvalidity
            self._next_folder_uidvalidity += 1
        return self._folder_uidvalidity[folder]

    def __call__(self, req):
        self.calls.append(req.full_url)
        auth = req.get_header("Authorization") or ""
        token = auth[len("Bearer "):] if auth.startswith("Bearer ") else None
        scope = self.token_scopes.get(token) if token is not None else None
        if scope is None:
            return 401, json.dumps({"ok": False, "error": "unauthorized"}).encode()

        parsed = urllib.parse.urlparse(req.full_url)
        path = parsed.path
        params = dict(urllib.parse.parse_qsl(parsed.query))
        method = req.get_method()

        need = _required_scope(method, path)
        if need is not None and not _scope_satisfies(scope, need):
            return 403, json.dumps({"ok": False, "error": "E_FORBIDDEN"}).encode()

        # #seen: POST /api/messages/seen { ids, seen } -> { ok, updated }. Routed
        # before the single-message GET branch (and never counted as a body fetch).
        if path == "/api/messages/seen" and method == "POST":
            return self._set_seen(req)
        if path == "/api/messages/flags" and method == "POST":
            return self._set_flags(req)
        if path == "/api/messages/move" and method == "POST":
            return self._move(req)

        if path == "/api/imap/drafts" or path.startswith("/api/imap/drafts/"):
            return self._imap_drafts(path, method, params, req)
        if path == "/api/imap/import" and method == "POST":
            return self._imap_import(req)
        if path == "/api/folders" and method == "GET":
            return self._folders(params)

        if method == "DELETE" and path.startswith("/api/messages/") and "/attachments/" not in path:
            return self._delete_message(path)

        if method == "GET" and path.startswith("/api/messages/") and path != "/api/messages/seen":
            if "/attachments/" in path:
                return self._get_attachment(path)
            self.body_fetches += 1

        if path == "/api/messages":
            return self._list(params)
        if path.startswith("/api/messages/") and "/attachments/" not in path:
            mid = urllib.parse.unquote(path[len("/api/messages/"):])
            return self._get(mid)
        if path.startswith("/api/threads/"):
            tid = urllib.parse.unquote(path[len("/api/threads/"):])
            return self._thread(tid)
        if path == "/api/search":
            return self._search(params)
        return 404, json.dumps({"ok": False, "error": "not_found"}).encode()

    def _uid_of(self, m: Dict[str, Any]) -> int:
        """The store's insertion key (rowid) for this message.

        Mirrors the real worker, which surfaces messages.id (an AUTOINCREMENT rowid
        assigned at arrival) as StoredMessageSummary.uid. The seed list is
        newest-first (as the API returns), so arrival order is its REVERSE: the
        newest message (index 0) gets the highest uid. Deriving uid from the
        arrival ordinal (len - index) keeps existing uids stable when a test inserts
        a new arrival at the front, exactly like an append-only rowid. An explicit
        per-message `uid` override wins (so a test can pin a specific value).
        """
        if "uid" in m:
            return int(m["uid"])
        for i, mm in enumerate(self.messages):
            if mm is m:
                return len(self.messages) - i
        return 0

    def _summary_of(self, m: Dict[str, Any]) -> Dict[str, Any]:
        s = {
            k: v
            for k, v in m.items()
            if k not in ("bodyText", "bodyHtml", "attachments", "attachmentBytes")
        }
        s["attachmentCount"] = len(m.get("attachments", []))
        s["uid"] = self._uid_of(m)
        if "hasHtml" not in s:
            html = m.get("bodyHtml")
            s["hasHtml"] = bool(html and str(html).strip())
        if "flagged" not in s:
            s["flagged"] = bool(m.get("flagged", False))
        if "answered" not in s:
            s["answered"] = bool(m.get("answered", False))
        if "mailbox" in m:
            s["mailbox"] = m.get("mailbox")
        if m.get("folderUid") is not None:
            s["folderUid"] = m.get("folderUid")
        if m.get("trashedAt") is not None:
            s["trashedAt"] = m.get("trashedAt")
        return s

    def _delivered_set(self, m: Dict[str, Any]) -> str:
        """Comma-wrapped membership set (CONTRACT 10.3 / worker COALESCE predicate)."""
        raw = m.get("deliveredTo")
        if isinstance(raw, list):
            addrs = [x.strip().lower() for x in raw if isinstance(x, str) and x]
        else:
            addrs = []
        if not addrs:
            to = m.get("to", "")
            if to:
                addrs = [to.strip().lower()]
        if not addrs:
            return ","
        return "," + ",".join(addrs) + ","

    def _list(self, params):
        direction = params.get("direction")
        to_filter = params.get("to")
        from_filter = params.get("from")
        mailbox = params.get("mailbox")
        rows = list(self.messages)
        # #352 placement filter: unset -> mailbox IS NULL; all -> no filter;
        # trash|junk|archive -> exact match.
        if mailbox == "all":
            pass
        elif mailbox in ("trash", "junk", "archive"):
            rows = [m for m in rows if m.get("mailbox") == mailbox]
        else:
            rows = [m for m in rows if not m.get("mailbox")]
        if to_filter and direction == "inbound":
            v = to_filter.strip().lower()
            needle = f",{v},"
            rows = [
                m
                for m in rows
                if needle in self._delivered_set(m)
                and (
                    m["direction"] == "inbound"
                    or (m["direction"] == "outbound" and m.get("from", "").strip().lower() != v)
                )
            ]
        else:
            if direction:
                rows = [m for m in rows if m["direction"] == direction]
            if to_filter:
                needle = f",{to_filter.strip().lower()},"
                rows = [m for m in rows if needle in self._delivered_set(m)]
        if from_filter:
            fv = from_filter.strip().lower()
            rows = [m for m in rows if m.get("from", "").strip().lower() == fv]
        start = int(params.get("cursor", "0"))
        limit = int(params.get("limit", str(self.page_size)))
        chunk = rows[start : start + limit]
        nxt = start + limit
        cursor = str(nxt) if nxt < len(rows) else None
        body = {"ok": True, "items": [self._summary_of(m) for m in chunk], "cursor": cursor}
        return 200, json.dumps(body).encode()

    def _get(self, mid):
        for m in self.messages:
            if m["messageId"] == mid:
                msg = {k: v for k, v in m.items() if k != "attachmentBytes"}
                return 200, json.dumps({"ok": True, "message": msg}).encode()
        return 404, json.dumps({"ok": False, "error": "E_NOT_FOUND"}).encode()

    def _get_attachment(self, path: str):
        self.attachment_fetches += 1
        rest = path[len("/api/messages/"):]
        mid_part, _, index_part = rest.partition("/attachments/")
        mid = urllib.parse.unquote(mid_part)
        try:
            index = int(index_part)
        except ValueError:
            return 404, json.dumps({"ok": False, "error": "E_NOT_FOUND"}).encode()
        for m in self.messages:
            if m["messageId"] != mid:
                continue
            raw_list = m.get("attachmentBytes") or []
            meta = m.get("attachments") or []
            if index < 0 or index >= len(meta):
                return 404, json.dumps({"ok": False, "error": "E_NOT_FOUND"}).encode()
            att = meta[index]
            body = raw_list[index] if index < len(raw_list) else b""
            filename = att.get("filename") or f"attachment-{index}"
            mime = att.get("mime") or "application/octet-stream"
            self.last_headers = {
                "content-type": mime,
                "content-disposition": f'attachment; filename="{filename}"',
            }
            return 200, body
        return 404, json.dumps({"ok": False, "error": "E_NOT_FOUND"}).encode()

    def _set_seen(self, req):
        """Mirror POST /api/messages/seen: flip `seen` on the seeded dicts and report
        how many rows changed (unknown ids skipped), so store()'s round-trip is real.

        Records the last decoded payload (#357) so a test can assert the per-recipient
        `for` address is (or is not) sent."""
        payload = json.loads((req.data or b"{}").decode("utf-8"))
        self.last_seen_payload = payload
        ids = set(payload.get("ids", []))
        seen = bool(payload.get("seen"))
        updated = 0
        for m in self.messages:
            if m["messageId"] in ids:
                m["seen"] = seen
                updated += 1
        return 200, json.dumps({"ok": True, "updated": updated}).encode()

    def _set_flags(self, req):
        payload = json.loads((req.data or b"{}").decode("utf-8"))
        self.last_flags_payload = payload
        ids = set(payload.get("ids", []))
        sett = payload.get("set") or {}
        updated = 0
        for m in self.messages:
            if m["messageId"] not in ids:
                continue
            if "flagged" in sett:
                m["flagged"] = bool(sett["flagged"])
            if "answered" in sett:
                m["answered"] = bool(sett["answered"])
            updated += 1
        return 200, json.dumps({"ok": True, "updated": updated}).encode()

    def _move(self, req):
        payload = json.loads((req.data or b"{}").decode("utf-8"))
        self.last_move_payload = payload
        ids = set(payload.get("ids", []))
        mailbox = payload.get("mailbox")
        updated = 0
        next_folder_uid = max(
            (int(m.get("folderUid") or 0) for m in self.messages), default=0
        ) + 1
        for m in self.messages:
            if m["messageId"] not in ids:
                continue
            m["mailbox"] = mailbox
            if mailbox == "trash":
                m["trashedAt"] = "2026-07-18T00:00:00Z"
                m["folderUid"] = next_folder_uid
                next_folder_uid += 1
                self._uidvalidity_for("trash")
            elif mailbox in ("junk", "archive"):
                m["trashedAt"] = None
                m["folderUid"] = next_folder_uid
                next_folder_uid += 1
                self._uidvalidity_for(mailbox)
            else:
                m["trashedAt"] = None
                m["folderUid"] = None
            updated += 1
        return 200, json.dumps({"ok": True, "updated": updated}).encode()

    def _imap_drafts(self, path, method, params, req):
        """/api/imap/drafts* -- the IMAP-service seam (#352 core unblocker 2):
        identity is asserted explicitly (query for GET/DELETE, body for POST/PUT),
        never taken from an ambient session, and a draft is only visible/writable
        by its owning identity (a wrong identity gets a clean 403, mirroring the
        real worker's getDraftOwner ownership check)."""
        self._uidvalidity_for("drafts")
        if path == "/api/imap/drafts" and method == "GET":
            identity = params.get("identity", "")
            drafts = [d for d in self.drafts if d.get("identity") == identity]
            return 200, json.dumps({"ok": True, "drafts": drafts}).encode()
        if path == "/api/imap/drafts" and method == "POST":
            payload = json.loads((req.data or b"{}").decode("utf-8"))
            identity = payload.get("identity", "")
            draft = {
                "id": f"draft-{self._draft_uid}",
                "identity": identity,
                "uid": self._draft_uid,
                "to": payload.get("to"),
                "cc": payload.get("cc"),
                "bcc": payload.get("bcc"),
                "subject": payload.get("subject"),
                "bodyText": payload.get("bodyText"),
                "bodyHtml": payload.get("bodyHtml"),
                "inReplyTo": payload.get("inReplyTo"),
                "threadId": payload.get("threadId"),
                "createdAt": "2026-07-18T00:00:00Z",
                "updatedAt": "2026-07-18T00:00:00Z",
            }
            self._draft_uid += 1
            self.drafts.append(draft)
            return 201, json.dumps({"ok": True, "id": draft["id"], "draft": draft}).encode()
        # /api/imap/drafts/{id}
        draft_id = urllib.parse.unquote(path[len("/api/imap/drafts/"):])
        if method == "GET":
            identity = params.get("identity", "")
            for d in self.drafts:
                if d["id"] == draft_id and d.get("identity") == identity:
                    return 200, json.dumps({"ok": True, "draft": d}).encode()
            return 404, json.dumps({"ok": False, "error": "E_NOT_FOUND"}).encode()
        if method == "DELETE":
            identity = params.get("identity", "")
            owner = next((d.get("identity") for d in self.drafts if d["id"] == draft_id), None)
            if owner is not None and owner != identity:
                return 403, json.dumps({"ok": False, "error": "E_FORBIDDEN"}).encode()
            before = len(self.drafts)
            self.drafts = [d for d in self.drafts if d["id"] != draft_id]
            if len(self.drafts) == before:
                return 404, json.dumps({"ok": False, "error": "E_NOT_FOUND"}).encode()
            return 200, json.dumps({"ok": True, "deleted": draft_id}).encode()
        if method == "PUT":
            payload = json.loads((req.data or b"{}").decode("utf-8"))
            identity = payload.get("identity", "")
            owner = next((d.get("identity") for d in self.drafts if d["id"] == draft_id), None)
            if owner is not None and owner != identity:
                return 403, json.dumps({"ok": False, "error": "E_FORBIDDEN"}).encode()
            for d in self.drafts:
                if d["id"] != draft_id:
                    continue
                if payload.get("updatedAt") and payload["updatedAt"] != d["updatedAt"]:
                    return 409, json.dumps({"ok": False, "error": "E_CONFLICT", "current": d}).encode()
                for key in (
                    "to", "cc", "bcc", "subject", "bodyText", "bodyHtml", "inReplyTo", "threadId",
                ):
                    if key in payload:
                        d[key] = payload[key]
                # #352 §2.4.1: a revision mints a NEW, strictly higher UID for the
                # SAME draft id (never a second draft) -- the door reads this as
                # EXPUNGE(old uid) + APPEND(new uid) in the selected Drafts folder.
                d["uid"] = self._draft_uid
                self._draft_uid += 1
                d["updatedAt"] = "2026-07-18T00:00:01Z"
                return 200, json.dumps({"ok": True, "draft": d}).encode()
            # create via PUT (client-chosen id, no existing owner)
            draft = {
                "id": draft_id,
                "identity": identity,
                "uid": self._draft_uid,
                "to": payload.get("to"),
                "subject": payload.get("subject"),
                "bodyText": payload.get("bodyText"),
                "createdAt": "2026-07-18T00:00:00Z",
                "updatedAt": "2026-07-18T00:00:00Z",
            }
            self._draft_uid += 1
            self.drafts.append(draft)
            return 200, json.dumps({"ok": True, "draft": draft}).encode()
        return 405, json.dumps({"ok": False, "error": "method_not_allowed"}).encode()

    def _imap_import(self, req):
        """POST /api/imap/import -- persist an APPEND miss (#352 core unblocker 3),
        mirroring inbound/src/api.ts handleImapImport: sent must match the
        asserted identity; trash/junk/archive place the new row directly."""
        payload = json.loads((req.data or b"{}").decode("utf-8"))
        self.last_import_payload = payload
        identity = payload.get("identity", "")
        folder = payload.get("folder")
        if folder not in ("sent", "archive", "trash", "junk"):
            return 400, json.dumps({"ok": False, "error": "E_VALIDATION_ERROR"}).encode()
        try:
            raw = base64.b64decode(payload.get("rawMime", ""))
        except Exception:
            return 400, json.dumps({"ok": False, "error": "E_VALIDATION_ERROR"}).encode()
        headers = _parse_raw_mime(raw)
        from_hdr = headers.get("from", "")
        from_addr = _bare_address(from_hdr)
        outbound = folder == "sent" or from_addr == identity
        if folder == "sent" and from_addr != identity:
            return 403, json.dumps({"ok": False, "error": "E_IDENTITY_MISMATCH"}).encode()
        message_id = (headers.get("message-id") or "").strip("<>") or f"imported-{self._draft_uid}"
        mailbox = None if folder == "sent" else folder
        next_folder_uid = max(
            (int(m.get("folderUid") or 0) for m in self.messages), default=0
        ) + 1
        m: Dict[str, Any] = {
            "messageId": message_id,
            "direction": "outbound" if outbound else "inbound",
            "threadId": message_id,
            "from": from_hdr or identity,
            "to": headers.get("to", "") or identity,
            "subject": headers.get("subject", ""),
            "date": headers.get("date") or "2026-07-18T00:00:00Z",
            "inReplyTo": None,
            "trusted": outbound,
            "receivedAt": "2026-07-18T00:00:00Z",
            "attachmentCount": 0,
            "bodyText": headers.get("_body", ""),
            "mailbox": mailbox,
        }
        if mailbox is not None:
            m["folderUid"] = next_folder_uid
            self._uidvalidity_for(mailbox)
        self.messages.insert(0, m)
        return 201, json.dumps({"ok": True, "mailbox": mailbox}).encode()

    def _folders(self, params):
        """GET /api/folders -- server-authoritative counts + durable UIDVALIDITY
        (#352 core unblocker 4): account.py reads THIS instead of a hardcoded
        client-side constant table."""

        def count(pred):
            return sum(1 for m in self.messages if pred(m))

        rows = [
            {"id": "inbox", "label": "Inbox", "count": count(lambda m: not m.get("mailbox") and m.get("direction") == "inbound"), "unread": 0},
            {"id": "sent", "label": "Sent", "count": count(lambda m: not m.get("mailbox") and m.get("direction") == "outbound"), "unread": 0},
            {"id": "all", "label": "All", "count": len(self.messages), "unread": 0},
            {
                "id": "drafts", "label": "Drafts", "count": len(self.drafts), "unread": 0,
                "uidValidity": self._uidvalidity_for("drafts"),
            },
            {
                "id": "trash", "label": "Trash",
                "count": count(lambda m: m.get("mailbox") == "trash"), "unread": 0,
                "uidValidity": self._uidvalidity_for("trash"),
            },
            {
                "id": "junk", "label": "Junk",
                "count": count(lambda m: m.get("mailbox") == "junk"), "unread": 0,
                "uidValidity": self._uidvalidity_for("junk"),
            },
            {
                "id": "archive", "label": "Archive",
                "count": count(lambda m: m.get("mailbox") == "archive"), "unread": 0,
                "uidValidity": self._uidvalidity_for("archive"),
            },
        ]
        return 200, json.dumps({"ok": True, "folders": rows}).encode()

    def _delete_message(self, path: str):
        mid = urllib.parse.unquote(path[len("/api/messages/"):])
        before = len(self.messages)
        self.messages = [m for m in self.messages if m["messageId"] != mid]
        if len(self.messages) == before:
            return 404, json.dumps({"ok": False, "error": "E_NOT_FOUND"}).encode()
        return 200, json.dumps({"ok": True, "deleted": mid}).encode()

    def _thread(self, tid):
        msgs = [m for m in self.messages if m.get("threadId") == tid]
        return 200, json.dumps({"ok": True, "threadId": tid, "messages": msgs}).encode()

    def _search(self, params):
        q = params.get("q", "").lower()
        # Mirror the worker's substr field selector (CONTRACT 10.8 / #216): subject
        # matches the subject only, body the body only, text (the default) either.
        field = params.get("field", "text")
        direction = params.get("direction")
        # #352 review: SEARCH must pass mailbox= so a durable-folder search is
        # actually scoped server-side (never leak an arrival-view hit under a
        # colliding folderUid). "all" = no filter; unset = mailbox IS NULL.
        mailbox = params.get("mailbox")

        def _hit(m: Dict[str, Any]) -> bool:
            subj = m.get("subject", "").lower()
            body = m.get("bodyText", "").lower()
            if field == "subject":
                matched = q in subj
            elif field == "body":
                matched = q in body
            else:
                matched = q in subj or q in body
            if not matched or (direction and m.get("direction") != direction):
                return False
            if mailbox == "all":
                return True
            if mailbox:
                return m.get("mailbox") == mailbox
            return not m.get("mailbox")

        rows = [m for m in self.messages if _hit(m)]
        # Page like the real endpoint (its _list sibling does the same): honor the
        # cursor, and cap each page at page_size (the fake's server-side max) so a
        # multi-page result set is exercised even when the caller requests a larger
        # limit.
        start = int(params.get("cursor", "0"))
        limit = min(int(params.get("limit", str(self.page_size))), self.page_size)
        chunk = rows[start : start + limit]
        nxt = start + limit
        cursor = str(nxt) if nxt < len(rows) else None
        hits = [{"message": self._summary_of(m)} for m in chunk]
        return 200, json.dumps({"ok": True, "items": hits, "cursor": cursor}).encode()


class ErrorTransport:
    """A transport that answers every Postern API call with a fixed error status.

    Drives the mailbox lazy-load path (SELECT/STATUS -> _ensure_loaded) into its
    upstream-error branch: status 401 -> PosternAuthError, any other >=400 ->
    PosternError, mirroring the real client._get mapping. `expected_token` is carried
    only for parity with FakeTransport (the e2e harness short-circuits auth via its
    verify lambda, so LOGIN still succeeds and the failure surfaces on the store read,
    exactly like the #143/#144 production traces). `calls` records the attempts so a
    test can assert the load was actually retried after a transient failure.
    """

    def __init__(self, status: int = 401, *, expected_token: Optional[str] = "tok") -> None:
        self.status = status
        self.expected_token = expected_token
        self.calls: List[str] = []

    def __call__(self, req):
        self.calls.append(req.full_url)
        body = json.dumps({"ok": False, "error": "injected"}).encode()
        return self.status, body

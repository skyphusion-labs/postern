"""Test doubles for postern-imap: a fake HTTP transport and sample messages.

The fake transport plugs into PosternClient (its injectable `transport`) so the
client + everything above it can be tested without a live Postern API or network.
It speaks the real wire shapes from CONTRACT section 4.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any, Dict, List, Optional


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
    ) -> None:
        self.messages = messages or []
        self.expected_token = expected_token
        self.page_size = page_size
        self.calls: List[str] = []
        # count of per-message body fetches (GET /api/messages/{id}); the #102 proof
        # is that an ENVELOPE/header scan never increments this.
        self.body_fetches = 0

    def __call__(self, req):
        self.calls.append(req.full_url)
        auth = req.get_header("Authorization") or ""
        if self.expected_token is not None and auth != f"Bearer {self.expected_token}":
            return 401, json.dumps({"ok": False, "error": "unauthorized"}).encode()

        parsed = urllib.parse.urlparse(req.full_url)
        path = parsed.path
        params = dict(urllib.parse.parse_qsl(parsed.query))
        if path.startswith("/api/messages/"):
            self.body_fetches += 1

        if path == "/api/messages":
            return self._list(params)
        if path.startswith("/api/messages/"):
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
        s = {k: v for k, v in m.items() if k not in ("bodyText", "attachments")}
        s["attachmentCount"] = len(m.get("attachments", []))
        s["uid"] = self._uid_of(m)
        return s

    def _list(self, params):
        direction = params.get("direction")
        rows = [m for m in self.messages if not direction or m["direction"] == direction]
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
                return 200, json.dumps({"ok": True, "message": m}).encode()
        return 404, json.dumps({"ok": False, "error": "E_NOT_FOUND"}).encode()

    def _thread(self, tid):
        msgs = [m for m in self.messages if m.get("threadId") == tid]
        return 200, json.dumps({"ok": True, "threadId": tid, "messages": msgs}).encode()

    def _search(self, params):
        q = params.get("q", "").lower()
        # Mirror the worker's substr field selector (CONTRACT 10.8 / #216): subject
        # matches the subject only, body the body only, text (the default) either.
        field = params.get("field", "text")
        direction = params.get("direction")

        def _hit(m: Dict[str, Any]) -> bool:
            subj = m.get("subject", "").lower()
            body = m.get("bodyText", "").lower()
            if field == "subject":
                matched = q in subj
            elif field == "body":
                matched = q in body
            else:
                matched = q in subj or q in body
            return matched and (not direction or m.get("direction") == direction)

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

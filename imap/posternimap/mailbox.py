"""Twisted IMailbox over the Postern mailbox API.

A SELECT snapshots the mailbox: we pull message summaries from the API
(paging through cursors, body-free), order them oldest-first (IMAP sequence
numbers are 1-based and ascending by arrival), and present a window of them.
fetch() wraps each in a PosternIMAPMessage that hydrates its body ONLY on demand
(#102).

Windowing (#102 Stage 1): INBOX/Sent are capped to the most-recent W messages
(POSTERN_IMAP_WINDOW); All is unbounded. Live refresh polls while selected.

UID model: INBOX/Sent/All use messages.id under the config UIDVALIDITY. Durable
folders (Trash/Junk/Archive/Drafts) use per-folder UIDs (#352 section 2.6).

#352 durable mailbox ops: APPEND persists or refuses (never silent OK+drop);
COPY/MOVE to Trash/Junk/Archive soft-places via POST /api/messages/move;
EXPUNGE hard-deletes; \\Flagged/\\Answered via POST /api/messages/flags.
Notes stays an empty placeholder.
"""

from __future__ import annotations

import email
import email.utils
import re
import uuid
from datetime import datetime, timedelta, timezone
from email.message import Message as PyMessage
from typing import TYPE_CHECKING, Any, List, Optional, Tuple

from zope.interface import implementer

from twisted.mail import imap4

from .client import Draft, Message, MessageSummary, PosternClient, PosternError
from .measure import Meter
from .message import PosternIMAPMessage

if TYPE_CHECKING:
    from twisted.internet.task import LoopingCall

_UID_VALIDITY = 1
_SEARCH_PAGE_LIMIT = 200
_SEARCH_MAX_PAGES_UNBOUNDED = 1000
_SENT_MATCH_WINDOW = timedelta(minutes=10)
# #352 §2.4.1: how long a same (to, subject) draft is treated as "the same logical
# draft, being autosaved again" rather than a genuinely new one. Generous compared
# to _SENT_MATCH_WINDOW: an editing session (pauses included) can run much longer
# than a submit-then-APPEND-copy race.
_DRAFT_REVISION_WINDOW = timedelta(hours=12)


class ReadOnlyError(imap4.MailboxException):
    """Raised for any write operation the mailbox refuses."""


class AppendRejectedError(imap4.MailboxException):
    """APPEND refused: no honest persist path (RFC 3501 tagged NO, never silent drop)."""


class MailboxLoadError(imap4.MailboxException):
    """The mailbox snapshot could not be loaded from the Postern read API (#144)."""


def _read_message_bytes(message) -> bytes:
    if isinstance(message, (bytes, bytearray)):
        return bytes(message)
    if hasattr(message, "read"):
        data = message.read()
        if isinstance(data, str):
            return data.encode("utf-8", "replace")
        return bytes(data or b"")
    return b""


def _parse_rfc822(raw: bytes) -> PyMessage:
    return email.message_from_bytes(raw)


def _header_addrs(msg: PyMessage, name: str) -> str:
    return (msg.get(name, "") or "").strip()


def _bare_addr(value: str) -> str:
    if not value:
        return ""
    _name, addr = email.utils.parseaddr(value)
    return (addr or value).strip().lower()


def _norm_subject(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def _message_id_header(msg: PyMessage) -> Optional[str]:
    mid = (msg.get("Message-ID") or msg.get("Message-Id") or "").strip()
    if not mid:
        return None
    if mid.startswith("<") and mid.endswith(">"):
        mid = mid[1:-1]
    return mid or None


def _body_text(msg: PyMessage) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if isinstance(payload, bytes):
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, "replace")
        return ""
    payload = msg.get_payload(decode=True)
    if isinstance(payload, bytes):
        charset = msg.get_content_charset() or "utf-8"
        return payload.decode(charset, "replace")
    text = msg.get_payload(decode=False)
    return text if isinstance(text, str) else ""


@implementer(imap4.IMailbox)
class PosternMailbox:
    """An IMAP view of the Postern mailbox, scoped by direction and/or mailbox=."""

    def __init__(
        self,
        client: PosternClient,
        *,
        direction: Optional[str] = None,
        to: Optional[str] = None,
        from_addr: Optional[str] = None,
        viewer: Optional[str] = None,
        special_use: Optional[List[str]] = None,
        list_view: bool = False,
        empty: bool = False,
        page_size: int = 200,
        window: int = 0,
        poll_seconds: int = 0,
        uidvalidity: int = _UID_VALIDITY,
        clock=None,
        meter: Optional[Meter] = None,
        writable_signal: bool = False,
        seen_writable: bool = False,
        delete_writable: bool = False,
        flags_writable: bool = False,
        delete_client: Optional[PosternClient] = None,
        mailbox_filter: Optional[str] = None,
        imap_client: Optional[PosternClient] = None,
        identity: Optional[str] = None,
        draft_revisions: Optional[set] = None,
    ) -> None:
        self._client = client
        self._delete_client = delete_client
        # #352 core unblocker 1/2/3: the least-privilege client + asserted identity
        # for /api/imap/drafts* and /api/imap/import. None when the operator has not
        # configured POSTERN_API_TOKEN_IMAP or no identity could be derived --
        # Drafts/import then fail closed (AppendRejectedError) rather than guess.
        self._imap_client = imap_client
        self._identity = identity
        # Shared across every Drafts mailbox instance the account constructs (see
        # PosternAccount._draft_revisions); a fresh local set when unset (e.g. a
        # test constructing PosternMailbox directly) so the code path is uniform.
        self._draft_revisions: set = draft_revisions if draft_revisions is not None else set()
        self._meter = meter or Meter(False)
        self._direction = direction
        self._to = to
        self._from = from_addr
        self._viewer = viewer
        self._special_use = list(special_use or [])
        self._list_view = list_view
        self._empty = empty
        self._page_size = page_size
        self._window = window
        self._poll_seconds = poll_seconds
        self._uidvalidity = uidvalidity
        self._writable_signal = writable_signal
        self._seen_writable = seen_writable
        self._delete_writable = delete_writable
        self._flags_writable = flags_writable
        self._mailbox_filter = mailbox_filter
        self._is_drafts = mailbox_filter == "drafts"
        self._summaries: List[MessageSummary] = []
        self._loaded = False
        self._newest_uid = 0
        self._newest_id: Optional[str] = None
        self._listeners: list = []
        self._poll: Optional["LoopingCall"] = None
        self._clock: Optional[Any] = clock

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        if self._empty:
            self._summaries = []
            self._loaded = True
            return
        try:
            with self._meter.timed(
                "cold_sync",
                direction=self._mailbox_filter or self._direction or "all",
            ) as span:
                if self._is_drafts:
                    items = self._load_drafts()
                    pages = 1
                else:
                    items, pages = self._load_messages()
                items.sort(key=lambda s: s.uid)
                n = len(items)
                self._newest_uid = items[-1].uid if items else 0
                self._newest_id = items[-1].message_id if items else None
                if self._window and n > self._window:
                    self._summaries = items[n - self._window :]
                else:
                    self._summaries = items
                self._loaded = True
                span.set(
                    pages=pages,
                    collected=n,
                    presented=len(self._summaries),
                    window=self._window,
                    windowed=bool(self._window and n > self._window),
                    newest_uid=self._newest_uid,
                )
        except PosternError as exc:
            if self._is_drafts and exc.status in (401, 403):
                self._summaries = []
                self._loaded = True
                return
            raise MailboxLoadError(
                "mailbox temporarily unavailable; please retry"
            ) from exc

    def _load_drafts(self) -> List[MessageSummary]:
        if self._imap_client is None or not self._identity:
            # No IMAP-service seam configured / no derivable identity: fail closed
            # to an empty Drafts view rather than 401/403-ing the whole SELECT.
            return []
        return [d.as_summary() for d in self._imap_client.list_imap_drafts(self._identity)]

    def _load_messages(self) -> tuple[List[MessageSummary], int]:
        items: List[MessageSummary] = []
        cursor: Optional[str] = None
        pages = 0
        while True:
            page = self._client.list_messages(
                direction=self._direction,
                to=self._to,
                from_addr=self._from,
                mailbox=self._mailbox_filter,
                limit=self._page_size,
                cursor=cursor,
            )
            items.extend(page.items)
            pages += 1
            cursor = page.cursor
            if not cursor:
                break
        return items, pages

    def _refresh(self) -> int:
        """Append any new arrivals to the snapshot; return how many were added."""
        if self._empty or not self._loaded or self._is_drafts:
            return 0
        boundary = self._newest_id
        max_uid = self._newest_uid
        new_items: List[MessageSummary] = []
        cursor: Optional[str] = None
        found = False
        while True:
            page = self._client.list_messages(
                direction=self._direction,
                to=self._to,
                from_addr=self._from,
                mailbox=self._mailbox_filter,
                limit=self._page_size,
                cursor=cursor,
            )
            for s in page.items:
                if boundary is not None and s.message_id == boundary:
                    found = True
                    break
                if s.uid > max_uid:
                    new_items.append(s)
            if found or not page.cursor:
                break
            cursor = page.cursor
        if boundary is not None and not found and not new_items:
            return 0
        if not new_items:
            return 0
        new_items.sort(key=lambda s: s.uid)
        self._summaries.extend(new_items)
        self._summaries.sort(key=lambda s: s.uid)
        self._newest_uid = self._summaries[-1].uid
        self._newest_id = self._summaries[-1].message_id
        return len(new_items)


    # --- IMailbox: identity / status ---

    def getUIDValidity(self) -> int:
        return self._uidvalidity

    def getUIDNext(self) -> int:
        self._ensure_loaded()
        return self._newest_uid + 1

    def getUID(self, message: int) -> int:
        self._ensure_loaded()
        return self._summaries[message - 1].uid

    def getMessageCount(self) -> int:
        self._ensure_loaded()
        return len(self._summaries)

    def getRecentCount(self) -> int:
        return 0

    def getUnseenCount(self) -> int:
        self._ensure_loaded()
        return sum(1 for s in self._summaries if not s.seen)

    def firstUnseen(self) -> int:
        self._ensure_loaded()
        for i, s in enumerate(self._summaries):
            if not s.seen:
                return i + 1
        return 0

    def getPermanentFlags(self) -> List[str]:
        if self._writable_signal:
            return ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft", "\\*"]
        flags: List[str] = []
        if self._seen_writable:
            flags.append("\\Seen")
        if self._flags_writable:
            flags.extend(["\\Flagged", "\\Answered"])
        if self._delete_writable:
            flags.append("\\Deleted")
        if self._is_drafts:
            flags.append("\\Draft")
            if self._delete_writable and "\\Deleted" not in flags:
                flags.append("\\Deleted")
        return flags

    def isWriteable(self) -> bool:
        return (
            self._writable_signal
            or self._seen_writable
            or self._flags_writable
            or (self._delete_writable and (not self._empty or self._is_drafts))
            or self._is_drafts
        )

    def getHierarchicalDelimiter(self) -> str:
        return "/"

    def getFlags(self) -> List[str]:
        if self._list_view:
            return self._special_use + ["\\HasNoChildren"]
        if self._writable_signal:
            return ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft"]
        if self._is_drafts:
            return ["\\Draft", "\\Seen", "\\Deleted"]
        flags = ["\\Seen", "Trusted", "Untrusted", "Inbound", "Outbound"]
        if self._flags_writable:
            flags[1:1] = ["\\Flagged", "\\Answered"]
        if self._delete_writable:
            flags.insert(1, "\\Deleted")
        return flags

    def getDefaultFlags(self) -> List[str]:
        return ["\\Seen"]

    def requestStatus(self, names):
        self._ensure_loaded()
        data = {
            "MESSAGES": len(self._summaries),
            "RECENT": 0,
            "UIDNEXT": self._newest_uid + 1,
            "UIDVALIDITY": self._uidvalidity,
            "UNSEEN": sum(1 for s in self._summaries if not s.seen),
        }
        return {name: data[name] for name in names if name in data}

    def _wrap(self, seq: int):
        idx0 = seq - 1
        summary = self._summaries[idx0]
        mid = summary.message_id

        def fetch_attachment(index: int, message_id: str = mid) -> bytes:
            return self._client.get_attachment(message_id, index).body

        def hydrate():
            if self._is_drafts:
                if self._imap_client is None or not self._identity:
                    return None
                draft = self._imap_client.get_imap_draft(self._identity, mid)
                if draft is None:
                    return None
                return Message(
                    message_id=draft.id,
                    direction="outbound",
                    thread_id=draft.thread_id or draft.id,
                    from_addr=draft.identity,
                    to_addr=draft.to_addr or "",
                    subject=draft.subject or "",
                    date=draft.updated_at or draft.created_at,
                    in_reply_to=draft.in_reply_to,
                    body_text=draft.body_text or "",
                    body_html=draft.body_html,
                    trusted=True,
                    received_at=draft.updated_at or draft.created_at,
                    attachments=[],
                )
            return self._client.get_message(mid)

        return seq, PosternIMAPMessage(
            summary,
            uid=summary.uid,
            seq=seq,
            hydrate=hydrate,
            fetch_attachment=fetch_attachment,
            meter=self._meter,
        )

    def fetch(self, messages, uid):
        return list(self._iter_fetch(messages, uid))

    def _iter_fetch(self, messages, uid):
        self._ensure_loaded()
        n = len(self._summaries)
        if n == 0:
            return
        if uid:
            by_uid = {s.uid: i + 1 for i, s in enumerate(self._summaries)}
            messages.last = self._summaries[-1].uid
            for num in messages:
                if num is None:
                    continue
                seq = by_uid.get(num)
                if seq is None:
                    continue
                yield self._wrap(seq)
        else:
            messages.last = n
            for num in messages:
                if num is None or num < 1 or num > n:
                    continue
                yield self._wrap(num)

    def search_substr(self, field: str, term: str, uid: bool) -> List[int]:
        self._ensure_loaded()
        if not self._summaries or self._is_drafts:
            # Drafts: no search API; fall through empty (manual path unused for drafts).
            return []
        by_uid = {s.uid: i + 1 for i, s in enumerate(self._summaries)}
        out: List[int] = []
        cursor: Optional[str] = None
        pages = 0
        max_pages = self._search_max_pages()
        while True:
            page = self._client.search_page(
                term,
                mode="substr",
                field=field,
                direction=self._direction,
                to=self._to,
                mailbox=self._mailbox_filter,
                cursor=cursor,
                limit=_SEARCH_PAGE_LIMIT,
            )
            for h in page.items:
                seq = by_uid.get(h.uid)
                if seq is None:
                    continue
                out.append(h.uid if uid else seq)
            cursor = page.cursor
            pages += 1
            if not cursor:
                break
            if pages >= max_pages:
                from twisted.python import log

                log.msg(
                    "postern-imap: SEARCH pagination hit the %d-page cap "
                    "(field=%s, direction=%s); the reply may be incomplete -- narrow "
                    "the query or raise POSTERN_IMAP_WINDOW."
                    % (max_pages, field, self._direction)
                )
                break
        out.sort()
        return out

    def _search_max_pages(self) -> int:
        if self._window and self._window > 0:
            return max(2, (self._window + _SEARCH_PAGE_LIMIT - 1) // _SEARCH_PAGE_LIMIT + 1)
        return _SEARCH_MAX_PAGES_UNBOUNDED

    def store(self, messages, flags, mode, uid):
        """Persist \\Seen / \\Flagged / \\Answered and session-local \\Deleted."""
        self._ensure_loaded()
        if self._empty:
            raise ReadOnlyError("this folder stores no messages; flags are not settable")
        if not (
            self._seen_writable or self._delete_writable or self._flags_writable or self._is_drafts
        ):
            raise ReadOnlyError("postern-imap is read-only; flags are not stored")

        norm = {str(f).lower() for f in (flags or [])}
        allowed = set()
        if self._seen_writable:
            allowed.add("\\seen")
        if self._flags_writable:
            allowed.update({"\\flagged", "\\answered"})
        if self._delete_writable or self._is_drafts:
            allowed.add("\\deleted")
        if self._is_drafts:
            allowed.add("\\draft")  # informational; always present on drafts
        if norm - allowed:
            raise ReadOnlyError(
                "postern-imap only persists allowed permanent flags; other flags are read-only"
            )

        wants_seen = "\\seen" in norm
        wants_deleted = "\\deleted" in norm
        wants_flagged = "\\flagged" in norm
        wants_answered = "\\answered" in norm

        if uid:
            by_uid = {s.uid: i + 1 for i, s in enumerate(self._summaries)}
            messages.last = self._summaries[-1].uid if self._summaries else 0
            seqs = [by_uid[num] for num in messages if num is not None and num in by_uid]
        else:
            n = len(self._summaries)
            messages.last = n
            seqs = [num for num in messages if num is not None and 1 <= num <= n]
        if not seqs:
            return {}

        def apply_bool(current: bool, wants: bool) -> bool:
            if mode == 0:
                return wants
            if mode == 1:
                return True if wants else current
            return False if wants else current

        seen_targets: dict[int, bool] = {}
        deleted_targets: dict[int, bool] = {}
        flagged_targets: dict[int, bool] = {}
        answered_targets: dict[int, bool] = {}
        for seq in seqs:
            summary = self._summaries[seq - 1]
            if self._seen_writable:
                seen_targets[seq] = apply_bool(summary.seen, wants_seen)
            if self._delete_writable or self._is_drafts:
                deleted_targets[seq] = apply_bool(summary.deleted, wants_deleted)
            if self._flags_writable:
                if mode == 0 or "\\flagged" in norm:
                    flagged_targets[seq] = apply_bool(summary.flagged, wants_flagged)
                if mode == 0 or "\\answered" in norm:
                    answered_targets[seq] = apply_bool(summary.answered, wants_answered)

        to_read = [
            self._summaries[s - 1].message_id
            for s, t in seen_targets.items()
            if t and not self._summaries[s - 1].seen
        ]
        to_unread = [
            self._summaries[s - 1].message_id
            for s, t in seen_targets.items()
            if not t and self._summaries[s - 1].seen
        ]
        if to_read:
            self._client.set_seen(to_read, True, for_addr=self._viewer)
        if to_unread:
            self._client.set_seen(to_unread, False, for_addr=self._viewer)
        for seq, target in seen_targets.items():
            self._summaries[seq - 1].seen = target
        for seq, target in deleted_targets.items():
            self._summaries[seq - 1].deleted = target

        # Batch flag writes by target state.
        for want_flagged in (True, False):
            ids = [
                self._summaries[s - 1].message_id
                for s, t in flagged_targets.items()
                if t is want_flagged and self._summaries[s - 1].flagged is not want_flagged
            ]
            if ids:
                self._client.set_flags(ids, flagged=want_flagged)
                for s, t in flagged_targets.items():
                    if t is want_flagged:
                        self._summaries[s - 1].flagged = want_flagged
        for want_answered in (True, False):
            ids = [
                self._summaries[s - 1].message_id
                for s, t in answered_targets.items()
                if t is want_answered and self._summaries[s - 1].answered is not want_answered
            ]
            if ids:
                self._client.set_flags(ids, answered=want_answered)
                for s, t in answered_targets.items():
                    if t is want_answered:
                        self._summaries[s - 1].answered = want_answered

        return {seq: list(self._wrap(seq)[1].getFlags()) for seq in seqs}

    def addMessage(self, message, flags=(), date=None):
        """APPEND persist-or-refuse (#352 section 3.2). Never silent OK+drop."""
        from twisted.internet import defer

        if self._empty:
            return defer.fail(
                AppendRejectedError(
                    "this folder does not store messages; APPEND is not supported"
                )
            )
        try:
            raw = _read_message_bytes(message)
            parsed = _parse_rfc822(raw)
            if self._is_drafts:
                self._append_draft(parsed)
            elif self._mailbox_filter in ("trash", "junk", "archive"):
                self._append_placement(parsed, raw, self._mailbox_filter)
            elif self._direction == "outbound" and self._mailbox_filter is None:
                self._append_sent(parsed, raw)
            else:
                # INBOX / All: refuse -- no honest home for a genuine new APPEND.
                return defer.fail(
                    AppendRejectedError(
                        "APPEND into this folder is not supported; "
                        "use Sent for outbound copies or a durable folder"
                    )
                )
        except AppendRejectedError as exc:
            return defer.fail(exc)
        except PosternError as exc:
            return defer.fail(
                AppendRejectedError(f"APPEND failed: {exc}")
            )
        except Exception as exc:
            return defer.fail(AppendRejectedError(f"APPEND failed: {exc}"))
        return defer.succeed(None)

    def _append_draft(self, parsed: PyMessage) -> None:
        if self._imap_client is None or not self._identity:
            raise AppendRejectedError(
                "Drafts APPEND requires POSTERN_API_TOKEN_IMAP and a bound identity"
            )
        fields = {
            "to": _header_addrs(parsed, "To") or None,
            "cc": _header_addrs(parsed, "Cc") or None,
            "bcc": _header_addrs(parsed, "Bcc") or None,
            "subject": (parsed.get("Subject") or "") or None,
            "bodyText": _body_text(parsed) or None,
            "inReplyTo": _message_id_header(parsed) and (parsed.get("In-Reply-To") or None),
        }
        # Normalize empty strings to None for the API.
        clean = {k: (v if v else None) for k, v in fields.items()}
        try:
            revision = self._find_draft_revision_target(clean)
            if revision is not None:
                self._imap_client.update_imap_draft(
                    self._identity,
                    revision.id,
                    clean,
                    updated_at=revision.updated_at or None,
                )
                # #352 §2.4.1: this draft id's OLD (pre-revision) uid, still sitting
                # in some session's live snapshot marked \Deleted, must NOT be
                # hard-deleted when that session's EXPUNGE reaches it -- the PUT
                # above already rewrote the SAME row under a new, higher uid.
                self._draft_revisions.add(revision.id)
            else:
                self._imap_client.create_imap_draft(self._identity, clean)
        except PosternError as exc:
            if exc.status in (401, 403):
                raise AppendRejectedError(
                    "Drafts APPEND requires a bound identity (POSTERN_API_TOKEN_IMAP scope)"
                ) from exc
            raise

    def _find_draft_revision_target(self, fields: dict) -> Optional[Draft]:
        """Contract §2.4.1: an autosave revision of an existing draft mints a NEW,
        higher UID for the SAME draft id instead of piling up a second draft.

        do_APPEND always selects a fresh, unloaded PosternMailbox for the target
        folder (see server.py), so there is no session-local \\Deleted snapshot to
        correlate against at this point -- match against SERVER-side truth instead:
        the most recent draft for this identity with the same (to, subject), within
        a generous recency window. Mirrors the fallback-matcher pattern
        _append_sent already uses for Sent (same idea, applied to Drafts).
        """
        to = fields.get("to") or ""
        subject = fields.get("subject") or ""
        if not to and not subject:
            return None
        if self._imap_client is None or not self._identity:
            return None
        try:
            drafts = self._imap_client.list_imap_drafts(self._identity)
        except PosternError:
            return None
        now = datetime.now(timezone.utc)
        best: Optional[Tuple[datetime, Draft]] = None
        for d in drafts:
            if _bare_addr(d.to_addr or "") != _bare_addr(to):
                continue
            if _norm_subject(d.subject or "") != _norm_subject(subject):
                continue
            src = d.updated_at or d.created_at
            try:
                ts = datetime.fromisoformat(src.replace("Z", "+00:00"))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if abs(now - ts) > _DRAFT_REVISION_WINDOW:
                continue
            if best is None or ts > best[0]:
                best = (ts, d)
        return best[1] if best else None

    def _append_placement(self, parsed: PyMessage, raw: bytes, mailbox: str) -> None:
        mid = _message_id_header(parsed)
        if mid:
            existing = self._client.get_message(mid)
            if existing is not None:
                self._client.move_messages([mid], mailbox)
                return
        # #352 core unblocker 3: a genuine new Trash/Junk/Archive APPEND (no
        # matching existing message) is now PERSISTED via the IMAP-service import
        # seam instead of refused -- never silently dropped.
        self._import_or_reject(raw, mailbox)

    def _append_sent(self, parsed: PyMessage, raw: bytes) -> None:
        """Sent APPEND: fallback matcher (#352 section 3.2). Hit -> OK; miss ->
        persist via the IMAP-service import seam (core unblocker 3), never refuse.

        The submission path already stored outbound copies with a core-minted
        Message-ID, so a client APPEND carries a different id. Matching recent
        outbound by from+to+subject within a short window avoids the copy-failed
        regression without a spurious second row on a genuine hit.
        """
        mid = _message_id_header(parsed)
        if mid:
            existing = self._client.get_message(mid)
            if existing is not None and existing.direction == "outbound":
                return
        from_addr = _bare_addr(_header_addrs(parsed, "From"))
        to_addr = _bare_addr(_header_addrs(parsed, "To"))
        subject = _norm_subject(parsed.get("Subject") or "")
        now = datetime.now(timezone.utc)
        date_hdr = parsed.get("Date")
        try:
            msg_dt = email.utils.parsedate_to_datetime(date_hdr) if date_hdr else now
            if msg_dt.tzinfo is None:
                msg_dt = msg_dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError, IndexError):
            msg_dt = now
        page = self._client.list_messages(direction="outbound", limit=50)
        for s in page.items:
            if _bare_addr(s.from_addr) != from_addr:
                continue
            if _bare_addr(s.to_addr) != to_addr:
                continue
            if _norm_subject(s.subject) != subject:
                continue
            # received_at / date within window of the APPEND's Date (or now).
            src = s.received_at or s.date
            try:
                stored_dt = datetime.fromisoformat(src.replace("Z", "+00:00"))
                if stored_dt.tzinfo is None:
                    stored_dt = stored_dt.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if abs(stored_dt - msg_dt) <= _SENT_MATCH_WINDOW or abs(stored_dt - now) <= _SENT_MATCH_WINDOW:
                return
        self._import_or_reject(raw, "sent")

    def _import_or_reject(self, raw: bytes, folder: str) -> None:
        """POST /api/imap/import (#352 core unblocker 3), or an honest refusal.

        Fails closed -- never silently drops -- when the IMAP-service seam is not
        configured or no identity could be derived; a live 401/403 from the worker
        (token present but lacking `imap` scope) maps to the same clean refusal.
        """
        if self._imap_client is None or not self._identity:
            raise AppendRejectedError(
                "APPEND of a new message into this folder requires "
                "POSTERN_API_TOKEN_IMAP and a bound identity; refusing rather "
                "than silently discarding"
            )
        try:
            self._imap_client.import_message(self._identity, folder, raw)
        except PosternError as exc:
            if exc.status in (401, 403):
                raise AppendRejectedError(
                    "APPEND import requires the POSTERN_API_TOKEN_IMAP scope"
                ) from exc
            raise AppendRejectedError(f"APPEND import failed: {exc}") from exc

    def expunge(self):
        """Hard-delete messages marked \\Deleted; return sequence numbers high-to-low."""
        self._ensure_loaded()
        if self._empty:
            return []
        if not self._delete_writable and not self._is_drafts:
            return []

        remove_at: List[int] = []
        for i, summary in enumerate(self._summaries):
            if not summary.deleted:
                continue
            try:
                if self._is_drafts:
                    if summary.message_id in self._draft_revisions:
                        # #352 §2.4.1: already superseded in place by an autosave
                        # PUT (see _append_draft) -- the row is NOT gone, it was
                        # rewritten under a new uid; deleting it now would destroy
                        # the just-saved revision. Just drop the stale local row.
                        self._draft_revisions.discard(summary.message_id)
                    elif self._imap_client is not None and self._identity:
                        self._imap_client.delete_imap_draft(self._identity, summary.message_id)
                    else:
                        raise ReadOnlyError(
                            "EXPUNGE of a draft requires POSTERN_API_TOKEN_IMAP "
                            "and a bound identity"
                        )
                else:
                    delete_client = self._delete_client or self._client
                    delete_client.delete_message(summary.message_id)
            except PosternError as exc:
                if exc.status in (401, 403):
                    raise ReadOnlyError(
                        "EXPUNGE requires POSTERN_API_TOKEN_DELETE (a both-scoped member)",
                    ) from exc
                raise ReadOnlyError(f"EXPUNGE failed: {exc}") from exc
            remove_at.append(i)

        expunged_seqs = [i + 1 for i in reversed(remove_at)]
        for i in reversed(remove_at):
            del self._summaries[i]
        return expunged_seqs

    def _matches_own_filter(self, mailbox_value: Optional[str]) -> bool:
        """Would a row with this `mailbox` placement still appear in THIS view?

        Mirrors the server-side predicate list_messages(mailbox=self._mailbox_filter)
        applies: "all" sees every placement; trash/junk/archive see only their own
        exact placement; the direction-default views (INBOX/Sent, mailbox_filter is
        None) see only unplaced (mailbox IS NULL) rows. Used after a soft-move to
        decide whether the row genuinely LEFT this session's snapshot (#352 review:
        COPY/MOVE from All to Trash must not strip a row All still owns).
        """
        if self._mailbox_filter == "all":
            return True
        if self._mailbox_filter in ("trash", "junk", "archive"):
            return mailbox_value == self._mailbox_filter
        return mailbox_value is None

    def soft_move_fetched_messages(
        self,
        fetched,
        mailbox: Optional[str],
        *,
        required_direction: Optional[str] = None,
    ) -> List[int]:
        """Soft-move fetched messages via POST /api/messages/move (#352).

        mailbox is archive|trash|junk, or None to restore to the direction-default
        view. `required_direction` (#352 core unblocker 5) rejects a restore whose
        source messages do not match the destination's direction (e.g. an outbound
        Sent copy restored to INBOX, or an inbound message restored to Sent) --
        checked BEFORE the move so a mixed batch fails atomically, never partially.

        Returns the 1-based sequence numbers (descending) that were actually
        REMOVED from this view's live snapshot -- i.e. rows that no longer match
        this mailbox's own filter after the move (see _matches_own_filter). The
        caller (server._cbSoftMove) emits an untagged EXPUNGE for exactly these,
        for BOTH COPY and MOVE: this mailbox mutates the SAME exclusive placement
        either way (there is no real dual-membership COPY here), so a client that
        is not told via EXPUNGE would hold a stale, now-wrong sequence mapping
        regardless of which verb it used (the bug locked in by the old
        test_copy_emits_no_untagged_expunge).
        """
        self._ensure_loaded()
        if self._empty or self._is_drafts:
            raise ReadOnlyError("move is not enabled on this mailbox")
        items = [(seq, msg._summary) for seq, msg in fetched]
        if not items:
            return []
        if required_direction is not None:
            bad = [s.message_id for _seq, s in items if s.direction != required_direction]
            if bad:
                raise ReadOnlyError(
                    f"cannot restore {required_direction!r}-incompatible message(s) "
                    "to this folder"
                )
        ids = [s.message_id for _seq, s in items]
        try:
            self._client.move_messages(ids, mailbox)
        except PosternError as exc:
            raise ReadOnlyError(f"move failed: {exc}") from exc
        moved_ids = set(ids)
        remove_at: List[int] = []
        for i, s in enumerate(self._summaries):
            if s.message_id not in moved_ids:
                continue
            s.mailbox = mailbox
            if not self._matches_own_filter(mailbox):
                remove_at.append(i)
        removed_seqs = sorted((i + 1 for i in remove_at), reverse=True)
        for i in reversed(remove_at):
            del self._summaries[i]
        return removed_seqs

    def delete_fetched_messages(self, fetched) -> List[int]:
        """Back-compat alias: soft-move to trash (prefer soft_move_fetched_messages)."""
        return self.soft_move_fetched_messages(fetched, "trash")

    def destroy(self):
        raise ReadOnlyError("postern-imap is read-only; mailboxes cannot be destroyed")


    # --- IMailbox: listeners (live refresh via a poll while selected) ---

    def addListener(self, listener):
        # Twisted registers the IMAP4Server protocol as a listener on SELECT; we
        # push untagged EXISTS to it from the poll so new mail surfaces mid-session.
        self._listeners.append(listener)
        self._maybe_start_poll()
        return None

    def removeListener(self, listener):
        try:
            self._listeners.remove(listener)
        except ValueError:
            pass
        if not self._listeners:
            self._stop_poll()
        return None

    def poll_now(self) -> int:
        """Refresh from the store now and push an untagged EXISTS if new mail arrived.

        Called on NOOP / CHECK (see server.PosternIMAP4Server.do_NOOP): RFC 3501 6.1.2
        makes NOOP a client's explicit poll for status, so new mail must surface on it
        immediately, without waiting for the timed poll and EVEN when the timed poll is
        disabled (POSTERN_IMAP_POLL_SECONDS=0). Same append-only, body-free refresh the
        timed poll uses; a no-op before the snapshot is loaded or on an empty mailbox.
        New arrivals grow EXISTS at the high end; existing sequence numbers and UIDs are
        untouched (RFC 3501: no renumbering)."""
        if not self._loaded or self._empty:
            return 0
        try:
            added = self._refresh()
        except Exception:
            from twisted.python import log

            log.err(None, "postern-imap: NOOP refresh failed")
            return 0
        if added:
            count = len(self._summaries)
            for listener in list(self._listeners):
                listener.newMessages(count, None)
        return added

    def _maybe_start_poll(self) -> None:
        if (
            self._poll is not None
            or self._empty
            or self._poll_seconds <= 0
            or not self._listeners
        ):
            return
        from twisted.internet.task import LoopingCall

        self._poll = LoopingCall(self._poll_tick)
        if self._clock is not None:
            self._poll.clock = self._clock
        # now=False: do not poll immediately (SELECT already loaded the snapshot).
        self._poll.start(self._poll_seconds, now=False).addErrback(self._poll_crashed)

    def _stop_poll(self) -> None:
        if self._poll is not None and self._poll.running:
            self._poll.stop()
        self._poll = None

    def _poll_tick(self) -> None:
        # IMAP4Server.connectionLost does NOT call removeListener on an abrupt
        # client disconnect (only CLOSE / SELECT-away / idle-timeout do), so the
        # poll prunes listeners whose transport is gone and stops itself when none
        # remain. That bounds any orphaned poll to a single interval and self-heals.
        self._listeners = [l for l in self._listeners if _listener_alive(l)]
        if not self._listeners:
            self._stop_poll()
            return
        # Blocking urllib in the reactor thread, matching fetch's I/O model for this
        # stage (see config POSTERN_IMAP_POLL_SECONDS). Errors are swallowed so a
        # transient store blip never tears down the LoopingCall or the session.
        try:
            # Time the blocking _refresh: this runs urllib in the reactor thread, so
            # its duration IS the per-tick reactor stall (validates the "deferToThread
            # if measurement shows reactor stalls" note in config).
            with self._meter.timed("poll_refresh", direction=self._direction or "all") as span:
                added = self._refresh()
                span.set(added=added, listeners=len(self._listeners))
        except Exception:
            from twisted.python import log

            log.err(None, "postern-imap: mailbox poll failed")
            return
        if not added:
            return
        from twisted.python import log

        log.msg(
            "postern-imap: %d new message(s); pushing EXISTS to %d listener(s)"
            % (added, len(self._listeners))
        )
        count = len(self._summaries)
        for listener in list(self._listeners):
            listener.newMessages(count, None)

    def _poll_crashed(self, failure) -> None:
        from twisted.python import log

        log.err(failure, "postern-imap: mailbox poll loop stopped")
        self._poll = None


def _listener_alive(listener) -> bool:
    """True unless we can prove the listener's connection is gone.

    A real IMAP4Server carries a transport whose `connected` flag drops to false
    after the socket closes; a test listener without a transport is assumed alive
    (we cannot tell, so we never prune it).
    """
    if not hasattr(listener, "transport"):
        return True
    transport = listener.transport
    if transport is None:
        return False
    return bool(getattr(transport, "connected", True))

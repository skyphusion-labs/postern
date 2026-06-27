"""Twisted IMailbox over the Postern read API (read-only, v1).

A SELECT snapshots the mailbox: we pull the message summaries from the API
(paging through cursors, body-free), order them oldest-first (IMAP sequence
numbers are 1-based and ascending by arrival), and present a window of them.
fetch() wraps each in a PosternIMAPMessage that hydrates its body ONLY on demand
(#102): ENVELOPE / FLAGS / INTERNALDATE / header-field scans are served straight
from the list summary, so a "FETCH 1:* ENVELOPE" over a large mailbox costs zero
per-message body GETs instead of one each.

Windowing (#102 Stage 1): INBOX/Sent are capped to the most-recent W messages
(POSTERN_IMAP_WINDOW); the All folder is unbounded for archival access. The window
is a SELECT-time floor: during a session it only GROWS at the high end (new mail
appends; EXISTS rises), it never slides, so existing sequence numbers and UIDs stay
stable mid-session (the IMAP invariant). Older-than-window mail is reachable via
All or by raising the window; IMAP cannot grow a folder downward mid-session, so
there is no in-folder scroll-back, by design.

Live refresh (#102 Stage 1): while selected, a poll (POSTERN_IMAP_POLL_SECONDS)
re-reads the recent end of the store and pushes an untagged EXISTS to listeners
when new mail arrives, so NOOP/poll clients AND IDLE both see new mail mid-session.
The poll is summary-only (no bodies) and reads only as far back as the previous
newest message, so its cost tracks new-mail volume, not mailbox size. D1 is the
source of truth for the fresh window; nothing here caches or gates arrival.

Read-only is deliberate for v1 (#12): humans read here and *send* through the
structured API, not by IMAP APPEND. Write paths raise so a client gets a clean
"read-only" rather than silent data loss.

UID model (v1 limitation, documented): UID == the message's GLOBAL arrival ordinal
(its 1-based position in the full oldest-first store), and UIDVALIDITY is constant.
Because the store is append-only, a message keeps its ordinal across reconnects, so
UIDs are stable session-to-session and a client's cache survives -- which a
window-relative UID would NOT be (it would shift as the window moves, forcing a
UIDVALIDITY bump and full re-sync every session). The honest caveat: this holds
only while the store is append-only; deletion/reordering would shift ordinals. A
truly durable, store-assigned UID (stable under deletion, identical across proxy
processes) is filed as #103; until it lands this ordinal is the correct interim.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, List, Optional

from zope.interface import implementer

from twisted.mail import imap4

from .client import MessageSummary, PosternClient
from .message import PosternIMAPMessage

if TYPE_CHECKING:  # annotation only; the runtime import stays lazy (see _maybe_start_poll)
    from twisted.internet.task import LoopingCall

# Stable across the life of a proxy process. Append-only store + global-ordinal
# UIDs means a message's UID does not change across snapshots, so we never need to
# bump this; documented as a v1 simplification (and see #103 for the durable fix).
_UID_VALIDITY = 1


class ReadOnlyError(imap4.MailboxException):
    """Raised for any write operation; the proxy is a read-only view in v1."""


@implementer(imap4.IMailbox)
class PosternMailbox:
    """A read-only IMAP view of the Postern mailbox, scoped by an optional filter.

    `direction` (None | "inbound" | "outbound") selects which slice the mailbox
    shows, so INBOX, Sent, and All are direction-filtered views over one store.

    `special_use` are the RFC 6154 attributes for this mailbox (e.g. ["\\Sent"]).
    Twisted reads getFlags() off the listMailboxes() instance for the LIST mailbox
    attributes, but off the select() instance for the SELECT message-FLAGS line, so
    `list_view` disambiguates: a list-view box reports its special-use + structural
    attributes; a selected box reports the message flags. The two instances never
    cross, so one getFlags() correctly serves both call sites.

    `empty` marks a present-but-empty placeholder (Drafts/Trash/Junk/Archive):
    selectable with zero messages and NO API hit, so a client (Thunderbird) maps
    its special-use folders to ours and never tries to CREATE them.

    `window` caps the snapshot to the most-recent N messages (0 = unlimited).
    `poll_seconds` enables a live-refresh poll while selected (0 = disabled).
    """

    def __init__(
        self,
        client: PosternClient,
        *,
        direction: Optional[str] = None,
        special_use: Optional[List[str]] = None,
        list_view: bool = False,
        empty: bool = False,
        page_size: int = 200,
        window: int = 0,
        poll_seconds: int = 0,
        clock=None,
    ) -> None:
        self._client = client
        self._direction = direction
        self._special_use = list(special_use or [])
        self._list_view = list_view
        self._empty = empty
        self._page_size = page_size
        self._window = window
        self._poll_seconds = poll_seconds
        self._summaries: List[MessageSummary] = []
        self._loaded = False
        # _base = number of older messages hidden below the window at SELECT time,
        # so UID == _base + sequenceNumber == the message's global arrival ordinal.
        self._base = 0
        # _n = total messages in the store for this view (grows as the poll appends
        # new arrivals). UIDNEXT == _n + 1 (the next arrival's global ordinal).
        self._n = 0
        # message_id of the newest message we have seen, used as the poll boundary.
        self._newest_id: Optional[str] = None
        self._listeners: list = []
        self._poll: Optional["LoopingCall"] = None
        # Injectable for tests (twisted.internet.task.Clock); None uses the reactor.
        self._clock: Optional[Any] = clock

    # --- snapshot ---

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        if self._empty:
            # Placeholder folder (e.g. Drafts/Trash): always empty, never hit the API.
            self._summaries = []
            self._loaded = True
            return
        items: List[MessageSummary] = []
        cursor: Optional[str] = None
        while True:
            page = self._client.list_messages(
                direction=self._direction, limit=self._page_size, cursor=cursor
            )
            items.extend(page.items)
            cursor = page.cursor
            if not cursor:
                break
        # The API returns newest-first; IMAP sequence numbers ascend with arrival,
        # so reverse to oldest-first. all[i] is global ordinal i+1.
        items.reverse()
        n = len(items)
        self._n = n
        self._newest_id = items[-1].message_id if items else None
        if self._window and n > self._window:
            # Show only the most-recent window; the hidden older count is the base
            # so UID stays the GLOBAL ordinal, not a window-relative position.
            self._base = n - self._window
            self._summaries = items[self._base:]
        else:
            self._base = 0
            self._summaries = items
        self._loaded = True

    def _refresh(self) -> int:
        """Append any new arrivals to the snapshot; return how many were added.

        Reads the store newest-first only as far back as the message we already
        treat as newest (the poll boundary), so the work tracks new-mail volume,
        not mailbox size, and never re-fetches bodies. New arrivals append to the
        high end (sequence/UID of existing messages are untouched). If the boundary
        message is not found (deletion/reorder -- not expected in an append-only
        store), we skip the append rather than risk re-adding the whole mailbox; the
        next SELECT re-snapshots cleanly.
        """
        if self._empty or not self._loaded:
            return 0
        boundary = self._newest_id
        new_items: List[MessageSummary] = []
        cursor: Optional[str] = None
        found = False
        while True:
            page = self._client.list_messages(
                direction=self._direction, limit=self._page_size, cursor=cursor
            )
            for item in page.items:  # newest-first
                if boundary is not None and item.message_id == boundary:
                    found = True
                    break
                new_items.append(item)
            cursor = page.cursor
            if found or not cursor:
                break
        if boundary is not None and not found:
            # Inconsistent view (boundary gone); do not blindly append. Stay safe.
            return 0
        if not new_items:
            return 0
        new_items.reverse()  # newest-first -> oldest-first (arrival order)
        self._summaries.extend(new_items)
        self._n += len(new_items)
        self._newest_id = new_items[-1].message_id
        return len(new_items)

    # --- IMailbox: metadata ---

    def getUIDValidity(self) -> int:
        return _UID_VALIDITY

    def getUIDNext(self) -> int:
        self._ensure_loaded()
        return self._n + 1

    def getUID(self, message: int) -> int:
        # `message` is a 1-based sequence number; UID is its global arrival ordinal.
        return self._base + message

    def getMessageCount(self) -> int:
        self._ensure_loaded()
        return len(self._summaries)

    def getRecentCount(self) -> int:
        return 0  # we do not track \\Recent in a read-only view

    def getUnseenCount(self) -> int:
        return 0  # everything is presented \\Seen (already processed)

    def isWriteable(self) -> bool:
        return False

    def getHierarchicalDelimiter(self) -> str:
        return "/"

    def getFlags(self) -> List[str]:
        # In a LIST (list_view), report the RFC 6154 special-use + structural
        # attributes so a client auto-maps its folders. In a SELECT, report the
        # message flags settable in this (read-only) mailbox. Twisted calls this on
        # distinct instances for the two cases (see the class docstring).
        if self._list_view:
            return self._special_use + ["\\HasNoChildren"]
        return ["\\Seen"]

    def getDefaultFlags(self) -> List[str]:
        return ["\\Seen"]

    def requestStatus(self, names):
        self._ensure_loaded()
        data = {
            "MESSAGES": len(self._summaries),
            "RECENT": 0,
            "UIDNEXT": self._n + 1,
            "UIDVALIDITY": _UID_VALIDITY,
            "UNSEEN": 0,
        }
        return {name: data[name] for name in names if name in data}

    # --- IMailbox: read ---

    def _wrap(self, seq: int):
        idx0 = seq - 1
        summary = self._summaries[idx0]
        mid = summary.message_id
        # hydrate is bound per message (its own scope), so there is no late-binding
        # capture bug; the body GET happens only if the client opens the message.
        return seq, PosternIMAPMessage(
            summary,
            uid=self._base + seq,
            seq=seq,
            hydrate=lambda: self._client.get_message(mid),
        )

    def fetch(self, messages, uid):
        """Yield (sequenceNumber, PosternIMAPMessage) for the requested set.

        `messages` is a twisted MessageSet. When uid is true the set is in UIDs
        (UID == _base + sequenceNumber), otherwise in sequence numbers; we resolve
        the open upper bound accordingly and convert UIDs back to sequence numbers.
        The untagged FETCH always keys on the sequence number (Twisted adds the UID
        as a data item via the message's getUID); bodies hydrate lazily per message.
        """
        self._ensure_loaded()
        n = len(self._summaries)
        if n == 0:
            return
        if uid:
            # '*' resolves to the highest UID present (base + count).
            messages.last = self._base + n
            for num in messages:
                if num is None:
                    continue
                seq = num - self._base
                if seq < 1 or seq > n:
                    continue
                yield self._wrap(seq)
        else:
            messages.last = n
            for num in messages:
                if num is None or num < 1 or num > n:
                    continue
                yield self._wrap(num)

    # --- IMailbox: write (all rejected: read-only proxy) ---

    def store(self, messages, flags, mode, uid):
        raise ReadOnlyError("postern-imap is read-only; flags are not stored")

    def addMessage(self, message, flags=(), date=None):
        # APPEND is accepted as a NO-OP success and never fails the client. A mail
        # client (Thunderbird) APPENDs its own copy of a sent message into Sent
        # after submission; the Postern submission path already records the outbound
        # message in the store, so persisting the APPEND would double-store. We
        # acknowledge it (returning a Deferred, as Twisted's do_APPEND expects) so
        # the post-send copy succeeds and the sent mail still appears (via the store
        # on the next SELECT), exactly once. Drafts/Trash/Junk are placeholders with
        # no v1 backing store, so an APPEND there is accepted but not persisted.
        from twisted.internet import defer

        return defer.succeed(None)

    def expunge(self):
        raise ReadOnlyError("postern-imap is read-only; nothing to expunge")

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
            added = self._refresh()
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

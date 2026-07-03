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

UID model (#102 / fault F9, DURABLE): the mailbox is ordered by the store's
monotonic insertion key (StoredMessageSummary.uid == messages.id, the D1
AUTOINCREMENT rowid) and exposes that key AS the IMAP UID under a constant
UIDVALIDITY. This is RFC 3501's model: UIDs are strictly ascending in arrival
order and stable within a UIDVALIDITY. The read API returns rows newest-first by
(date DESC, id DESC), so we SORT the collected summaries by `uid` ascending -- not
a plain reverse, which would order by `date` and reintroduce the F9 shift. A
backdated arrival (a new message carrying an OLD Date header) simply takes the
next-highest uid and appears LAST; it never inserts mid-order, so no existing UID
shifts. uid is contract-guaranteed present and > 0 on every row (#103), populated
for ALL rows at insert (it is the rowid; the Vectorize backfill writes vectors
only and never touches messages.id), so no null-fallback path is needed.

Never-reuse note (migration 0005): SQLite can reuse the highest rowid after that
row is deleted UNLESS the column is AUTOINCREMENT; migration 0005 adds AUTOINCREMENT
to make never-reuse-after-delete total. Meanwhile this is SAFE because the proxy is
strictly READ-ONLY -- expunge/store/destroy all raise, so no delete happens through
it and no rowid is ever freed for reuse within a UIDVALIDITY. If hard deletes are
ever introduced on the store side before 0005 lands, bump UIDVALIDITY so conformant
clients re-sync rather than letting a reused UID alias a different message.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, List, Optional

from zope.interface import implementer

from twisted.mail import imap4

from .client import MessageSummary, PosternClient, PosternError
from .measure import Meter
from .message import PosternIMAPMessage

if TYPE_CHECKING:  # annotation only; the runtime import stays lazy (see _maybe_start_poll)
    from twisted.internet.task import LoopingCall

# Stable across the life of a proxy process (and across reconnects). The mailbox
# UID is the store's never-reused insertion key (the rowid), so a message's UID is
# identical in every snapshot and we never need to bump this. (If pre-0005 hard
# deletes are ever added on the store side, bump it so clients re-sync -- see the
# module docstring's never-reuse note.)
_UID_VALIDITY = 1

# Per-page size and the cursor-loop bound for the server-side SEARCH pushdown (#148).
# We request the worker's max page (200) to minimize round-trips, and cap the loop so
# a pathological non-terminating cursor cannot spin forever. In-folder hits that
# survive the snapshot intersection are bounded by the window and the store returns
# newest-first (recent = in-window matches sort early), so a few window-widths of
# pages covers a real folder; the cap breach is logged LOUDLY (never a silent
# truncation). With no window (0 = unbounded snapshot) a large fixed cap applies.
_SEARCH_PAGE_LIMIT = 200
_SEARCH_MAX_PAGES_UNBOUNDED = 1000


class ReadOnlyError(imap4.MailboxException):
    """Raised for any write operation; the proxy is a read-only view in v1."""


class AppendRejectedError(imap4.MailboxException):
    """APPEND into a folder that has no backing store (placeholder folders, #109).

    A MailboxException so the server maps it to a tagged NO (see server.py): the
    client learns the save did not persist instead of the message being silently
    dropped with a fake OK (RFC 3501 / audit F11)."""


class MailboxLoadError(imap4.MailboxException):
    """The mailbox snapshot could not be loaded from the Postern read API (#144).

    Raised when the lazy SELECT/STATUS load (`_ensure_loaded`) hits an upstream
    failure -- a 401 (stale read token), a 5xx, or a transport error. Carried as a
    MailboxException so the server maps it to a clean tagged IMAP NO with a transient
    [UNAVAILABLE] hint (see server.py), instead of letting the raw PosternError
    propagate through Twisted's SELECT/STATUS callbacks as an unhandled error -- a
    client-facing BAD 'Server error' plus a logged traceback (#143/#144). The text
    is generic and transient (never the token or internal detail), and the snapshot
    stays unloaded so a later command re-attempts the load: the failure is transient,
    not sticky. Distinct from 'no such mailbox' (that path returns None in select)."""


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
        uidvalidity: int = _UID_VALIDITY,
        clock=None,
        meter: Optional[Meter] = None,
    ) -> None:
        self._client = client
        # A disabled Meter by default: measurement hooks are no-ops unless an enabled
        # meter is injected (POSTERN_IMAP_MEASURE, threaded in from the account).
        self._meter = meter or Meter(False)
        self._direction = direction
        self._special_use = list(special_use or [])
        self._list_view = list_view
        self._empty = empty
        self._page_size = page_size
        self._window = window
        self._poll_seconds = poll_seconds
        self._uidvalidity = uidvalidity
        self._summaries: List[MessageSummary] = []
        self._loaded = False
        # Highest UID (== store rowid) currently in the snapshot. UIDNEXT is this
        # + 1 (the next arrival takes the next-highest rowid). 0 until loaded/empty.
        self._newest_uid = 0
        # message_id of the highest-uid (newest-arrival) message; the poll boundary.
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
        # Measure the cold sync: how many pages/summaries a SELECT pulls and how often
        # the window cap truncates a real mailbox (validates POSTERN_IMAP_WINDOW=500 as
        # a "measurement-informed" floor). Counts/sizes only, never message content.
        try:
            with self._meter.timed("cold_sync", direction=self._direction or "all") as span:
                items: List[MessageSummary] = []
                cursor: Optional[str] = None
                pages = 0
                while True:
                    page = self._client.list_messages(
                        direction=self._direction, limit=self._page_size, cursor=cursor
                    )
                    items.extend(page.items)
                    pages += 1
                    cursor = page.cursor
                    if not cursor:
                        break
                # The API returns newest-first by (date DESC, id DESC). IMAP UIDs must ascend
                # with ARRIVAL, which is the store's insertion key (uid == rowid), NOT date:
                # sort by uid ascending so a backdated arrival lands LAST instead of shifting
                # every higher UID (fault F9). Treating uid as a stable, never-reused UID is
                # safe while the proxy is read-only (no deletes free a rowid); migration 0005
                # (AUTOINCREMENT) makes never-reuse total -- see the module docstring.
                items.sort(key=lambda s: s.uid)
                n = len(items)
                self._newest_uid = items[-1].uid if items else 0
                self._newest_id = items[-1].message_id if items else None
                if self._window and n > self._window:
                    # Show only the most-recent window (the highest uids); older mail stays
                    # reachable via All or by raising the window.
                    self._summaries = items[n - self._window:]
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
            # An upstream store/auth failure (401 stale read token, 5xx, or a transport
            # error) must degrade to a clean tagged IMAP NO, not propagate unhandled as
            # a BAD 'Server error' + traceback (#144). Re-raise as a MailboxException the
            # server maps to NO; the snapshot stays unloaded (nothing above was assigned
            # before the raise), so a later command re-attempts the load. The text is
            # generic and transient -- never the token or any internal detail.
            raise MailboxLoadError(
                "mailbox temporarily unavailable; please retry"
            ) from exc

    def _refresh(self) -> int:
        """Append any new arrivals to the snapshot; return how many were added.

        Reads the store newest-first only as far back as the message we already
        treat as newest (the highest-uid message, our poll boundary), so the work
        tracks new-mail volume, not mailbox size, and never re-fetches bodies. A new
        arrival has a higher insertion key (uid > the current max), so we collect by
        that test and the snapshot stays strictly uid-ascending after a re-sort; the
        uid filter also means nothing already present is re-added (no duplicates).
        New arrivals grow EXISTS at the high end; existing sequence numbers and UIDs
        are untouched. If the boundary message is not found (deletion/reorder -- not
        expected in an append-only store), we skip the append rather than risk a bad
        merge; the next SELECT re-snapshots cleanly.

        A backdated NEW arrival (high uid, old Date) sits below the boundary in the
        date-ordered stream, so this bounded poll may not see it until the next
        SELECT re-snapshots; that is acceptable for the live-refresh path and never
        produces a wrong or shifted UID (the re-snapshot orders it correctly by uid).
        """
        if self._empty or not self._loaded:
            return 0
        boundary = self._newest_id
        max_uid = self._newest_uid
        new_items: List[MessageSummary] = []
        cursor: Optional[str] = None
        found = False
        while True:
            page = self._client.list_messages(
                direction=self._direction, limit=self._page_size, cursor=cursor
            )
            for item in page.items:  # newest-first by (date DESC, id DESC)
                if boundary is not None and item.message_id == boundary:
                    found = True
                    break
                if item.uid > max_uid:  # a genuine new arrival (higher insertion key)
                    new_items.append(item)
            cursor = page.cursor
            if found or not cursor:
                break
        if boundary is not None and not found:
            # Inconsistent view (boundary gone); do not blindly append. Stay safe.
            return 0
        if not new_items:
            return 0
        # Merge in UID order. New arrivals carry higher uids than everything present
        # (the uid > max_uid filter guarantees it), so the sort settles them at the
        # high end and keeps the snapshot strictly ascending even if a batch arrived
        # out of date order.
        self._summaries.extend(new_items)
        self._summaries.sort(key=lambda s: s.uid)
        self._newest_uid = self._summaries[-1].uid
        self._newest_id = self._summaries[-1].message_id
        return len(new_items)

    # --- IMailbox: metadata ---

    def getUIDValidity(self) -> int:
        return self._uidvalidity

    def getUIDNext(self) -> int:
        self._ensure_loaded()
        # The next arrival takes the next rowid above the current highest UID.
        return self._newest_uid + 1

    def getUID(self, message: int) -> int:
        # `message` is a 1-based sequence number; its UID is the store insertion key
        # (the rowid), read straight off the summary -- no positional arithmetic.
        self._ensure_loaded()
        return self._summaries[message - 1].uid

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
        # SELECT view: announce every flag/keyword a FETCH on this mailbox can
        # return, so a client is never handed an unadvertised keyword (#218). A
        # message's getFlags() returns \\Seen plus the trust + direction keywords;
        # the mailbox FLAGS line must be their union. PERMANENTFLAGS stays empty
        # (read-only) -- announcing a flag is not a promise it is settable.
        return ["\\Seen", "Trusted", "Untrusted", "Inbound", "Outbound"]

    def getDefaultFlags(self) -> List[str]:
        return ["\\Seen"]

    def requestStatus(self, names):
        self._ensure_loaded()
        data = {
            "MESSAGES": len(self._summaries),
            "RECENT": 0,
            "UIDNEXT": self._newest_uid + 1,
            "UIDVALIDITY": self._uidvalidity,
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
            uid=summary.uid,
            seq=seq,
            hydrate=lambda: self._client.get_message(mid),
            meter=self._meter,
        )

    def fetch(self, messages, uid):
        """Return a list of (sequenceNumber, PosternIMAPMessage) for the requested set.

        `messages` is a twisted MessageSet. When uid is true the set is in UIDs (the
        store rowids -- sparse and not derivable from the sequence number), so we map
        each requested UID back to its sequence number via the snapshot. Otherwise
        the set is in sequence numbers. The untagged FETCH always keys on the
        sequence number (Twisted adds the UID as a data item via getUID); bodies
        hydrate lazily per message.

        This MUST return a materialized list, not a generator: Twisted's IMAP4Server
        consumes IMailbox.fetch in two incompatible ways. do_FETCH wraps the result in
        iter() before pulling with next(), so a generator is fine there; but because
        this mailbox is not ISearchableMailbox, do_SEARCH takes the manual-search
        fallback __cbManualSearch, whose first line subscripts the result
        (result[-1][0]) and which later slices it (result[5:]). A generator cannot be
        subscripted ('generator' object is not subscriptable), which surfaces to the
        client as `BAD [SEARCH failed: ...]`. A list satisfies both paths. Materializing
        only builds the lazy message wrappers (see _wrap); it fires no body GETs, so an
        ENVELOPE-only scan stays body-free.
        """
        return list(self._iter_fetch(messages, uid))

    def _iter_fetch(self, messages, uid):
        """The fetch body as a generator; fetch() materializes it (see fetch docstring)."""
        self._ensure_loaded()
        n = len(self._summaries)
        if n == 0:
            return
        if uid:
            # UIDs are not contiguous (rowids), so resolve via a uid -> seq map.
            # '*' resolves to the highest UID present (the snapshot is uid-ascending,
            # so that is the last summary).
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
        """Server-side IMAP SEARCH pushdown for one SUBJECT/BODY/TEXT key (#148).

        The stock path (PosternMailbox is deliberately NOT ISearchableMailbox, so
        do_SEARCH falls back to Twisted's __cbManualSearch) re-scans the whole
        snapshot in Python. For a plain single-term SUBJECT/BODY/TEXT search the
        server (PosternIMAP4Server.do_SEARCH) instead calls this: we delegate the
        substring match to the API (mode=substr, field=..., #212/#216) and then
        intersect the GLOBAL hits with THIS folder's current snapshot BY UID. A hit
        whose uid is not in the snapshot (a different folder, or older than the
        window cap) is dropped, so the result is folder- and window-scoped exactly
        like the manual fallback would be -- identical substring semantics, just
        matched in the store instead of in the proxy.

        Returns snapshot sequence numbers, or the UIDs when `uid` is set (UID
        SEARCH), ascending (RFC 3501 does not require order; ascending is
        conventional and matches the uid-ascending snapshot). Body-free: the API
        returns summaries, so no message body is hydrated.
        """
        self._ensure_loaded()
        if not self._summaries:
            return []
        # uid -> 1-based sequence number over the uid-ascending snapshot (the same
        # mapping _iter_fetch builds for UID FETCH).
        by_uid = {s.uid: i + 1 for i, s in enumerate(self._summaries)}
        out: List[int] = []
        cursor: Optional[str] = None
        pages = 0
        max_pages = self._search_max_pages()
        # RFC 3501 SEARCH returns EVERY match; the API pages, so we MUST follow the
        # cursor to exhaustion rather than keep only the first page (a silent cap).
        while True:
            page = self._client.search_page(
                term,
                mode="substr",
                field=field,
                direction=self._direction,
                cursor=cursor,
                limit=_SEARCH_PAGE_LIMIT,
            )
            for h in page.items:
                seq = by_uid.get(h.uid)
                if seq is None:
                    continue  # outside this folder's snapshot / window: drop it
                out.append(h.uid if uid else seq)
            cursor = page.cursor
            pages += 1
            if not cursor:
                break
            if pages >= max_pages:
                # Never silently truncate a SEARCH. If the cursor loop hits its bound
                # with pages still pending, say so LOUDLY so an operator sees it.
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
        """Bound the SEARCH cursor loop (see the module constants). A window caps the
        useful hits, so a few window-widths of pages suffices; without a window a large
        fixed cap guards against a non-terminating cursor."""
        if self._window and self._window > 0:
            # ceil(window / page) + 1, without importing math.
            return max(2, (self._window + _SEARCH_PAGE_LIMIT - 1) // _SEARCH_PAGE_LIMIT + 1)
        return _SEARCH_MAX_PAGES_UNBOUNDED

    # --- IMailbox: write (all rejected: read-only proxy) ---

    def store(self, messages, flags, mode, uid):
        raise ReadOnlyError("postern-imap is read-only; flags are not stored")

    def addMessage(self, message, flags=(), date=None):
        # do_APPEND calls this WITHOUT maybeDeferred, so we must return a Deferred
        # (never raise synchronously, which Twisted would report as a server BAD).
        from twisted.internet import defer

        if self._empty:
            # Placeholder folders (Drafts/Trash/Junk/Archive) have no backing store
            # in v1; the pre-#109 behaviour fake-acked the APPEND with OK and then
            # DROPPED the message -> silent data loss (RFC 3501 / audit F11). Reject
            # with a failed Deferred so the server returns a tagged NO and a client
            # doing server-side drafts learns the save did not persist.
            return defer.fail(
                AppendRejectedError(
                    "this folder does not store messages; APPEND is not supported"
                )
            )
        # Real views (INBOX/Sent/All): accept as a NO-OP success. A mail client
        # (Thunderbird) APPENDs its own copy of a sent message into Sent after
        # submission; the Postern submission path already recorded that outbound
        # message, so persisting the APPEND would double-store. Acknowledging it lets
        # the post-send copy succeed while the sent mail still appears exactly once
        # (via the store on the next SELECT).
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

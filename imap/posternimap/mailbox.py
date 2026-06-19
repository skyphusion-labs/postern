"""Twisted IMailbox over the Postern read API (read-only, v1).

A SELECT snapshots the mailbox: we pull the message summaries from the API
(paging through cursors), order them oldest-first (IMAP sequence numbers are
1-based and ascending by arrival), and assign each a sequence number and a UID.
fetch() then hydrates full bodies on demand via get_message, wrapping each in a
PosternIMAPMessage.

Read-only is deliberate for v1 (#12): the mailbox is the agent/store's source of
truth; humans read it here and *send* through the structured API (or a future
webmail), not by IMAP APPEND. Write paths (store/expunge/append/delete) raise so
a client gets a clean "read-only" rather than silent data loss. This is called
out in the README and on the class.

UID model (v1 limitation, documented): UIDs are assigned per snapshot from the
message's position, and UIDVALIDITY is constant. That keeps UIDs stable *within*
a session (the spec's hard requirement for FETCH/STORE within a SELECT) but a
client should not rely on them across reconnects to skip a resync. A durable
(message_id -> int) map is a post-v1 enhancement; for a read-only proxy a client
simply re-reads, which is correct, just not bandwidth-optimal.
"""

from __future__ import annotations

from typing import List, Optional

from zope.interface import implementer

from twisted.mail import imap4

from .client import MessageSummary, PosternClient
from .message import PosternIMAPMessage

# Stable across the life of a proxy process. Read-only + re-snapshot-on-select
# means we never need to bump it; documented as a v1 simplification.
_UID_VALIDITY = 1


class ReadOnlyError(imap4.MailboxException):
    """Raised for any write operation; the proxy is a read-only view in v1."""


@implementer(imap4.IMailbox)
class PosternMailbox:
    """A read-only IMAP view of the Postern mailbox, scoped by an optional filter.

    `direction` (None | "inbound" | "outbound") selects which slice the mailbox
    shows, so INBOX, Sent, and All can be three mailboxes over one store.
    """

    def __init__(
        self,
        client: PosternClient,
        *,
        direction: Optional[str] = None,
        page_size: int = 200,
    ) -> None:
        self._client = client
        self._direction = direction
        self._page_size = page_size
        self._summaries: List[MessageSummary] = []
        self._loaded = False

    # --- snapshot ---

    def _ensure_loaded(self) -> None:
        if self._loaded:
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
        # so reverse to oldest-first. Sequence i (1-based) == _summaries[i-1].
        items.reverse()
        self._summaries = items
        self._loaded = True

    def _uid_for_index(self, idx0: int) -> int:
        # idx0 is the 0-based position in the oldest-first snapshot. UID is 1-based
        # and ascends with arrival, matching sequence number this snapshot.
        return idx0 + 1

    # --- IMailbox: metadata ---

    def getUIDValidity(self) -> int:
        return _UID_VALIDITY

    def getUIDNext(self) -> int:
        self._ensure_loaded()
        return len(self._summaries) + 1

    def getUID(self, message: int) -> int:
        # `message` is a 1-based sequence number; in this snapshot UID == seq.
        return message

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
        return ["\\Seen"]

    def getDefaultFlags(self) -> List[str]:
        return ["\\Seen"]

    def requestStatus(self, names):
        self._ensure_loaded()
        n = len(self._summaries)
        data = {
            "MESSAGES": n,
            "RECENT": 0,
            "UIDNEXT": n + 1,
            "UIDVALIDITY": _UID_VALIDITY,
            "UNSEEN": 0,
        }
        return {name: data[name] for name in names if name in data}

    # --- IMailbox: read ---

    def fetch(self, messages, uid):
        """Yield (sequenceNumber, PosternIMAPMessage) for the requested set.

        `messages` is a twisted MessageSet. When uid is true the set is in UIDs,
        otherwise in sequence numbers; in this snapshot they coincide, so the same
        index math serves both. Bodies are hydrated lazily per message via the API.
        """
        self._ensure_loaded()
        n = len(self._summaries)
        if n == 0:
            return
        # MessageSet needs its open upper bound resolved to the last id.
        messages.last = n
        for num in messages:
            if num is None or num < 1 or num > n:
                continue
            idx0 = num - 1
            summary = self._summaries[idx0]
            full = self._client.get_message(summary.message_id)
            if full is None:
                continue  # raced/deleted between list and get; skip cleanly
            uid_val = self._uid_for_index(idx0)
            yield num, PosternIMAPMessage(full, uid=uid_val, seq=num)

    # --- IMailbox: write (all rejected: read-only proxy) ---

    def store(self, messages, flags, mode, uid):
        raise ReadOnlyError("postern-imap is read-only; flags are not stored")

    def addMessage(self, message, flags=(), date=None):
        raise ReadOnlyError("postern-imap is read-only; send via the Postern API")

    def expunge(self):
        raise ReadOnlyError("postern-imap is read-only; nothing to expunge")

    def destroy(self):
        raise ReadOnlyError("postern-imap is read-only; mailboxes cannot be destroyed")

    # --- IMailbox: listeners (no-ops; no server-pushed updates in v1) ---

    def addListener(self, listener):
        return None

    def removeListener(self, listener):
        return None

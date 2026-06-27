"""Twisted IAccount for an authenticated postern-imap session.

One account == one Postern API token (the avatar the realm hands back after
login, #32). It exposes a fixed set of mailboxes over the one underlying store:

  INBOX    -> inbound mail
  Sent     -> outbound mail (the stored sent copies, #27); RFC 6154 \\Sent
  All      -> the whole mailbox, both directions; \\All
  Drafts   -> present-but-empty placeholder; \\Drafts
  Trash    -> present-but-empty placeholder; \\Trash
  Junk     -> present-but-empty placeholder; \\Junk
  Archive  -> present-but-empty placeholder; \\Archive

The special-use attributes (RFC 6154) let a real mail client (Thunderbird) map
its Sent/Drafts/Trash/Junk/Archive folders onto ours automatically, instead of
erroring or trying to CREATE them. INBOX/Sent/All are direction-filtered views of
the store; Drafts/Trash/Junk/Archive have no backing state in v1, so they are
advertised as existing but empty (selectable, zero messages, no API hit).

The mailbox set is fixed: create/rename/delete are rejected. SUBSCRIBE/LSUB are
satisfied (every advertised folder is implicitly subscribed). APPEND is accepted
as a no-op by the mailbox layer (see mailbox.addMessage) so a client's post-send
"copy to Sent" never fails and never double-stores.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from zope.interface import implementer

from twisted.mail import imap4

from .client import PosternClient
from .config import Config
from .mailbox import PosternMailbox


class _Folder:
    """Static description of one advertised mailbox."""

    __slots__ = ("direction", "special_use", "empty")

    def __init__(self, direction: Optional[str], special_use: List[str], empty: bool) -> None:
        self.direction = direction
        self.special_use = special_use
        self.empty = empty


# name (as the client sees it) -> folder description. INBOX/Sent/All are real
# direction views; the rest are RFC 6154 special-use placeholders (empty in v1).
_MAILBOXES: Dict[str, _Folder] = {
    "INBOX": _Folder("inbound", [], False),
    "Sent": _Folder("outbound", ["\\Sent"], False),
    "All": _Folder(None, ["\\All"], False),
    "Drafts": _Folder(None, ["\\Drafts"], True),
    "Trash": _Folder(None, ["\\Trash"], True),
    "Junk": _Folder(None, ["\\Junk"], True),
    "Archive": _Folder(None, ["\\Archive"], True),
}


class ReadOnlyAccountError(imap4.MailboxException):
    """Raised for mutating account operations (the mailbox set is fixed in v1)."""


@implementer(imap4.IAccount)
class PosternAccount:
    def __init__(self, cfg: Config, username: str, token: str) -> None:
        self._cfg = cfg
        self._username = username
        self._token = token

    def _client(self) -> PosternClient:
        return PosternClient(self._cfg.api_url, self._token, timeout=self._cfg.api_timeout)

    def _mailbox(self, folder: _Folder, *, list_view: bool) -> PosternMailbox:
        return PosternMailbox(
            self._client(),
            direction=folder.direction,
            special_use=folder.special_use,
            empty=folder.empty,
            list_view=list_view,
        )

    # --- IAccount: read ---

    def listMailboxes(self, ref: str, wildcard: str) -> List[Tuple[str, imap4.IMailbox]]:
        # ref/wildcard filtering against the fixed name set with the standard
        # IMAP matcher. The boxes here are list-view, so getFlags() reports each
        # folder's RFC 6154 special-use attributes for the LIST response.
        matcher = imap4.wildcardToRegexp(wildcard, "/")
        out: List[Tuple[str, imap4.IMailbox]] = []
        for name, folder in _MAILBOXES.items():
            if matcher.match(name):
                # PosternMailbox provides imap4.IMailbox via @implementer (zope,
                # not a nominal subtype, so mypy needs the hint).
                out.append((name, self._mailbox(folder, list_view=True)))  # type: ignore[arg-type]
        return out

    def select(self, name: str, rw: bool = True):
        folder = _MAILBOXES.get(_canonical(name))
        if folder is None:
            return None  # unknown mailbox -> client gets "no such mailbox"
        # rw is ignored: always read-only. Twisted reads isWriteable() for the
        # advertised mode, so the client is told it is read-only correctly.
        return self._mailbox(folder, list_view=False)

    def isSubscribed(self, name: str) -> bool:
        return _canonical(name) in _MAILBOXES

    # --- IAccount: write (mostly rejected; fixed read-only set) ---

    def addMailbox(self, name, mbox=None):
        raise ReadOnlyAccountError("postern-imap exposes a fixed mailbox set")

    def create(self, pathspec):
        raise ReadOnlyAccountError("postern-imap exposes a fixed mailbox set")

    def delete(self, name):
        raise ReadOnlyAccountError("postern-imap exposes a fixed mailbox set")

    def rename(self, oldname, newname):
        raise ReadOnlyAccountError("postern-imap exposes a fixed mailbox set")

    def subscribe(self, name):
        # Every advertised folder is implicitly subscribed; accept as a no-op so a
        # client's SUBSCRIBE (Thunderbird subscribes its mapped special-use folders)
        # succeeds rather than erroring.
        return None

    def unsubscribe(self, name):
        # Likewise a no-op success: the set is fixed and always subscribed, but we
        # must not fail the client if it issues UNSUBSCRIBE.
        return None


def _canonical(name: str) -> str:
    # INBOX is case-insensitive per RFC 3501; the other names match as given.
    if name.upper() == "INBOX":
        return "INBOX"
    return name

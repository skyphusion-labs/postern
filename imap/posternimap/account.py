"""Twisted IAccount for an authenticated postern-imap session.

One account == one Postern API token (the avatar the realm hands back after
login, #32). It exposes a small fixed set of read-only mailboxes that are just
direction-filtered views of the one underlying store:

  INBOX  -> inbound mail
  Sent   -> outbound mail (the stored sent copies, #27)
  All    -> the whole mailbox, both directions

Mailbox creation / rename / delete / subscribe are rejected: the set is fixed and
read-only in v1. The account holds the token and builds a PosternClient per
select so each mailbox reads with the session's own credential.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from zope.interface import implementer

from twisted.mail import imap4

from .client import PosternClient
from .config import Config
from .mailbox import PosternMailbox

# name (as the client sees it) -> direction filter passed to the mailbox.
_MAILBOXES = {
    "INBOX": "inbound",
    "Sent": "outbound",
    "All": None,
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

    # --- IAccount: read ---

    def listMailboxes(self, ref: str, wildcard: str) -> List[Tuple[str, imap4.IMailbox]]:
        # ref/wildcard filtering: we only have three fixed names, so match them
        # against the wildcard with the standard IMAP matcher.
        matcher = imap4.wildcardToRegexp(wildcard, "/")
        out: List[Tuple[str, imap4.IMailbox]] = []
        for name, direction in _MAILBOXES.items():
            if matcher.match(name):
                # PosternMailbox provides imap4.IMailbox via @implementer (zope,
                # not a nominal subtype, so mypy needs the hint).
                out.append((name, PosternMailbox(self._client(), direction=direction)))  # type: ignore[arg-type]
        return out

    def select(self, name: str, rw: bool = True):
        direction = _MAILBOXES.get(_canonical(name))
        if _canonical(name) not in _MAILBOXES:
            return None  # unknown mailbox -> client gets "no such mailbox"
        # rw is ignored: always read-only. Twisted reads isWriteable() for the
        # advertised mode, so the client is told it is read-only correctly.
        return PosternMailbox(self._client(), direction=direction)

    def isSubscribed(self, name: str) -> bool:
        return _canonical(name) in _MAILBOXES

    # --- IAccount: write (rejected; fixed read-only set) ---

    def addMailbox(self, name, mbox=None):
        raise ReadOnlyAccountError("postern-imap exposes a fixed mailbox set")

    def create(self, pathspec):
        raise ReadOnlyAccountError("postern-imap exposes a fixed mailbox set")

    def delete(self, name):
        raise ReadOnlyAccountError("postern-imap exposes a fixed mailbox set")

    def rename(self, oldname, newname):
        raise ReadOnlyAccountError("postern-imap exposes a fixed mailbox set")

    def subscribe(self, name):
        return None  # all three are implicitly subscribed; no-op success

    def unsubscribe(self, name):
        raise ReadOnlyAccountError("the postern-imap mailbox set is fixed")


def _canonical(name: str) -> str:
    # INBOX is case-insensitive per RFC 3501; the other names match as given.
    if name.upper() == "INBOX":
        return "INBOX"
    return name

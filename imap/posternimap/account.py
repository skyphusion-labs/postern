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
  Notes    -> present-but-empty placeholder; NO special-use (bare flags)

The special-use attributes (RFC 6154) let a real mail client (Thunderbird) map
its Sent/Drafts/Trash/Junk/Archive folders onto ours automatically, instead of
erroring or trying to CREATE them. INBOX/Sent/All are direction-filtered views of
the store; Drafts/Trash/Junk/Archive/Notes have no backing state in v1, so they are
advertised as existing but empty (selectable, zero messages, no API hit).

Notes has no RFC 6154 special-use attribute (none is defined for it), so it carries
bare structural flags. It exists purely so iOS Mail finds it in LIST: iOS issues
`CREATE Notes` during account setup and aborts the ENTIRE sync (no SELECT, no
population) on the read-only `NO` the fixed set returns; advertising Notes as an
existing empty folder means iOS never issues the CREATE (#218). CREATE of an
already-existing name still correctly returns NO (read-only account), but iOS no
longer needs to try.

The mailbox set is fixed: create/rename/delete are rejected. SUBSCRIBE/LSUB are
satisfied (every advertised folder is implicitly subscribed). APPEND is accepted
as a no-op SUCCESS on the real views (INBOX/Sent/All) so a client's post-send
"copy to Sent" never fails and never double-stores, but REJECTED with a tagged NO
on the placeholder folders (Drafts/Trash/Junk/Archive), which have no backing store:
failing honestly beats fake-acking and dropping the message (#109).
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from zope.interface import implementer

from twisted.mail import imap4

from .client import PosternClient
from .config import Config
from .mailbox import PosternMailbox
from .measure import Meter


class _Folder:
    """Static description of one advertised mailbox."""

    __slots__ = ("direction", "special_use", "empty", "windowed", "writable_signal", "seen_writable", "delete_writable")

    def __init__(
        self,
        direction: Optional[str],
        special_use: List[str],
        empty: bool,
        windowed: bool = False,
        writable_signal: bool = False,
        seen_writable: bool = False,
        delete_writable: bool = False,
    ) -> None:
        self.direction = direction
        self.special_use = special_use
        self.empty = empty
        # windowed folders cap to the most-recent POSTERN_IMAP_WINDOW at SELECT; the
        # unbounded All folder is the archival escape hatch (#102 Stage 1).
        self.windowed = windowed
        # #218 Experiment A: report SELECT READ-WRITE for this folder (Notes only) so
        # iOS can provision its Notes account; writes are still refused (see mailbox
        # isWriteable / addMessage). Signal, not a storage promise.
        self.writable_signal = writable_signal
        # #seen: this folder persists the \Seen flag (INBOX/Sent/All, the real backed
        # views). SELECT reports READ-WRITE + PERMANENTFLAGS (\Seen) so a client's
        # mark-read sticks; only \Seen is settable (see mailbox.store). Placeholders
        # (empty) never set this -- they store nothing.
        self.seen_writable = seen_writable
        # #278: EXPUNGE on the real views; DELETE /api/messages/{id} requires a both-scoped
        # token (see mailbox.expunge). Placeholders stay read-only.
        self.delete_writable = delete_writable


# name (as the client sees it) -> folder description. INBOX/Sent/All are real
# direction views; the rest are RFC 6154 special-use placeholders (empty in v1).
_MAILBOXES: Dict[str, _Folder] = {
    "INBOX": _Folder("inbound", [], False, windowed=True, seen_writable=True, delete_writable=True),
    "Sent": _Folder("outbound", ["\\Sent"], False, windowed=True, seen_writable=True, delete_writable=True),
    "All": _Folder(None, ["\\All"], False, seen_writable=True, delete_writable=True),
    "Drafts": _Folder(None, ["\\Drafts"], True),
    "Trash": _Folder(None, ["\\Trash"], True),
    "Junk": _Folder(None, ["\\Junk"], True),
    "Archive": _Folder(None, ["\\Archive"], True),
    # No RFC 6154 special-use exists for Notes; bare flags. Present-but-empty so iOS
    # Mail finds it in LIST and never issues the setup-aborting `CREATE Notes` (#218).
    # writable_signal=True (#218 Experiment A): SELECT Notes reports READ-WRITE so iOS
    # completes Notes provisioning (a read-only Notes stalled the whole account setup,
    # round 5); actual writes stay refused with a tagged NO.
    "Notes": _Folder(None, [], True, writable_signal=True),
}


class ReadOnlyAccountError(imap4.MailboxException):
    """Raised for mutating account operations (the mailbox set is fixed in v1)."""


@implementer(imap4.IAccount, imap4.INamespacePresenter)
class PosternAccount:
    def __init__(self, cfg: Config, username: str, token: str) -> None:
        self._cfg = cfg
        self._username = username
        self._token = token
        # One meter per session, gated by POSTERN_IMAP_MEASURE (default off = no-op),
        # shared by every client + mailbox + message this account builds.
        self._meter = Meter(cfg.measure)

    def _client(self) -> PosternClient:
        return PosternClient(
            self._cfg.api_url, self._token, timeout=self._cfg.api_timeout, meter=self._meter
        )

    def _delete_client(self) -> Optional[PosternClient]:
        delete_token = self._cfg.service_delete_token
        if not delete_token:
            return None
        return PosternClient(
            self._cfg.api_url,
            delete_token,
            timeout=self._cfg.api_timeout,
            meter=self._meter,
        )

    def _mailbox(self, folder: _Folder, *, list_view: bool) -> PosternMailbox:
        delete_enabled = folder.delete_writable and self._cfg.service_delete_token is not None
        return PosternMailbox(
            self._client(),
            direction=folder.direction,
            special_use=folder.special_use,
            empty=folder.empty,
            list_view=list_view,
            window=self._cfg.imap_window if folder.windowed else 0,
            poll_seconds=self._cfg.imap_poll_seconds,
            uidvalidity=self._cfg.imap_uidvalidity,
            meter=self._meter,
            writable_signal=folder.writable_signal,
            seen_writable=folder.seen_writable,
            delete_writable=delete_enabled,
            delete_client=self._delete_client(),
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
        # rw is ignored: the server reads isWriteable() for the advertised mode. A real
        # view (INBOX/Sent/All) is READ-WRITE for the \Seen flag only (#seen); Notes
        # signals READ-WRITE for iOS provisioning (#218); the rest stay READ-ONLY.
        return self._mailbox(folder, list_view=False)

    def isSubscribed(self, name: str) -> bool:
        return _canonical(name) in _MAILBOXES

    def appendability(self, name: str) -> str:
        """Classify a mailbox for APPEND (#233), so the server can answer without a
        store read. Returns:
          * "real"        -- INBOX/Sent/All: accept a client's post-send Sent copy as a
                             no-op success (the outbound message is already in the store
                             via the submission path; re-storing would double-count).
          * "placeholder" -- Drafts/Trash/Junk/Archive/Notes: reject cleanly (tagged NO),
                             they have no backing store, so a fake-ack would drop data (#109).
          * "unknown"     -- no such mailbox -> the server answers NO [TRYCREATE].
        """
        folder = _MAILBOXES.get(_canonical(name))
        if folder is None:
            return "unknown"
        return "placeholder" if folder.empty else "real"

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

    # --- INamespacePresenter: advertise a real personal namespace (#218 round 6) ---
    # Twisted's do_NAMESPACE returns NIL for every class unless the account provides
    # INamespacePresenter. A NIL personal namespace under-reports what we actually
    # have -- one flat personal namespace at prefix "" with "/" as the hierarchy
    # delimiter -- and a strict client (iOS) uses the personal namespace to place and
    # verify folders. A known-good server (Dovecot) answers `(("" "/")) NIL NIL`; we
    # now match it. No shared/other-user namespaces exist on this single-account door.
    def getPersonalNamespaces(self):
        return [["", "/"]]

    def getSharedNamespaces(self):
        return None

    def getUserNamespaces(self):
        return None


def _canonical(name: str) -> str:
    # INBOX is case-insensitive per RFC 3501; the other names match as given.
    if name.upper() == "INBOX":
        return "INBOX"
    return name

"""Twisted IAccount for an authenticated postern-imap session.

One account == one Postern API token (the avatar the realm hands back after
login, #32). It exposes a fixed set of mailboxes over the one underlying store:

  INBOX    -> inbound mail with mailbox IS NULL (direction-default view)
  Sent     -> outbound mail with mailbox IS NULL; RFC 6154 \\Sent
  All      -> mailbox=all (union including placed folders); \\All
  Drafts   -> identity-owned /api/drafts; \\Drafts (#352 durable)
  Trash    -> mailbox=trash (soft-delete); \\Trash
  Junk     -> mailbox=junk; \\Junk
  Archive  -> mailbox=archive; \\Archive
  Notes    -> present-but-empty placeholder; NO special-use (bare flags)

The special-use attributes (RFC 6154) let a real mail client (Thunderbird) map
its Sent/Drafts/Trash/Junk/Archive folders onto ours automatically, instead of
erroring or trying to CREATE them.

Notes stays an empty placeholder (#218 Experiment A): SELECT reports READ-WRITE
so iOS can provision; APPEND/STORE stay refused. Drafts/Trash/Junk/Archive are
real durable views (#352): they hit the store, APPEND persists or refuses loudly
(never silent OK+drop), and COPY/MOVE to Trash is a soft placement.

INBOX/Sent/All keep messages.id as the IMAP UID under the config UIDVALIDITY
(no bump for durable-folder introduction). Trash/Junk/Archive/Drafts use
per-folder UIDs under stable folder UIDVALIDITY constants.

Per-account view scoping (#357, POSTERN_IMAP_VIEWER_MODE=per_account): the real
views become viewer-relative to the authenticated login's address V.
"""

from __future__ import annotations

from typing import Dict, List, Mapping, Optional, Tuple

from zope.interface import implementer

from twisted.mail import imap4

from .client import PosternClient
from .config import Config
from .mailbox import PosternMailbox
from .measure import Meter

# Stable UIDVALIDITY for durable folders minted once when they went real (#352 §3.4).
# Distinct from INBOX/Sent/All (config imap_uidvalidity). Not read from the worker
# counter API (none exists); these constants must not change without a deliberate
# projection bump.
_DURABLE_UIDVALIDITY = {
    "archive": 352000001,
    "trash": 352000002,
    "junk": 352000003,
    "drafts": 352000004,
}


class _Folder:
    """Static description of one advertised mailbox."""

    __slots__ = (
        "direction",
        "special_use",
        "empty",
        "windowed",
        "writable_signal",
        "seen_writable",
        "delete_writable",
        "flags_writable",
        "mailbox",
        "viewer_to",
        "viewer_from",
        "viewer_seen",
    )

    def __init__(
        self,
        direction: Optional[str],
        special_use: List[str],
        empty: bool,
        windowed: bool = False,
        writable_signal: bool = False,
        seen_writable: bool = False,
        delete_writable: bool = False,
        flags_writable: bool = False,
        mailbox: Optional[str] = None,
        viewer_to: bool = False,
        viewer_from: bool = False,
        viewer_seen: bool = False,
    ) -> None:
        self.direction = direction
        self.special_use = special_use
        self.empty = empty
        self.windowed = windowed
        self.writable_signal = writable_signal
        self.seen_writable = seen_writable
        self.delete_writable = delete_writable
        # #352: persist \\Flagged / \\Answered via POST /api/messages/flags.
        self.flags_writable = flags_writable
        # Durable placement filter for list_messages mailbox= (#352).
        # "drafts" is special-cased in the mailbox (list_drafts, not messages list).
        self.mailbox = mailbox
        self.viewer_to = viewer_to
        self.viewer_from = viewer_from
        self.viewer_seen = viewer_seen


# name (as the client sees it) -> folder description.
_MAILBOXES: Dict[str, _Folder] = {
    "INBOX": _Folder(
        "inbound", [], False,
        windowed=True, seen_writable=True, delete_writable=True, flags_writable=True,
        viewer_to=True, viewer_seen=True,
    ),
    "Sent": _Folder(
        "outbound", ["\\Sent"], False,
        windowed=True, seen_writable=True, delete_writable=True, flags_writable=True,
        viewer_from=True,
    ),
    "All": _Folder(
        None, ["\\All"], False,
        seen_writable=True, delete_writable=True, flags_writable=True,
        mailbox="all", viewer_to=True, viewer_seen=True,
    ),
    "Drafts": _Folder(
        None, ["\\Drafts"], False,
        delete_writable=True, mailbox="drafts",
    ),
    "Trash": _Folder(
        None, ["\\Trash"], False,
        seen_writable=True, delete_writable=True, flags_writable=True,
        mailbox="trash",
    ),
    "Junk": _Folder(
        None, ["\\Junk"], False,
        seen_writable=True, delete_writable=True, flags_writable=True,
        mailbox="junk",
    ),
    "Archive": _Folder(
        None, ["\\Archive"], False,
        seen_writable=True, delete_writable=True, flags_writable=True,
        mailbox="archive",
    ),
    # Notes stays a placeholder (#218 Experiment A). writable_signal only.
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
        self._per_account = cfg.viewer_mode == "per_account"
        self._viewer = (
            derive_viewer(username, cfg.viewer_domain, cfg.viewer_map)
            if self._per_account
            else None
        )
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
        scoped = self._per_account and self._viewer is not None
        to = self._viewer if (scoped and folder.viewer_to) else None
        from_addr = self._viewer if (scoped and folder.viewer_from) else None
        viewer = self._viewer if (scoped and folder.viewer_seen) else None
        # Durable folders get their own UIDVALIDITY; arrival views keep config.
        if folder.mailbox in _DURABLE_UIDVALIDITY:
            uidvalidity = _DURABLE_UIDVALIDITY[folder.mailbox]
        else:
            uidvalidity = self._cfg.imap_uidvalidity
        return PosternMailbox(
            self._client(),
            direction=folder.direction,
            to=to,
            from_addr=from_addr,
            viewer=viewer,
            special_use=folder.special_use,
            empty=folder.empty,
            list_view=list_view,
            window=self._cfg.imap_window if folder.windowed else 0,
            poll_seconds=self._cfg.imap_poll_seconds,
            uidvalidity=uidvalidity,
            meter=self._meter,
            writable_signal=folder.writable_signal,
            seen_writable=folder.seen_writable,
            delete_writable=delete_enabled,
            flags_writable=folder.flags_writable,
            delete_client=self._delete_client(),
            mailbox_filter=folder.mailbox,
        )

    # --- IAccount: read ---

    def listMailboxes(self, ref: str, wildcard: str) -> List[Tuple[str, imap4.IMailbox]]:
        if self._per_account and self._viewer is None:
            self._log_viewer_gap("LIST")
            return []
        matcher = imap4.wildcardToRegexp(wildcard, "/")
        out: List[Tuple[str, imap4.IMailbox]] = []
        for name, folder in _MAILBOXES.items():
            if matcher.match(name):
                out.append((name, self._mailbox(folder, list_view=True)))  # type: ignore[arg-type]
        return out

    def select(self, name: str, rw: bool = True):
        if self._per_account and self._viewer is None:
            self._log_viewer_gap("SELECT")
            return None
        folder = _MAILBOXES.get(_canonical(name))
        if folder is None:
            return None
        return self._mailbox(folder, list_view=False)

    def isSubscribed(self, name: str) -> bool:
        return _canonical(name) in _MAILBOXES

    def appendability(self, name: str) -> str:
        """Classify a mailbox for APPEND (#352 §3.2 persist-or-refuse).

        Returns:
          * "refuse"     -- INBOX/All: tagged NO (no honest home for a new message).
          * "sent"       -- Sent: fallback matcher; OK on hit, refuse on miss.
          * "drafts"     -- Drafts: persist via POST /api/drafts.
          * "placement"  -- Trash/Junk/Archive: move existing or refuse new.
          * "placeholder"-- Notes: reject cleanly (tagged NO).
          * "unknown"    -- no such mailbox -> NO [TRYCREATE].
        """
        folder = _MAILBOXES.get(_canonical(name))
        if folder is None:
            return "unknown"
        if folder.empty:
            return "placeholder"
        if folder.mailbox == "drafts":
            return "drafts"
        if folder.mailbox in ("trash", "junk", "archive"):
            return "placement"
        if folder.direction == "outbound" and folder.mailbox is None:
            return "sent"
        # INBOX (inbound) and All (mailbox=all): refuse new APPENDs.
        return "refuse"

    def copyability(self, name: str) -> str:
        """Classify a mailbox for COPY/MOVE (#352 soft-move).

        Returns:
          * "soft_move"  -- Trash/Junk/Archive: set mailbox placement (soft).
          * "restore"    -- INBOX/Sent/All: move_messages(..., null).
          * "placeholder"-- Drafts/Notes: reject COPY.
          * "unknown"    -- no such mailbox.
        """
        folder = _MAILBOXES.get(_canonical(name))
        if folder is None:
            return "unknown"
        if folder.mailbox in ("trash", "junk", "archive"):
            return "soft_move"
        if folder.empty or folder.mailbox == "drafts":
            return "placeholder"
        return "restore"

    def placement_mailbox(self, name: str) -> Optional[str]:
        """Return the durable placement key for a soft-move destination, or None."""
        folder = _MAILBOXES.get(_canonical(name))
        if folder is None:
            return None
        if folder.mailbox in ("trash", "junk", "archive"):
            return folder.mailbox
        return None

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
        return None

    def unsubscribe(self, name):
        return None

    def _log_viewer_gap(self, op: str) -> None:
        from twisted.python import log

        log.msg(
            "postern-imap: per_account is on but login %r has no derivable viewer "
            "address (empty local part); refusing %s, serving nothing (fail closed)."
            % (self._username, op)
        )

    def getPersonalNamespaces(self):
        return [["", "/"]]

    def getSharedNamespaces(self):
        return None

    def getUserNamespaces(self):
        return None


def _canonical(name: str) -> str:
    if name.upper() == "INBOX":
        return "INBOX"
    return name


def derive_viewer(
    login: str, domain: Optional[str], viewer_map: Mapping[str, str]
) -> Optional[str]:
    """Map an authenticated IMAP login to its viewer address V (#357)."""
    key = login.strip().lower()
    local = key.split("@", 1)[0]
    if key in viewer_map:
        return viewer_map[key]
    if local and local in viewer_map:
        return viewer_map[local]
    if not local or not domain:
        return None
    return "%s@%s" % (local, domain.lower())

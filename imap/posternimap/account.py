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

Role queues (#404, POSTERN_IMAP_VIEWER_ROLES): a viewer resolves to a SET of
addresses -- V, plus every role address V is a member of. Each role publishes as
its OWN folder, Roles/<local part>, under a \\Noselect Roles parent; role mail is
never merged into INBOX, which stays personal. A role folder filters on the ROLE
address but keeps read state PER VIEWER (to=R with seenFor=V, and \\Seen STOREs
write for=V), so "Ada read it" never renders as "the queue is handled" -- that
workflow is deliberately not modeled yet, which is also why a role folder is read
plus \\Seen only (no delete, no flags, no APPEND, no COPY/MOVE).
"""

from __future__ import annotations

import re
from typing import Dict, List, Mapping, Optional, Tuple

from zope.interface import implementer

from twisted.mail import imap4

from .client import PosternClient, PosternError
from .config import ROLE_FOLDER_PREFIX, Config, role_folder_name
from .mailbox import PosternMailbox
from .measure import Meter

_DURABLE_FOLDERS = ("archive", "trash", "junk", "drafts")

def _wildcard_matcher(pattern: str, delim: str = "/") -> "re.Pattern[str]":
    """Compile an RFC 3501 6.3.8 mailbox pattern (#427).

    6.3.8 gives the pattern exactly TWO wildcards, and they are the only
    characters with meaning:

      ``*``  zero or more characters, INCLUDING the hierarchy delimiter
      ``%``  zero or more characters, EXCLUDING the hierarchy delimiter

    Every other character is LITERAL, and 6.3.8 matches the pattern against the
    WHOLE mailbox name (callers use ``fullmatch``, never ``match``).

    We do not use ``imap4.wildcardToRegexp`` because it gives us neither half of
    that: it substitutes the two wildcards but hands every other character to the
    regex engine, so ``IN.OX`` matched INBOX, ``Roles/(abuse)`` was a group rather
    than a name, and an unbalanced paren raised re.error out of LIST instead of
    listing nothing. Escaping character by character keeps the two wildcards and
    makes the rest literal, which is what the RFC actually says.

    ``re.I`` is kept from the inherited matcher: RFC 3501 5.1 makes INBOX
    case-insensitive, and our other mailbox names are a fixed set, so this is the
    pre-existing behavior, unchanged by #427.
    """
    parts = []
    for ch in pattern:
        if ch == "*":
            parts.append("(?:.*?)")
        elif ch == "%":
            parts.append("(?:[^" + re.escape(delim) + "]*?)")
        else:
            parts.append(re.escape(ch))
    return re.compile("".join(parts), re.I)


# A loose but sufficient shape check for "does this login look like a mail
# address" (#352 core unblocker: derive an IMAP-service identity from the
# authenticated login in estate mode, where there is no per_account viewer).
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


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
        "role",
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
        role: Optional[str] = None,
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
        # #404: the role ADDRESS this folder is the queue for (None for the fixed
        # personal set). Set = filter on to=<role>, key read state on the viewer.
        self.role = role


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
    # #352 review: Trash/Junk/Archive MUST scope to the viewer in per_account mode
    # (viewer_to + viewer_seen) exactly like INBOX/All -- these are DELIVERED-mail
    # placements, not sent copies, so they key off delivered-set membership (`to`),
    # never `from` (that stays Sent-only). Without this, user A could list/move/
    # EXPUNGE user B's trash: the placement filter (mailbox=trash) is estate-wide,
    # so the viewer boundary MUST be layered on top the same way INBOX/All are.
    "Trash": _Folder(
        None, ["\\Trash"], False,
        seen_writable=True, delete_writable=True, flags_writable=True,
        mailbox="trash", viewer_to=True, viewer_seen=True,
    ),
    "Junk": _Folder(
        None, ["\\Junk"], False,
        seen_writable=True, delete_writable=True, flags_writable=True,
        mailbox="junk", viewer_to=True, viewer_seen=True,
    ),
    "Archive": _Folder(
        None, ["\\Archive"], False,
        seen_writable=True, delete_writable=True, flags_writable=True,
        mailbox="archive", viewer_to=True, viewer_seen=True,
    ),
    # Notes stays a placeholder (#218 Experiment A). writable_signal only.
    "Notes": _Folder(None, [], True, writable_signal=True),
}


class RolesParentNode:
    """The \\Noselect parent of the role hierarchy (#404, RFC 3501 7.2.2).

    LIST is the only command that ever touches this object -- Twisted asks a listed
    mailbox for getFlags + getHierarchicalDelimiter and nothing else. SELECT of the
    parent goes through PosternAccount.select, which does not resolve the name and
    answers NO: exactly what \\Noselect means. It deliberately does NOT claim
    IMailbox, because there is no store behind it. Without this node a client whose
    discovery is LIST "%" (which does not cross the "/" delimiter) would see no
    Roles entry at all and could never reach the children.
    """

    def getFlags(self) -> List[str]:
        return ["\\Noselect", "\\HasChildren"]

    def getHierarchicalDelimiter(self) -> str:
        return "/"


def role_folders_for(
    viewer: Optional[str], viewer_roles: Mapping[str, tuple]
) -> Dict[str, _Folder]:
    """The role folders THIS viewer may see: {folder name: folder} (#404).

    Membership is checked against the viewer ADDRESS, so it composes with the 1:1
    POSTERN_IMAP_VIEWER_MAP by construction (login -> V resolves first). A viewer of
    None (estate mode, or per_account with an underivable login) yields NOTHING:
    membership is unanswerable without V, and the fail-closed answer is no folders,
    never a guess. Config order is preserved so LIST output is deterministic.
    """
    out: Dict[str, _Folder] = {}
    if not viewer or not viewer_roles:
        return out
    for role, members in viewer_roles.items():
        if viewer in members:
            out[role_folder_name(role)] = _Folder(
                "inbound",
                [],
                False,
                windowed=True,
                seen_writable=True,
                role=role,
            )
    return out


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
        # #404: the viewer resolves to a SET -- V plus every role V belongs to.
        # Empty in estate mode and empty when the viewer is underivable, so the
        # feature is unreachable outside a per_account login that is truly a member.
        self._role_folders: Dict[str, _Folder] = role_folders_for(
            self._viewer if self._per_account else None, cfg.viewer_roles
        )
        self._meter = Meter(cfg.measure)
        # #352 core unblocker 4: durable-folder UIDVALIDITY is read through from
        # the worker's GET /api/folders (mailbox_uid_counter), not a client-side
        # hardcoded table. Cached per account/session (one login, one durable
        # UIDVALIDITY for its whole lifetime) so every SELECT/LIST after the first
        # does not pay a round trip; a fetch failure degrades to the config
        # default rather than failing every mailbox open.
        self._durable_uidvalidity_cache: Optional[Dict[str, int]] = None
        # #352 §2.4.1 draft autosave: draft ids already revised in place (PUT) this
        # session, so a later EXPUNGE of the stale pre-revision summary (held in a
        # DIFFERENT PosternMailbox instance -- APPEND always selects a fresh
        # throwaway mailbox, see server.do_APPEND) skips re-deleting the row the
        # revision just wrote. Shared across every Drafts mailbox instance this
        # account constructs, which is the only reason it lives here and not on
        # PosternMailbox itself.
        self._draft_revisions: set = set()

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

    def _imap_client(self) -> Optional[PosternClient]:
        """The least-privilege client for /api/imap/drafts* + /api/imap/import

        (#352 core unblocker 1): a SEPARATE token from read/delete, held only for
        those two write seams. None when POSTERN_API_TOKEN_IMAP is unset -- Drafts
        and the APPEND-import fallback then fail closed at the point of use
        (AppendRejectedError), never silently reusing a read-scoped token that
        would just 403 at the worker anyway.
        """
        imap_token = self._cfg.service_imap_token
        if not imap_token:
            return None
        return PosternClient(
            self._cfg.api_url, imap_token, timeout=self._cfg.api_timeout, meter=self._meter
        )

    def _imap_identity(self) -> Optional[str]:
        """The identity asserted on IMAP-service calls (drafts / import, #352).

        per_account mode: the derived viewer address IS the identity -- it is
        already a real mail address on the configured domain. estate mode has no
        viewer concept, so this falls back to the login itself ONLY when it looks
        like a mail address (the common case: `POSTERN_IMAP_USERNAME` /
        token-mode username set to the mailbox address); otherwise None, and
        Drafts/import fail closed with an honest error rather than guessing.
        """
        if self._viewer is not None:
            return self._viewer
        candidate = (self._username or "").strip().lower()
        return candidate if _EMAIL_RE.match(candidate) else None

    def _durable_uidvalidity(self) -> Dict[str, int]:
        if self._durable_uidvalidity_cache is None:
            cache: Dict[str, int] = {}
            try:
                for f in self._client().get_folders():
                    if f.id in _DURABLE_FOLDERS and f.uid_validity:
                        cache[f.id] = f.uid_validity
            except PosternError:
                pass  # degrade to the config default below; never fail SELECT/LIST.
            self._durable_uidvalidity_cache = cache
        return self._durable_uidvalidity_cache

    def _mailbox(self, folder: _Folder, *, list_view: bool) -> PosternMailbox:
        delete_enabled = folder.delete_writable and self._cfg.service_delete_token is not None
        scoped = self._per_account and self._viewer is not None
        to: Optional[str]
        from_addr: Optional[str]
        viewer: Optional[str]
        seen_for: Optional[str]
        lens: Optional[str]
        direction: Optional[str]
        if folder.role is not None:
            # #404 role queue. The membership filter is the ROLE address; read state
            # stays per-member (seen_for=V on reads, for=V on \\Seen writes), so two
            # members of one queue never inherit each other unread counts. Only ever
            # constructed for a member (role_folders_for), so no membership re-check
            # belongs here. The queue arrival view is the NAMED lens (#403): filtering
            # on direction=inbound would drop the same-domain sends delivered TO the
            # queue, which is exactly the blindness class #350/#357 exist to fix.
            lens = "inbox"
            direction = None
            to = folder.role
            from_addr = None
            viewer = self._viewer
            seen_for = self._viewer
        else:
            # #403: with a viewer, an arrival view is the NAMED lens (lens=inbox), not
            # direction=inbound -- the worker now filters `direction` on the stored wire
            # fact, so an INBOX asking for direction=inbound would go blind to same-domain
            # sends again (the fc#792 class #350 fixed). Estate mode has no viewer and
            # keeps the stored-direction filter, which IS the honest estate arrival view.
            lens = "inbox" if (scoped and folder.viewer_to and folder.direction == "inbound") else None
            direction = None if lens else folder.direction
            to = self._viewer if (scoped and folder.viewer_to) else None
            from_addr = self._viewer if (scoped and folder.viewer_from) else None
            viewer = self._viewer if (scoped and folder.viewer_seen) else None
            # A personal lens keys read state off its own address, which IS `to`, so
            # nothing extra goes on the wire (byte-identical to pre-#404).
            seen_for = None
        # Durable folders get their own UIDVALIDITY (read through from the worker,
        # #352 core unblocker 4); arrival views (INBOX/Sent/All) keep config.
        if folder.mailbox in _DURABLE_FOLDERS:
            uidvalidity = self._durable_uidvalidity().get(folder.mailbox, self._cfg.imap_uidvalidity)
        else:
            uidvalidity = self._cfg.imap_uidvalidity
        return PosternMailbox(
            self._client(),
            direction=direction,
            lens=lens,
            to=to,
            seen_for=seen_for,
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
            role_queue=folder.role is not None,
            imap_client=self._imap_client(),
            identity=self._imap_identity(),
            draft_revisions=self._draft_revisions,
        )

    def _folder_for(self, name: str) -> Optional[_Folder]:
        """The folder behind a client-visible name: the fixed personal set plus the
        role queues THIS login belongs to (#404). A non-member resolves nothing here,
        so every name-keyed operation (SELECT, APPEND, COPY, subscription) answers
        exactly as it would for a mailbox that does not exist -- no existence
        disclosure, no estate fallback."""
        folder = _MAILBOXES.get(_canonical(name))
        if folder is not None:
            return folder
        return self._role_folders.get(name)

    # --- IAccount: read ---

    def listMailboxes(self, ref: str, wildcard: str) -> List[Tuple[str, imap4.IMailbox]]:
        if self._per_account and self._viewer is None:
            self._log_viewer_gap("LIST")
            return []
        # RFC 3501 6.3.8 matches the pattern against the WHOLE name, so fullmatch,
        # never match: `LIST "" "IN"` used to return every folder because IN is a
        # prefix of INBOX, and `LIST "" "%"` used to return children below the
        # delimiter because the child's empty prefix satisfied the pattern (#427).
        # This is the one matching site for both LIST and LSUB: Twisted's
        # _listWork calls listMailboxes for either command and filters LSUB by
        # subscription afterwards.
        matcher = _wildcard_matcher(wildcard, "/")
        out: List[Tuple[str, imap4.IMailbox]] = []
        for name, folder in _MAILBOXES.items():
            if matcher.fullmatch(name):
                out.append((name, self._mailbox(folder, list_view=True)))  # type: ignore[arg-type]
        if self._role_folders:
            if matcher.fullmatch(ROLE_FOLDER_PREFIX):
                out.append((ROLE_FOLDER_PREFIX, RolesParentNode()))  # type: ignore[arg-type]
            for name, folder in self._role_folders.items():
                if matcher.fullmatch(name):
                    out.append((name, self._mailbox(folder, list_view=True)))  # type: ignore[arg-type]
        return out

    def select(self, name: str, rw: bool = True):
        if self._per_account and self._viewer is None:
            self._log_viewer_gap("SELECT")
            return None
        folder = self._folder_for(name)
        if folder is None:
            return None
        return self._mailbox(folder, list_view=False)

    def isSubscribed(self, name: str) -> bool:
        if name == ROLE_FOLDER_PREFIX:
            return bool(self._role_folders)
        return self._folder_for(name) is not None

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
        folder = self._folder_for(name)
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
        folder = self._folder_for(name)
        if folder is None:
            return "unknown"
        if folder.role is not None:
            # #404: a role queue is fed by delivery, never by another member COPY.
            # Without this it would classify as "restore", and a COPY into it would
            # clear the source message durable placement estate-wide.
            return "placeholder"
        if folder.mailbox in ("trash", "junk", "archive"):
            return "soft_move"
        if folder.empty or folder.mailbox == "drafts":
            return "placeholder"
        return "restore"

    def placement_mailbox(self, name: str) -> Optional[str]:
        """Return the durable placement key for a soft-move destination, or None."""
        folder = self._folder_for(name)
        if folder is None:
            return None
        if folder.mailbox in ("trash", "junk", "archive"):
            return folder.mailbox
        return None

    def restore_direction(self, name: str) -> Optional[str]:
        """The direction a restore DESTINATION (copyability()=="restore") requires

        of its source messages (#352 core unblocker 5): "inbound" for INBOX,
        "outbound" for Sent, None for All (accepts either). Only meaningful for
        INBOX/Sent/All; any other name returns None (no constraint), which is safe
        because callers only consult this for the "restore" kind.
        """
        folder = self._folder_for(name)
        if folder is None:
            return None
        return folder.direction

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

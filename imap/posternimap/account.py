"""Twisted IAccount for an authenticated postern-imap session.

One account == one Postern API token (the avatar the realm hands back after
login, #32). It exposes a fixed set of mailboxes over the one underlying store:

  INBOX    -> inbound mail
  Sent     -> outbound mail (the stored sent copies, #27); RFC 6154 \\Sent
  All      -> the whole mailbox, both directions; \\All
  Drafts   -> present-but-empty placeholder; \\Drafts; APPEND no-op for Apple Mail
  Trash    -> delete sink for clients that MOVE/COPY here (Apple Mail); \\Trash
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
"copy to Sent" never fails and never double-stores. Drafts is a narrowly scoped
client-compat exception: Apple Mail auto-saves mid-compose via APPEND, so it also
gets a no-op SUCCESS. The draft remains local to the client; Postern still has no
draft store. Trash/Junk/Archive/Notes reject APPEND with a tagged NO (#109).

Per-account view scoping (#357, POSTERN_IMAP_VIEWER_MODE=per_account): the real views
become viewer-relative to the authenticated login's address V. INBOX = mail delivered
to V that V did not send (the CONTRACT 10.9 recipient predicate), Sent = mail from V,
All = everything delivered to V (both directions, unwindowed; V's external-only sends
live under Sent), and \\Seen is per-recipient (for=V) on the to=V lenses. This is a
VIEW tier, a deterrent, NOT a credential boundary: the door still reads with an
estate-wide token, so per-user privacy is the later credential work (#351 / D-AUTH-2).
estate mode (the default) is byte-identical to the historical shared-mailbox door.
"""

from __future__ import annotations

from typing import Dict, List, Mapping, Optional, Tuple

from zope.interface import implementer

from twisted.mail import imap4

from .client import PosternClient
from .config import Config
from .mailbox import PosternMailbox
from .measure import Meter


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
        "trash_sink",
        "append_noop",
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
        trash_sink: bool = False,
        append_noop: bool = False,
        viewer_to: bool = False,
        viewer_from: bool = False,
        viewer_seen: bool = False,
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
        # #278 Apple Mail: COPY/MOVE to Trash must succeed; we treat it as hard-delete
        # from the source mailbox (Postern has no Trash store). SELECT reports READ-WRITE
        # so the client does not pre-reject the destination as immovable.
        self.trash_sink = trash_sink
        # Apple Mail auto-saves drafts with APPEND. Drafts has no backing store, but
        # accepting this as a no-op lets the client retain its local draft without
        # surfacing an error on every compose autosave.
        self.append_noop = append_noop
        # #357 per-account scoping. viewer_to: pass to=V (INBOX/All, the recipient
        # lens). viewer_from: pass from=V (Sent, the sender lens). viewer_seen: a
        # \Seen STORE writes a per-recipient override (for=V) instead of the estate
        # flag; set ONLY on the to=V lenses so the write matches the rendered read.
        self.viewer_to = viewer_to
        self.viewer_from = viewer_from
        self.viewer_seen = viewer_seen


# name (as the client sees it) -> folder description. INBOX/Sent/All are real
# direction views; the rest are RFC 6154 special-use placeholders (empty in v1).
_MAILBOXES: Dict[str, _Folder] = {
    "INBOX": _Folder("inbound", [], False, windowed=True, seen_writable=True, delete_writable=True, viewer_to=True, viewer_seen=True),
    "Sent": _Folder("outbound", ["\\Sent"], False, windowed=True, seen_writable=True, delete_writable=True, viewer_from=True),
    "All": _Folder(None, ["\\All"], False, seen_writable=True, delete_writable=True, viewer_to=True, viewer_seen=True),
    "Drafts": _Folder(None, ["\\Drafts"], True, append_noop=True),
    # Trash is empty in the store but accepts COPY/MOVE as delete-from-source (#278).
    "Trash": _Folder(None, ["\\Trash"], True, writable_signal=True, trash_sink=True),
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


# Process-wide Trash staging keyed by IMAP username (#278). Apple Mail opens INBOX
# and Trash on separate TCP connections (each gets its own PosternAccount), so
# per-account-instance staging left Trash empty while INBOX delete succeeded.
_TRASH_STAGING_BY_USER: Dict[str, list] = {}


def _shared_trash_staging(username: str) -> list:
    return _TRASH_STAGING_BY_USER.setdefault(username, [])


@implementer(imap4.IAccount, imap4.INamespacePresenter)
class PosternAccount:
    def __init__(self, cfg: Config, username: str, token: str) -> None:
        self._cfg = cfg
        self._username = username
        self._token = token
        # #357: viewer address V for per-account scoping (None in estate mode). When
        # per_account is on but this login cannot derive a V (only when the local part
        # is empty, e.g. a "@host" login), _viewer stays None and the account fails
        # CLOSED (listMailboxes/select serve nothing + log), never open to the estate.
        self._per_account = cfg.viewer_mode == "per_account"
        self._viewer = (
            derive_viewer(username, cfg.viewer_domain, cfg.viewer_map)
            if self._per_account
            else None
        )
        # Trash staging (#278): COPY/MOVE to Trash hard-deletes from the API but
        # keeps summaries visible in Trash until EXPUNGE or reconnect. Shared across
        # connections for this username (see module note above).
        self._trash_staging = _shared_trash_staging(username)
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
        # #357: estate mode -> all None (byte-identical to the historical door).
        # per_account with a derived V -> INBOX/All read to=V, Sent reads from=V, and
        # seen writes carry for=V on the to=V lenses only (CONTRACT 10.9).
        scoped = self._per_account and self._viewer is not None
        to = self._viewer if (scoped and folder.viewer_to) else None
        from_addr = self._viewer if (scoped and folder.viewer_from) else None
        viewer = self._viewer if (scoped and folder.viewer_seen) else None
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
            uidvalidity=self._cfg.imap_uidvalidity,
            meter=self._meter,
            writable_signal=folder.writable_signal,
            seen_writable=folder.seen_writable,
            delete_writable=delete_enabled,
            delete_client=self._delete_client(),
            trash_sink=folder.trash_sink,
            append_noop=folder.append_noop,
            trash_staging=self._trash_staging if folder.trash_sink else None,
            trash_staging_sink=self._trash_staging,
        )

    # --- IAccount: read ---

    def listMailboxes(self, ref: str, wildcard: str) -> List[Tuple[str, imap4.IMailbox]]:
        # ref/wildcard filtering against the fixed name set with the standard
        # IMAP matcher. The boxes here are list-view, so getFlags() reports each
        # folder's RFC 6154 special-use attributes for the LIST response.
        if self._per_account and self._viewer is None:
            self._log_viewer_gap("LIST")
            return []
        matcher = imap4.wildcardToRegexp(wildcard, "/")
        out: List[Tuple[str, imap4.IMailbox]] = []
        for name, folder in _MAILBOXES.items():
            if matcher.match(name):
                # PosternMailbox provides imap4.IMailbox via @implementer (zope,
                # not a nominal subtype, so mypy needs the hint).
                out.append((name, self._mailbox(folder, list_view=True)))  # type: ignore[arg-type]
        return out

    def select(self, name: str, rw: bool = True):
        if self._per_account and self._viewer is None:
            self._log_viewer_gap("SELECT")
            return None
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
          * "noop"        -- Drafts: accept Apple Mail autosave without storing it.
          * "placeholder" -- Trash/Junk/Archive/Notes: reject cleanly (tagged NO);
                             they have no backing store (#109).
          * "unknown"     -- no such mailbox -> the server answers NO [TRYCREATE].
        """
        folder = _MAILBOXES.get(_canonical(name))
        if folder is None:
            return "unknown"
        if folder.append_noop:
            return "noop"
        return "placeholder" if folder.empty else "real"

    def copyability(self, name: str) -> str:
        """Classify a mailbox for COPY/MOVE (#278 Apple Mail trash).

        Returns:
          * "trash_delete" -- Trash: COPY here deletes from the selected mailbox.
          * "real"         -- INBOX/Sent/All: stock COPY (unused in v1).
          * "placeholder"  -- other empty folders: reject COPY.
          * "unknown"      -- no such mailbox.
        """
        folder = _MAILBOXES.get(_canonical(name))
        if folder is None:
            return "unknown"
        if folder.trash_sink:
            return "trash_delete"
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

    def _log_viewer_gap(self, op: str) -> None:
        # #357 fail-closed: per_account is on but this login has no derivable viewer
        # address. Serve nothing and say so loudly (never fall back to the estate view).
        from twisted.python import log

        log.msg(
            "postern-imap: per_account is on but login %r has no derivable viewer "
            "address (empty local part); refusing %s, serving nothing (fail closed)."
            % (self._username, op)
        )

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


def derive_viewer(
    login: str, domain: Optional[str], viewer_map: Mapping[str, str]
) -> Optional[str]:
    """Map an authenticated IMAP login to its viewer address V (#357).

    An explicit override (POSTERN_IMAP_VIEWER_MAP) wins, matched on the full lowercased
    login first, then on the bare local part; otherwise the rule V = localpart(login)
    @ domain, where any domain the client typed on the username is stripped and
    everything is lower-cased. So `conrad`, `conrad@example.org`, and `Conrad@EXAMPLE.ORG`
    all map to `conrad@example.org` when domain is example.org.

    Returns None ONLY when V is genuinely underivable (an empty local part, or the rule
    with no domain), so the caller can fail closed rather than fall back to the estate.
    Config guarantees a domain whenever per_account is set, so in practice None arises
    only for a malformed login (e.g. "@host").
    """
    key = login.strip().lower()
    local = key.split("@", 1)[0]
    if key in viewer_map:
        return viewer_map[key]
    if local and local in viewer_map:
        return viewer_map[local]
    if not local or not domain:
        return None
    return "%s@%s" % (local, domain.lower())

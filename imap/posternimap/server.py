"""The Twisted IMAP4 server: wire a portal to a listening factory.

`build_factory(cfg)` returns a protocol factory whose IMAP4Server instances are
backed by the #32 auth portal (auth.build_portal). Twisted's IMAP4Server already
defers LOGIN to `self.portal.login(IUsernamePassword, None, IAccount)`, so wiring
auth is just setting `proto.portal`.

`run(cfg)` binds the listener (plain TCP, or TLS when a cert+key are configured)
and starts the reactor.

Twisted is imported here and in the adapter modules only; the pure layers
(client, rfc822, config, the resolve_token half of auth) never drag in Twisted.

Security note: the IMAP password is a Postern API token (or, in fixed mode, a
chosen password). Run behind TLS (set POSTERN_IMAP_TLS_CERT/KEY) or on loopback
fronted by stunnel; do not expose a plaintext listener to the internet.
"""

from __future__ import annotations

import copy
import re
import sys

from twisted.cred import credentials
from twisted.cred.error import UnauthorizedLogin
from twisted.internet import protocol
from twisted.internet.defer import maybeDeferred
from twisted.mail import imap4
from twisted.python import log
from twisted.python.compat import networkString

from .auth import build_portal
from .config import Config
from .mailbox import MailboxLoadError
from .proxywrap import wrap_listener_factory

# The three SEARCH keys whose single-term form we can push to the store's substr
# endpoint (#148). Maps the RFC 3501 search key to the /api/search field selector
# (CONTRACT 10.8 / #216 mode=substr). FROM/TO are deliberately absent: the endpoint
# has no field=from/to and field=text cannot isolate a single header, so those stay
# on the stock manual-search fallback.
_SUBSTR_SEARCH_FIELD = {b"SUBJECT": "subject", b"BODY": "body", b"TEXT": "text"}

# SEARCH keys whose VALUE argument(s) Twisted's manual-search matchers compare
# against str data -- str headers from getHeaders(), or parseTime() on a date
# string -- so the wire BYTES arg must be decoded to str before the stock manual
# path runs, or the matcher raises "cannot use a string pattern on a bytes-like
# object" and the command returns BAD (#218/#222). Grounded in the RFC 3501 6.4.4
# search-key grammar.
#   * _SEARCH_STR_ARG1: keys with ONE string/date value arg (a header substring,
#     or a DD-Mon-YYYY date).
#   * _SEARCH_STR_ARG2: HEADER takes TWO string args (field-name, then value).
# Everything NOT listed here deliberately keeps its wire bytes:
#   * BODY/TEXT match via text.strFile against getBodyFile() (a BytesIO), so their
#     arg MUST stay bytes;
#   * UID and a bare message-set token feed parseIdList(), which splits on b"," --
#     bytes;
#   * the KEY tokens themselves stay bytes so _singleSearchStep's membership test
#     against _requiresLastMessageInfo ({b"OR", b"UID", b"NOT"}) still matches and
#     OR/NOT/UID keep their lastIDs argument.
# So a blind "decode every token" is WRONG -- it breaks BODY/TEXT, message-set, and
# OR/NOT/UID dispatch. This selective, arity-aware decode is the compliant
# workaround for the upstream Twisted str/bytes bug (the upstream report stays open,
# tracked on #222; our decode is the fix that lets real clients populate folders).
_SEARCH_STR_ARG1 = frozenset(
    {
        b"FROM", b"TO", b"CC", b"BCC", b"SUBJECT",
        b"BEFORE", b"ON", b"SINCE", b"SENTBEFORE", b"SENTON", b"SENTSINCE",
    }
)
_SEARCH_STR_ARG2 = frozenset({b"HEADER"})
# Keys that take a value arg we must NOT decode (kept as wire bytes). Listed so the
# walker consumes the arg positionally and never re-reads a value as a key -- e.g.
# BODY "SINCE" must not treat the body term "SINCE" as a date key.
_SEARCH_BYTES_ARG1 = frozenset(
    {b"BODY", b"TEXT", b"UID", b"LARGER", b"SMALLER", b"KEYWORD", b"UNKEYWORD"}
)

# A LOGIN / AUTHENTICATE command line carries the password INLINE (e.g.
# `a02 LOGIN "user" "secret"`). The #218 wire-trace lever (POSTERN_IMAP_WIRE_TRACE)
# logs received command lines, so we MUST redact those args BEFORE the line reaches
# the logger -- at capture, never at read -- or the trace would leak the password.
_WIRE_TRACE_REDACT = re.compile(rb"^(\s*\S+\s+(?:LOGIN|AUTHENTICATE))\b.*$", re.IGNORECASE)


def _redact_wire_trace(line: bytes) -> bytes:
    """Redact a credential-bearing IMAP command line for the wire trace (#218).

    Keeps only `<tag> LOGIN` / `<tag> AUTHENTICATE` and replaces everything after the
    command word with ` <REDACTED>`; any non-credential line passes through unchanged.
    Note: this door advertises no SASL mechanism and known clients (iOS Mail included)
    send LOGIN as inline quoted strings, which this catches. A LOGIN that used IMAP
    literals for its arguments would carry the password on a raw literal continuation
    delivered via rawDataReceived, NOT lineReceived, so it never reaches this trace at
    all (the trace only hooks lineReceived + sendLine). Redaction happens AT CAPTURE."""
    return _WIRE_TRACE_REDACT.sub(rb"\1 <REDACTED>", line)


class PosternIMAP4Server(imap4.IMAP4Server):
    """IMAP4Server that returns a tagged NO (not BAD) for a refused APPEND.

    RFC 3501: a well-formed APPEND the server declines is a tagged NO. Twisted's
    do_APPEND maps every addMessage failure to BAD via the (name-mangled) __ebAppend
    handler, so we override it: a deliberate reject we raise as a MailboxException
    (e.g. AppendRejectedError on a placeholder folder, #109) becomes NO with the
    reason text; any other (unexpected) failure keeps the BAD + log behaviour. This
    is a deliberate, documented conformance shim; if a future Twisted renames the
    handler the override simply stops applying and the response degrades to BAD (the
    APPEND still fails -- no silent data loss either way).
    """

    def connectionMade(self):
        # Disable Nagle on the accepted socket. The RFC822/BODY[] response is written as
        # several segments (the {size} literal line, the body, the trailing ")"); with
        # Nagle on, the small trailing segment waits for the client's ACK, which the
        # client's delayed-ACK timer holds ~40ms -- a ~40ms stall on EVERY message open
        # (measured: FETCH RFC822 ~50ms vs FETCH ENVELOPE ~0.8ms on loopback). A mail
        # client opening or backfilling many messages pays it per message (#229).
        imap4.IMAP4Server.connectionMade(self)
        try:
            self.transport.setTcpNoDelay(True)
        except (AttributeError, RuntimeError):
            # PROXY-wrapped / TLS transports may not expose setTcpNoDelay; harmless.
            pass

    def authenticateLogin(self, user, passwd):
        """Defer LOGIN to the portal, tagging the credentials with the connection's
        peer address (#183).

        The #105 throttle keys token/fixed attempts on the SOURCE address instead
        of the attacker-chosen username (auth.build_portal / throttle_account), so
        the checker needs to know who is connecting. Behind the L4 load balancer
        the PROXY wrapper (proxywrap.py) has already swapped the transport's peer
        for the recovered real client IP, so getPeer() is the true source. The
        stock behavior is otherwise unchanged (portal.login with IUsernamePassword).
        """
        if not self.portal:
            raise UnauthorizedLogin()
        creds = credentials.UsernamePassword(user, passwd)
        peer = self.transport.getPeer() if self.transport is not None else None
        # UNIXAddress has no host attribute; None falls back to the shared bucket.
        setattr(creds, "peer_host", getattr(peer, "host", None))
        return self.portal.login(creds, None, imap4.IAccount)

    def _IMAP4Server__ebAppend(self, failure, tag):  # overrides IMAP4Server.__ebAppend
        if failure.check(imap4.MailboxException):
            self.sendNegativeResponse(
                tag, b"APPEND failed: " + networkString(str(failure.value))
            )
            return
        self.sendBadResponse(tag, b"APPEND failed: " + networkString(str(failure.value)))
        log.err(failure)

    def _ebSelectWork(self, failure, cmdName, tag):  # overrides IMAP4Server._ebSelectWork
        """Map an upstream mailbox-load failure on SELECT/EXAMINE to a tagged NO (#144).

        Twisted's stock _ebSelectWork answers every SELECT-path failure with a tagged
        BAD 'Server error' and log.err()s the traceback. A transient store/auth blip on
        the lazy load (`_ensure_loaded`, surfaced via getMessageCount in _cbSelectWork)
        is not a protocol error: it should degrade to a clean tagged NO with an
        [UNAVAILABLE] hint (RFC 5530) the client can retry, with no noisy traceback. A
        MailboxLoadError gets that treatment; any other (genuinely unexpected) failure
        keeps the stock BAD + log so real defects stay loud. Name-unmangled single
        underscore, so this is a plain override; if a future Twisted renames it the
        response simply degrades to the stock BAD (no crash, SELECT still fails).
        """
        if failure.check(MailboxLoadError):
            self.sendNegativeResponse(
                tag,
                b"[UNAVAILABLE] " + cmdName + b" failed: " + networkString(str(failure.value)),
            )
            return
        self.sendBadResponse(tag, cmdName + b" failed: Server error")
        log.err(failure)

    def _cbSelectWork(self, mbox, cmdName, tag):
        """SELECT/EXAMINE with the RFC 3501 6.3.1 SHOULD fields Twisted's stock
        _cbSelectWork omits: UIDNEXT and PERMANENTFLAGS (#218). Apple Mail drives
        folder population off the SELECT response and is intolerant of a missing
        UIDNEXT; the stock response emitted only EXISTS/RECENT/FLAGS/UIDVALIDITY, so
        we add:
          * OK [UIDNEXT n]         -- mbox.getUIDNext() (the store already knows it;
                                      STATUS returns it), so a client can size its sync.
          * OK [PERMANENTFLAGS ...] -- writability-dependent (see below).
        FLAGS reports every keyword a FETCH can actually return (the selected-view
        getFlags was widened to \\Seen + the Trusted/Untrusted + Inbound/Outbound
        keywords), so a client is never handed an unannounced keyword.

        Writability + PERMANENTFLAGS (#218 Experiment A): almost every folder is
        READ-ONLY, so the mode is READ-ONLY and PERMANENTFLAGS is the empty list. The
        ONE exception is Notes (mbox.isWriteable() True): round 5 convicted, on the
        live device trace, that a read-only Notes folder fails Apple's Notes-over-IMAP
        provisioning -- iOS SELECTs Notes, sees [READ-ONLY]/PERMANENTFLAGS (), gives up
        WITHOUT ever attempting a write (window-wide APPEND count = 0), never advances
        to INBOX, and the whole account is left unverified (so maild never syncs Mail).
        Experiment A answers Notes with READ-WRITE + the RFC-standard writable set + \\*
        (the normal read-write mailbox signal iOS needs) so provisioning completes. This
        is a SIGNAL, not a storage promise: an actual STORE/APPEND to Notes is still
        refused with a loud tagged NO (mailbox.store raises ReadOnlyError, addMessage
        AppendRejectedError), so nothing is ever silently dropped. EXAMINE stays
        READ-ONLY for every folder (protocol requires it). The louder, data-lossy
        alternative (no-op-accept APPEND) is Experiment B, gated on Conrad's explicit
        word. None of this changes message identity or the body projection, so NO
        UIDVALIDITY bump (Notes is empty -- nothing cached to invalidate). Plain
        override (name-unmangled; _selectWork calls self._cbSelectWork), so a future
        Twisted rework simply degrades this to the stock (still-valid) response."""
        if mbox is None:
            self.sendNegativeResponse(tag, b"No such mailbox")
            return
        if "\\noselect" in [flag.lower() for flag in mbox.getFlags()]:
            self.sendNegativeResponse(tag, b"Mailbox cannot be selected")
            return
        flags = [networkString(flag) for flag in mbox.getFlags()]
        # EXAMINE is read-only by protocol regardless of the mailbox; only SELECT of a
        # writable-signalling mailbox (Notes, #218 Experiment A) reports READ-WRITE.
        writable = mbox.isWriteable() and cmdName != b"EXAMINE"
        self.sendUntaggedResponse(b"%d EXISTS" % (mbox.getMessageCount(),))
        self.sendUntaggedResponse(b"%d RECENT" % (mbox.getRecentCount(),))
        self.sendUntaggedResponse(b"FLAGS (" + b" ".join(flags) + b")")
        if writable:
            # The flags this mailbox actually persists, from mbox.getPermanentFlags():
            #   * a seen-writable real view (INBOX/Sent/All) -> (\\Seen), so a client's
            #     mark-read sticks (#seen);
            #   * Notes (#218 Experiment A) -> the RFC-standard writable set + \\*, the
            #     "normal read-write mailbox" signal iOS needs to finish provisioning.
            # It is a SIGNAL of what is settable, not a blanket storage promise: APPEND
            # of a new message and any flag other than \\Seen are still refused with a
            # loud tagged NO (mailbox.store / addMessage), so nothing is silently dropped.
            perm = " ".join(mbox.getPermanentFlags()).encode("ascii")
            self.sendPositiveResponse(None, b"[PERMANENTFLAGS (" + perm + b")]")
        else:
            # Read-only folder (EXAMINE, or a view that persists nothing): PERMANENTFLAGS
            # is the empty list (no \\* -- new keywords cannot be created either).
            self.sendPositiveResponse(None, b"[PERMANENTFLAGS ()] No permanent flags permitted")
        # #seen: RFC 3501 6.3.1 OK [UNSEEN n] points the client at its first unread
        # message. Sent only when there IS unread mail and the mailbox tracks it
        # (getattr-guard: a future/other IMailbox may not implement firstUnseen).
        first_unseen = getattr(mbox, "firstUnseen", lambda: 0)()
        if first_unseen:
            self.sendPositiveResponse(None, b"[UNSEEN %d]" % (first_unseen,))
        self.sendPositiveResponse(None, b"[UIDVALIDITY %d]" % (mbox.getUIDValidity(),))
        self.sendPositiveResponse(None, b"[UIDNEXT %d]" % (mbox.getUIDNext(),))
        s = writable and b"READ-WRITE" or b"READ-ONLY"
        mbox.addListener(self)
        self.sendPositiveResponse(tag, b"[" + s + b"] " + cmdName + b" successful")
        self.state = "select"
        self.mbox = mbox

    def _IMAP4Server__ebStatus(self, failure, tag, box):  # overrides IMAP4Server.__ebStatus
        """Fix the STATUS error path: bytes-safe response + upstream-error -> NO (#143).

        Twisted 26.4.0's __ebStatus builds `b"STATUS " + box + ...` where `box` is a
        str (the parsed mailbox name), so a STATUS whose backend call FAILS raises
        `TypeError: can't concat str to bytes` inside the errback -- an unhandled error
        on a hostile/buggy client's malformed or failing STATUS. We rebuild the response
        with bytes throughout (encode the box name as imap4-utf-7, matching __cbStatus),
        and additionally map our transient mailbox-load failure (MailboxLoadError, e.g. a
        stale read token / upstream 5xx surfaced via requestStatus) to a clean tagged NO
        with an [UNAVAILABLE] hint instead of a BAD. Any other failure keeps a bytes-safe
        BAD + log so unexpected defects stay loud. Name-mangled like __ebAppend; if a
        future Twisted renames the handler the override stops applying and STATUS simply
        falls back to the library default (the command still fails -- no silent loss)."""
        box_bytes = box.encode("imap4-utf-7") if isinstance(box, str) else box
        if failure.check(MailboxLoadError):
            self.sendNegativeResponse(
                tag,
                b"[UNAVAILABLE] STATUS "
                + box_bytes
                + b" failed: "
                + networkString(str(failure.value)),
            )
            return
        self.sendBadResponse(
            tag, b"STATUS " + box_bytes + b" failed: " + networkString(str(failure.value))
        )
        log.err(failure)

    def do_NOOP(self, tag):
        """Refresh the selected mailbox on NOOP so new mail surfaces on demand (#102).

        RFC 3501 6.1.2: NOOP is a client's explicit poll for status updates, and any
        command may carry untagged status. Twisted's stock do_NOOP only acks, so a
        NOOP-polling client (or any client between timed polls, or with the poll off)
        never saw new mail. We refresh the mailbox first; poll_now pushes an untagged
        EXISTS before the tagged OK when new mail arrived. Only meaningful in the
        selected state (mbox set); harmless otherwise. The refresh is the same blocking
        body-free store read the timed poll uses (this stage's I/O model)."""
        mbox = getattr(self, "mbox", None)
        poll_now = getattr(mbox, "poll_now", None)
        if callable(poll_now):
            poll_now()
        imap4.IMAP4Server.do_NOOP(self, tag)

    # Rebind the command table entries so dispatchCommand (which reads the class-level
    # tuple, not getattr(self, "do_NOOP")) routes to the override above.
    unauth_NOOP = (do_NOOP,)  # type: ignore[assignment]
    auth_NOOP = unauth_NOOP  # type: ignore[assignment]
    select_NOOP = unauth_NOOP  # type: ignore[assignment]
    logout_NOOP = unauth_NOOP  # type: ignore[assignment]

    def do_APPEND(self, tag, mailbox, flags, date, message):
        """Answer APPEND WITHOUT touching the store (#233).

        macOS Mail (and Thunderbird) copy the just-sent message into Sent via APPEND
        right after SMTP submission. The Postern submission path already recorded that
        outbound message, so we must not double-store -- but we also must not FAIL the
        client's Sent-copy save. Twisted's stock do_APPEND opens the target mailbox
        (`account.select`) and then calls `mbox.getMessageCount()` to emit an untagged
        EXISTS; on the live store the Sent folder is full of outbound copies, so that
        getMessageCount is a full D1 page-through, and ANY transient failure there turned
        the client's save into `NO APPEND failed` / `BAD Server error encountered while
        opening mailbox` (the macOS Mail error in #233). Our APPEND is a declared no-op,
        so it must not depend on a store read at all.

        We short-circuit on the mailbox classification (account.appendability), with no
        store I/O:
          * real view (INBOX/Sent/All) -> tagged OK. EXISTS is optional on APPEND (RFC
            3501 7.4.1), and the copy is not actually stored, so we omit it; the client
            re-syncs Sent on its next poll/SELECT.
          * placeholder (Drafts/Trash/Junk/Archive/Notes) -> tagged NO (no backing store,
            #109: fail honestly rather than fake-ack and drop the message).
          * unknown mailbox -> NO [TRYCREATE], matching the stock behavior.
        The message literal is already fully read by the APPEND arg parser (arg_literal),
        so there is nothing to drain. Falls back to the stock machinery if the avatar is
        not a PosternAccount (defensive; keeps a non-standard account working)."""
        name = imap4._parseMbox(mailbox)
        classify = getattr(self.account, "appendability", None)
        if classify is None:
            imap4.IMAP4Server.do_APPEND(self, tag, mailbox, flags, date, message)
            return
        kind = classify(name)
        if kind == "unknown":
            self.sendNegativeResponse(tag, b"[TRYCREATE] No such mailbox")
        elif kind == "placeholder":
            self.sendNegativeResponse(
                tag, b"APPEND failed: this folder does not store messages; APPEND is not supported"
            )
        else:
            self.sendPositiveResponse(tag, b"APPEND complete")

    # Route APPEND through the override in both states it is valid (authenticated +
    # selected). dispatchCommand reads the class tuple, not getattr(self, "do_APPEND");
    # the parse callables (astring name, optional flag-list, optional datetime, and the
    # message literal) are the stock ones, so the literal is still consumed identically.
    auth_APPEND = (  # type: ignore[assignment]
        do_APPEND,
        imap4.IMAP4Server.arg_astring,
        imap4.IMAP4Server.opt_plist,
        imap4.IMAP4Server.opt_datetime,
        imap4.IMAP4Server.arg_literal,
    )
    select_APPEND = auth_APPEND  # type: ignore[assignment]

    def do_COPY(self, tag, messages, mailbox, uid=0):
        """Answer COPY; Trash is a delete sink for Apple Mail (#278).

        macOS Mail (and some other clients) delete by COPY/MOVE to the \\Trash
        mailbox, not STORE \\Deleted + EXPUNGE in the current folder. Trash has no
        backing store in Postern, so COPY-to-Trash hard-deletes from the selected
        mailbox via DELETE /api/messages/{id}. Trash SELECT reports READ-WRITE so the
        client does not reject the destination up front. COPY does NOT emit untagged
        EXPUNGE for the source (RFC 3501 semantics); the client re-syncs the source
        mailbox on its next poll (the documented COPY-to-Trash client-view gap, see
        docs/IMAP-APPLE-MAIL.md). MOVE (do_MOVE) closes that gap."""
        self._copy_or_move_to_mailbox(tag, messages, mailbox, uid, is_move=False)

    def do_MOVE(self, tag, messages, mailbox, uid=0):
        """RFC 6851 MOVE, advertised in CAPABILITY (#304).

        MOVE = COPY + mark \\Deleted + EXPUNGE, atomically. For the Trash delete sink
        this is the same source hard-delete as COPY, but MOVE additionally emits an
        untagged EXPUNGE for every moved message BEFORE the tagged OK (RFC 6851 sec 3),
        so the client's source view updates in the same round-trip instead of going
        stale until re-sync. Sequence numbers, high-to-low, per RFC 3501 7.4.1 and the
        #300/#301 EXPUNGE fix (untagged EXPUNGE carries 1-based SEQUENCE numbers, never
        UIDs). COPYUID (RFC 6851 sec 4.3) is deliberately NOT emitted: it is a UIDPLUS
        (RFC 4315) response code and we neither advertise UIDPLUS nor give Trash a
        backing store with persistent destination UIDs, so a COPYUID would fabricate
        UIDs that do not exist."""
        self._copy_or_move_to_mailbox(tag, messages, mailbox, uid, is_move=True)

    def _copy_or_move_to_mailbox(self, tag, messages, mailbox, uid=0, is_move=False):
        verb = b"MOVE" if is_move else b"COPY"
        dest = imap4._parseMbox(mailbox)
        classify = getattr(self.account, "copyability", None)
        src = getattr(self, "mbox", None)
        if classify is None or src is None:
            imap4.IMAP4Server.do_COPY(self, tag, messages, mailbox, uid)
            return
        kind = classify(dest)
        if kind == "trash_delete":
            if not getattr(src, "_delete_writable", False):
                self.sendNegativeResponse(
                    tag, verb + b" failed: delete is not enabled on this account"
                )
                return
            maybeDeferred(src.fetch, messages, uid).addCallback(
                self._cbCopyToTrashDelete, tag, is_move
            ).addErrback(self._ebCopyToTrashDelete, tag, verb)
            return
        if kind == "placeholder":
            self.sendNegativeResponse(
                tag, verb + b" failed: this folder does not store messages"
            )
            return
        imap4.IMAP4Server.do_COPY(self, tag, messages, mailbox, uid)

    def _cbCopyToTrashDelete(self, fetched, tag, is_move=False):
        src = getattr(self, "mbox", None)
        verb = b"MOVE" if is_move else b"COPY"
        if src is None:
            self.sendNegativeResponse(tag, verb + b" failed: no mailbox selected")
            return
        # RFC 6851 sec 3: MOVE emits an untagged EXPUNGE per moved message. Capture the
        # source SEQUENCE numbers from the pre-delete snapshot and emit them high-to-low
        # so no running decrement is needed (removing the highest first leaves every
        # lower sequence number valid), the same rule as PosternMailbox.expunge()
        # (#300/#301). COPY emits none (see do_COPY).
        moved_seqs = sorted((seq for seq, _msg in fetched), reverse=True)
        try:
            src.delete_fetched_messages(fetched)
        except imap4.MailboxException as exc:
            self.sendNegativeResponse(tag, verb + b" failed: " + networkString(str(exc)))
        except Exception as exc:
            self.sendBadResponse(tag, verb + b" failed: " + networkString(str(exc)))
        else:
            if is_move:
                for seq in moved_seqs:
                    self.sendUntaggedResponse(b"%d EXPUNGE" % (seq,))
            self.sendPositiveResponse(tag, verb + b" completed")

    def _ebCopyToTrashDelete(self, failure, tag, verb=b"COPY"):
        self.sendBadResponse(tag, verb + b" failed: " + networkString(str(failure.value)))

    auth_COPY = (
        do_COPY,
        imap4.IMAP4Server.arg_seqset,
        imap4.IMAP4Server.arg_finalastring,
    )
    select_COPY = auth_COPY  # type: ignore[assignment]

    auth_MOVE = (
        do_MOVE,
        imap4.IMAP4Server.arg_seqset,
        imap4.IMAP4Server.arg_finalastring,
    )
    select_MOVE = auth_MOVE

    def _wire_trace_enabled(self) -> bool:
        cfg = getattr(getattr(self, "factory", None), "_cfg", None)
        return bool(getattr(cfg, "imap_wire_trace", False))

    def lineReceived(self, line):
        """#218 diagnostic lever (POSTERN_IMAP_WIRE_TRACE, default OFF): trace the
        RECEIVED command line, REDACTED at capture (the raw line may carry the LOGIN
        password). We log the redacted copy but hand the ORIGINAL line to the stock
        parser, so auth is unaffected. OFF => a pure passthrough (zero behavior
        change), so the un-instrumented read path is byte-for-byte preserved."""
        if self._wire_trace_enabled():
            log.msg("wire C: " + _redact_wire_trace(line).decode("latin-1", "replace"))
        return imap4.IMAP4Server.lineReceived(self, line)

    def sendLine(self, line):
        """Trace the SENT response line under the same gate (server->client lines carry
        no credential). OFF => pure passthrough."""
        if self._wire_trace_enabled():
            log.msg("wire S: " + line.decode("latin-1", "replace"))
        return imap4.IMAP4Server.sendLine(self, line)

    def capabilities(self):
        """Advertise IDLE (RFC 2177) only when a live push path exists (#102).

        IDLE requires the server to push an unsolicited EXISTS when new mail arrives
        while the client idles. Our push path is the timed poll (POSTERN_IMAP_POLL_
        SECONDS); with it disabled (0) nothing pushes during IDLE, so advertising IDLE
        would be non-compliant. We drop IDLE from CAPABILITY in that case (NOOP still
        surfaces new mail on demand via do_NOOP). With the poll enabled (the default,
        30s) IDLE is advertised and the poll delivers EXISTS to the idling client."""
        cap = imap4.IMAP4Server.capabilities(self)
        cfg = getattr(getattr(self, "factory", None), "_cfg", None)
        if cfg is None or getattr(cfg, "imap_poll_seconds", 0) <= 0:
            cap.pop(b"IDLE", None)
        # RFC 2971: advertise ID so a client knows the server implements it (#218).
        cap[b"ID"] = None
        # RFC 6851: advertise MOVE (#304). do_MOVE implements it fully for the Trash
        # delete sink (untagged EXPUNGE per moved message, then tagged OK).
        cap[b"MOVE"] = None
        return cap

    @staticmethod
    def _pushable_substr_search(charset, query):
        """Return (field, term) when the whole SEARCH is one pushable substring key,
        else None (the caller then takes the stock manual-search fallback) -- #148.

        We push ONLY when the entire parsed query is exactly one of SUBJECT / BODY /
        TEXT with a single plain-ASCII string argument and no CHARSET was given.
        EVERYTHING else -- FROM/TO (the substr endpoint cannot isolate a single
        header), compound / OR / NOT queries, message-set / date / flag keys, and any
        charset or non-ASCII term -- returns None and stays on Twisted's faithful
        manual path (the mailbox is intentionally not ISearchableMailbox).

        Twisted's own client wraps the whole query in parens, so
        `SEARCH (SUBJECT "x")` parses to [[b"SUBJECT", b"x"]] while
        `SEARCH SUBJECT "x"` parses to [b"SUBJECT", b"x"]; both are the same single
        key, so we unwrap one nested level before the [KEY, arg] shape test.
        """
        if charset is not None:
            return None
        q = query
        if len(q) == 1 and isinstance(q[0], list):
            q = q[0]  # unwrap the parenthesized single-key form
        if len(q) != 2:
            return None
        key, arg = q
        if not isinstance(key, bytes) or not isinstance(arg, bytes):
            return None
        field = _SUBSTR_SEARCH_FIELD.get(key.upper())
        if field is None:
            return None
        try:
            term = arg.decode("ascii")
        except UnicodeDecodeError:
            return None
        return field, term

    @staticmethod
    def _to_search_str(tok):
        """Decode one wire-bytes SEARCH argument to str for Twisted's manual
        matchers. UTF-8 first (what real clients send for header substrings; date
        args are ASCII), latin-1 as the never-fails fallback so a pathological
        term degrades to a harmless non-match instead of crashing the connection.
        A non-bytes token (already str, or a nested list) passes through unchanged."""
        if not isinstance(tok, bytes):
            return tok
        try:
            return tok.decode("utf-8")
        except UnicodeDecodeError:
            return tok.decode("latin-1")

    @classmethod
    def _decode_manual_search(cls, query):
        """Selectively decode a parsed SEARCH query's string/date VALUE args from
        wire bytes to str so Twisted's manual-search matchers get the type they
        compare against, fixing #218/#222 for string AND date keys in one move.

        The walk is arity-aware per RFC 3501 6.4.4: a key that takes a str/date
        value has that value decoded (HEADER decodes two); a key that takes a bytes
        value (BODY/TEXT/UID/message-set) keeps it as wire bytes; key tokens and
        bare message-set tokens stay bytes; parenthesized sub-lists recurse.
        Consuming EVERY arg-bearing key positionally means a value that happens to
        spell a key name (e.g. SUBJECT "SINCE") is never re-interpreted as a key.
        NOT/OR need no special case: their following terms are simply the next keys
        the walk visits, and each decodes its own args. This is a projection-free,
        read-only transform of the parsed query list (a fresh list is returned; the
        input is not mutated)."""
        out = []
        i = 0
        n = len(query)
        while i < n:
            tok = query[i]
            if isinstance(tok, list):
                out.append(cls._decode_manual_search(tok))
                i += 1
                continue
            out.append(tok)  # key token / bare message-set / flag stays as-is (bytes)
            key = tok.upper() if isinstance(tok, bytes) else tok
            if key in _SEARCH_STR_ARG2:  # HEADER: two str args (field-name, value)
                for j in (1, 2):
                    if i + j < n:
                        out.append(cls._to_search_str(query[i + j]))
                i += 3
                continue
            if key in _SEARCH_STR_ARG1:  # one str/date arg -> decode to str
                if i + 1 < n:
                    out.append(cls._to_search_str(query[i + 1]))
                i += 2
                continue
            if key in _SEARCH_BYTES_ARG1:  # one arg, kept as wire bytes
                if i + 1 < n:
                    out.append(query[i + 1])
                i += 2
                continue
            i += 1
        return out

    def do_SEARCH(self, tag, charset, query, uid=0):
        """Push a single SUBJECT/BODY/TEXT substring SEARCH to the store (#148).

        For a pushable query (see _pushable_substr_search) we ask the mailbox to run
        the match server-side (mode=substr) and map the hits back to this folder's
        snapshot, then reply exactly as Twisted's __cbSearch does (an untagged SEARCH
        with the ids, then a tagged OK). For anything else we defer to the stock
        do_SEARCH, whose manual-search fallback (__cbManualSearch) keeps full RFC 3501
        fidelity -- so declining to push is always the safe, faithful default. The
        error path reuses the library's __ebSearch (tagged BAD + log), matching the
        stock manual path's behavior on an upstream failure.
        """
        pushable = self._pushable_substr_search(charset, query)
        if pushable is None:
            # Manual-search fallback. Decode the string/date VALUE args from wire
            # bytes to str first, so Twisted's stock matchers (which the upstream
            # str/bytes bug breaks on bytes) evaluate string AND date keys
            # correctly -- #218/#222. The pushdown predicate above already ran on
            # the ORIGINAL bytes query, so #148 pushdown behavior is unchanged;
            # only this non-pushable path is decoded (and only its str/date args --
            # see _decode_manual_search).
            imap4.IMAP4Server.do_SEARCH(
                self, tag, charset, self._decode_manual_search(query), uid=uid
            )
            return
        field, term = pushable
        maybeDeferred(self.mbox.search_substr, field, term, bool(uid)).addCallback(
            self._cb_push_search, tag
        ).addErrback(self._IMAP4Server__ebSearch, tag)

    @staticmethod
    def _search_untagged(id_tokens):
        """Build the untagged SEARCH response bytes (#218 round 4). RFC 3501 7.2.5: a
        successful SEARCH MUST send an untagged SEARCH reply even with NO matches --
        a bare `* SEARCH` with no ids and NO trailing space. id_tokens is a list of
        already-formatted id byte strings; empty => bare `SEARCH`."""
        if id_tokens:
            return b"SEARCH " + b" ".join(id_tokens)
        return b"SEARCH"

    def _cb_push_search(self, ids, tag):
        """Emit the pushed-search result, replicating IMAP4Server.__cbSearch (which is
        name-mangled and so not callable directly): an untagged SEARCH with the ids
        (already the UIDs when this was a UID SEARCH -- the mailbox emitted them),
        then the tagged OK. `ids` is a list of ints from mailbox.search_substr. An
        EMPTY result still emits the mandatory bare `* SEARCH` (RFC 3501 7.2.5), via
        the shared _search_untagged helper -- not the old `b"SEARCH " + b""`
        trailing-space form (#218 round 4)."""
        tokens = [networkString(str(i)) for i in ids]
        self.sendUntaggedResponse(self._search_untagged(tokens))
        self.sendPositiveResponse(tag, b"SEARCH completed")

    def _IMAP4Server__cbManualSearch(  # overrides IMAP4Server.__cbManualSearch
        self, result, tag, mbox, query, uid, searchResults=None
    ):
        """Always emit the untagged SEARCH reply, even on an empty result set (#218
        round 4). Twisted 24.3.0's stock __cbManualSearch skips the untagged response
        when there are no matches (`if searchResults: sendUntaggedResponse(...)`),
        which violates RFC 3501 7.2.5 (a successful SEARCH MUST send `* SEARCH`, bare
        when empty). iOS Mail SELECTs the empty Notes placeholder, runs UID SEARCH
        (e.g. `1:* NOT DELETED`) as part of its per-folder sync, and stalls forever
        waiting for the untagged reply that never comes -- eternal spinner, no further
        commands. This is the same str/bytes-era rot as #222; it stayed hidden because
        every prior search we replayed had matches. Upstream Twisted bug (goes in the
        parked report alongside #222); this is the compliant workaround.

        A verbatim copy of the stock body with two changes: the final branch always
        sends via the shared _search_untagged helper (bare `SEARCH` when empty), and
        the batched-recursion callLater references the EXPLICIT mangled name
        self._IMAP4Server__cbManualSearch (writing self.__cbManualSearch here would
        mangle to this subclass and miss the override). Name-mangled like the
        __ebStatus / __ebAppend overrides; a future Twisted rework of the search
        callback simply stops this from applying (SEARCH degrades to the stock, still
        empty-skipping behavior -- re-copy then)."""
        if searchResults is None:
            searchResults = []
        i = 0

        # result is a list of tuples (sequenceId, Message)
        lastSequenceId = result and result[-1][0]
        lastMessageId = result and result[-1][1].getUID()
        for i, (msgId, msg) in list(zip(range(5), result)):
            # searchFilter and singleSearchStep will mutate the query.  Dang.
            # Copy it here or else things will go poorly for subsequent messages.
            if self._searchFilter(
                copy.deepcopy(query), msgId, msg, lastSequenceId, lastMessageId
            ):
                searchResults.append(b"%d" % (msg.getUID() if uid else msgId,))

        if i == 4:
            from twisted.internet import reactor

            reactor.callLater(
                0,
                self._IMAP4Server__cbManualSearch,
                list(result[5:]),
                tag,
                mbox,
                query,
                uid,
                searchResults,
            )
        else:
            # RFC 3501 7.2.5: ALWAYS send the untagged SEARCH, bare when empty.
            self.sendUntaggedResponse(self._search_untagged(searchResults))
            self.sendPositiveResponse(tag, b"SEARCH completed")

    # Rebind the SELECTED-state SEARCH dispatch tuple so dispatchCommand routes to the
    # override above. dispatchCommand reads the class tuple by state name
    # (select_SEARCH), not getattr(self, "do_SEARCH"), and UID SEARCH re-dispatches
    # through the SAME tuple with uid=1 (do_UID), so this one rebind catches both
    # SEARCH and UID SEARCH. The parse callables (charset + search keys) are the stock
    # ones, unchanged. SEARCH is only valid in the selected state, so there is no
    # auth_/unauth_ SEARCH tuple to rebind.
    select_SEARCH = (  # type: ignore[assignment]
        do_SEARCH,
        imap4.IMAP4Server.opt_charset,
        imap4.IMAP4Server.arg_searchkeys,
    )

    def _listWork(self, tag, ref, mbox, sub, cmdName):
        """Answer LIST "" "" with the RFC 3501 6.3.8 delimiter/root reply (#218).

        An empty mailbox pattern is NOT a wildcard: 6.3.8 makes it a special probe
        for the hierarchy delimiter and the reference's root name. iOS Mail and
        Evolution issue LIST "" "" to learn the delimiter before they build any
        folder path; Twisted's stock _listWork treats "" as a pattern and returns
        the whole folder set, so those clients never learn the delimiter (and the
        wire-convicted symptom is folders that exist but never populate). We answer
        with the single \\Noselect root row: delimiter "/" (getHierarchicalDelimiter),
        and our flat namespace has no reference root so the root name is "". Only
        LIST carries this special case -- LSUB (6.3.9) has no empty-pattern rule --
        so we gate on cmdName; every other LIST (and all LSUB) takes the stock path
        byte-for-byte unchanged."""
        if cmdName == b"LIST" and imap4._parseMbox(mbox) == "":
            self.sendUntaggedResponse(b'LIST (\\Noselect) "/" ""')
            self.sendPositiveResponse(tag, cmdName + b" completed")
            return
        imap4.IMAP4Server._listWork(self, tag, ref, mbox, sub, cmdName)

    # Route LIST through the override (dispatchCommand reads the class tuple, not
    # getattr(self, "_listWork")). We rebind ONLY the LIST tuples; the LSUB tuples
    # still hold the parent _listWork, and the cmdName gate makes a non-empty LIST
    # identical to the stock behavior.
    auth_LIST = (  # type: ignore[assignment]
        _listWork,
        imap4.IMAP4Server.arg_astring,
        imap4.IMAP4Server.arg_astring,
        0,
        b"LIST",
    )
    select_LIST = auth_LIST  # type: ignore[assignment]

    def _arg_idparams(self, line, final=False):
        """Consume the ID command argument (RFC 2971): NIL or a parenthesized
        field/value list. We do not interpret it -- the whole remainder is taken as one
        opaque token so dispatch is satisfied -- and reply with our own server ID."""
        return (line.strip(), b"")

    def do_ID(self, tag, params):
        """RFC 2971 ID. iOS Mail issues ID as its first command after LOGIN; Twisted's
        stock IMAP4Server has no ID handler, so dispatchCommand answered
        `BAD Unsupported command`, which Apple Mail treats as fatal and aborts the sync
        before populating the folder (#218). We answer compliantly: an untagged server
        ID (a fixed, non-sensitive name -- no version, to avoid build fingerprinting)
        then a tagged OK. The client's params are accepted and ignored (RFC 2971 permits
        this). Valid in any state, so unauth/auth/select tuples are registered below."""
        self.sendUntaggedResponse(b'ID ("name" "postern-imap")')
        self.sendPositiveResponse(tag, b"ID completed")

    # dispatchCommand routes `<state>_ID` from the class tuple; ID is valid in any
    # state (RFC 2971), so bind unauth/auth/select to the same (handler, argparser).
    unauth_ID = (do_ID, _arg_idparams)
    auth_ID = unauth_ID
    select_ID = unauth_ID


class PosternIMAPFactory(protocol.Factory):
    """Builds IMAP4Server protocols bound to the proxy's auth portal."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._portal = build_portal(cfg)

    def buildProtocol(self, addr):
        proto = PosternIMAP4Server()
        # IMAP4Server.authenticateLogin defers LOGIN to this portal, which
        # resolves credentials to a PosternAccount (auth.build_portal / #32).
        proto.portal = self._portal
        proto.factory = self
        return proto


def _build_tls_context_factory(cert_path: str, key_path: str):
    """An IMAPS context factory with a TLS 1.2 floor (#106) that presents the
    full certificate chain (#175).

    Twisted's stock DefaultOpenSSLContextFactory negotiates down to TLS 1.0/1.1,
    which are deprecated and must not be offered. We build it on TLS_METHOD and
    raise the minimum protocol version to TLS 1.2, mirroring the SMTP relay's
    tls.VersionTLS12 floor so both doors share one posture. TLS deps are imported
    lazily here so a non-TLS (loopback) deployment never needs pyOpenSSL.

    DefaultOpenSSLContextFactory loads the cert with use_certificate_file, which
    sends the LEAF only. A client then sees Verify code 21 (unable to verify the
    first certificate) because the intermediate(s) are absent. We reload the cert
    as a CHAIN with use_certificate_chain_file so the intermediate(s) are sent,
    matching the 587 door (Verify 0). cert_path MUST be the Let's Encrypt
    fullchain.pem (leaf + intermediate), not the leaf-only cert.pem; a single-cert
    PEM still loads correctly (chain of one), so loopback self-signed tests pass.
    """
    from twisted.internet import ssl
    from OpenSSL import SSL

    factory = ssl.DefaultOpenSSLContextFactory(key_path, cert_path, sslmethod=SSL.TLS_METHOD)
    # getContext() returns the cached context served to every connection.
    ctx = factory.getContext()
    # Present leaf + intermediate(s), not just the leaf the default factory loaded.
    ctx.use_certificate_chain_file(cert_path)
    ctx.set_min_proto_version(SSL.TLS1_2_VERSION)
    return factory


def build_factory(cfg: Config) -> PosternIMAPFactory:
    return PosternIMAPFactory(cfg)


def run(cfg: Config) -> None:
    from twisted.internet import reactor

    log.startLogging(sys.stdout)
    factory = build_factory(cfg)

    proxy = cfg.proxy_protocol
    if cfg.tls_cert and cfg.tls_key:
        ctx = _build_tls_context_factory(cfg.tls_cert, cfg.tls_key)
        scheme = "imaps"
        if proxy.enabled():
            # 993 is implicit TLS, but the L4 LB prepends the PROXY header on the RAW
            # TCP stream ahead of the TLS ClientHello. So we listen plain TCP with the
            # PROXY wrapper OUTERMOST (it strips the header off the raw bytes) and the
            # TLS factory as the wrapped factory: raw bytes -> PROXY strip -> TLS ->
            # IMAP. (docs/PROXY-PROTOCOL.md section 8.)
            from twisted.protocols.tls import TLSMemoryBIOFactory

            tls_factory = TLSMemoryBIOFactory(ctx, False, factory)  # type: ignore[arg-type]
            wrapped = wrap_listener_factory(proxy, tls_factory, reactor=reactor)
            reactor.listenTCP(cfg.listen_port, wrapped, interface=cfg.listen_host)  # type: ignore
        else:
            # Unchanged default path: native IMAPS, no PROXY handling.
            reactor.listenSSL(cfg.listen_port, factory, ctx, interface=cfg.listen_host)
    else:
        scheme = "imap"
        # Plaintext/loopback listener; PROXY wrapper applied only when enabled (else
        # the factory is returned unwrapped -- byte-for-byte the prior behavior).
        wrapped = wrap_listener_factory(proxy, factory, reactor=reactor)
        reactor.listenTCP(cfg.listen_port, wrapped, interface=cfg.listen_host)  # type: ignore

    # Never log the token or any secret. URL + mode only.
    log.msg(
        f"postern-imap listening {scheme}://{cfg.listen_host}:{cfg.listen_port} "
        f"-> {cfg.api_url} (auth_mode={cfg.auth_mode}, proxy_protocol={cfg.proxy_protocol.mode})"
    )
    reactor.run()  # type: ignore

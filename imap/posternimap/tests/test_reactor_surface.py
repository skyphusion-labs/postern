"""#468: drive the REST of the door surface and assert the non-blocking property on it.

WHY THIS FILE EXISTS. test_reactor_nonblocking.py asserts that no worker call runs on
the reactor thread, through a seam that is total: PosternClient has exactly one way to
reach the network, so a recording there sees every worker call the door makes. What
bounded that assertion was never the seam, it was the DRIVING. That suite drives LOGIN,
LIST, SELECT, FETCH, SEARCH, STORE and LOGOUT against a default token-mode Config, so a
blocking call site on any other path was invisible to it. Proven, not argued: working
#438, joan mutated the role-membership property to resolve on a cache MISS, which is a
worker fetch from a synchronous accessor on the reactor thread, and that suite stayed
GREEN. This file drives the rest: APPEND, COPY, MOVE, restore, EXPUNGE/delete, STATUS,
LSUB, the drafts lifecycle, ID, the live poll, per_account sessions and role folders.

WHY A SEPARATE SUITE rather than more commands in the existing session test. Three
reasons, in order of weight. A per-command drive NAMES the offending command when it
fails, where one long session reports only that something in it blocked. The existing
file's per-shape FETCH battery already dominates its runtime, and folding a command walk
into it makes both harder to read. And the two files answer different questions: that one
pins the FETCH render path shape by shape, this one pins the command surface.

WHAT MAKES THIS MORE THAN A LONGER LIST. Two things.

  * Every drive carries a CONTROL. A command that is refused, or that answers out of an
    already-loaded snapshot, makes no worker call at all, and "no call on the reactor
    thread" is then true for free. Each case therefore also asserts the worker routes it
    MUST have reached (the move POST, the drafts POST, the DELETE), so a case that stops
    exercising its path fails instead of passing vacuously.
  * A MUTATION CONTROL. RoleResolutionMutationControlTest reproduces joan's #438 mutation
    and asserts this harness goes RED on it. That is the test of the test: the bar #468
    set was "would it have caught that mutation without anyone knowing to look for it",
    and the answer is asserted here rather than claimed.

THE ONE DECLARED EXCEPTION, and it is a REAL defect rather than a carve-out for
convenience. The live poll refreshes ON the reactor thread: PosternMailbox._refresh is a
blocking worker read, and both callers reach it from the reactor. do_NOOP runs it on every
NOOP a client sends against a selected mailbox, and the LoopingCall tick runs it every
POSTERN_IMAP_POLL_SECONDS with no client command at all. It is the last blocking call site
#416 part 2 left standing; config.py and mailbox.py both describe it as this stage's I/O
model, and no test ever pinned it. The fix is not a wrapper: poll_now both READS the store
and PUSHES untagged EXISTS to listeners, and a listener push writes to the protocol
transport, which must happen on the reactor thread, so the read and the notify have to be
split. That is a design change with its own review, filed as #485. LivePollReactorGapTest
pins the CURRENT truth in BOTH callers, so the gap cannot be forgotten and a fix has to
flip a test deliberately. A pin describes the door; it never blesses it.

DECLARED, NOT ASSUMED. DrivenSurfaceDeclarationTest reads the door's own do_* overrides
off PosternIMAP4Server and fails when one is neither driven here nor declared with a
reason, in BOTH directions, so a stale declaration fails too. That is what keeps this file
honest as the door grows: the next command that lands has to answer the question instead
of inheriting a green suite.
"""

from __future__ import annotations

import io
import threading
import unittest

try:
    from twisted.internet import defer, reactor, task
    from twisted.internet.protocol import ClientCreator
    from twisted.mail import imap4
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore

from posternimap.config import Config
from posternimap.roles import reset_cache
from posternimap.tests.fakes import FakeTransport, make_message

# The recorder is IMPORTED, never re-implemented: one definition of the seam means the
# two suites cannot drift into recording different things.
from posternimap.tests.test_reactor_nonblocking import ThreadRecordingTransport
from posternimap.tests.test_server_e2e import _patched_factory, _restore_account

ESTATE_LOGIN = b"agent@skyphusion.org"
VIEWER_LOGIN = b"ada@example.org"
VIEWER = "ada@example.org"
ROLE = "abuse@example.org"
ROLE_MAP = {ROLE: (VIEWER, "ben@example.org")}
ROLE_FOLDER = b"Roles/abuse"

# Scope-faithful tokens, the way a real deployment runs them: reads on the service token,
# hard deletes on the delete token, drafts / import / roles on the imap-scoped token. One
# all-powerful token would let a case pass while reaching for the wrong client.
READ_TOKEN = "tok"
DELETE_TOKEN = "dtok"
IMAP_TOKEN = "itok"
TOKEN_SCOPES = {READ_TOKEN: "both", DELETE_TOKEN: "delete", IMAP_TOKEN: "imap"}


def _fixture_messages():
    """Newest first, as the API returns it: one role message, two personal, one sent."""
    role = make_message("r1", subject="queue item", body="role mail", seen=False)
    role["to"] = ROLE
    role["deliveredTo"] = [ROLE]
    sent = make_message("m3", direction="outbound", subject="sent note")
    sent["from"] = VIEWER
    newer = make_message("m2", subject="meeting tuesday", body="lunch?", seen=False)
    newer["to"] = VIEWER
    newer["deliveredTo"] = [VIEWER]
    older = make_message("m1", subject="welcome aboard", body="hello", seen=False)
    older["to"] = VIEWER
    older["deliveredTo"] = [VIEWER]
    return [sent, newer, older, role]


def _config(**over) -> Config:
    base = dict(
        api_url="https://x",
        auth_mode="token",
        api_timeout=5.0,
        imap_poll_seconds=0,
        service_delete_token=DELETE_TOKEN,
        service_imap_token=IMAP_TOKEN,
    )
    base.update(over)
    return Config(**base)


def _per_account_config(**over) -> Config:
    return _config(viewer_mode="per_account", viewer_domain="example.org", **over)


class Recording:
    """What one drive did: every worker call, and the ones that ran on the reactor."""

    def __init__(self, calls, reactor_thread):
        self.calls = calls
        self.reactor_thread = reactor_thread
        self.on_reactor = [(m, u) for t, m, u in calls if t == reactor_thread]

    def routes(self):
        return ["%s %s" % (m, u) for _t, m, u in self.calls]


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class _SurfaceTest(twisted_unittest.TestCase):
    """Drive one command group over a real socket and record every worker call."""

    def _drive(self, body, *, cfg=None, login=ESTATE_LOGIN, roles=None):
        """LOGIN, run body(proto), LOGOUT. Returns a Recording of the BODY alone.

        The mark is taken after LOGIN so the auth ping does not colour the numbers, and
        the fake worker is rebuilt per drive so no case inherits another's state. The
        role map cache is process-wide with a TTL, so it is dropped too: a cached map
        would let the FIRST drive answer every drive after it.
        """
        reset_cache()
        cfg = cfg or _config()
        worker = FakeTransport(
            _fixture_messages(),
            expected_token=READ_TOKEN,
            token_scopes=TOKEN_SCOPES,
            roles=ROLE_MAP if roles is None else roles,
            page_size=50,
        )
        recorder = ThreadRecordingTransport(worker)
        factory, restore = _patched_factory(cfg, recorder)
        port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        addr = port.getHost()
        self.worker = worker

        @defer.inlineCallbacks
        def run():
            reactor_thread = threading.current_thread().name
            cc = ClientCreator(reactor, imap4.IMAP4Client)
            proto = yield cc.connectTCP("127.0.0.1", addr.port)
            try:
                yield proto.login(login, READ_TOKEN.encode())
                mark = len(recorder.calls)
                yield defer.maybeDeferred(body, proto)
                during = recorder.calls[mark:]
            finally:
                yield proto.logout()
            defer.returnValue(Recording(during, reactor_thread))

        def cleanup(result):
            _restore_account(restore)
            return defer.maybeDeferred(port.stopListening).addCallback(lambda _: result)

        return run().addBoth(cleanup)

    def assertOffReactor(self, label, recording, expect=()):
        """The property, plus the control that the drive reached the worker at all."""
        routes = recording.routes()
        for needle in expect:
            self.assertTrue(
                any(needle in route for route in routes),
                "%s never reached %s, so it proves nothing about it (saw %r)"
                % (label, needle, routes),
            )
        self.assertEqual(
            [],
            recording.on_reactor,
            "%s made a worker call on the reactor thread, which stalls every other "
            "connected client" % label,
        )
        self.assertTrue(
            all(t.startswith("PoolThread") for t, _m, _u in recording.calls),
            "%s ran a worker call off an unexpected thread: %r"
            % (label, sorted({t for t, _m, _u in recording.calls})),
        )

    def assertOnReactor(self, label, recording, expect=()):
        """The inverse pin, for a call site KNOWN to block (#485; see the docstring)."""
        routes = recording.routes()
        for needle in expect:
            self.assertTrue(
                any(needle in route for route in routes),
                "%s never reached %s (saw %r)" % (label, needle, routes),
            )
        self.assertTrue(
            recording.on_reactor,
            "%s no longer makes a worker call on the reactor thread. If that is the #485 "
            "FIX, delete this pin and move the case into the off-reactor battery; do not "
            "loosen it." % label,
        )


class DoorCommandSurfaceTest(_SurfaceTest):
    """The commands the original non-blocking suite never drove."""

    @defer.inlineCallbacks
    def test_append_into_sent_stays_off_the_reactor_thread(self):
        # Thunderbird APPENDs its own copy into Sent; a miss on the fallback matcher
        # persists through POST /api/imap/import on the imap-scoped seam.
        @defer.inlineCallbacks
        def body(proto):
            msg = io.BytesIO(
                b"From: agent@skyphusion.org\r\nTo: b@example.com\r\n"
                b"Subject: a copy the matcher will miss\r\n\r\nbody\r\n"
            )
            yield proto.append("Sent", msg, ("\\Seen",))

        rec = yield self._drive(body)
        self.assertOffReactor("APPEND Sent", rec, expect=["POST https://x/api/imap/import"])

    @defer.inlineCallbacks
    def test_append_into_drafts_stays_off_the_reactor_thread(self):
        @defer.inlineCallbacks
        def body(proto):
            msg = io.BytesIO(b"From: agent@skyphusion.org\r\nSubject: draft\r\n\r\nbody\r\n")
            yield proto.append("Drafts", msg, ("\\Draft",))

        rec = yield self._drive(body)
        self.assertOffReactor("APPEND Drafts", rec, expect=["POST https://x/api/imap/drafts"])

    @defer.inlineCallbacks
    def test_a_refused_append_stays_off_the_reactor_thread(self):
        # The refusal classifies through the synchronous account accessors, which is
        # exactly where a lazy worker read would land on the reactor thread.
        @defer.inlineCallbacks
        def body(proto):
            msg = io.BytesIO(b"From: agent@skyphusion.org\r\nSubject: note\r\n\r\nbody\r\n")
            d = proto.append("Notes", msg, ("\\Seen",))
            yield self.assertFailure(d, imap4.IMAP4Exception)

        rec = yield self._drive(body)
        self.assertOffReactor("APPEND Notes (refused)", rec)

    @defer.inlineCallbacks
    def test_copy_to_a_durable_folder_stays_off_the_reactor_thread(self):
        # Apple Mail deletes by COPY to Trash (#278), which is a soft-move worker call.
        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            yield proto.copy(imap4.MessageSet(1, 1), "Trash", uid=False)
            yield proto.copy(imap4.MessageSet(1, 1), "Junk", uid=False)
            yield proto.copy(imap4.MessageSet(1, 1), "Archive", uid=False)

        rec = yield self._drive(body)
        self.assertOffReactor(
            "COPY to Trash/Junk/Archive", rec, expect=["POST https://x/api/messages/move"]
        )
        moves = [r for r in rec.routes() if "/api/messages/move" in r]
        self.assertEqual(3, len(moves), "expected one move per destination: %r" % (moves,))

    @defer.inlineCallbacks
    def test_move_stays_off_the_reactor_thread(self):
        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            yield proto.sendCommand(imap4.Command(b"MOVE", b"1 Trash"))

        rec = yield self._drive(body)
        self.assertOffReactor("MOVE to Trash", rec, expect=["POST https://x/api/messages/move"])

    @defer.inlineCallbacks
    def test_restore_out_of_trash_stays_off_the_reactor_thread(self):
        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            yield proto.copy(imap4.MessageSet(1, 1), "Trash", uid=False)
            yield proto.select(b"Trash")
            yield proto.copy(imap4.MessageSet(1, 1), "INBOX", uid=False)

        rec = yield self._drive(body)
        self.assertOffReactor(
            "COPY Trash to INBOX (restore)", rec, expect=["POST https://x/api/messages/move"]
        )

    @defer.inlineCallbacks
    def test_store_deleted_and_expunge_stay_off_the_reactor_thread(self):
        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            yield proto.setFlags("1", ["\\Deleted"], uid=False)
            yield proto.expunge()

        rec = yield self._drive(body)
        self.assertOffReactor(
            "STORE \\Deleted + EXPUNGE", rec, expect=["DELETE https://x/api/messages/"]
        )

    @defer.inlineCallbacks
    def test_status_stays_off_the_reactor_thread(self):
        @defer.inlineCallbacks
        def body(proto):
            status = yield proto.status(b"INBOX", "MESSAGES", "UNSEEN", "UIDNEXT", "UIDVALIDITY")
            # Control: a STATUS that answered nothing would make no worker call either.
            self.assertEqual(3, int(status["MESSAGES"]))

        rec = yield self._drive(body)
        self.assertOffReactor("STATUS INBOX", rec, expect=["GET https://x/api/messages?"])

    @defer.inlineCallbacks
    def test_the_drafts_lifecycle_stays_off_the_reactor_thread(self):
        # Autosave writes a draft, the client lists it, opens it, and deletes it: the
        # worker seams a mail client walks in one compose window.
        @defer.inlineCallbacks
        def body(proto):
            first = io.BytesIO(
                b"From: agent@skyphusion.org\r\nSubject: half a thought\r\n\r\ndraft\r\n"
            )
            yield proto.append("Drafts", first, ("\\Draft",))
            info = yield proto.select(b"Drafts")
            self.assertEqual(1, info["EXISTS"])
            yield proto.fetchMessage("1")
            yield proto.setFlags("1", ["\\Deleted"], uid=False)
            yield proto.expunge()

        rec = yield self._drive(body)
        self.assertOffReactor(
            "drafts lifecycle",
            rec,
            expect=[
                "POST https://x/api/imap/drafts",
                "GET https://x/api/imap/drafts?",
                "DELETE https://x/api/imap/drafts/",
            ],
        )

    @defer.inlineCallbacks
    def test_lsub_stays_off_the_reactor_thread(self):
        # LSUB filters LIST through isSubscribed, a synchronous account accessor.
        @defer.inlineCallbacks
        def body(proto):
            boxes = yield proto.lsub("", "*")
            self.assertIn("INBOX", {b[2] for b in boxes})

        rec = yield self._drive(body)
        self.assertOffReactor("LSUB", rec, expect=["GET https://x/api/folders"])

    @defer.inlineCallbacks
    def test_id_touches_no_worker_at_all(self):
        # ID is a pure protocol answer, so the claim is stronger than off-reactor: it
        # must cost NO worker call, and an implementation that decided to look something
        # up fails here rather than quietly adding a round trip per connection.
        @defer.inlineCallbacks
        def body(proto):
            yield proto.sendCommand(
                imap4.Command(b"ID", b'("name" "probe")', wantResponse=(b"ID",))
            )

        rec = yield self._drive(body)
        self.assertEqual([], rec.routes(), "ID reached the worker")


class PerAccountSurfaceTest(_SurfaceTest):
    """per_account sessions and role folders: the modes the original suite never ran."""

    @defer.inlineCallbacks
    def test_a_per_account_session_stays_off_the_reactor_thread(self):
        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            yield proto.select(b"Sent")
            yield proto.select(b"All")
            yield proto.select(b"Trash")
            # Back to a lens with mail in it: a SEARCH over the empty Trash snapshot is
            # answered locally, so it would prove nothing about the pushdown path.
            yield proto.select(b"INBOX")
            yield proto.search(imap4.Query(subject="meeting"))

        rec = yield self._drive(body, cfg=_per_account_config(), login=VIEWER_LOGIN)
        self.assertOffReactor(
            "per_account session",
            rec,
            expect=["to=ada%40example.org", "GET https://x/api/search?"],
        )

    @defer.inlineCallbacks
    def test_role_folders_stay_off_the_reactor_thread(self):
        # The path joan's #438 mutation broke, driven end to end: the map fetch, the
        # folder listing, SELECT, FETCH, a per-viewer \\Seen write, and a SEARCH.
        @defer.inlineCallbacks
        def body(proto):
            boxes = yield proto.list("", "*")
            self.assertIn("Roles/abuse", {b[2] for b in boxes})
            yield proto.select(ROLE_FOLDER)
            yield proto.fetchMessage("1")
            yield proto.setFlags("1", ["\\Seen"], uid=False)
            yield proto.search(imap4.Query(subject="queue"))

        rec = yield self._drive(body, cfg=_per_account_config(), login=VIEWER_LOGIN)
        self.assertOffReactor(
            "role folder session",
            rec,
            expect=[
                "GET https://x/api/imap/roles",
                "to=abuse%40example.org",
                "POST https://x/api/messages/seen",
            ],
        )

    @defer.inlineCallbacks
    def test_a_blind_append_to_a_role_folder_stays_off_the_reactor_thread(self):
        # No LIST and no SELECT first, so this session's role map is UNRESOLVED and the
        # APPEND classifies through the synchronous accessors. That is the exact shape
        # which must never fetch; the mutation control below proves the assertion bites.
        @defer.inlineCallbacks
        def body(proto):
            msg = io.BytesIO(b"From: ada@example.org\r\nSubject: x\r\n\r\nbody\r\n")
            d = proto.append("Roles/abuse", msg, ("\\Seen",))
            yield self.assertFailure(d, imap4.IMAP4Exception)

        rec = yield self._drive(body, cfg=_per_account_config(), login=VIEWER_LOGIN)
        self.assertOffReactor("blind APPEND to a role folder", rec)


class RoleResolutionMutationControlTest(_SurfaceTest):
    """The test of the test: joan's #438 mutation must make this harness FAIL.

    #468's bar was not "add cases", it was "would this have caught that mutation without
    anyone knowing to look for it". So the mutation is reproduced here (the _role_folders
    property resolving on a cache MISS, which turns a synchronous account accessor into a
    worker fetch on the reactor thread) and what is asserted is that assertOffReactor
    RAISES on the recording. Without this, the battery above would be a pile of cases
    whose sensitivity nobody had measured.
    """

    @defer.inlineCallbacks
    def test_the_438_mutation_is_caught_by_this_harness(self):
        from posternimap.account import PosternAccount

        original = PosternAccount._role_folders

        def mutated(self):
            # The mutation, verbatim in behavior: resolve (and therefore FETCH) on a
            # cache miss, from a property every synchronous accessor reads.
            return self._ensure_role_folders()

        PosternAccount._role_folders = property(mutated)
        self.addCleanup(setattr, PosternAccount, "_role_folders", original)

        @defer.inlineCallbacks
        def body(proto):
            msg = io.BytesIO(b"From: ada@example.org\r\nSubject: x\r\n\r\nbody\r\n")
            d = proto.append("Roles/abuse", msg, ("\\Seen",))
            try:
                yield d
            except imap4.IMAP4Exception:
                pass

        rec = yield self._drive(body, cfg=_per_account_config(), login=VIEWER_LOGIN)
        # CONTROL: the mutation really did reach the role map, from a command the
        # original suite does not drive.
        self.assertTrue(
            any("/api/imap/roles" in route for route in rec.routes()),
            "the mutation never reached the role map, so this control proves nothing: %r"
            % (rec.routes(),),
        )
        with self.assertRaises(self.failureException):
            self.assertOffReactor("mutated blind APPEND", rec)


class LivePollReactorGapTest(_SurfaceTest):
    """PINS the one path that DOES block: the live poll (#485).

    Both callers are pinned, because they are two different failure shapes. do_NOOP
    stalls the door on a command every client sends on a keep-alive cadence; the
    LoopingCall stalls it with no client command at all, so an idle selected mailbox is
    enough. These tests describe today's door; they do not bless it.
    """

    @defer.inlineCallbacks
    def test_noop_refreshes_on_the_reactor_thread_known_gap(self):
        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            before = len(self.worker.calls)
            yield proto.sendCommand(imap4.Command(b"NOOP"))
            self.assertGreater(
                len(self.worker.calls), before, "NOOP made no store read at all"
            )

        rec = yield self._drive(body)
        self.assertOnReactor("NOOP refresh", rec, expect=["GET https://x/api/messages?"])

    @defer.inlineCallbacks
    def test_the_timed_poll_refreshes_on_the_reactor_thread_known_gap(self):
        # No client command at all: SELECT registers the listener, the LoopingCall fires
        # on the reactor a second later, and the refresh it runs is a blocking worker
        # call on that same thread. CLOSE stops the loop deterministically
        # (removeListener -> _stop_poll), so no delayed call outlives the test.
        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            before = len(self.worker.calls)
            ticks = 60  # 60 * 100ms, far above the one-second interval
            while ticks and len(self.worker.calls) == before:
                ticks -= 1
                yield task.deferLater(reactor, 0.1, lambda: None)
            self.assertTrue(ticks, "the timed poll never fired")
            yield proto.close()

        rec = yield self._drive(body, cfg=_config(imap_poll_seconds=1))
        self.assertOnReactor("timed poll refresh", rec, expect=["GET https://x/api/messages?"])


class DrivenSurfaceDeclarationTest(unittest.TestCase):
    """Every door command override must be driven somewhere, or declared with a why.

    This is what stops #468 from re-opening quietly: a new do_* override nobody drives
    fails here, at the moment it lands, instead of inheriting a green suite that says
    nothing about it. Stale entries fail too, so the declaration cannot rot into a list of
    commands that no longer exist.
    """

    # command -> where the non-blocking property is asserted for it.
    DRIVEN = {
        "do_FETCH": "test_reactor_nonblocking.FetchShapeTest (every FETCH shape)",
        "do_SEARCH": "test_reactor_nonblocking + PerAccountSurfaceTest",
        "do_APPEND": "DoorCommandSurfaceTest (sent, drafts, refusal, blind role folder)",
        "do_COPY": "DoorCommandSurfaceTest (durable folders + restore)",
        "do_MOVE": "DoorCommandSurfaceTest",
        "do_ID": "DoorCommandSurfaceTest (must cost no worker call)",
        "do_NOOP": "LivePollReactorGapTest (PINNED as the known gap, #485)",
    }
    # command -> why it is not driven here. Empty on purpose: everything the door
    # overrides is driven. An entry belongs here only with a reason that survives review.
    NOT_DRIVEN: dict = {}

    def test_every_door_command_override_is_driven_or_declared(self):
        from posternimap.server import PosternIMAP4Server

        overrides = {
            name
            for name, value in vars(PosternIMAP4Server).items()
            if name.startswith("do_") and callable(value)
        }
        declared = set(self.DRIVEN) | set(self.NOT_DRIVEN)
        self.assertEqual(
            set(),
            overrides - declared,
            "a door command override is neither driven nor declared: drive it in this "
            "file, or declare it in NOT_DRIVEN with a reason",
        )
        self.assertEqual(
            set(),
            declared - overrides,
            "the declaration names a command the door no longer overrides",
        )
        self.assertEqual({}, self.NOT_DRIVEN, "an undriven command needs a stated reason")

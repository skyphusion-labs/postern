"""#492 tier 2: ONE mailbox operation at a time, and COPY/MOVE as ONE of them.

Twisted does not serialize commands per connection (`blocked` is set only inside
__cbFetch), so before this every command dispatched into the reactor threadpool the
moment its line was parsed. Two commands against the same mailbox therefore ran at once,
each resolving sequence numbers against a snapshot the other was mutating. RFC 3501 /
RFC 9051 section 5.5 makes that the responsibility of the SERVER, not of a client that
declines to pipeline, and mutt (depth 15) and mbsync (unlimited) pipeline by default.

Three groups, three different things to prove:

  SerialQueueTest          the ordering primitive on its own: one at a time, FIFO, no
                           wedge on failure, and NO thread held by a waiter.
  MailboxSerializationTest the door seam, against the REAL reactor and REAL threadpool
                           with a REAL worker call parked mid-flight.
  CopyMoveOneCrossingTest  that COPY/MOVE is ONE turn, driven over a real socket.

The queue is deliberately provable without a reactor (the executor is injected), but an
injected executor only proves the decision path. Every property that has to hold of the
SHIPPED door is proved again here against the real thing.
"""

from __future__ import annotations

import threading
import unittest

try:
    from twisted.internet import defer, reactor, task
    from twisted.mail import imap4
    from twisted.python import failure
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore

from posternimap.client import PosternClient
from posternimap.tests.fakes import FakeTransport, make_message

# The real-socket drive harness is IMPORTED, not re-implemented: one definition of the
# seam means these cases cannot drift from what the rest of the surface suite drives.
from posternimap.tests.test_reactor_surface import _SurfaceTest


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class SerialQueueTest(unittest.TestCase):
    """The ordering primitive, with a hand-driven executor: nothing here races."""

    def setUp(self):
        from posternimap.serialqueue import SerialQueue

        self.dispatched = []

        def execute(fn):
            d = defer.Deferred()
            self.dispatched.append((fn, d))
            return d

        self.q = SerialQueue(execute)

    def _finish(self, index, result=None):
        _fn, waiter = self.dispatched[index]
        waiter.callback(result)

    def test_only_one_operation_is_in_flight_at_a_time(self):
        self.q.run(lambda: "a")
        self.q.run(lambda: "b")
        self.q.run(lambda: "c")
        self.assertEqual(1, len(self.dispatched), "the queue dispatched more than one")
        self.assertTrue(self.q.busy)
        self.assertEqual(2, self.q.waiting)
        self._finish(0)
        self.assertEqual(2, len(self.dispatched))
        self._finish(1)
        self.assertEqual(3, len(self.dispatched))

    def test_operations_run_in_submission_order(self):
        # FIFO is the fairness property. A mutex gives no ordering at all: it wakes
        # whichever waiter the OS picks, so a caller can be starved by luck (#416).
        ran = []
        for name in "abcde":
            self.q.run(lambda n=name: ran.append(n))
        for i in range(5):
            fn, waiter = self.dispatched[i]
            waiter.callback(fn())
        self.assertEqual(list("abcde"), ran)

    def test_a_result_reaches_its_own_caller(self):
        out = []
        self.q.run(lambda: "first").addCallback(out.append)
        self.q.run(lambda: "second").addCallback(out.append)
        self._finish(0, "first")
        self._finish(1, "second")
        self.assertEqual(["first", "second"], out)

    def test_a_failed_operation_does_not_wedge_the_queue(self):
        errors = []
        ok = []
        self.q.run(lambda: None).addErrback(errors.append)
        self.q.run(lambda: None).addCallback(ok.append)
        _fn, waiter = self.dispatched[0]
        waiter.errback(failure.Failure(RuntimeError("boom")))
        self.assertEqual(1, len(errors), "the failure did not reach its own caller")
        self.assertEqual(
            2, len(self.dispatched), "the queue stalled after an operation failed"
        )
        self._finish(1, "after")
        self.assertEqual(["after"], ok)

    def test_a_dispatch_that_raises_synchronously_does_not_wedge_the_queue(self):
        # If the pool seam itself throws, _running must not stay stuck True with every
        # later operation waiting on a call that never happened.
        from posternimap.serialqueue import SerialQueue

        calls = []

        def execute(fn):
            calls.append(fn)
            if len(calls) == 1:
                raise RuntimeError("dispatch exploded")
            return defer.succeed(fn())

        q = SerialQueue(execute)
        errors = []
        out = []
        q.run(lambda: "never").addErrback(errors.append)
        q.run(lambda: "later").addCallback(out.append)
        self.assertEqual(1, len(errors))
        self.assertEqual(["later"], out)
        self.assertFalse(q.busy)

    def test_a_reentrant_submission_goes_to_the_back_not_the_front(self):
        # A callback that submits more work (a NOOP chaining a read, a poll tick landing
        # in the same turn) must not jump the queue in front of callers already waiting.
        ran = []
        first = self.q.run(lambda: ran.append("first"))
        self.q.run(lambda: ran.append("queued-before"))
        first.addCallback(lambda _r: self.q.run(lambda: ran.append("submitted-later")))
        for i in range(3):
            fn, waiter = self.dispatched[i]
            waiter.callback(fn())
        self.assertEqual(["first", "queued-before", "submitted-later"], ran)

    def test_a_waiting_operation_holds_no_execution_slot(self):
        # THE reason this is a queue and not a mutex. With a mutex the second caller waits
        # INSIDE a pool thread; ten of those is the whole ten-thread pool consumed by
        # calls doing nothing, and the eleventh command -- from another client, on another
        # mailbox -- queues behind them. Here, fifty waiters occupy exactly one slot.
        for i in range(50):
            self.q.run(lambda n=i: n)
        self.assertEqual(
            1,
            len(self.dispatched),
            "waiting operations were handed to the executor, so each one is holding a "
            "pool thread while it waits: that is the #416 starvation, not a queue",
        )
        self.assertEqual(49, self.q.waiting)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class MailboxSerializationTest(twisted_unittest.TestCase):
    """The door seam, against the real reactor, real threadpool, real parked call."""

    def setUp(self):
        self.msgs = [
            make_message("m3", subject="third", seen=True),
            make_message("m2", subject="second", seen=True),
            make_message("m1", subject="first", seen=True),
        ]
        self.gate = {"armed": False, "release": threading.Event()}
        self.entered = threading.Event()
        self.calls = []
        inner = FakeTransport(
            self.msgs, expected_token="t", page_size=10, token_scopes={"t": "both"}
        )

        def gated(req):
            self.calls.append("%s %s" % (req.get_method(), req.full_url))
            if self.gate["armed"]:
                self.gate["armed"] = False
                self.entered.set()
                self.gate["release"].wait(10)
            return inner(req)

        self.addCleanup(self.gate["release"].set)
        self.client = PosternClient("https://x", "t", transport=gated)
        # TURN THE REACTOR ONCE BEFORE THE TEST BODY RUNS. trial has not marked the
        # reactor running yet when a test method is entered (reactor.running is False on
        # the first line and True after the first turn), and threaded.in_pool falls back
        # to running work INLINE when no reactor is running. Every dispatch in this file
        # would then be synchronous, and a synchronous door is trivially serialized: every
        # assertion below would pass while proving nothing at all about the shipped
        # article. Verified by watching these tests fail with the work on MainThread
        # before this line existed.
        return task.deferLater(reactor, 0, lambda: None)

    def _threaded(self, **kw):
        from posternimap.mailbox import PosternMailbox
        from posternimap.threaded import ThreadedMailbox

        mb = PosternMailbox(self.client, page_size=10, **kw)
        mb.preload()
        return mb, ThreadedMailbox(mb)

    def _wait_for_park(self):
        # Yields to the reactor until the parked worker call is confirmed inside the pool.
        return _poll_until(lambda: self.entered.is_set())

    def _expect_no_worker_call(self, label, match="/api/messages?"):
        """Watch for WINDOW seconds and fail the moment a matching call appears.

        NOT a few reactor turns. That was the first version of this and it was worthless:
        a few zero-delay turns are faster than the reactor threadpool can start a thread,
        so an operation that HAD been handed straight to the pool simply had not reached
        the transport yet, and the assertion passed on a door with no serializer at all.
        Caught by reverting the fix and watching these cases stay green.

        The window is sized from that same experiment rather than guessed: with it, the
        un-serialized door is observed reaching the worker every time. Every caller pairs
        this with a post-release assertion that the operation DID eventually run, so a
        case can never pass because the second operation was never going to happen.
        """
        WINDOW = 0.30
        deadline = [int(WINDOW / 0.01)]

        def step(_result=None):
            hits = [c for c in self.calls if match in c]
            if hits:
                # failureException, not AssertionError: raised inside a Deferred chain the
                # latter is reported by trial as an ERROR, which reads like the test broke
                # rather than like the door did.
                raise self.failureException(
                    "%s reached the worker while another operation was still in flight "
                    "on the same mailbox: %r" % (label, hits)
                )
            deadline[0] -= 1
            if deadline[0] <= 0:
                return None
            return task.deferLater(reactor, 0.01, lambda: None).addCallback(step)

        return defer.maybeDeferred(step)

    @defer.inlineCallbacks
    def test_a_second_refresh_waits_for_the_one_in_flight(self):
        # The #485 property, re-proved against the queue that replaced its mutex and
        # against the real article: two overlapping refreshes would read the SAME boundary
        # and append the SAME arrival twice.
        mb, tm = self._threaded()
        self.msgs.insert(0, make_message("m4", subject="newest"))
        self.gate["armed"] = True

        first = tm.refresh_now()
        yield self._wait_for_park()
        del self.calls[:]  # mark: only what happens from HERE counts
        second = tm.refresh_now()
        yield self._expect_no_worker_call("the second refresh")

        self.gate["release"].set()
        added_first = yield first
        added_second = yield second
        # CONTROL: the second refresh really did run, after the first, so the window above
        # was not empty merely because nothing was ever going to happen in it.
        self.assertTrue(
            [c for c in self.calls if "/api/messages?" in c],
            "the second refresh never reached the worker at all, so the window above "
            "proved nothing",
        )
        self.assertEqual([0, 1], sorted([added_first, added_second]))
        self.assertEqual(4, mb.getMessageCount())
        self.assertEqual([1, 2, 3, 4], [s.uid for s in mb._summaries])

    @defer.inlineCallbacks
    def test_a_refresh_cannot_run_while_a_store_is_in_flight(self):
        # THE #492 tier-2 property, and the one the old refresh mutex never covered: it
        # serialized refresh against refresh only, leaving a refresh free to grow the
        # snapshot underneath a store that had already resolved its sequence numbers.
        mb, tm = self._threaded(seen_writable=True)
        self.gate["armed"] = True

        storing = tm.store(imap4.MessageSet(1, 1), ["\\Seen"], -1, False)
        yield self._wait_for_park()
        del self.calls[:]  # mark: only what happens from HERE counts
        refreshing = tm.refresh_now()
        yield self._expect_no_worker_call("a refresh, during a STORE")

        self.gate["release"].set()
        yield storing
        yield refreshing
        self.assertTrue(
            [c for c in self.calls if "/api/messages?" in c],
            "the refresh never ran at all, so the window above proved nothing",
        )

    @defer.inlineCallbacks
    def test_the_timed_poll_takes_a_turn_like_everything_else(self):
        # "Poll joins the queue, no side door." The tick used to go straight to the pool
        # through _dispatch, so it could land in the middle of a client command.
        mb, tm = self._threaded()
        self.gate["armed"] = True

        blocking = tm.refresh_now()
        yield self._wait_for_park()
        del self.calls[:]  # mark: only what happens from HERE counts
        # Drive the tick the way LoopingCall does, with a listener registered so it runs.
        mb._listeners.append(_FakeListener())
        tick = mb._poll_tick()
        yield self._expect_no_worker_call("the timed poll")

        self.gate["release"].set()
        yield blocking
        yield tick
        self.assertTrue(
            [c for c in self.calls if "/api/messages?" in c],
            "the poll never read the store at all, so the window above proved nothing",
        )

    def test_a_mailbox_without_the_serializer_is_refused(self):
        # No side door by construction: a deferred-capable method that reached the pool
        # directly would reopen #492 silently, so the proxy refuses to serve one.
        from posternimap.threaded import ThreadedMailbox

        class Bare:
            def preload(self):
                return None

            def fetch(self, messages, uid):
                return []

        with self.assertRaises(TypeError) as caught:
            ThreadedMailbox(Bare()).fetch
        self.assertIn("run_serialized", str(caught.exception))

    def test_every_deferred_method_goes_through_the_serializer(self):
        # The declaration and the routing cannot drift: whatever is declared
        # deferred-capable must take a turn, and nothing may reach the pool around it.
        from posternimap.threaded import _DEFERRED_METHODS, ThreadedMailbox

        mb, _tm = self._threaded(seen_writable=True, delete_writable=True)
        turns = []
        mb.run_serialized = lambda fn: turns.append(fn) or defer.succeed(None)
        tm = ThreadedMailbox(mb)

        covered = []
        for name in _DEFERRED_METHODS:
            method = getattr(mb, name, None)
            if method is None:
                continue  # e.g. `copy`, which only some mailbox shapes implement
            covered.append(name)
            before = len(turns)
            getattr(tm, name)()
            self.assertEqual(
                before + 1, len(turns), "%s did not take a turn in the queue" % name
            )
        self.assertIn("refresh_now", covered)
        self.assertIn("copy_or_move", covered)
        self.assertIn("store", covered)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class CopyMoveOneCrossingTest(_SurfaceTest):
    """COPY/MOVE crosses into the pool EXACTLY ONCE (#492).

    It used to cross twice: the door fetched the source rows (one turn), and the move ran
    from the callback on that fetch (a second turn). The reactor is free between the two,
    so a pipelined EXPUNGE or a poll tick could delete rows from the same snapshot after
    the sequence numbers had been resolved and before they were used, and the untagged
    EXPUNGE the door then emits carries positions that no longer mean what the client
    thinks they mean. A queue cannot fix that by itself: two entries are two turns by
    definition. So the COUNT is the property, and it is asserted over a real socket.
    """

    def _record_turns(self):
        """Every serialized turn taken during a drive, recorded on the CLASS.

        Patched on PosternMailbox rather than injected, so it counts the turns the real
        door takes through its real seams during a real COPY.
        """
        from posternimap.mailbox import PosternMailbox

        turns = []
        original = PosternMailbox.run_serialized

        def recording(mailbox, fn):
            turns.append(fn)
            return original(mailbox, fn)

        PosternMailbox.run_serialized = recording
        self.addCleanup(setattr, PosternMailbox, "run_serialized", original)
        return turns

    @defer.inlineCallbacks
    def test_a_copy_to_a_durable_folder_takes_exactly_one_turn(self):
        turns = self._record_turns()

        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            del turns[:]  # mark: count the COPY alone, not the SELECT that set it up
            yield proto.copy(imap4.MessageSet(1, 1), "Trash", uid=False)

        rec = yield self._drive(body)
        moves = [r for r in rec.routes() if "/api/messages/move" in r]
        self.assertEqual(
            1,
            len(moves),
            "control: the COPY never reached the move route (%r)" % (moves,),
        )
        self.assertEqual(
            1,
            len(turns),
            "COPY took %d serialized turns, so it is still resolving its source rows in "
            "one turn and moving them in another; another operation can run in between "
            "and the rows it moves are not the ones it resolved" % len(turns),
        )

    @defer.inlineCallbacks
    def test_a_move_takes_exactly_one_turn(self):
        turns = self._record_turns()

        @defer.inlineCallbacks
        def body(proto):
            yield proto.select(b"INBOX")
            del turns[:]
            yield proto.sendCommand(imap4.Command(b"MOVE", b"1 Trash"))

        rec = yield self._drive(body)
        self.assertTrue(
            any("/api/messages/move" in r for r in rec.routes()),
            "control: the MOVE never reached the move route",
        )
        self.assertEqual(1, len(turns), "MOVE took %d serialized turns" % len(turns))

    def test_copy_or_move_reports_sequence_numbers_never_uids(self):
        """The half that moved out of MoveUntaggedSequencingTest, asserted where it lives.

        The door emits the untagged EXPUNGE from whatever copy_or_move returns, so a
        uid/seq confusion in here would put UIDs on the wire as sequence numbers (#300).
        Pinned uids 101..103 against sequence numbers 1..3 so the two cannot be confused.
        """
        from twisted.mail.imap4 import MessageSet

        from posternimap.mailbox import PosternMailbox

        msgs = [
            make_message("c3", uid=103, subject="third"),
            make_message("c2", uid=102, subject="second"),
            make_message("c1", uid=101, subject="first"),
        ]
        transport = FakeTransport(
            msgs, expected_token="t", page_size=10, token_scopes={"t": "both"}
        )
        client = PosternClient("https://x", "t", transport=transport)
        mb = PosternMailbox(client, page_size=10, delete_writable=True)
        mb.preload()
        self.assertEqual([101, 102, 103], [s.uid for s in mb._summaries])

        removed = mb.copy_or_move(MessageSet(1, 2), False, "trash")
        self.assertEqual(
            [2, 1],
            removed,
            "copy_or_move must report 1-based SEQUENCE numbers, descending; %r looks "
            "like uids leaking onto the wire as sequence numbers" % (removed,),
        )
        self.assertTrue(
            any("/api/messages/move" in c for c in transport.calls),
            "control: no move was actually made",
        )


class _FakeListener:
    def newMessages(self, exists, recent):
        return None


def _poll_until(predicate, tries=200):
    def step(_result=None, left=tries):
        if predicate():
            return None
        if left <= 0:
            raise AssertionError("condition never became true")
        return task.deferLater(reactor, 0.01, lambda: None).addCallback(
            lambda _r: step(left=left - 1)
        )

    return defer.maybeDeferred(step)

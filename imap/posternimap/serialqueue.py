"""One mailbox operation at a time, ordered, without a pool thread waiting (#492).

WHAT THIS FIXES. Twisted does NOT serialize commands per connection: `blocked` is set
only inside `__cbFetch`, so every other command dispatches the moment its line is parsed.
Measured identically on Twisted 24.3.0 and 26.4.0, and it is not a client-behaviour
question either -- RFC 3501 / RFC 9051 section 5.5 puts the obligation on the SERVER, and
mutt (pipeline depth 15) and mbsync (unlimited) pipeline by default. So two commands
against the SAME mailbox could be in flight in the reactor threadpool at once, each
having resolved sequence numbers against a snapshot the other was mutating: a STORE
landing on the row an EXPUNGE had just shifted, silently, with a tagged OK.

WHY A QUEUE AND NOT A MUTEX. A mutex makes the second caller WAIT INSIDE A POOL THREAD.
The pool is ten threads (threaded.py), so ten waiters is the whole pool consumed by calls
that are doing nothing, and the eleventh command -- from a completely different client, on
a completely different mailbox -- queues behind them. That is exactly the starvation #416
exists to prevent, reintroduced one level down. A mutex also gives no ordering guarantee:
it wakes whichever waiter the OS picks, so a caller can be starved by luck.

This queue holds waiters as Deferreds ON THE REACTOR THREAD, which cost no thread at all,
and runs them strictly FIFO, so a caller waits for exactly the work queued ahead of it and
never longer. The pool stays free for other mailboxes.

WHAT IT DOES NOT DO. It does not make an operation atomic against work that never enters
it. The contract is that every worker-touching mailbox operation goes through
`PosternMailbox.run_serialized` -- the threaded proxy for the seams Twisted invokes, and
the poll tick for its own -- and that a compound operation (COPY/MOVE resolving rows and
then moving them) is ONE function submitted once, not two submitted twice. Two entries can
be interleaved by definition; that is what a queue is.

THREADING. Every method here runs on the reactor thread and none of them block, so this
needs no lock of its own. The work it submits is what goes to the pool.
"""

from __future__ import annotations

from collections import deque
from typing import Any, Callable, Deque, Tuple

from twisted.internet import defer
from twisted.python import failure


class SerialQueue:
    """FIFO queue with at most ONE operation in flight.

    `execute` is the seam that actually runs a submitted callable and answers with a
    Deferred (in production, the reactor threadpool via PosternMailbox._dispatch). It is
    injected rather than imported so the ordering can be tested on its own, with no
    reactor and no threads in the way.
    """

    def __init__(self, execute: Callable[[Callable[[], Any]], defer.Deferred]) -> None:
        self._execute = execute
        self._pending: Deque[Tuple[Callable[[], Any], defer.Deferred]] = deque()
        self._running = False
        self._pumping = False

    def run(self, fn: Callable[[], Any]) -> defer.Deferred:
        """Submit `fn`; returns a Deferred that fires with its result, in turn."""
        waiter: defer.Deferred = defer.Deferred()
        self._pending.append((fn, waiter))
        self._pump()
        return waiter

    @property
    def busy(self) -> bool:
        """True while an operation is in flight."""
        return self._running

    @property
    def waiting(self) -> int:
        """How many operations are queued behind the one in flight."""
        return len(self._pending)

    def _pump(self) -> None:
        """Start operations while the queue is idle.

        A LOOP rather than recursion: `execute` fires synchronously when no reactor is
        running (threaded.in_pool falls back to defer.execute), so a recursive pump would
        grow the stack by one frame per queued operation. The re-entrancy guard is what
        lets _finish call back in here unconditionally without the loop running twice.
        """
        if self._pumping:
            return
        self._pumping = True
        try:
            while self._pending and not self._running:
                fn, waiter = self._pending.popleft()
                self._running = True
                self._start(fn, waiter)
        finally:
            self._pumping = False

    def _start(self, fn: Callable[[], Any], waiter: defer.Deferred) -> None:
        try:
            running = self._execute(fn)
        except Exception:
            # A dispatch that raises SYNCHRONOUSLY must not wedge the queue with _running
            # stuck True and every later operation waiting on a call that never happened.
            self._finish(failure.Failure(), waiter)
            return
        running.addBoth(self._finish, waiter)

    def _finish(self, result: Any, waiter: defer.Deferred) -> None:
        """Deliver one result, then start the next.

        ORDER MATTERS. The waiter is fired while _running is still True, so anything its
        own callbacks submit re-entrantly (a NOOP chaining another read, a poll tick
        landing in the same turn) goes to the BACK of the queue rather than jumping ahead
        of operations already waiting. _running drops afterwards, and only then does the
        next operation start.

        Returns None so a failure is consumed HERE: it belongs to the waiter now, and
        leaving it in the dispatch chain as well would report every handled error a second
        time as an unhandled one.
        """
        try:
            if isinstance(result, failure.Failure):
                waiter.errback(result)
            else:
                waiter.callback(result)
        finally:
            self._running = False
            self._pump()
        return None

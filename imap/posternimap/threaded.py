"""Run the door blocking worker calls OFF the reactor thread (#416 part 2).

MEASURED PROBLEM. Every Postern API call was made with blocking http.client ON the single
Twisted reactor thread, so one slow worker call stalled EVERY connected client, not just
the caller. The stall equalled the call duration exactly (a 2.0s call froze the reactor
for 2017ms against a 20ms heartbeat), and api_timeout defaults to 15s, so the worst case
was a fifteen-second freeze of the whole door. Numbers and method: imap/bench/.

SHAPE. Twisted IMAP4Server already wraps the interesting mailbox and account entry points
in maybeDeferred (select, listMailboxes, requestStatus, fetch, search, store, expunge,
addMessage, and authenticateLogin), so those seams may return a Deferred. The ones it does
NOT wrap -- getMessageCount, getUIDValidity, getUIDNext, getRecentCount, getUnseenCount,
isWriteable, getFlags, getHierarchicalDelimiter -- must stay synchronous and must
therefore never touch the network. That is why the account PRELOADS a mailbox inside the
pool before handing it over: after that, the sync accessors read state that is already in
memory.

WHY A PROXY rather than making PosternMailbox itself return Deferreds: the mailbox is the
door pure, synchronous, heavily tested core (489 tests drive it directly). Changing its
return types would rewrite that suite and put Deferred plumbing in the layer that should
stay easy to reason about. The proxy is the thin Twisted-facing shell, and the thing it
wraps stays exactly what it was.

BOUNDED. deferToThread uses the reactor threadpool, whose default maximum is 10 threads
(twisted.internet.base.ReactorBase.threadpool / suggestThreadPoolSize). A hung worker can
therefore consume at most ten threads, not unbounded ones. It is deliberately not raised
here: ten concurrent stalled calls is already a door in trouble, and a bigger pool would
hide that rather than fix it.
"""

from __future__ import annotations

from typing import Any

from twisted.internet import defer, reactor, threads
from twisted.python import failure
from zope.interface import directlyProvides, providedBy

# The mailbox methods Twisted invokes through maybeDeferred, and which therefore may
# answer with a Deferred. Anything not listed is a synchronous accessor and is delegated
# untouched (it must not do I/O; the preload in PosternAccount.select is what makes that
# true, and test_reactor_nonblocking.py is what keeps it true).
_DEFERRED_METHODS = (
    "fetch",
    "search",
    "search_substr",
    "store",
    "expunge",
    "addMessage",
    "requestStatus",
    "soft_move_fetched_messages",
    "copy",
)


def in_pool(fn, *args, **kwargs):
    """Run a blocking door call in the reactor threadpool, returning a Deferred.

    With NO reactor running the work is done inline and wrapped in an already-fired
    Deferred. That is not a test affordance, it is the only correct answer: deferToThread
    delivers its result via reactor.callFromThread, so without a running reactor the
    callback would never fire and the caller would wait forever. Production always has a
    running reactor by the time a connection is accepted (the listeners come up with it),
    so the threaded branch is what production takes, every time. The reactor-running
    branch is proven by test_reactor_nonblocking, which asserts against real thread
    identities through a real reactor rather than trusting this comment.
    """
    import sys, threading as _t
    print('DEBUG in_pool enter', getattr(fn, "__name__", fn), 'thread=', _t.current_thread().name, file=sys.stderr, flush=True)
    if not reactor.running:
        return defer.execute(fn, *args, **kwargs)
    return threads.deferToThread(_flattened, fn, *args, **kwargs)


def _flattened(fn, *args, **kwargs):
    """Call fn IN THE WORKER THREAD and never hand a Deferred back across the boundary.

    Some door methods already answer with a Deferred even though their body blocks
    (PosternMailbox.addMessage returns defer.succeed / defer.fail around synchronous
    worker calls). Returning one of those as the RESULT of deferToThread hangs the
    command: a Deferred is not thread-safe, it was created off the reactor thread, and
    the chain simply never resumes. Observed, not theorized -- APPEND hung until this
    existed, and the thread dump showed an idle pool and an idle reactor with the result
    stranded between them.

    So the Deferred is unwrapped HERE, in the thread that made it, before anything
    crosses back. An unfired one is a loud error rather than a silent hang: it would mean
    a door method is doing genuinely asynchronous work, which this seam cannot carry and
    which nobody should discover through a stuck mail client.
    """
    out = fn(*args, **kwargs)
    if not isinstance(out, defer.Deferred):
        return out
    box = []
    out.addBoth(box.append)
    if not box:
        raise RuntimeError(
            "threaded door call %r returned an UNFIRED Deferred; this seam runs blocking "
            "work and cannot carry asynchronous results" % getattr(fn, "__name__", fn)
        )
    result = box[0]
    if isinstance(result, failure.Failure):
        result.raiseException()
    return result


class ThreadedMailbox:
    """Twisted-facing shell around PosternMailbox (#416).

    Deferred-capable methods run in the pool; every other attribute is delegated
    unchanged, so the wrapped mailbox stays the single implementation of door behavior.
    """

    def __init__(self, mailbox: Any) -> None:
        # Bypass __setattr__ delegation for our own field.
        object.__setattr__(self, "_mailbox", mailbox)
        # Twisted ADAPTS the mailbox rather than duck-typing it: ISearchableMailbox(mbox,
        # None) at imap4.py:1634 and IMessageCopier(mbox, None) at :2328. A proxy that did
        # not carry the wrapped declarations would adapt to None, and Twisted would
        # silently fall back to its own generic SEARCH and COPY over fetch -- the door
        # server-side search would just stop being used, with every test still green
        # because the results would still be correct, only slower and differently scoped.
        # Copy the declarations across so the adaptation finds exactly what it found
        # before.
        directlyProvides(self, providedBy(mailbox))

    @property
    def mailbox(self) -> Any:
        """The wrapped PosternMailbox (tests and the door own code reach through)."""
        return object.__getattribute__(self, "_mailbox")

    def __getattr__(self, name: str) -> Any:
        target = object.__getattribute__(self, "_mailbox")
        value = getattr(target, name)
        if name in _DEFERRED_METHODS and callable(value):
            def deferred_call(*args, **kwargs):
                return in_pool(value, *args, **kwargs)

            return deferred_call
        return value

    def __setattr__(self, name: str, value: Any) -> None:
        # Dunder attributes stay on the PROXY. zope declares interfaces by assigning
        # __provides__, so a blanket delegation would write the declaration onto the
        # wrapped mailbox and leave the proxy adapting to None -- which is precisely the
        # silent SEARCH/COPY fallback the declaration copy above exists to prevent. Found
        # by asserting the adaptation rather than assuming it.
        if name.startswith("__") and name.endswith("__"):
            object.__setattr__(self, name, value)
            return
        setattr(object.__getattribute__(self, "_mailbox"), name, value)

    def __repr__(self) -> str:
        return "ThreadedMailbox(%r)" % (object.__getattribute__(self, "_mailbox"),)


class ThreadedAccount:
    """Twisted-facing shell around PosternAccount (#416).

    Twisted invokes account.select and account.listMailboxes through maybeDeferred, so
    both may answer with a Deferred; every other account method is a local lookup with no
    I/O (appendability, copyability, placement_mailbox, restore_direction, isSubscribed)
    and is delegated untouched.

    select does the LOAD as well as the build, inside the pool. That is what makes the
    synchronous IMailbox accessors safe: getMessageCount, getUIDNext, getUID, firstUnseen
    and getUnseenCount all lazily _ensure_loaded, Twisted calls them straight after SELECT
    without a Deferred seam to hang I/O on, and the door SELECT response reads four of
    them in a row. Preloading turns every one of those into a memory read.

    The account itself stays exactly what it was: synchronous, and covered by its own
    suite. Wrapping happens once, in the realm, so production gets the threaded shell and
    the tests keep driving the plain object.
    """

    def __init__(self, account: Any) -> None:
        object.__setattr__(self, "_account", account)
        directlyProvides(self, providedBy(account))

    @property
    def account(self) -> Any:
        return object.__getattribute__(self, "_account")

    def select(self, name: str, rw: bool = True):
        account = object.__getattribute__(self, "_account")

        def build():
            mailbox = account.select(name, rw)
            if mailbox is None:
                return None
            preload = getattr(mailbox, "preload", None)
            if callable(preload):
                preload()
            # The Roles parent (\\Noselect) is not a mailbox and has no store behind it;
            # it never reaches select, but if it ever did, wrapping it would be wrong.
            if preload is None:
                return mailbox
            return ThreadedMailbox(mailbox)

        return in_pool(build)

    def listMailboxes(self, ref: str, wildcard: str):
        account = object.__getattribute__(self, "_account")

        def build():
            out = []
            for name, mailbox in account.listMailboxes(ref, wildcard):
                # LIST only reads getFlags + getHierarchicalDelimiter, both pure, so the
                # listing is NOT preloaded: a LIST would otherwise fetch every folder
                # snapshot to answer a question about names. The BUILD is what goes in
                # the pool, because durable folder UIDVALIDITY is read through from the
                # worker on first use.
                out.append((name, ThreadedMailbox(mailbox) if hasattr(mailbox, "preload") else mailbox))
            return out

        return in_pool(build)

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_account"), name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("__") and name.endswith("__"):
            object.__setattr__(self, name, value)
            return
        setattr(object.__getattribute__(self, "_account"), name, value)

    def __repr__(self) -> str:
        return "ThreadedAccount(%r)" % (object.__getattribute__(self, "_account"),)

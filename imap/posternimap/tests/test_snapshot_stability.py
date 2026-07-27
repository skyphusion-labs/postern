"""#492 step 0: the live snapshot is never re-sorted in place during a refresh.

`_refresh` used to end with `self._summaries.sort(key=lambda s: s.uid)`. That sort
REORDERED NOTHING (the snapshot is uid-ascending by construction, and every collected
arrival has uid > the previous high-water mark, so the extend already lands in order),
but it was not free: CPython DETACHES the backing array for the whole duration of a
keyed sort, so a concurrent reader sees an EMPTY list. `_refresh` runs in the reactor
threadpool (#485) while the synchronous IMailbox accessors -- `getMessageCount` after an
APPEND, `getUID` after a STORE -- run on the reactor thread, with nothing serializing the
two. The observable failure was `* 0 EXISTS` pushed for a non-empty mailbox, which makes a
client wipe its view of the folder.

Two tests, ported from the sprint-8 measurement branch (rollins/492-measurement, R4 and
R2) and rewritten as regression gates:

  1. RefreshSortTest    -- the direct root cause: no in-place sort of the live snapshot.
  2. RefreshWindowTest  -- the harm: a reactor-thread accessor mid-refresh never sees a
                           detached snapshot.

Both go RED if the sort is reintroduced.
"""

from __future__ import annotations

import threading
import unittest

from posternimap.client import PosternClient
from posternimap.tests.fakes import FakeTransport, make_message


class RefreshSortTest(unittest.TestCase):
    """R4 ported: `_refresh` must not sort the live snapshot in place.

    The snapshot is uid-ascending by construction: `_ensure_loaded` sorts and the window
    slice preserves order, `_refresh` collects only rows with uid > `_newest_uid` and
    sorts THOSE (a local list) before extending, and expunge / soft-move only delete.
    A sort of the live list is therefore a no-op that buys nothing and opens a window
    (see RefreshWindowTest).
    """

    def test_refresh_does_not_sort_the_live_snapshot(self):
        from posternimap.mailbox import PosternMailbox

        sorts = []

        class WatchedList(list):
            def sort(self, *a, **kw):
                before = [s.uid for s in self]
                super().sort(*a, **kw)
                sorts.append((before, [s.uid for s in self]))

        msgs = [make_message("m%d" % i) for i in range(6, 0, -1)]
        transport = FakeTransport(msgs, expected_token="t", page_size=2)
        client = PosternClient("https://x", "t", transport=transport)
        mb = PosternMailbox(client, page_size=2)
        self.assertEqual(6, mb.getMessageCount())
        mb._summaries = WatchedList(mb._summaries)

        for n in range(7, 12):
            msgs.insert(0, make_message("m%d" % n))
            # The refresh has to actually do its job, or this test would pass on a
            # `_refresh` that stopped growing the snapshot at all.
            self.assertEqual(1, mb.refresh_now())
            uids = [s.uid for s in mb._summaries]
            self.assertEqual(sorted(uids), uids, "the snapshot left uid order: %r" % (uids,))

        self.assertEqual(11, mb.getMessageCount())
        self.assertEqual(
            [],
            sorts,
            "_refresh sorted the live snapshot in place (%d times, %r). CPython detaches "
            "the backing array for the whole sort, so a reactor-thread accessor reading it "
            "mid-refresh sees an EMPTY mailbox (#492)." % (len(sorts), sorts),
        )


class ParkingSummary:
    """A snapshot row whose `uid` read can be parked, so the window is observable.

    Not a test affordance bolted onto production code: the sort this guards against
    really does read `s.uid` on every live row (`key=lambda s: s.uid`), and CPython holds
    the list empty for that whole traversal. Parking inside the key is how a ~10%
    probabilistic window at 500 rows is turned into a deterministic assertion instead of
    a flaky one.

    It parks ONLY the pooled refresh thread (`gate["thread"]`). The reactor-side probe
    reads the same rows, and a park there would just be the test blocking on itself.
    """

    def __init__(self, inner, gate, entered):
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_gate", gate)
        object.__setattr__(self, "_entered", entered)

    @property
    def uid(self):
        gate = object.__getattribute__(self, "_gate")
        if gate["armed"] and threading.get_ident() == gate["thread"]:
            gate["armed"] = False
            object.__getattribute__(self, "_entered").set()
            gate["release"].wait(10)
        return object.__getattribute__(self, "_inner").uid

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, "_inner"), name)

    def __setattr__(self, name, value):
        setattr(object.__getattribute__(self, "_inner"), name, value)


class RefreshWindowTest(unittest.TestCase):
    """R2 ported: NO client pipelining needed. One pooled refresh (the 30s LoopingCall
    tick, or a do_NOOP through ThreadedMailbox) against the synchronous accessors Twisted
    calls straight from the reactor thread (`__cbStore` -> getUID, `__cbAppend` ->
    getMessageCount).
    """

    def setUp(self):
        self.msgs = [
            make_message("m3", subject="third"),
            make_message("m2", subject="second"),
            make_message("m1", subject="first"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="t", page_size=10)
        self.client = PosternClient("https://x", "t", transport=self.transport)

    def test_reactor_accessors_never_see_a_detached_snapshot(self):
        from posternimap.mailbox import PosternMailbox

        mb = PosternMailbox(self.client, page_size=10)
        self.assertEqual(3, mb.getMessageCount())

        gate = {"armed": False, "release": threading.Event(), "thread": None}
        entered = threading.Event()
        mb._summaries = [ParkingSummary(s, gate, entered) for s in mb._summaries]

        self.msgs.insert(0, make_message("m4", subject="new arrival"))

        errors = []

        def refresher():
            gate["thread"] = threading.get_ident()
            gate["armed"] = True
            try:
                mb.refresh_now()
            except Exception as exc:  # noqa: BLE001
                errors.append(("refresh", exc))

        t = threading.Thread(target=refresher, name="pool-poll-refresh")
        t.start()
        # Park inside the window if one is opened; otherwise fall through the moment the
        # refresh is done (nothing read a live row uid, so nothing can park any more).
        while t.is_alive() and not entered.is_set():
            entered.wait(0.01)
        parked = entered.is_set()

        # The reactor thread. Mid-sort if the defect is back, post-refresh if not.
        count = mb.getMessageCount()
        try:
            got = mb.getUID(1)
        except Exception as exc:  # noqa: BLE001
            errors.append(("getUID", exc))
            got = None

        gate["release"].set()
        t.join(10)
        self.assertFalse(t.is_alive(), "the refresh thread never finished")

        self.assertEqual(
            [],
            errors,
            "a reactor-thread accessor raised while a pooled refresh held the snapshot "
            "in sort: %r (count seen: %r)" % (errors, count),
        )
        self.assertNotEqual(
            0,
            count,
            "getMessageCount returned 0 during a pooled refresh: the door would push "
            "* 0 EXISTS and a client would wipe its view of a non-empty mailbox (#492)",
        )
        self.assertIsNotNone(got)
        self.assertFalse(
            parked,
            "a pooled refresh read a LIVE snapshot row uid, i.e. it sorted the list the "
            "reactor thread reads. That window is exactly #492; nothing in _refresh has "
            "any reason to traverse existing rows.",
        )
        # The refresh still did its job.
        self.assertEqual(4, mb.getMessageCount())
        self.assertEqual([1, 2, 3, 4], [s.uid for s in mb._summaries])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

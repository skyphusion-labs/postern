"""Tests for the reactor-threadpool saturation signal (#458).

#416 part 2 made a hung Worker QUIET: the door stays responsive and absorbs the
stalls, so ten stalled pool threads is the pool exhausted and the eleventh command
queues behind them with nothing in the logs saying why. These pin that it says why.

Every log assertion has a control: the not-saturated case must produce NO line, or a
watch that logged unconditionally would pass every test here.
"""

from __future__ import annotations

import unittest

try:
    from twisted.internet import defer, reactor, task
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore


class _Clock:
    def __init__(self) -> None:
        self.t = 500.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class _FakePool:
    """The shape of twisted.python.threadpool.ThreadPool this watch reads."""

    def __init__(self, busy: int, size: int) -> None:
        self.working = ["worker"] * busy
        self.max = size


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class PoolSaturationWatchTest(unittest.TestCase):
    def setUp(self):
        from posternimap.threaded import PoolSaturationWatch

        self.clock = _Clock()
        self.lines = []
        self.w = PoolSaturationWatch(
            log_interval=60.0, now=self.clock, log=self.lines.append
        )

    def test_a_pool_with_room_logs_nothing(self):
        # CONTROL. Without this, a watch that logged on every dispatch would satisfy
        # every other assertion in this file.
        for busy in range(0, 10):
            self.w.observe(busy, 10)
        self.assertEqual(self.lines, [])

    def test_saturation_logs_once_with_the_numbers(self):
        self.w.observe(10, 10)
        self.assertEqual(len(self.lines), 1)
        self.assertIn("SATURATED", self.lines[0])
        self.assertIn("10/10", self.lines[0])

    def test_repeat_saturation_is_rate_limited_then_reports_the_backlog(self):
        self.w.observe(10, 10)
        for _ in range(50):
            self.clock.advance(0.5)
            self.w.observe(10, 10)
        self.assertEqual(len(self.lines), 1)  # 25s of stalls, still one line
        self.clock.advance(40.0)
        self.w.observe(10, 10)
        self.assertEqual(len(self.lines), 2)
        # The rate limit must not HIDE anything: the suppressed dispatches are counted.
        self.assertIn("STILL SATURATED", self.lines[1])
        self.assertIn("52 dispatches queued", self.lines[1])

    def test_recovery_is_logged_once_with_what_it_cost(self):
        self.w.observe(10, 10)
        self.w.observe(10, 10)
        self.clock.advance(12.0)
        self.w.observe(3, 10)
        self.assertEqual(len(self.lines), 2)
        self.assertIn("RECOVERED", self.lines[1])
        self.assertIn("2 dispatches queued", self.lines[1])
        # ... and staying healthy is silent again.
        self.w.observe(1, 10)
        self.assertEqual(len(self.lines), 2)

    def test_observe_pool_reads_a_real_pool_shape(self):
        self.w.observe_pool(_FakePool(10, 10))
        self.assertEqual(len(self.lines), 1)
        self.w.observe_pool(_FakePool(9, 10))
        self.assertIn("RECOVERED", self.lines[-1])

    def test_a_zero_sized_pool_is_ignored_not_reported_as_saturated(self):
        self.w.observe(0, 0)
        self.assertEqual(self.lines, [])


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class InPoolObservesTheRealPoolTest(twisted_unittest.TestCase):
    """The seam itself: in_pool must observe the LIVE reactor threadpool on dispatch.

    Trial runs with a real running reactor, so this exercises the production branch of
    in_pool (deferToThread), not the no-reactor fallback.
    """

    @defer.inlineCallbacks
    def _reactor_is_running(self):
        """Hand control back to trial so the reactor is actually SPINNING.

        A trial test body runs before that happens, and `in_pool` takes its inline
        (defer.execute) branch when the reactor is not running -- which is correct
        production behavior, and would make every assertion below test the wrong
        branch. One deferLater is enough to be past it.
        """
        yield task.deferLater(reactor, 0, lambda: None)
        self.assertTrue(reactor.running)

    @defer.inlineCallbacks
    def test_dispatch_observes_the_live_pool(self):
        # The wiring, against the REAL reactor threadpool: one dispatch, one
        # observation, reporting that pool's actual ceiling.
        from posternimap import threaded

        yield self._reactor_is_running()
        seen = []

        class _Recorder:
            def observe_pool(self, pool):
                seen.append((len(pool.working), pool.max))

        self.patch(threaded, "_POOL_WATCH", _Recorder())
        result = yield threaded.in_pool(lambda: 42)
        self.assertEqual(result, 42)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][1], reactor.getThreadPool().max)

    @defer.inlineCallbacks
    def test_a_genuinely_full_pool_is_reported(self):
        """The un-stubbable half: fill the REAL pool and watch the door say so.

        The unit tests above prove the watch's arithmetic against a hand-cranked
        clock and a fake pool shape. They cannot prove that `len(pool.working)`
        actually reaches `pool.max` on a live Twisted threadpool, which is the only
        reason the signal exists. So this occupies every thread the pool may run,
        with real blocked worker threads, and asserts the next dispatch says
        SATURATED.
        """
        import threading
        import time

        from posternimap import threaded

        yield self._reactor_is_running()
        pool = reactor.getThreadPool()
        lines = []
        watch = threaded.PoolSaturationWatch(log_interval=0.0, log=lines.append)
        self.patch(threaded, "_POOL_WATCH", watch)

        release = threading.Event()
        self.addCleanup(release.set)
        held = [threaded.in_pool(release.wait, 30) for _ in range(pool.max)]

        deadline = time.time() + 10.0
        while len(pool.working) < pool.max and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(pool.working), pool.max, "the pool never filled")

        lines.clear()
        queued = threaded.in_pool(lambda: "queued behind them")
        self.assertTrue(
            any("SATURATED" in line for line in lines),
            "a dispatch into a full pool produced no saturation line: %r" % (lines,),
        )
        release.set()
        yield defer.gatherResults(held + [queued])


if __name__ == "__main__":
    unittest.main()

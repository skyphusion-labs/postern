"""Tests for the flag-gated measurement layer (measure.py) and its read-path wiring.

The Meter unit tests are pure (injected emit + clock, no Twisted). The wiring tests
build a real mailbox/client/message with an ENABLED meter and assert the expected
@measure events fire -- and, crucially, that a body-free scan emits ZERO hydrate
events (the #102 lazy-hydration claim, made checkable). A final test proves a
DISABLED meter emits nothing through the whole read path (the no-behaviour-change
invariant for the flag-off default).
"""

from __future__ import annotations

import json
import unittest
from typing import Any, Dict, List, Tuple

from posternimap.measure import Meter

try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False

from posternimap.client import PosternClient
from posternimap.tests.fakes import FakeTransport, make_message


class _Sink:
    """Collects (name, fields) emitted by an enabled Meter, for assertions."""

    def __init__(self) -> None:
        self.events: List[Tuple[str, Dict[str, Any]]] = []

    def __call__(self, name: str, fields: Dict[str, Any]) -> None:
        self.events.append((name, fields))

    def names(self) -> List[str]:
        return [n for n, _ in self.events]

    def of(self, name: str) -> List[Dict[str, Any]]:
        return [f for n, f in self.events if n == name]


class _FakeClock:
    """Returns preset values on each call so elapsed_ms is deterministic."""

    def __init__(self, ticks: List[float]) -> None:
        self._ticks = list(ticks)

    def __call__(self) -> float:
        return self._ticks.pop(0)


class MeterUnitTest(unittest.TestCase):
    def test_disabled_meter_is_a_noop(self):
        sink = _Sink()
        m = Meter(False, emit=sink)
        self.assertFalse(m.enabled)
        m.event("x", a=1)
        with m.timed("y", b=2) as span:
            span.set(c=3)  # accepted but discarded
        self.assertEqual(sink.events, [])

    def test_event_emits_fields(self):
        sink = _Sink()
        m = Meter(True, emit=sink)
        self.assertTrue(m.enabled)
        m.event("api_up", count=2)
        self.assertEqual(sink.names(), ["api_up"])
        self.assertEqual(sink.of("api_up")[0], {"count": 2})

    def test_timed_records_elapsed_and_span_fields(self):
        sink = _Sink()
        m = Meter(True, emit=sink, clock=_FakeClock([1.0, 1.25]))
        with m.timed("cold_sync", direction="all") as span:
            span.set(pages=3, collected=42)
        self.assertEqual(sink.names(), ["cold_sync"])
        f = sink.of("cold_sync")[0]
        self.assertEqual(f["direction"], "all")
        self.assertEqual(f["pages"], 3)
        self.assertEqual(f["collected"], 42)
        self.assertEqual(f["elapsed_ms"], 250.0)  # (1.25 - 1.0) * 1000

    def test_timed_emits_even_when_block_raises(self):
        sink = _Sink()
        m = Meter(True, emit=sink, clock=_FakeClock([2.0, 2.1]))
        with self.assertRaises(ValueError):
            with m.timed("api_request", path="/api/messages") as span:
                span.set(status=200)
                raise ValueError("boom")
        # Latency is still recorded, with whatever was set before the raise.
        self.assertEqual(sink.names(), ["api_request"])
        f = sink.of("api_request")[0]
        self.assertEqual(f["status"], 200)
        self.assertIn("elapsed_ms", f)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class MeterDefaultSinkTest(unittest.TestCase):
    def test_default_sink_writes_one_structured_measure_line(self):
        from twisted.python import log

        captured: List[Dict[str, Any]] = []
        log.addObserver(captured.append)
        self.addCleanup(log.removeObserver, captured.append)

        Meter(True).event("cold_sync", pages=1, collected=5)  # default sink = twisted log

        lines = [
            part
            for e in captured
            for part in (e.get("message") or ())
            if isinstance(part, str) and part.startswith("@measure ")
        ]
        self.assertEqual(len(lines), 1)
        _tag, name, payload = lines[0].split(" ", 2)
        self.assertEqual(name, "cold_sync")
        self.assertEqual(json.loads(payload), {"collected": 5, "pages": 1})
        self.assertTrue(any(e.get("system") == "postern-imap" for e in captured))


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ReadPathMeasurementTest(unittest.TestCase):
    def setUp(self):
        # newest-first, as the API returns it
        self.msgs = [
            make_message("m3", direction="outbound", subject="sent"),
            make_message("m2", subject="second"),
            make_message("m1", subject="first"),
        ]
        # A distinctive token so the "never leaked into a measurement line" assertion
        # is meaningful (a single-char token would substring-match every JSON key).
        self.token = "secret-tok-abc123"
        self.transport = FakeTransport(self.msgs, expected_token=self.token, page_size=2)
        self.sink = _Sink()
        self.meter = Meter(True, emit=self.sink)
        self.client = PosternClient("https://x", self.token, transport=self.transport, meter=self.meter)

    def _mailbox(self, **kw):
        from posternimap.mailbox import PosternMailbox

        return PosternMailbox(self.client, page_size=2, meter=self.meter, **kw)

    def test_cold_sync_and_api_request_fire_on_select(self):
        mb = self._mailbox()
        self.assertEqual(mb.getMessageCount(), 3)
        self.assertIn("cold_sync", self.sink.names())
        self.assertIn("api_request", self.sink.names())

        cs = self.sink.of("cold_sync")[0]
        self.assertEqual(cs["collected"], 3)
        self.assertEqual(cs["presented"], 3)
        self.assertEqual(cs["pages"], 2)  # 3 messages at page_size 2 -> 2 pages
        self.assertFalse(cs["windowed"])
        self.assertIn("elapsed_ms", cs)

        ar = self.sink.of("api_request")[0]
        self.assertEqual(ar["path"], "/api/messages")
        self.assertEqual(ar["status"], 200)
        self.assertIn("bytes", ar)
        # The token never appears in a measurement line (paths/counts/sizes only).
        self.assertNotIn(self.token, json.dumps(self.sink.events))

    def test_window_saturation_recorded(self):
        mb = self._mailbox(window=2)
        self.assertEqual(mb.getMessageCount(), 2)
        cs = self.sink.of("cold_sync")[0]
        self.assertEqual(cs["collected"], 3)
        self.assertEqual(cs["presented"], 2)
        self.assertTrue(cs["windowed"])
        self.assertEqual(cs["window"], 2)

    def test_envelope_scan_emits_zero_hydrate_then_open_emits_one(self):
        from twisted.mail.imap4 import MessageSet

        mb = self._mailbox()
        got = list(mb.fetch(MessageSet(1, 3), uid=False))
        # ENVELOPE / whole-header scan: body-free, so NO hydrate event and NO body GET.
        for _seq, msg in got:
            msg.getHeaders(True)
        self.assertEqual(self.sink.of("hydrate"), [])
        self.assertEqual(self.transport.body_fetches, 0)

        # Opening one message hydrates exactly once.
        got[0][1].getBodyFile()
        hyd = self.sink.of("hydrate")
        self.assertEqual(len(hyd), 1)
        self.assertIn("uid", hyd[0])
        self.assertIn("bytes", hyd[0])
        self.assertFalse(hyd[0]["placeholder"])
        self.assertEqual(self.transport.body_fetches, 1)

    def test_disabled_meter_emits_nothing_through_read_path(self):
        from posternimap.mailbox import PosternMailbox

        sink = _Sink()
        # Disabled meter, sink injected only to prove it is never called.
        meter = Meter(False, emit=sink)
        client = PosternClient("https://x", self.token, transport=self.transport, meter=meter)
        mb = PosternMailbox(client, page_size=2, meter=meter)
        self.assertEqual(mb.getMessageCount(), 3)  # full read path exercised
        self.assertEqual(sink.events, [])


if __name__ == "__main__":
    unittest.main()

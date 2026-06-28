"""Flag-gated, structured measurement for the postern-imap read path.

GO-LIVE.md step 0.6 / #102 Stage 1: additive, behaviour-neutral instrumentation on
the read path so the Stage-1 windowing / live-refresh / lazy-hydration / UID model
can be validated on the live (post-0005) store. It answers the questions the code
comments call "measurement-informed":

  - cold-sync cost + window saturation  (config: POSTERN_IMAP_WINDOW = 500 is a
    "measurement-informed starting point") -- how many summaries a SELECT pulls,
    total collected vs presented after the window cap, how often W actually truncates.
  - per-request Postern API latency      -- the cost of the blocking-urllib I/O model.
  - live-refresh poll reactor stall      (config: "a deferToThread variant is a clean
    follow-up if measurement shows reactor stalls under concurrent SELECTs") -- how
    long the poll's blocking urllib holds the reactor thread per tick.
  - lazy-body hydration                  (#102 core: "FETCH 1:* ENVELOPE costs zero
    per-message body GETs") -- one line per body actually fetched, so an envelope
    scan that hydrates nothing emits zero hydrate lines = the claim, made checkable.

OFF by default (POSTERN_IMAP_MEASURE). Disabled, every hook is a no-op: no clock
read, no JSON, no log line, no allocation -- so the read path is byte-for-byte the
un-instrumented path. Enabled, each measurement is ONE GMCP-style structured line on
the Twisted log (journald via the systemd unit), the machine-readable state channel
the house style asks for (assert on the JSON, not prose):

    @measure <event> {"k":v,...}

It NEVER emits message content, addresses, subjects, or a token -- only counts,
sizes, and timings. See imap/MEASUREMENT.md for the event catalogue + thresholds.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from time import perf_counter
from typing import Any, Callable, Dict, Iterator, Optional, Protocol

# Injectable sink for tests (name, fields) -> None; default writes to the Twisted log.
EmitFn = Callable[[str, Dict[str, Any]], None]
# Injectable monotonic clock for tests; default time.perf_counter.
ClockFn = Callable[[], float]


class Span(Protocol):
    """A field bag a timed() block can attach measured counts/sizes to.

    Call set() to record values discovered mid-block (e.g. how many summaries a
    cold sync collected). On a disabled meter the yielded span is a no-op, so the
    instrumented code reads identically whether measurement is on or off.
    """

    def set(self, **fields: Any) -> None: ...


class _Span:
    """The real span: accumulates fields the Meter merges into the emitted line."""

    __slots__ = ("fields",)

    def __init__(self) -> None:
        self.fields: Dict[str, Any] = {}

    def set(self, **fields: Any) -> None:
        self.fields.update(fields)


class _NullSpan:
    """The disabled span: set() is a no-op so the off-path allocates and stores nothing."""

    __slots__ = ()

    def set(self, **fields: Any) -> None:
        return None


_NULL_SPAN = _NullSpan()


class Meter:
    """A flag-gated structured measurement sink for one proxy session.

    enabled=False (the default) makes event() and timed() no-ops. `emit` and `clock`
    are injectable for tests; in production both default in (Twisted log + perf_counter).
    """

    __slots__ = ("_enabled", "_emit", "_clock")

    def __init__(
        self,
        enabled: bool = False,
        *,
        emit: Optional[EmitFn] = None,
        clock: Optional[ClockFn] = None,
    ) -> None:
        self._enabled = bool(enabled)
        self._emit = emit
        self._clock = clock or perf_counter

    @property
    def enabled(self) -> bool:
        return self._enabled

    def event(self, name: str, **fields: Any) -> None:
        """Emit a point-in-time measurement (no duration)."""
        if not self._enabled:
            return
        self._write(name, dict(fields))

    @contextmanager
    def timed(self, name: str, **fields: Any) -> Iterator[Span]:
        """Time the block and emit `name` with elapsed_ms plus any span.set() fields.

        Always yields a span so call sites are identical on or off. The emit happens
        in a finally, so a block that raises still records its latency (with whatever
        fields were set before the raise) -- useful for a failed or slow request.
        """
        if not self._enabled:
            yield _NULL_SPAN
            return
        span = _Span()
        start = self._clock()
        try:
            yield span
        finally:
            elapsed_ms = round((self._clock() - start) * 1000.0, 3)
            data = dict(fields)
            data.update(span.fields)
            data["elapsed_ms"] = elapsed_ms
            self._write(name, data)

    def _write(self, name: str, fields: Dict[str, Any]) -> None:
        if self._emit is not None:
            self._emit(name, fields)
            return
        # default=str is belt-and-suspenders: we only pass ints/floats/strs/bools, but
        # a stray value must never raise inside an instrumentation path. sort_keys keeps
        # the line stable/diffable; compact separators keep it one terse line.
        payload = json.dumps(fields, separators=(",", ":"), sort_keys=True, default=str)
        from twisted.python import log

        log.msg("@measure %s %s" % (name, payload), system="postern-imap")

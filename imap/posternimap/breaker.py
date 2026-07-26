"""Circuit breaker for the door -> Worker seam (#458, follow-up to #416 part 2).

THE PROBLEM IT BOUNDS. #416 part 2 moved every blocking Worker call off the reactor
thread, so a hung Worker no longer freezes the whole door. What it did NOT change is
the COST of a dead Worker: every call still pays a full `api_timeout` before it fails,
per command, from every connected client, and each of those waits holds one of the ten
reactor pool threads for the duration. Ten stalled threads is the pool exhausted, and
the eleventh command queues behind them.

WHAT IT COUNTS. Consecutive TRANSPORT failures only: a timeout, a refused connection, a
reset socket. An HTTP status is NOT a transport failure, and that distinction is the
whole design:

  * a 4xx is the Worker REFUSING, honestly and instantly. It is an answer, not an
    outage, and tripping on it would take a mailbox offline because a token lost a
    scope.
  * a 5xx (including a Cloudflare edge 5xx when the Worker itself is down) is also an
    ANSWER, and it arrives in milliseconds. There is no timeout to save, so there is
    nothing for a breaker to buy. The one failure mode this exists for is the one where
    the caller waits.

Any response at all -- 200, 401, 503 -- therefore RESETS the counter: the path to the
Worker demonstrably works.

FAIL CLOSED, LOUDLY. An open breaker makes the client raise, exactly like a timeout
does, so the door answers the same honest tagged NO it already gives for an unreachable
Worker. It NEVER answers "no messages": an empty INBOX because a breaker is open is the
#404 / #416 failure class, and `tests/test_breaker.py` pins it against the real mailbox.

STATES. closed -> (threshold consecutive transport failures) -> open -> (cooldown
elapsed) -> half_open -> (one probe call) -> closed on success, open again on failure.
Exactly ONE probe is admitted at a time; the rest keep failing fast. A probe that never
reports back (a thread that died) un-sticks itself after one more cooldown, so the
breaker can never wedge permanently in half_open.

SCOPE. One breaker per Worker ENDPOINT, process-wide (`breaker_for`), because the
account mints a fresh `PosternClient` per mailbox and per session: a per-client breaker
would count to N separately in each and never trip. It is deliberately NOT per token or
per route -- the fact being tracked is "can this door reach that origin".
"""

from __future__ import annotations

import threading
from typing import Callable, Dict, Optional

CLOSED = "closed"
OPEN = "open"
HALF_OPEN = "half_open"

LogFn = Callable[[str], None]
ClockFn = Callable[[], float]


def _twisted_log(message: str) -> None:
    # Imported lazily so the pure (non-Twisted) test layers can import this module.
    from twisted.python import log

    log.msg(message, system="postern-imap")


class CircuitBreaker:
    """Consecutive-transport-failure breaker for ONE Worker endpoint.

    Disabled (`enabled=False`, or a threshold of 0) it is a true no-op: allow() is
    always True and the record_* calls do nothing, so the un-broken path is the path
    the door always had.

    `now` and `log` are injectable for tests; production defaults are time.monotonic
    (immune to wall-clock jumps) and the Twisted log (journald via the unit).
    """

    __slots__ = (
        "_enabled",
        "_threshold",
        "_cooldown",
        "_endpoint",
        "_now",
        "_log",
        "_lock",
        "_state",
        "_failures",
        "_opened_at",
        "_probe_started",
        "_probe_in_flight",
        "_fast_failures",
    )

    def __init__(
        self,
        *,
        enabled: bool,
        threshold: int,
        cooldown: float,
        endpoint: str = "",
        now: Optional[ClockFn] = None,
        log: Optional[LogFn] = None,
    ) -> None:
        self._enabled = bool(enabled) and threshold > 0 and cooldown > 0
        self._threshold = threshold
        self._cooldown = float(cooldown)
        self._endpoint = endpoint
        if now is None:
            import time

            now = time.monotonic
        self._now = now
        self._log = log or _twisted_log
        self._lock = threading.Lock()
        self._state = CLOSED
        self._failures = 0
        self._opened_at = 0.0
        self._probe_started = 0.0
        self._probe_in_flight = False
        # How many calls were failed fast since the breaker last opened; reported on
        # close so the log says what the outage actually cost.
        self._fast_failures = 0

    # --- state ---

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    def retry_after(self) -> float:
        """Seconds until the next probe is admitted (0 when a call may proceed)."""
        with self._lock:
            if self._state != OPEN:
                return 0.0
            return max(0.0, self._cooldown - (self._now() - self._opened_at))

    def reason(self) -> str:
        """The operator-facing sentence a fail-fast raise carries. No URL, no token:
        the endpoint is already in the transition log line, and this text can reach an
        IMAP client through an error path."""
        return (
            "Postern API circuit breaker is OPEN after %d consecutive transport "
            "failures; failing fast for another %.0fs" % (self._threshold, self.retry_after())
        )

    # --- the gate ---

    def allow(self) -> bool:
        """True if this call may go to the Worker. False = fail fast, do not dial."""
        if not self._enabled:
            return True
        with self._lock:
            if self._state == CLOSED:
                return True
            now = self._now()
            if self._state == OPEN:
                if (now - self._opened_at) < self._cooldown:
                    self._fast_failures += 1
                    return False
                self._state = HALF_OPEN
                self._probe_in_flight = True
                self._probe_started = now
                self._log(
                    "postern-imap: worker circuit breaker HALF-OPEN for %s: cooldown "
                    "elapsed, admitting one probe call" % (self._endpoint or "the API",)
                )
                return True
            # HALF_OPEN: exactly one probe at a time. A probe that never reports back
            # (a dead thread) would otherwise wedge the breaker here forever, so it is
            # considered abandoned after one more cooldown and another is admitted.
            if self._probe_in_flight and (now - self._probe_started) < self._cooldown:
                self._fast_failures += 1
                return False
            self._probe_in_flight = True
            self._probe_started = now
            return True

    # --- outcome reporting ---

    def record_success(self) -> None:
        """The Worker ANSWERED (any HTTP status). The path works; reset."""
        if not self._enabled:
            return
        with self._lock:
            self._probe_in_flight = False
            self._failures = 0
            if self._state != CLOSED:
                was_open_for = self._now() - self._opened_at
                fast = self._fast_failures
                self._state = CLOSED
                self._fast_failures = 0
                self._log(
                    "postern-imap: worker circuit breaker CLOSED for %s: probe "
                    "succeeded after %.1fs open (%d calls failed fast while open)"
                    % (self._endpoint or "the API", was_open_for, fast)
                )

    def record_transport_failure(self) -> None:
        """A timeout / connection error. NOT for an HTTP status of any kind."""
        if not self._enabled:
            return
        with self._lock:
            now = self._now()
            was_probe = self._probe_in_flight
            self._probe_in_flight = False
            self._failures += 1
            if self._state == HALF_OPEN and was_probe:
                self._state = OPEN
                self._opened_at = now
                self._log(
                    "postern-imap: worker circuit breaker RE-OPENED for %s: probe call "
                    "failed; failing fast for another %.0fs"
                    % (self._endpoint or "the API", self._cooldown)
                )
                return
            if self._state == CLOSED and self._failures >= self._threshold:
                self._state = OPEN
                self._opened_at = now
                self._fast_failures = 0
                self._log(
                    "postern-imap: worker circuit breaker OPEN for %s: %d consecutive "
                    "transport failures; failing fast for %.0fs (clients get a tagged "
                    "NO, never an empty mailbox)"
                    % (self._endpoint or "the API", self._failures, self._cooldown)
                )


# A shared, always-allow instance for callers with no breaker configured (every
# PosternClient built without one, which is what the pre-#458 suites do). Stateless
# because it is disabled, so one instance is safe to share process-wide.
DISABLED = CircuitBreaker(enabled=False, threshold=0, cooldown=0.0)


_registry_lock = threading.Lock()
_registry: Dict[str, CircuitBreaker] = {}


def breaker_for(
    cfg, *, now: Optional[ClockFn] = None, log: Optional[LogFn] = None
) -> CircuitBreaker:
    """The process-wide breaker for cfg's Worker endpoint, created on first use.

    Keyed on the endpoint alone: one door process runs one config, and the fact being
    tracked belongs to the origin, not to whoever asked. Callers hold the returned
    object; they never re-key per call.
    """
    endpoint = getattr(cfg, "api_url", "") or ""
    with _registry_lock:
        breaker = _registry.get(endpoint)
        if breaker is None:
            breaker = CircuitBreaker(
                enabled=getattr(cfg, "breaker_enabled", False),
                threshold=getattr(cfg, "breaker_threshold", 0),
                cooldown=getattr(cfg, "breaker_cooldown", 0.0),
                endpoint=endpoint,
                now=now,
                log=log,
            )
            _registry[endpoint] = breaker
        return breaker


def reset_registry() -> None:
    """Drop every cached breaker. TESTS ONLY: a process-wide singleton that survives
    between tests would carry one test's open circuit into the next."""
    with _registry_lock:
        _registry.clear()

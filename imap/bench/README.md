# Door benchmarks (#416, #457)

Three re-runnable measurements behind the door concurrency model. A concurrency change
justified by a measurement needs the measurement to survive the change, so these are
checked in rather than described.

Both use real sockets, a real reactor and the real door client. Neither touches the
network beyond loopback, and neither needs the worker.

```bash
cd imap
python3 bench/reactor_stall.py       # does a slow worker call stall every other client?
python3 bench/shared_connection.py   # does one transport survive concurrent threads?
python3 bench/fetch_hydration.py     # does rendering a FETCH stall every other client?
```

## reactor_stall.py

A heartbeat records a timestamp every 20ms, standing in for every OTHER connected client
getting service. One worker call is then issued against an HTTP server that sleeps, first
inline on the reactor thread (how the door worked before #416) and then through the
reactor threadpool (how it works now). The largest heartbeat gap is the stall.

Measured on dischord, 2026-07-26:

```
heartbeat interval: 20ms (a gap larger than this is a stall)

INLINE (pre-#416), sleep 0.0s          call=     2.0ms   worst reactor gap=    20.4ms
INLINE (pre-#416), sleep 0.5s          call=   502.1ms   worst reactor gap=   514.4ms
INLINE (pre-#416), sleep 2.0s          call=  2001.7ms   worst reactor gap=  2020.3ms
POOL (post-#416), sleep 0.0s           call=     4.8ms   worst reactor gap=    20.3ms
POOL (post-#416), sleep 2.0s           call=  2002.9ms   worst reactor gap=    20.5ms
```

Read it as: before, the stall equalled the call duration exactly, one for one. With
`api_timeout` defaulting to 15s, the worst case was a fifteen-second freeze of the whole
door for every connected client. After, the reactor keeps its 20ms cadence while the
caller still waits for its own answer, which is correct: the caller is the only one who
should wait. The cost is roughly 2ms per call.

## shared_connection.py

Six concurrent calls on ONE client. This is why the fix is a per-thread connection
(`threading.local`) rather than a mutex.

Before #416 (one shared `http.client` connection, no lock):

```
  succeeded : 2
  failed    : 4
    - AttributeError: NoneType object has no attribute makefile
    - PosternError: request failed: Idle
    - AttributeError: NoneType object has no attribute makefile
    - PosternError: request failed: timed out
  wall      : 15331ms
```

After:

```
  succeeded : 6
  failed    : 0
  wall      : 166ms (serialized would be ~900ms; true concurrency ~150ms)
```

Sharing the connection was not a degradation, it was corruption. A mutex would have
fixed the corruption and reintroduced the queue: every door call behind the slowest one,
and keep-alive collapsed to a single connection under contention. The wall time above is
also the assertion that no lock crept back in.

Note the servers in both scripts accept CONCURRENT connections on purpose. Since #416 the
client keeps one keep-alive connection per thread, so a single-threaded test server would
refuse the second connection and the harness, not the door, would be what the numbers
described.

## fetch_hydration.py

The path #416 could not reach. Twisted renders a FETCH by calling IMessage accessors
(getBodyFile, getHeaders, getSize) straight from the protocol while it writes the
response, and that path has no `maybeDeferred` seam, so the door body hydration ran
there: on the reactor thread, once PER RENDERED MESSAGE. #457 closes it by pre-running
the same accessor reads in the threadpool before the messages reach Twisted.

Same heartbeat method as `reactor_stall.py`, but the subject is a real `FETCH 1:10`
issued by a real Twisted IMAP client against the real door, with the warm switched off
and then on in the same process against the same worker. `stalls` counts heartbeat gaps
over 2x the interval and `frozen` sums them, because the worst single gap badly
understates a freeze that repeats once per message.

Measured on dischord, 2026-07-26:

```
heartbeat interval: 20ms (a gap larger than this is a stall)
FETCH 1:10, one worker message GET per rendered message

INLINE (pre-#457), worker 0ms/msg          fetch=   399.7ms   worst gap=   44.7ms   stalls= 9   frozen=  392.8ms
WARMED (post-#457), worker 0ms/msg         fetch=   396.4ms   worst gap=   21.1ms   stalls= 0   frozen=    0.0ms

INLINE (pre-#457), worker 50ms/msg         fetch=   892.6ms   worst gap=   93.8ms   stalls=10   frozen=  898.2ms
WARMED (post-#457), worker 50ms/msg        fetch=   890.3ms   worst gap=   20.8ms   stalls= 0   frozen=    0.0ms

INLINE (pre-#457), worker 200ms/msg        fetch=  2399.0ms   worst gap=  244.2ms   stalls=10   frozen= 2405.2ms
WARMED (post-#457), worker 200ms/msg       fetch=  2392.2ms   worst gap=   20.9ms   stalls= 0   frozen=    0.0ms

WARMED scan (#102), worker 200ms/msg       fetch=    12.5ms   worst gap=   20.3ms   stalls= 0   frozen=    0.0ms
```

Read it as: before, the reactor was frozen for very nearly the WHOLE command (2405ms of
freeze inside a 2399ms fetch), in ten separate stalls, one per message, and every other
connected client was frozen with it. With `api_timeout` at 15s an unreachable worker
made each of those ten stalls up to fifteen seconds long. After, the heartbeat holds its
20ms cadence throughout and the count of stalls is zero. The caller still waits the same
2.39s for its own answer, which is correct: the caller is the only one who should wait.

The last line is the guardrail, not a result. A warm that simply hydrated everything
would post the same zeros above while turning every list view into a body download. The
scan fetches nothing from a worker sleeping 200ms per message and completes in 12.5ms,
so lazy hydration (#102) survived the fix.

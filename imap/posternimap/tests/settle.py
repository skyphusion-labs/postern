"""Test helper: let the server side of a loopback connection finish closing.

A test that ends with ``yield proto.transport.loseConnection()`` has only asked
the CLIENT socket to close. ``loseConnection`` returns ``None``, so the yield waits
for nothing. The SERVER side sees the close a few reactor turns later, and its
``connectionLost`` is what cancels the 60s idle timeout. Trial checks for a dirty
reactor right after ``tearDown``, so when the server is slow by a few
milliseconds the test fails with a pending ``TimeoutMixin.__timedOut`` call and an
open ``PosternIMAP4Server`` (postern#712).

That is a test race, not a leak: the connection always closes and the timeout is
always cancelled once it does. This helper waits for that, with a hard bound. If a
server connection is still open after ``timeout`` seconds, it raises, so a real
leak still fails loudly instead of being waited out.
"""

from __future__ import annotations

from typing import Any


def wait_for_server_connections_to_close(timeout: float = 5.0) -> Any:
    """Return a Deferred that fires when no server-side TCP connection is open."""
    import time

    from twisted.internet import defer, task, tcp
    from twisted.internet import reactor as _reactor

    # The reactor is typed as its interface stub, which lacks getReaders and
    # declares callLater-style methods without self. Treat it as Any here.
    rx: Any = _reactor

    def _open() -> bool:
        return any(isinstance(r, tcp.Server) for r in rx.getReaders())

    @defer.inlineCallbacks
    def _wait() -> Any:
        deadline = time.monotonic() + timeout
        while _open():
            if time.monotonic() > deadline:
                raise AssertionError(
                    "a server connection was still open %.1fs after the client closed" % timeout
                )
            yield task.deferLater(rx, 0.001, lambda: None)

    return _wait()

"""Measure whether a slow worker call stalls the Twisted reactor (#416).

Real sockets, real reactor, the real door client. A stubbed clock would encode the
answer instead of measuring it.

METHOD. A heartbeat LoopingCall records a timestamp every 20ms; it stands in for every
OTHER connected IMAP client getting service. While it runs, one worker call is issued
against an HTTP server that sleeps for a set delay, first the way the door issued calls
BEFORE #416 (inline on the reactor thread) and then the way it issues them now (through
the reactor threadpool). The largest heartbeat gap IS the stall every other client feels.

RUN: python3 imap/bench/reactor_stall.py
"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twisted.internet import defer, reactor, task, threads  # noqa: E402

from posternimap.client import PosternClient  # noqa: E402

DELAY = [0.0]
HEARTBEAT_S = 0.02


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        time.sleep(DELAY[0])
        payload = json.dumps({"ok": True, "items": [], "cursor": None}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):
        pass


class ThreadedServer(HTTPServer):
    # Concurrent-capable ON PURPOSE. Since #416 the client keeps ONE keep-alive
    # connection PER THREAD, so the pool phase opens a second connection while the main
    # thread still holds its own; a single-threaded server would refuse to serve it and
    # the measurement would time out on the harness rather than measure the door. Any
    # real worker (the Cloudflare edge) serves concurrent connections; this models that.
    daemon_threads = True

    def process_request(self, request, addr):
        threading.Thread(target=self._one, args=(request, addr), daemon=True).start()

    def _one(self, request, addr):
        try:
            self.finish_request(request, addr)
        finally:
            self.shutdown_request(request)


server = ThreadedServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % server.server_address[1]

beats: list = []


def gaps():
    return [(b - a) * 1000 for a, b in zip(beats, beats[1:])]


def report(label, mark, call_ms):
    window = gaps()[mark:]
    worst = max(window) if window else 0.0
    print("%-38s call=%8.1fms   worst reactor gap=%8.1fms" % (label, call_ms, worst))
    return worst


@defer.inlineCallbacks
def run():
    client = PosternClient(BASE, "tok", timeout=15)
    loop = task.LoopingCall(lambda: beats.append(time.monotonic()))
    loop.start(HEARTBEAT_S, now=True)
    yield task.deferLater(reactor, 0.4)

    print("heartbeat interval: %.0fms (a gap larger than this is a stall)\n" % (HEARTBEAT_S * 1000))
    for delay in (0.0, 0.5, 2.0):
        DELAY[0] = delay
        client.list_messages(limit=1)  # warm keep-alive: measure the SLEEP, not connect
        yield task.deferLater(reactor, 0.3)
        mark = len(gaps())
        t0 = time.monotonic()
        client.list_messages(limit=1)
        call_ms = (time.monotonic() - t0) * 1000
        # Let the heartbeat run again BEFORE reading the gaps. The stall only becomes
        # visible when the next beat lands: reading immediately after the call reported a
        # flat 0.0ms stall for a call that had just frozen the reactor for two seconds,
        # which is a measurement that says "safe" for the exact case it exists to catch.
        yield task.deferLater(reactor, 0.3)
        report("INLINE (pre-#416), sleep %.1fs" % delay, mark, call_ms)

    for delay in (0.0, 2.0):
        DELAY[0] = delay
        yield task.deferLater(reactor, 0.3)
        mark = len(gaps())
        t0 = time.monotonic()
        yield threads.deferToThread(client.list_messages, limit=1)
        call_ms = (time.monotonic() - t0) * 1000
        yield task.deferLater(reactor, 0.3)
        report("POOL (post-#416), sleep %.1fs" % delay, mark, call_ms)

    loop.stop()
    reactor.stop()


reactor.callWhenRunning(run)
reactor.run()

"""Measure the reactor stall a FETCH body hydration causes, before and after #457.

Real sockets, real reactor, the real door, and a real Twisted IMAP client driving real
FETCH commands. Nothing is stubbed except the worker itself, which is a loopback HTTP
server that sleeps on the message GET so the delay is a knob instead of a guess.

WHY THIS BENCH EXISTS SEPARATELY FROM reactor_stall.py. That one measured a single
worker call. This one measures the path #416 part 2 could NOT reach: Twisted renders a
FETCH by calling IMessage accessors straight from the protocol while writing the
response, so before #457 the hydration happened there, on the reactor thread, once PER
RENDERED MESSAGE. The cost is therefore multiplied by the size of the fetch range, which
is the part a single-call measurement does not show.

METHOD. A heartbeat LoopingCall records a timestamp every 20ms; it stands in for every
OTHER connected IMAP client getting service. While it runs, one client issues
FETCH 1:N (RFC822.TEXT) against a worker that sleeps on each message GET. The largest
heartbeat gap IS the freeze every other client feels.

BEFORE is not a reconstruction from memory: the warm is switched off at its seam
(server.fetch_reads is made to return no reads), which is exactly the pre-#457 code path,
in the same process, against the same worker, in the same run.

RUN: python3 imap/bench/fetch_hydration.py
"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twisted.internet import defer, reactor, task  # noqa: E402
from twisted.internet.protocol import ClientCreator  # noqa: E402
from twisted.mail import imap4  # noqa: E402

from posternimap import server as server_mod  # noqa: E402
from posternimap.auth import build_portal  # noqa: E402
from posternimap.config import Config  # noqa: E402
from posternimap.server import PosternIMAPFactory  # noqa: E402

HEARTBEAT_S = 0.02
MESSAGES = 10
DELAY = [0.0]

_IDS = ["m%d" % i for i in range(1, MESSAGES + 1)]


def _summary(i, mid):
    return {
        "messageId": mid,
        "uid": i,
        "direction": "inbound",
        "threadId": mid,
        "from": "%s@example.com" % mid,
        "to": "agent@skyphusion.org",
        "subject": "Subject %s" % mid,
        "date": "2026-06-18T12:00:00Z",
        "inReplyTo": None,
        "trusted": True,
        "receivedAt": "2026-06-18T12:00:01Z",
        "seen": False,
        "deleted": False,
        "attachmentCount": 0,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/messages/"):
            # The per-message body GET: the call that used to land on the reactor thread.
            time.sleep(DELAY[0])
            mid = path[len("/api/messages/"):]
            body = dict(_summary(_IDS.index(mid) + 1, mid))
            body["bodyText"] = "hello body of %s" % mid
            body["attachments"] = []
            payload = {"ok": True, "message": body}
        elif path in ("/api/messages", "/api/messages/"):
            payload = {
                "ok": True,
                "items": [_summary(i + 1, mid) for i, mid in enumerate(_IDS)],
                "cursor": None,
            }
        elif path == "/api/folders":
            payload = {"ok": True, "folders": []}
        else:
            payload = {"ok": True, "items": [], "cursor": None}
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


class ThreadedServer(HTTPServer):
    # Concurrent-capable ON PURPOSE, same reason as reactor_stall.py: since #416 the
    # client keeps one keep-alive connection PER THREAD, so a single-threaded server
    # would make the harness, not the door, the thing being measured.
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


def report(label, mark, cmd_ms):
    window = gaps()[mark:]
    worst = max(window) if window else 0.0
    # The WORST gap alone understates this one. Twisted renders a FETCH message by
    # message with a reactor turn between, so the pre-#457 freeze was not one long
    # stall: it was one stall PER RENDERED MESSAGE, repeated across the command. Count
    # them, or a 10-message fetch looks like a single 200ms hiccup.
    stalls = [g for g in window if g > HEARTBEAT_S * 1000 * 2]
    print(
        "%-42s fetch=%8.1fms   worst gap=%7.1fms   stalls=%2d   frozen=%7.1fms"
        % (label, cmd_ms, worst, len(stalls), sum(stalls))
    )


@defer.inlineCallbacks
def one_fetch(addr, shape):
    cc = ClientCreator(reactor, imap4.IMAP4Client)
    proto = yield cc.connectTCP("127.0.0.1", addr.port)
    yield proto.login(b"agent@skyphusion.org", b"tok")
    yield proto.select(b"INBOX")
    yield task.deferLater(reactor, 0.3)
    mark = len(gaps())
    t0 = time.monotonic()
    yield proto.sendCommand(
        imap4.Command(b"FETCH", b"1:%d " % MESSAGES + shape, wantResponse=(b"FETCH",))
    )
    cmd_ms = (time.monotonic() - t0) * 1000
    # Let the heartbeat run again BEFORE reading the gaps: the stall only becomes visible
    # when the next beat lands (the lesson reactor_stall.py records).
    yield task.deferLater(reactor, 0.3)
    yield proto.logout()
    defer.returnValue((mark, cmd_ms))


@defer.inlineCallbacks
def run():
    cfg = Config(api_url=BASE, auth_mode="token", api_timeout=15.0, imap_poll_seconds=0)
    factory = PosternIMAPFactory.__new__(PosternIMAPFactory)
    factory._cfg = cfg
    factory._portal = build_portal(cfg, verify=lambda tok: True)
    port = reactor.listenTCP(0, factory, interface="127.0.0.1")
    addr = port.getHost()

    loop = task.LoopingCall(lambda: beats.append(time.monotonic()))
    loop.start(HEARTBEAT_S, now=True)
    yield task.deferLater(reactor, 0.4)

    print("heartbeat interval: %.0fms (a gap larger than this is a stall)" % (HEARTBEAT_S * 1000))
    print("FETCH 1:%d, one worker message GET per rendered message\n" % MESSAGES)

    real_reads = server_mod.fetch_reads
    for delay in (0.0, 0.05, 0.2):
        DELAY[0] = delay
        # BEFORE: the warm produces no reads, so every hydration falls back to the
        # accessor on the reactor thread. This IS the pre-#457 path.
        server_mod.fetch_reads = lambda query: ()
        mark, cmd_ms = yield one_fetch(addr, b"(RFC822.TEXT)")
        report("INLINE (pre-#457), worker %.0fms/msg" % (delay * 1000), mark, cmd_ms)

        server_mod.fetch_reads = real_reads
        mark, cmd_ms = yield one_fetch(addr, b"(RFC822.TEXT)")
        report("WARMED (post-#457), worker %.0fms/msg" % (delay * 1000), mark, cmd_ms)
        print("")

    # A header scan must stay free in BOTH worlds: the warm derives its reads from the
    # query, so a list view still fetches no body at all. If this line ever shows a
    # stall, #457 bought its speed by breaking #102.
    DELAY[0] = 0.2
    mark, cmd_ms = yield one_fetch(addr, b"(UID FLAGS ENVELOPE)")
    report("WARMED scan (#102), worker 200ms/msg", mark, cmd_ms)

    loop.stop()
    yield port.stopListening()
    reactor.stop()


reactor.callWhenRunning(run)
reactor.run()

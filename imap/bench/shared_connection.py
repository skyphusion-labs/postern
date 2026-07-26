"""Measure whether ONE client transport survives concurrent threads (#416).

This is why the fix is a per-thread connection (threading.local) and not a mutex. Before
#416 the transport held ONE http.client connection with no lock, which was safe only
while every call ran on the single reactor thread. Moving calls into the threadpool
without changing that would not have degraded the door, it would have CORRUPTED it: six
concurrent calls returned 2 successes and 4 failures (NoneType.makefile, "Idle", and a
call that sat on the full 15s timeout).

RUN: python3 imap/bench/shared_connection.py
"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from posternimap.client import PosternClient  # noqa: E402

CONCURRENCY = 6
SERVER_DELAY_S = 0.15


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        time.sleep(SERVER_DELAY_S)
        payload = json.dumps({"ok": True, "items": [], "cursor": None}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):
        pass


class ThreadedServer(HTTPServer):
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
client = PosternClient("http://127.0.0.1:%d" % server.server_address[1], "tok", timeout=15)
client.list_messages(limit=1)  # warm one keep-alive connection

ok: list = []
errors: list = []


def call(i):
    try:
        client.list_messages(limit=1)
        ok.append(i)
    except Exception as exc:
        errors.append("%s: %s" % (type(exc).__name__, exc))


threads = [threading.Thread(target=call, args=(i,)) for i in range(CONCURRENCY)]
started = time.monotonic()
for t in threads:
    t.start()
for t in threads:
    t.join()
elapsed = (time.monotonic() - started) * 1000

print("%d concurrent calls on ONE client transport" % CONCURRENCY)
print("  succeeded : %d" % len(ok))
print("  failed    : %d" % len(errors))
for e in errors:
    print("    - %s" % e)
print(
    "  wall      : %.0fms (serialized would be ~%.0fms; true concurrency ~%.0fms)"
    % (elapsed, CONCURRENCY * SERVER_DELAY_S * 1000, SERVER_DELAY_S * 1000)
)

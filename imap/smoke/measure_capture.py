#!/usr/bin/env python3
"""0.6 full measurement provoker for postern-imap (#102 / GO-LIVE step 0.6).

Drives one authenticated session that exercises ALL FOUR measurement events so
the operator can confirm each `@measure` line lands. Pair it with an UNANCHORED
grep of the container log on dischord (Swarm):

    docker service logs postern-imap_postern-imap | grep '@measure'

The four events and what provokes each here:
  - cold_sync    : SELECT INBOX (the cold load that hits /api/messages)
  - api_request  : every HTTP round-trip (SELECT + the FETCHes below)
  - hydrate      : one body open (FETCH <n> (RFC822)); the prior ENVELOPE scan
                   must emit ZERO hydrate (lazy-hydration check, GO-LIVE 0.6 #2)
  - poll_refresh : holding the selected mailbox idle past one poll interval
                   (POSTERN_IMAP_POLL_SECONDS, 30s by default)

This is a READ-ONLY session (SELECT readonly=True, no writes, no deletes). The
password is read once via getpass: never echoed, argv'd, env'd, or logged. Only
`@sanity` lines (counts) are printed locally; the authoritative signal is the
server-side `@measure` lines in the container log.

    python3 measure_capture.py                 # logs in as the current OS user
    python3 measure_capture.py --user joan
    python3 measure_capture.py --idle 35       # seconds to hold for poll_refresh
"""

from __future__ import annotations

import argparse
import getpass
import imaplib
import json
import ssl
import sys
import time


def emit(tag: str, **fields: object) -> None:
    print("@sanity %s %s" % (tag, json.dumps(fields, separators=(",", ":"), sort_keys=True)), flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="postern-imap 0.6 full measurement provoker")
    ap.add_argument("--host", default="10.1.1.2")
    ap.add_argument("--port", type=int, default=993)
    ap.add_argument("--user", default=getpass.getuser())
    ap.add_argument("--idle", type=int, default=35,
                    help="seconds to hold the mailbox idle to provoke one poll_refresh (>POLL_SECONDS, default 35)")
    args = ap.parse_args()

    emit("begin", host=args.host, port=args.port, user=args.user, idle=args.idle)
    password = getpass.getpass("postern-imap password for %s@%s (not echoed): " % (args.user, args.host))
    if not password:
        emit("abort", reason="empty_password")
        return 2

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # self-signed cert on the private estate (crew trust)

    conn = imaplib.IMAP4_SSL(host=args.host, port=args.port, ssl_context=ctx)
    try:
        conn.login(args.user, password)
        emit("login", ok=True)

        # cold_sync (+ api_request): the SELECT that hits the API.
        typ, resp = conn.select("INBOX", readonly=True)
        exists = 0
        try:
            exists = int(resp[0])
        except (ValueError, TypeError, IndexError):
            pass
        emit("select", mailbox="INBOX", ok=(typ == "OK"), exists=exists,
             note="provokes one @measure cold_sync (direction=inbound) + api_request")

        if exists <= 0:
            emit("note", msg="INBOX empty; cannot provoke hydrate (no body to open). cold_sync still fired.")
        else:
            # lazy-hydration check: an ENVELOPE scan over the window must emit ZERO hydrate.
            typ, _ = conn.fetch("1:*", "(ENVELOPE FLAGS INTERNALDATE)")
            emit("envelope_scan", ok=(typ == "OK"),
                 note="must emit ZERO @measure hydrate (GO-LIVE 0.6 #2)")
            # hydrate: open exactly one body -> exactly one @measure hydrate.
            typ, _ = conn.fetch("1", "(RFC822)")
            emit("body_open", uid_seq=1, ok=(typ == "OK"),
                 note="provokes exactly one @measure hydrate + api_request")

        # poll_refresh: hold the selected mailbox idle past one poll interval.
        emit("idle_begin", seconds=args.idle, note="hold past POSTERN_IMAP_POLL_SECONDS to provoke one poll_refresh")
        time.sleep(args.idle)
        # a no-op NOOP keeps the connection live and lets the server push EXISTS.
        conn.noop()
        emit("idle_end", note="expect >=1 @measure poll_refresh during this window")

        conn.logout()
        emit("done", ok=True)
        return 0
    except imaplib.IMAP4.error as exc:
        emit("error", kind="imap", detail=str(exc))
        return 1
    except OSError as exc:
        emit("error", kind="transport", detail=str(exc))
        return 1
    finally:
        try:
            conn.shutdown()
        except Exception:
            pass
        del password


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Minimal post-deploy emit-sanity gate for postern-imap (#102 measurement).

Run AFTER a redeploy with POSTERN_IMAP_MEASURE=on, BEFORE the full acceptance run.
Does the smallest thing that must provoke a `@measure cold_sync` line: one
authenticated LOGIN + SELECT INBOX + LOGOUT against the live 993 door. It does NOT
touch SEARCH (so it works even if SEARCH were broken) and does NOT open bodies.

Identity-neutral: system/PAM reads the shared store, so any crew login proves the
wiring. Prints only `@sanity` lines (the SELECT exists count -- a bare integer);
the authoritative signal is the server-side `@measure cold_sync` line the operator
reads from journald. The password is read once via getpass: never echoed, argv'd,
env'd, or logged.

    python3 emit_sanity.py            # logs in as the current OS user
    python3 emit_sanity.py --user strummer
"""

from __future__ import annotations

import argparse
import getpass
import imaplib
import json
import ssl
import sys


def emit(tag: str, **fields: object) -> None:
    print("@sanity %s %s" % (tag, json.dumps(fields, separators=(",", ":"), sort_keys=True)), flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="postern-imap post-deploy emit-sanity")
    ap.add_argument("--host", default="10.1.1.2")
    ap.add_argument("--port", type=int, default=993)
    ap.add_argument("--user", default=getpass.getuser())
    args = ap.parse_args()

    emit("begin", host=args.host, port=args.port, user=args.user)
    password = getpass.getpass("postern-imap password for %s@%s (not echoed): " % (args.user, args.host))
    if not password:
        emit("abort", reason="empty_password")
        return 2

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # self-signed cert on the private estate

    conn = imaplib.IMAP4_SSL(host=args.host, port=args.port, ssl_context=ctx)
    try:
        conn.login(args.user, password)
        emit("login", ok=True)
        typ, resp = conn.select("INBOX", readonly=True)
        exists = 0
        try:
            exists = int(resp[0])
        except (ValueError, TypeError, IndexError):
            pass
        emit("select", mailbox="INBOX", ok=(typ == "OK"), exists=exists,
             note="this SELECT must provoke one @measure cold_sync in journald")
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

"""Thin CLI over the Postern API client.

Usage: `postern <command> ...` (or `python -m postern_client <command> ...`).
The API origin and token come from the environment (POSTERN_API_URL /
POSTERN_API_TOKEN); the token is NEVER accepted as a command-line argument, so it
cannot leak into shell history, `ps`, or argv. Results print as JSON to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Optional, Sequence

from .client import Attachment, PosternAuthError, PosternClient, PosternError, from_env


def _read_body(inline: Optional[str], path: Optional[str]) -> Optional[str]:
    """Resolve a body field from an inline string or a file ('-' = stdin)."""
    if path is not None:
        if path == "-":
            return sys.stdin.read()
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    return inline


def _parse_headers(items: Optional[Sequence[str]]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for item in items or []:
        if "=" not in item:
            raise SystemExit(f"--header must be KEY=VALUE, got: {item}")
        key, value = item.split("=", 1)
        headers[key.strip()] = value
    return headers


def _emit(obj: object) -> None:
    json.dump(obj, sys.stdout, indent=2, ensure_ascii=False, sort_keys=True)
    sys.stdout.write("\n")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="postern",
        description="Reusable client for the Postern mailbox API. "
        "Reads POSTERN_API_URL and POSTERN_API_TOKEN from the environment "
        "(the token is never a CLI argument).",
    )
    p.add_argument(
        "--api-url",
        default=None,
        help="override POSTERN_API_URL (the token still comes only from the env)",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("ping", help="validate the token against the API")

    s = sub.add_parser("send", help="send a new message")
    s.add_argument("--to", action="append", required=True, metavar="ADDR", help="recipient (repeatable)")
    s.add_argument("--subject", required=True)
    s.add_argument("--text", help="plain-text body")
    s.add_argument("--text-file", help="read the plain-text body from a file ('-' = stdin)")
    s.add_argument("--html", help="HTML body")
    s.add_argument("--html-file", help="read the HTML body from a file ('-' = stdin)")
    s.add_argument("--from", dest="from_addr", help="From override (must be on the allowed domain)")
    s.add_argument("--reply-to", dest="reply_to", help="Reply-To address")
    s.add_argument("--cc", action="append", metavar="ADDR", help="CC (repeatable)")
    s.add_argument("--bcc", action="append", metavar="ADDR", help="BCC (repeatable)")
    s.add_argument("--header", action="append", metavar="KEY=VALUE", help="extra header (repeatable)")

    r = sub.add_parser("reply", help="reply to a stored message")
    r.add_argument("message_id", help="message_id of the stored message to reply to")
    r.add_argument("--text", help="plain-text body")
    r.add_argument("--text-file", help="read the plain-text body from a file ('-' = stdin)")
    r.add_argument("--html", help="HTML body")
    r.add_argument("--html-file", help="read the HTML body from a file ('-' = stdin)")
    r.add_argument("--from", dest="from_addr", help="From override (must be on the allowed domain)")
    r.add_argument("--cc", action="append", metavar="ADDR", help="CC (repeatable)")
    r.add_argument("--bcc", action="append", metavar="ADDR", help="BCC (repeatable)")

    ls = sub.add_parser("list", help="list messages (filters + pagination)")
    ls.add_argument("--to")
    ls.add_argument("--from", dest="from_addr")
    ls.add_argument("--thread")
    ls.add_argument("--direction", choices=["inbound", "outbound"])
    ls.add_argument("--q", help="free-text filter")
    ls.add_argument("--limit", type=int)
    ls.add_argument("--cursor", help="pagination cursor from a previous page")

    g = sub.add_parser("get", help="get one message by id")
    g.add_argument("message_id")

    t = sub.add_parser("thread", help="get every message in a thread")
    t.add_argument("thread_id")

    sc = sub.add_parser("search", help="search messages")
    sc.add_argument("query")
    sc.add_argument("--mode", choices=["fts", "semantic", "hybrid"])
    sc.add_argument("--limit", type=int)
    sc.add_argument("--cursor")

    a = sub.add_parser("attachment", help="download an attachment by message id + index")
    a.add_argument("message_id")
    a.add_argument("index", type=int)
    a.add_argument("-o", "--output", help="write to this path (default: the attachment filename)")
    return p


def _run(client: PosternClient, args: argparse.Namespace) -> int:
    cmd = args.command
    if cmd == "ping":
        ok = client.ping()
        _emit({"ok": ok})
        return 0 if ok else 1

    if cmd == "send":
        text = _read_body(args.text, args.text_file)
        html = _read_body(args.html, args.html_file)
        if text is None and html is None:
            raise SystemExit("send needs a body: pass --text/--text-file or --html/--html-file")
        _emit(
            client.send(
                args.to,
                args.subject,
                text=text,
                html=html,
                from_addr=args.from_addr,
                reply_to=args.reply_to,
                cc=args.cc,
                bcc=args.bcc,
                headers=_parse_headers(args.header),
            )
        )
        return 0

    if cmd == "reply":
        text = _read_body(args.text, args.text_file)
        html = _read_body(args.html, args.html_file)
        if text is None and html is None:
            raise SystemExit("reply needs a body: pass --text/--text-file or --html/--html-file")
        _emit(
            client.reply(
                args.message_id,
                text=text,
                html=html,
                from_addr=args.from_addr,
                cc=args.cc,
                bcc=args.bcc,
            )
        )
        return 0

    if cmd == "list":
        _emit(
            client.list_messages(
                to=args.to,
                from_addr=args.from_addr,
                thread=args.thread,
                direction=args.direction,
                q=args.q,
                limit=args.limit,
                cursor=args.cursor,
            )
        )
        return 0

    if cmd == "get":
        msg = client.get_message(args.message_id)
        if msg is None:
            print(f"message not found: {args.message_id}", file=sys.stderr)
            return 1
        _emit(msg)
        return 0

    if cmd == "thread":
        _emit(client.get_thread(args.thread_id))
        return 0

    if cmd == "search":
        _emit(client.search(args.query, mode=args.mode, limit=args.limit, cursor=args.cursor))
        return 0

    if cmd == "attachment":
        att: Attachment = client.get_attachment(args.message_id, args.index)
        out = args.output or att.filename
        with open(out, "wb") as fh:
            fh.write(att.body)
        # Metadata to stderr so stdout stays clean if a caller pipes it.
        print(f"wrote {len(att.body)} bytes to {out} ({att.mime})", file=sys.stderr)
        return 0

    raise SystemExit(f"unknown command: {cmd}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        # An origin override is fine on the CLI (not a secret); the token still
        # comes only from POSTERN_API_TOKEN.
        client = from_env(base_url=args.api_url, transport=None)
        return _run(client, args)
    except PosternAuthError as e:
        print(f"auth failed: {e} (check POSTERN_API_TOKEN)", file=sys.stderr)
        return 2
    except PosternError as e:
        detail = f" [{e.code}]" if getattr(e, "code", None) else ""
        print(f"error{detail}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

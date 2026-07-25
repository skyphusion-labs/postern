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

from .client import (
    Attachment,
    OutboundAttachment,
    PosternAuthError,
    PosternClient,
    PosternError,
    from_env,
)


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


def _attachments(paths: Optional[Sequence[str]]) -> Optional[list[OutboundAttachment]]:
    """Load --attach paths into outbound attachments (base64 happens in the client)."""
    if not paths:
        return None
    return [OutboundAttachment.from_path(p) for p in paths]


def _emit(obj: object) -> None:
    json.dump(obj, sys.stdout, indent=2, ensure_ascii=False, sort_keys=True)
    sys.stdout.write("\n")


def _add_draft_fields(p: argparse.ArgumentParser) -> None:
    """The draft document fields, shared by create and update."""
    p.add_argument("--to", help="recipient string (comma/semicolon/newline separated)")
    p.add_argument("--cc")
    p.add_argument("--bcc")
    p.add_argument("--subject")
    p.add_argument("--text", dest="body_text", help="plain-text body")
    p.add_argument("--html", dest="body_html", help="HTML body")
    p.add_argument("--in-reply-to", dest="in_reply_to")
    p.add_argument("--thread", dest="thread_id")
    p.add_argument(
        "--compose-mode",
        dest="compose_mode",
        choices=["new", "reply", "replyAll", "forward"],
        help="how the draft was composed (a reply/replyAll draft needs --source)",
    )
    p.add_argument("--source", dest="source_message_id", help="message id a reply/forward draft came from")


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
    s.add_argument("--attach", action="append", metavar="PATH", help="attach a file (repeatable)")
    s.add_argument(
        "--forward",
        dest="forward_message_id",
        metavar="MESSAGE_ID",
        help="quote a stored message as a forward (recipients stay the --to you pass)",
    )

    r = sub.add_parser("reply", help="reply to a stored message")
    r.add_argument("message_id", help="message_id of the stored message to reply to")
    r.add_argument("--text", help="plain-text body")
    r.add_argument("--text-file", help="read the plain-text body from a file ('-' = stdin)")
    r.add_argument("--html", help="HTML body")
    r.add_argument("--html-file", help="read the HTML body from a file ('-' = stdin)")
    r.add_argument("--from", dest="from_addr", help="From override (must be on the allowed domain)")
    r.add_argument("--cc", action="append", metavar="ADDR", help="CC (repeatable)")
    r.add_argument("--bcc", action="append", metavar="ADDR", help="BCC (repeatable)")
    r.add_argument("--attach", action="append", metavar="PATH", help="attach a file (repeatable)")
    r.add_argument(
        "--mode",
        choices=["reply", "replyAll"],
        help="replyAll derives the original To/Cc server-side, excluding the sender",
    )
    r.add_argument(
        "--quote",
        dest="quote_original",
        action="store_true",
        default=None,
        help="append a server-built quote of the original",
    )

    ls = sub.add_parser("list", help="list messages (filters + pagination)")
    ls.add_argument("--to")
    ls.add_argument("--from", dest="from_addr")
    ls.add_argument("--thread")
    ls.add_argument("--direction", choices=["inbound", "outbound"], help="filter on the stored direction")
    ls.add_argument(
        "--lens",
        choices=["inbox", "sent"],
        help="viewer view for --to (inbox = delivered to them, not written by them); not combinable with --direction",
    )
    ls.add_argument(
        "--mailbox",
        choices=["archive", "trash", "junk", "all"],
        help="durable folder scope; omit for the direction-default INBOX/Sent view",
    )
    ls.add_argument(
        "--seen-for",
        dest="seen_for",
        metavar="ADDR",
        help="whose read state to project (a role queue reads --to ROLE --seen-for HUMAN)",
    )
    ls.add_argument("--q", help="free-text filter")
    ls.add_argument("--limit", type=int)
    ls.add_argument("--cursor", help="pagination cursor from a previous page")

    g = sub.add_parser("get", help="get one message by id")
    g.add_argument("message_id")

    t = sub.add_parser("thread", help="get every message in a thread")
    t.add_argument("thread_id")

    sc = sub.add_parser("search", help="search messages")
    sc.add_argument("query")
    sc.add_argument(
        "--mode",
        choices=["fts", "substr", "semantic", "hybrid"],
        help="substr is the literal substring match, paired with --field",
    )
    sc.add_argument(
        "--field",
        choices=["subject", "body", "text"],
        help="which column substr matches (ignored by the other modes)",
    )
    sc.add_argument("--direction", choices=["inbound", "outbound"])
    sc.add_argument("--lens", choices=["inbox", "sent"], help="needs --to; not combinable with --direction")
    sc.add_argument("--to")
    sc.add_argument("--from", dest="from_addr")
    sc.add_argument("--mailbox", choices=["archive", "trash", "junk", "all"])
    sc.add_argument("--seen-for", dest="seen_for", metavar="ADDR")
    sc.add_argument("--after", help="only messages at or after this date/timestamp")
    sc.add_argument("--before", help="only messages at or before this date/timestamp")
    sc.add_argument(
        "--has-attachment",
        dest="has_attachment",
        action="store_true",
        default=None,
        help="only messages WITH attachments",
    )
    sc.add_argument(
        "--no-attachment",
        dest="has_attachment",
        action="store_false",
        help="only messages WITHOUT attachments",
    )
    sc.add_argument("--seen", dest="seen", action="store_true", default=None, help="only messages already read")
    sc.add_argument("--unseen", dest="seen", action="store_false", help="only unread messages")
    sc.add_argument("--limit", type=int)
    sc.add_argument("--cursor")

    a = sub.add_parser("attachment", help="download an attachment by message id + index")
    a.add_argument("message_id")
    a.add_argument("index", type=int)
    a.add_argument("-o", "--output", help="write to this path (default: the attachment filename)")

    f = sub.add_parser("folders", help="list folders with server-authoritative unread counts")
    f.add_argument("--to", help="scope the unread counts to one viewer")

    sn = sub.add_parser("seen", help="mark messages read (or unread with --unread)")
    sn.add_argument("message_ids", nargs="+", metavar="MESSAGE_ID")
    sn.add_argument("--unread", action="store_true", help="mark UNread instead")
    sn.add_argument(
        "--for",
        dest="for_addr",
        metavar="ADDR",
        help="write a per-recipient override instead of the row-level estate mark",
    )

    fl = sub.add_parser("flags", help="set durable Flagged / Answered on messages")
    fl.add_argument("message_ids", nargs="+", metavar="MESSAGE_ID")
    fl.add_argument("--flagged", dest="flagged", action="store_true", default=None)
    fl.add_argument("--unflagged", dest="flagged", action="store_false")
    fl.add_argument("--answered", dest="answered", action="store_true", default=None)
    fl.add_argument("--unanswered", dest="answered", action="store_false")

    mv = sub.add_parser("move", help="soft-move messages between durable folders")
    mv.add_argument("message_ids", nargs="+", metavar="MESSAGE_ID")
    mv.add_argument(
        "--mailbox",
        required=True,
        choices=["archive", "trash", "junk", "none"],
        help="destination folder; none restores the direction-default view",
    )

    dl = sub.add_parser("delete", help="hard-delete one message (needs a delete-scoped token)")
    dl.add_argument("message_id")

    dr = sub.add_parser(
        "drafts",
        help="server-side drafts (needs a token bound to an identity)",
        description="Server-side drafts are identity-owned: a static operator token "
        "cannot use them and gets E_IDENTITY_REQUIRED.",
    )
    drs = dr.add_subparsers(dest="draft_command", required=True)
    drs.add_parser("list", help="list the bound identity's drafts")
    dg = drs.add_parser("get", help="get one draft")
    dg.add_argument("draft_id")
    dc = drs.add_parser("create", help="create a draft")
    _add_draft_fields(dc)
    du = drs.add_parser(
        "update",
        help="replace a draft (a field you omit is CLEARED; read-modify-write to patch)",
    )
    du.add_argument("draft_id")
    _add_draft_fields(du)
    du.add_argument(
        "--updated-at",
        dest="updated_at",
        help="optimistic concurrency: a stale value fails with E_CONFLICT (409)",
    )
    dd = drs.add_parser("delete", help="delete a draft")
    dd.add_argument("draft_id")
    dsend = drs.add_parser("send", help="send a draft (deleted only after it goes out)")
    dsend.add_argument("draft_id")
    da = drs.add_parser("attachments", help="list the attachments staged on a draft")
    da.add_argument("draft_id")
    dat = drs.add_parser("attach", help="stage a file on a draft")
    dat.add_argument("draft_id")
    dat.add_argument("path")
    dat.add_argument("--filename", help="override the stored filename (default: the file's own name)")
    dat.add_argument("--mime", help="override the content type (default: guessed from the name)")
    ddt = drs.add_parser("detach", help="remove one staged attachment from a draft")
    ddt.add_argument("draft_id")
    ddt.add_argument("attachment_id")
    return p


def _run_drafts(client: PosternClient, args: argparse.Namespace) -> int:
    cmd = args.draft_command
    if cmd == "list":
        _emit(client.list_drafts())
        return 0
    if cmd == "get":
        draft = client.get_draft(args.draft_id)
        if draft is None:
            print(f"draft not found: {args.draft_id}", file=sys.stderr)
            return 1
        _emit(draft)
        return 0
    if cmd in ("create", "update"):
        fields = dict(
            to=args.to,
            cc=args.cc,
            bcc=args.bcc,
            subject=args.subject,
            body_text=args.body_text,
            body_html=args.body_html,
            in_reply_to=args.in_reply_to,
            thread_id=args.thread_id,
            compose_mode=args.compose_mode,
            source_message_id=args.source_message_id,
        )
        if cmd == "create":
            _emit(client.create_draft(**fields))
        else:
            _emit(client.update_draft(args.draft_id, updated_at=args.updated_at, **fields))
        return 0
    if cmd == "delete":
        client.delete_draft(args.draft_id)
        _emit({"ok": True, "deleted": args.draft_id})
        return 0
    if cmd == "send":
        _emit(client.send_draft(args.draft_id))
        return 0
    if cmd == "attachments":
        _emit(client.list_draft_attachments(args.draft_id))
        return 0
    if cmd == "attach":
        att = OutboundAttachment.from_path(args.path, filename=args.filename, mime_type=args.mime)
        _emit(
            client.add_draft_attachment(
                args.draft_id, att.content, filename=att.filename, mime_type=att.mime_type
            )
        )
        return 0
    if cmd == "detach":
        client.delete_draft_attachment(args.draft_id, args.attachment_id)
        _emit({"ok": True, "deleted": args.attachment_id})
        return 0
    raise SystemExit(f"unknown drafts subcommand: {cmd}")


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
                attachments=_attachments(args.attach),
                forward_message_id=args.forward_message_id,
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
                mode=args.mode,
                quote_original=args.quote_original,
                attachments=_attachments(args.attach),
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
                lens=args.lens,
                mailbox=args.mailbox,
                seen_for=args.seen_for,
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
        _emit(
            client.search(
                args.query,
                mode=args.mode,
                field=args.field,
                direction=args.direction,
                lens=args.lens,
                to=args.to,
                from_addr=args.from_addr,
                mailbox=args.mailbox,
                seen_for=args.seen_for,
                after=args.after,
                before=args.before,
                has_attachment=args.has_attachment,
                seen=args.seen,
                limit=args.limit,
                cursor=args.cursor,
            )
        )
        return 0

    if cmd == "attachment":
        att: Attachment = client.get_attachment(args.message_id, args.index)
        out = args.output or att.filename
        with open(out, "wb") as fh:
            fh.write(att.body)
        # Metadata to stderr so stdout stays clean if a caller pipes it.
        print(f"wrote {len(att.body)} bytes to {out} ({att.mime})", file=sys.stderr)
        return 0

    if cmd == "folders":
        _emit(client.get_folders(to=args.to))
        return 0

    if cmd == "seen":
        updated = client.set_seen(args.message_ids, not args.unread, for_addr=args.for_addr)
        _emit({"ok": True, "updated": updated})
        return 0

    if cmd == "flags":
        if args.flagged is None and args.answered is None:
            raise SystemExit("flags needs at least one of --flagged/--unflagged or --answered/--unanswered")
        updated = client.set_flags(args.message_ids, flagged=args.flagged, answered=args.answered)
        _emit({"ok": True, "updated": updated})
        return 0

    if cmd == "move":
        mailbox = None if args.mailbox == "none" else args.mailbox
        _emit({"ok": True, "updated": client.move_messages(args.message_ids, mailbox)})
        return 0

    if cmd == "delete":
        client.delete_message(args.message_id)
        _emit({"ok": True, "deleted": args.message_id})
        return 0

    if cmd == "drafts":
        return _run_drafts(client, args)

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

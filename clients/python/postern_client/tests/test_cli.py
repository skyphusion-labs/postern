"""Tests for the CLI, driving main() with a patched client (no network)."""

from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from postern_client.cli import build_parser, main
from postern_client.client import PosternClient
from postern_client.tests.test_client import FakeTransport


def run(argv, transport):
    """Run main(argv) with from_env patched to a client over `transport`.

    Captures (exit_code, stdout, stderr).
    """
    client = PosternClient("https://postern.example", "tok", transport=transport)
    out, err = io.StringIO(), io.StringIO()
    with mock.patch("postern_client.cli.from_env", return_value=client):
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
    return code, out.getvalue(), err.getvalue()


class SendCliTest(unittest.TestCase):
    def test_send_builds_body_and_prints_result(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m1","threadId":"t1"}')
        code, out, _ = run(
            ["send", "--to", "a@x.com", "--to", "b@x.com", "--subject", "Hi", "--text", "yo"], t
        )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["messageId"], "m1")
        body = json.loads(t.last.data.decode())
        self.assertEqual(body["to"], ["a@x.com", "b@x.com"])
        self.assertEqual(body["subject"], "Hi")
        self.assertEqual(body["text"], "yo")

    def test_send_requires_a_body(self):
        t = FakeTransport()
        with self.assertRaises(SystemExit):
            run(["send", "--to", "a@x.com", "--subject", "Hi"], t)

    def test_send_text_from_file(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
            fh.write("body from file")
            path = fh.name
        try:
            code, _, _ = run(["send", "--to", "a@x.com", "--subject", "S", "--text-file", path], t)
        finally:
            os.unlink(path)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(t.last.data.decode())["text"], "body from file")

    def test_bad_header_errors(self):
        t = FakeTransport(body=b'{"ok":true}')
        with self.assertRaises(SystemExit):
            run(["send", "--to", "a@x.com", "--subject", "S", "--text", "t", "--header", "noequals"], t)


class ReadCliTest(unittest.TestCase):
    def test_list(self):
        t = FakeTransport(body=b'{"ok":true,"items":[{"messageId":"m"}],"cursor":"c"}')
        code, out, _ = run(["list", "--direction", "inbound", "--limit", "5"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["cursor"], "c")
        self.assertIn("direction=inbound", t.last.full_url)

    def test_get_found(self):
        t = FakeTransport(body=b'{"ok":true,"message":{"messageId":"m","subject":"s"}}')
        code, out, _ = run(["get", "m"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["subject"], "s")

    def test_get_not_found_exit_1(self):
        t = FakeTransport(status=404, body=b'{"ok":false,"error":"E_NOT_FOUND"}')
        code, _, err = run(["get", "nope"], t)
        self.assertEqual(code, 1)
        self.assertIn("not found", err)

    def test_thread(self):
        t = FakeTransport(body=b'{"ok":true,"messages":[{"messageId":"a"}]}')
        code, out, _ = run(["thread", "t1"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)[0]["messageId"], "a")

    def test_search(self):
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        code, _, _ = run(["search", "invoice", "--mode", "fts"], t)
        self.assertEqual(code, 0)
        self.assertIn("q=invoice", t.last.full_url)
        self.assertIn("mode=fts", t.last.full_url)


class AttachmentCliTest(unittest.TestCase):
    def test_attachment_writes_file(self):
        t = FakeTransport(
            body=b"BYTES",
            headers={"content-type": "image/png", "content-disposition": 'attachment; filename="p.png"'},
        )
        with tempfile.TemporaryDirectory() as d:
            out_path = os.path.join(d, "got.png")
            code, _, err = run(["attachment", "m", "0", "-o", out_path], t)
            self.assertEqual(code, 0)
            with open(out_path, "rb") as fh:
                self.assertEqual(fh.read(), b"BYTES")
        self.assertIn("wrote 5 bytes", err)


class AuthCliTest(unittest.TestCase):
    def test_ping_ok(self):
        code, out, _ = run(["ping"], FakeTransport(body=b'{"ok":true,"items":[]}'))
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["ok"])

    def test_auth_failure_exit_2(self):
        t = FakeTransport(status=401, body=b'{"ok":false,"error":"unauthorized"}')
        code, _, err = run(["list"], t)
        self.assertEqual(code, 2)
        self.assertIn("auth failed", err)


class NoTokenArgTest(unittest.TestCase):
    def test_no_token_flag_exists(self):
        # The token must never be a CLI argument; the parser must reject --token.
        parser = build_parser()
        with self.assertRaises(SystemExit):
            parser.parse_args(["--token", "leak", "ping"])



class SendAttachmentCliTest(unittest.TestCase):
    def test_attach_reads_the_file_and_base64s_it(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "note.txt")
            with open(path, "wb") as fh:
                fh.write(b"file bytes")
            code, _, _ = run(
                ["send", "--to", "a@x.com", "--subject", "S", "--text", "t", "--attach", path], t
            )
        self.assertEqual(code, 0)
        att = json.loads(t.last.data.decode())["attachments"][0]
        self.assertEqual(base64.b64decode(att["content"]), b"file bytes")
        self.assertEqual(att["filename"], "note.txt")
        self.assertEqual(att["mimeType"], "text/plain")

    def test_forward_flag(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        code, _, _ = run(
            ["send", "--to", "a@x.com", "--subject", "S", "--text", "t", "--forward", "orig"], t
        )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(t.last.data.decode())["forwardMessageId"], "orig")


class ReplyCliTest(unittest.TestCase):
    def test_reply_all_quote_and_attachment(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "a.bin")
            with open(path, "wb") as fh:
                fh.write(b"\x00\xff")
            code, _, _ = run(
                ["reply", "orig", "--text", "re", "--mode", "replyAll", "--quote", "--attach", path], t
            )
        self.assertEqual(code, 0)
        body = json.loads(t.last.data.decode())
        self.assertEqual(body["mode"], "replyAll")
        self.assertIs(body["quoteOriginal"], True)
        self.assertEqual(base64.b64decode(body["attachments"][0]["content"]), b"\x00\xff")

    def test_reply_without_quote_sends_no_quote_key(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        run(["reply", "orig", "--text", "re"], t)
        self.assertNotIn("quoteOriginal", json.loads(t.last.data.decode()))


class ListSearchCliTest(unittest.TestCase):
    def test_list_mailbox_and_seen_for(self):
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        code, _, _ = run(["list", "--mailbox", "trash", "--to", "r@x.com", "--seen-for", "h@x.com"], t)
        self.assertEqual(code, 0)
        self.assertEqual(
            t.last_query(), {"mailbox": ["trash"], "to": ["r@x.com"], "seenFor": ["h@x.com"]}
        )

    def test_search_substr_mode_with_field(self):
        # cli.py used to restrict --mode to fts|semantic|hybrid and had no --field,
        # so the worker's substr mode was unreachable from the CLI (#413).
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        code, _, _ = run(["search", "inv", "--mode", "substr", "--field", "subject"], t)
        self.assertEqual(code, 0)
        self.assertEqual(t.last_query()["mode"], ["substr"])
        self.assertEqual(t.last_query()["field"], ["subject"])

    def test_search_filter_flags(self):
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        code, _, _ = run(
            [
                "search", "inv",
                "--to", "me@x.com",
                "--mailbox", "archive",
                "--after", "2026-01-01",
                "--before", "2026-02-01",
                "--has-attachment",
                "--unseen",
            ],
            t,
        )
        self.assertEqual(code, 0)
        q = t.last_query()
        self.assertEqual(q["hasAttachment"], ["true"])
        self.assertEqual(q["seen"], ["false"])
        self.assertEqual(q["after"], ["2026-01-01"])
        self.assertEqual(q["before"], ["2026-02-01"])

    def test_search_without_filter_flags_sends_none_of_them(self):
        # Control: the tri-state flags default to absent, not to false.
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        run(["search", "inv"], t)
        self.assertEqual(t.last_query(), {"q": ["inv"]})


class FolderStateCliTest(unittest.TestCase):
    def test_folders(self):
        t = FakeTransport(body=b'{"ok":true,"folders":[{"name":"INBOX"}]}')
        code, out, _ = run(["folders", "--to", "me@x.com"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)[0]["name"], "INBOX")
        self.assertEqual(t.last_query(), {"to": ["me@x.com"]})

    def test_seen_marks_read_by_default(self):
        t = FakeTransport(body=b'{"ok":true,"updated":2}')
        code, out, _ = run(["seen", "m1", "m2"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["updated"], 2)
        self.assertEqual(json.loads(t.last.data.decode()), {"ids": ["m1", "m2"], "seen": True})

    def test_seen_unread_and_for(self):
        t = FakeTransport(body=b'{"ok":true,"updated":1}')
        run(["seen", "m1", "--unread", "--for", "me@x.com"], t)
        self.assertEqual(
            json.loads(t.last.data.decode()), {"ids": ["m1"], "seen": False, "for": "me@x.com"}
        )

    def test_flags_requires_one_flag(self):
        t = FakeTransport(body=b'{"ok":true,"updated":0}')
        with self.assertRaises(SystemExit):
            run(["flags", "m1"], t)
        self.assertEqual(t.calls, [])

    def test_flags_sets_both(self):
        t = FakeTransport(body=b'{"ok":true,"updated":1}')
        code, _, _ = run(["flags", "m1", "--flagged", "--unanswered"], t)
        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(t.last.data.decode()),
            {"ids": ["m1"], "set": {"flagged": True, "answered": False}},
        )

    def test_move_none_is_null_not_the_string(self):
        t = FakeTransport(body=b'{"ok":true,"updated":1}')
        run(["move", "m1", "--mailbox", "none"], t)
        self.assertEqual(json.loads(t.last.data.decode()), {"ids": ["m1"], "mailbox": None})

    def test_move_to_a_folder(self):
        t = FakeTransport(body=b'{"ok":true,"updated":1}')
        run(["move", "m1", "--mailbox", "junk"], t)
        self.assertEqual(json.loads(t.last.data.decode())["mailbox"], "junk")

    def test_delete(self):
        t = FakeTransport(body=b'{"ok":true,"deleted":"m1"}')
        code, out, _ = run(["delete", "m1"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["deleted"], "m1")
        self.assertEqual(t.last.method, "DELETE")

    def test_delete_without_scope_exits_1_with_the_reason(self):
        t = FakeTransport(status=403, body=b'{"ok":false,"error":"forbidden","message":"requires delete scope"}')
        code, _, err = run(["delete", "m1"], t)
        self.assertEqual(code, 1)
        self.assertIn("delete scope", err)


class DraftsCliTest(unittest.TestCase):
    def test_drafts_list(self):
        t = FakeTransport(body=b'{"ok":true,"drafts":[{"id":"d1"}]}')
        code, out, _ = run(["drafts", "list"], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)[0]["id"], "d1")
        self.assertEqual(t.last_path(), "/api/drafts")

    def test_drafts_create_maps_flags_to_worker_keys(self):
        t = FakeTransport(body=b'{"ok":true,"id":"d1","draft":{}}')
        code, _, _ = run(
            ["drafts", "create", "--to", "a@x.com", "--subject", "S", "--text", "hi",
             "--compose-mode", "reply", "--source", "orig"],
            t,
        )
        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(t.last.data.decode()),
            {"to": "a@x.com", "subject": "S", "bodyText": "hi", "composeMode": "reply", "sourceMessageId": "orig"},
        )

    def test_drafts_update_sends_put_with_updated_at(self):
        t = FakeTransport(body=b'{"ok":true,"draft":{}}')
        run(["drafts", "update", "d1", "--subject", "S2", "--updated-at", "2026-07-26T00:00:00Z"], t)
        self.assertEqual(t.last.method, "PUT")
        self.assertEqual(json.loads(t.last.data.decode())["updatedAt"], "2026-07-26T00:00:00Z")

    def test_drafts_send_and_delete(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        run(["drafts", "send", "d1"], t)
        self.assertEqual(t.last_path(), "/api/drafts/d1/send")
        t2 = FakeTransport(body=b'{"ok":true,"deleted":"d1"}')
        run(["drafts", "delete", "d1"], t2)
        self.assertEqual(t2.last.method, "DELETE")
        self.assertEqual(t2.last_path(), "/api/drafts/d1")

    def test_drafts_attach_sends_raw_bytes(self):
        t = FakeTransport(body=b'{"ok":true,"attachment":{"id":"a1"}}')
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pic.png")
            with open(path, "wb") as fh:
                fh.write(b"\x89PNG")
            code, out, _ = run(["drafts", "attach", "d1", path], t)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["id"], "a1")
        self.assertEqual(t.last.data, b"\x89PNG")
        self.assertEqual(t.last.get_header("Content-type"), "image/png")
        self.assertEqual(t.last.get_header("X-postern-filename"), "pic.png")

    def test_drafts_detach(self):
        t = FakeTransport(body=b'{"ok":true,"deleted":"a1"}')
        run(["drafts", "detach", "d1", "a1"], t)
        self.assertEqual(t.last.method, "DELETE")
        self.assertEqual(t.last_path(), "/api/drafts/d1/attachments/a1")

    def test_drafts_identity_required_exits_1(self):
        t = FakeTransport(
            status=403,
            body=b'{"ok":false,"error":"E_IDENTITY_REQUIRED","message":"drafts require a bound identity"}',
        )
        code, _, err = run(["drafts", "list"], t)
        self.assertEqual(code, 1)
        self.assertIn("E_IDENTITY_REQUIRED", err)


if __name__ == "__main__":
    unittest.main()

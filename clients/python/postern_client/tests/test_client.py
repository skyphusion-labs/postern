"""Tests for PosternClient, using an injected transport (no network).

Evidence bar: these assert the EMITTED path, method, query params, and JSON body
keys, not just that a call returned. A fake transport can never disagree with the
client, so the assertions have to be specific enough that a worker parameter
rename shows up as a failure here (test_worker_contract.py closes the other half
by reading the accepted names out of the worker source).
"""

from __future__ import annotations

import base64
import json
import unittest
import urllib.parse

from postern_client.client import (
    OutboundAttachment,
    PosternAuthError,
    PosternClient,
    PosternError,
    from_env,
)


class FakeTransport:
    """Records the last urllib Request and returns a scripted (status, headers, body)."""

    def __init__(self, status=200, headers=None, body=b"{}"):
        self.status = status
        self.headers = headers or {}
        self.body = body
        self.calls = []

    def __call__(self, req):
        self.calls.append(req)
        return self.status, self.headers, self.body

    # convenience accessors for the most recent request
    @property
    def last(self):
        return self.calls[-1]

    def last_json(self):
        return json.loads(self.last.data.decode("utf-8"))

    def last_query(self):
        """The emitted query string as {name: [values]}, so an assertion can name
        the exact parameter set instead of substring-matching a URL."""
        return urllib.parse.parse_qs(urllib.parse.urlsplit(self.last.full_url).query)

    def last_path(self):
        return urllib.parse.urlsplit(self.last.full_url).path


def _client(transport):
    return PosternClient("https://postern.example", "the-token", transport=transport)


class FromEnvTest(unittest.TestCase):
    def test_builds_from_env(self):
        t = FakeTransport()
        c = from_env({"POSTERN_API_URL": "https://x/", "POSTERN_API_TOKEN": "tok"}, transport=t)
        self.assertIsInstance(c, PosternClient)

    def test_missing_url(self):
        with self.assertRaises(PosternError):
            from_env({"POSTERN_API_TOKEN": "tok"})

    def test_missing_token(self):
        with self.assertRaises(PosternError):
            from_env({"POSTERN_API_URL": "https://x"})

    def test_bad_scheme(self):
        with self.assertRaises(PosternError):
            from_env({"POSTERN_API_URL": "x", "POSTERN_API_TOKEN": "tok"})

    def test_base_url_override_uses_arg_not_env_for_origin(self):
        t = FakeTransport(body=b'{"ok":true,"items":[]}')
        c = from_env(
            {"POSTERN_API_URL": "https://env-origin", "POSTERN_API_TOKEN": "tok"},
            base_url="https://override-origin",
            transport=t,
        )
        c.list_messages()
        self.assertTrue(t.last.full_url.startswith("https://override-origin/api/messages"))

    def test_bad_timeout(self):
        with self.assertRaises(PosternError):
            from_env({"POSTERN_API_URL": "https://x", "POSTERN_API_TOKEN": "t", "POSTERN_API_TIMEOUT": "soon"})


class AuthHeaderTest(unittest.TestCase):
    def test_bearer_and_ua_present(self):
        t = FakeTransport(body=b'{"ok":true,"items":[]}')
        _client(t).list_messages()
        self.assertEqual(t.last.get_header("Authorization"), "Bearer the-token")
        self.assertEqual(t.last.get_header("User-agent"), "postern-client")


class SendTest(unittest.TestCase):
    def test_send_body_shape(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m1","threadId":"t1"}')
        res = _client(t).send(
            "a@x.com",
            "Hi",
            text="hello",
            from_addr="me@x.com",
            reply_to="r@x.com",
            cc=["c1@x.com", "c2@x.com"],
            headers={"X-Tag": "v"},
        )
        self.assertEqual(res["messageId"], "m1")
        self.assertEqual(t.last.method, "POST")
        self.assertTrue(t.last.full_url.endswith("/api/send"))
        body = t.last_json()
        # Single recipient normalizes to a list; JS camelCase keys preserved.
        self.assertEqual(body["to"], ["a@x.com"])
        self.assertEqual(body["subject"], "Hi")
        self.assertEqual(body["text"], "hello")
        self.assertEqual(body["from"], "me@x.com")
        self.assertEqual(body["replyTo"], "r@x.com")
        self.assertEqual(body["cc"], ["c1@x.com", "c2@x.com"])
        self.assertEqual(body["headers"], {"X-Tag": "v"})
        # Unset optionals are omitted, not sent as null.
        self.assertNotIn("html", body)
        self.assertNotIn("bcc", body)
        self.assertNotIn("attachments", body)
        self.assertNotIn("forwardMessageId", body)

    def test_send_list_recipients_passthrough(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        _client(t).send(["a@x.com", "b@x.com"], "S", text="t")
        self.assertEqual(t.last_json()["to"], ["a@x.com", "b@x.com"])

    def test_send_attachments_are_base64_over_json(self):
        # #70: the worker takes attachment BYTES as standard base64 in the JSON
        # body under content/filename/mimeType. Assert the encoded value exactly,
        # so a wrong encoding (raw bytes, url-safe base64, line wrapping) fails.
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        _client(t).send(
            "a@x.com",
            "S",
            text="t",
            attachments=[
                OutboundAttachment(content=b"\x00\xff hello", filename="a.bin", mime_type="application/octet-stream"),
                OutboundAttachment(content=b"plain"),
            ],
        )
        atts = t.last_json()["attachments"]
        self.assertEqual(
            atts[0],
            {
                "content": base64.b64encode(b"\x00\xff hello").decode("ascii"),
                "filename": "a.bin",
                "mimeType": "application/octet-stream",
            },
        )
        # Optional metadata is omitted rather than sent as null.
        self.assertEqual(atts[1], {"content": base64.b64encode(b"plain").decode("ascii")})

    def test_send_attachment_roundtrips_to_the_original_bytes(self):
        # Positive control on the encoding: decoding what we emit must give back
        # the exact input, so this cannot pass with a mangled payload.
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        raw = bytes(range(256))
        _client(t).send("a@x.com", "S", text="t", attachments=[OutboundAttachment(content=raw)])
        self.assertEqual(base64.b64decode(t.last_json()["attachments"][0]["content"]), raw)

    def test_send_rejects_a_non_attachment_locally(self):
        t = FakeTransport(body=b'{"ok":true}')
        with self.assertRaises(PosternError):
            _client(t).send("a@x.com", "S", text="t", attachments=[{"content": "already-encoded"}])
        # The bad call never reached the network at all.
        self.assertEqual(t.calls, [])

    def test_send_forward_message_id(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        _client(t).send("a@x.com", "Fwd", text="t", forward_message_id="orig-id")
        self.assertEqual(t.last_json()["forwardMessageId"], "orig-id")

    def test_attachment_from_path_guesses_name_and_mime(self):
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "note.txt")
            with open(path, "wb") as fh:
                fh.write(b"body bytes")
            att = OutboundAttachment.from_path(path)
        self.assertEqual(att.content, b"body bytes")
        self.assertEqual(att.filename, "note.txt")
        self.assertEqual(att.mime_type, "text/plain")


class ReplyTest(unittest.TestCase):
    def test_reply_body_shape(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m2","threadId":"t1"}')
        res = _client(t).reply("orig-id", text="re", bcc="b@x.com")
        self.assertEqual(res["threadId"], "t1")
        self.assertTrue(t.last.full_url.endswith("/api/reply"))
        body = t.last_json()
        self.assertEqual(body["messageId"], "orig-id")
        self.assertEqual(body["text"], "re")
        self.assertEqual(body["bcc"], ["b@x.com"])
        self.assertNotIn("mode", body)
        self.assertNotIn("quoteOriginal", body)

    def test_reply_all_with_quote_and_attachments(self):
        # #363: reply takes the same attachments shape as send; mode/quoteOriginal
        # are worker-side behaviors the client must be able to ask for.
        t = FakeTransport(body=b'{"ok":true,"messageId":"m2"}')
        _client(t).reply(
            "orig-id",
            text="re",
            mode="replyAll",
            quote_original=True,
            attachments=[OutboundAttachment(content=b"z", filename="z.txt")],
        )
        body = t.last_json()
        self.assertEqual(body["mode"], "replyAll")
        self.assertIs(body["quoteOriginal"], True)
        self.assertEqual(
            body["attachments"], [{"content": base64.b64encode(b"z").decode("ascii"), "filename": "z.txt"}]
        )

    def test_reply_quote_false_is_sent_not_dropped(self):
        # An explicit False must reach the worker; only None means "unset".
        t = FakeTransport(body=b'{"ok":true}')
        _client(t).reply("orig-id", text="re", quote_original=False)
        self.assertIs(t.last_json()["quoteOriginal"], False)


class ListSearchTest(unittest.TestCase):
    def test_list_params_and_result(self):
        t = FakeTransport(body=b'{"ok":true,"items":[{"messageId":"m"}],"cursor":"c2"}')
        res = _client(t).list_messages(to="me@x.com", direction="inbound", limit=10, cursor="c1")
        self.assertEqual(res["cursor"], "c2")
        self.assertEqual(len(res["items"]), 1)
        self.assertEqual(t.last_path(), "/api/messages")
        self.assertEqual(
            t.last_query(),
            {"to": ["me@x.com"], "direction": ["inbound"], "limit": ["10"], "cursor": ["c1"]},
        )

    def test_list_sends_lens_and_never_both(self):
        # #403: `lens` is the viewer VIEW, `direction` the stored wire fact. They are
        # mutually exclusive at the API, so the client sends exactly what it was
        # given, never both and never one standing in for the other.
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        _client(t).list_messages(to="abuse@x.com", lens="inbox")
        url = t.last.full_url
        self.assertIn("lens=inbox", url)
        self.assertNotIn("direction=", url)

    def test_list_omits_lens_by_default(self):
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        _client(t).list_messages(to="abuse@x.com", direction="inbound")
        url = t.last.full_url
        self.assertIn("direction=inbound", url)
        self.assertNotIn("lens=", url)

    def test_list_mailbox_reaches_the_durable_folders(self):
        # #352: without `mailbox` the worker applies mailbox IS NULL, so Archive /
        # Trash / Junk were literally unreachable from this client before.
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        _client(t).list_messages(mailbox="trash")
        self.assertEqual(t.last_query(), {"mailbox": ["trash"]})

    def test_list_seen_for_is_a_separate_projection_key(self):
        # #404: a role queue filters on the ROLE but projects the HUMAN's read
        # state, so seenFor must be emitted independently of `to`.
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        _client(t).list_messages(to="abuse@x.com", lens="inbox", seen_for="human@x.com")
        self.assertEqual(
            t.last_query(),
            {"to": ["abuse@x.com"], "lens": ["inbox"], "seenFor": ["human@x.com"]},
        )

    def test_list_omits_everything_it_was_not_given(self):
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        _client(t).list_messages()
        self.assertEqual(t.last_query(), {})

    def test_search_params(self):
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        _client(t).search("invoice", mode="hybrid", limit=5)
        url = t.last.full_url
        self.assertIn("/api/search?", url)
        self.assertIn("q=invoice", url)
        self.assertIn("mode=hybrid", url)

    def test_search_emits_the_full_filter_set_by_worker_name(self):
        # The whole #413 gap in one assertion: every filter the worker honors,
        # spelled exactly as the worker reads it. An added, dropped, or renamed
        # parameter fails here because the comparison is the full param dict.
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        _client(t).search(
            "invoice",
            mode="substr",
            field="subject",
            direction="inbound",
            to="me@x.com",
            from_addr="them@x.com",
            mailbox="archive",
            seen_for="me@x.com",
            after="2026-01-01",
            before="2026-02-01",
            has_attachment=True,
            seen=False,
            limit=25,
            cursor="c1",
        )
        self.assertEqual(t.last_path(), "/api/search")
        self.assertEqual(
            t.last_query(),
            {
                "q": ["invoice"],
                "mode": ["substr"],
                "field": ["subject"],
                "direction": ["inbound"],
                "to": ["me@x.com"],
                "from": ["them@x.com"],
                "mailbox": ["archive"],
                "seenFor": ["me@x.com"],
                "after": ["2026-01-01"],
                "before": ["2026-02-01"],
                "hasAttachment": ["true"],
                "seen": ["false"],
                "limit": ["25"],
                "cursor": ["c1"],
            },
        )

    def test_search_booleans_are_tri_state(self):
        # False must be SENT (unread-only is a real filter); None must be absent.
        t = FakeTransport(body=b'{"ok":true,"items":[]}')
        c = _client(t)
        c.search("q", seen=False, has_attachment=False)
        self.assertEqual(t.last_query()["seen"], ["false"])
        self.assertEqual(t.last_query()["hasAttachment"], ["false"])
        c.search("q")
        self.assertNotIn("seen", t.last_query())
        self.assertNotIn("hasAttachment", t.last_query())

    def test_search_lens_and_direction_are_passed_as_given(self):
        t = FakeTransport(body=b'{"ok":true,"items":[]}')
        _client(t).search("q", lens="sent", to="me@x.com")
        self.assertEqual(t.last_query(), {"q": ["q"], "lens": ["sent"], "to": ["me@x.com"]})


class GetThreadTest(unittest.TestCase):
    def test_get_message_ok(self):
        t = FakeTransport(body=b'{"ok":true,"message":{"messageId":"m","subject":"s"}}')
        msg = _client(t).get_message("m")
        self.assertEqual(msg["subject"], "s")
        # id is URL-quoted into the path.
        self.assertTrue(t.last.full_url.endswith("/api/messages/m"))

    def test_get_message_404_returns_none(self):
        t = FakeTransport(status=404, body=b'{"ok":false,"error":"E_NOT_FOUND"}')
        self.assertIsNone(_client(t).get_message("nope"))

    def test_get_message_other_error_raises(self):
        t = FakeTransport(status=500, body=b'{"ok":false,"error":"E_INTERNAL"}')
        with self.assertRaises(PosternError):
            _client(t).get_message("m")

    def test_get_thread(self):
        t = FakeTransport(body=b'{"ok":true,"threadId":"t","messages":[{"messageId":"a"},{"messageId":"b"}]}')
        msgs = _client(t).get_thread("t")
        self.assertEqual([m["messageId"] for m in msgs], ["a", "b"])


class AttachmentTest(unittest.TestCase):
    def test_attachment_bytes_and_filename(self):
        t = FakeTransport(
            body=b"PNGDATA",
            headers={
                "content-type": "image/png",
                "content-disposition": 'attachment; filename="photo.png"',
            },
        )
        att = _client(t).get_attachment("m", 0)
        self.assertEqual(att.body, b"PNGDATA")
        self.assertEqual(att.mime, "image/png")
        self.assertEqual(att.filename, "photo.png")
        self.assertTrue(t.last.full_url.endswith("/api/messages/m/attachments/0"))

    def test_attachment_default_filename(self):
        t = FakeTransport(body=b"x", headers={"content-type": "application/octet-stream"})
        att = _client(t).get_attachment("m", 3)
        self.assertEqual(att.filename, "attachment-3")

    def test_attachment_404_raises(self):
        t = FakeTransport(status=404, body=b'{"ok":false}')
        with self.assertRaises(PosternError):
            _client(t).get_attachment("m", 0)


class FoldersTest(unittest.TestCase):
    def test_folders_path_and_viewer_scope(self):
        t = FakeTransport(body=b'{"ok":true,"folders":[{"name":"INBOX","unseen":2}]}')
        folders = _client(t).get_folders(to="me@x.com")
        self.assertEqual(folders[0]["name"], "INBOX")
        self.assertEqual(t.last_path(), "/api/folders")
        self.assertEqual(t.last_query(), {"to": ["me@x.com"]})

    def test_folders_unscoped_sends_no_params(self):
        t = FakeTransport(body=b'{"ok":true,"folders":[]}')
        _client(t).get_folders()
        self.assertEqual(t.last_query(), {})


class ReadStateTest(unittest.TestCase):
    def test_set_seen_body_and_path(self):
        t = FakeTransport(body=b'{"ok":true,"updated":2}')
        updated = _client(t).set_seen(["a", "b"], True)
        self.assertEqual(updated, 2)
        self.assertEqual(t.last.method, "POST")
        self.assertEqual(t.last_path(), "/api/messages/seen")
        self.assertEqual(t.last_json(), {"ids": ["a", "b"], "seen": True})

    def test_set_seen_per_recipient_override(self):
        t = FakeTransport(body=b'{"ok":true,"updated":1}')
        _client(t).set_seen(["a"], False, for_addr="me@x.com")
        self.assertEqual(t.last_json(), {"ids": ["a"], "seen": False, "for": "me@x.com"})

    def test_set_seen_empty_never_hits_the_network(self):
        t = FakeTransport(body=b'{"ok":true,"updated":0}')
        self.assertEqual(_client(t).set_seen([], True), 0)
        self.assertEqual(t.calls, [])

    def test_set_flags_body(self):
        t = FakeTransport(body=b'{"ok":true,"updated":1}')
        self.assertEqual(_client(t).set_flags(["a"], flagged=True, answered=False), 1)
        self.assertEqual(t.last_path(), "/api/messages/flags")
        self.assertEqual(t.last_json(), {"ids": ["a"], "set": {"flagged": True, "answered": False}})

    def test_set_flags_sends_only_what_was_named(self):
        t = FakeTransport(body=b'{"ok":true,"updated":1}')
        _client(t).set_flags(["a"], answered=True)
        self.assertEqual(t.last_json()["set"], {"answered": True})

    def test_set_flags_with_nothing_to_set_is_a_local_no_op(self):
        # The worker answers 400 for an empty `set`; do not spend a round trip
        # learning that.
        t = FakeTransport(body=b'{"ok":true,"updated":0}')
        self.assertEqual(_client(t).set_flags(["a"]), 0)
        self.assertEqual(t.calls, [])

    def test_move_messages_body(self):
        t = FakeTransport(body=b'{"ok":true,"updated":3}')
        self.assertEqual(_client(t).move_messages(["a", "b", "c"], "trash"), 3)
        self.assertEqual(t.last_path(), "/api/messages/move")
        self.assertEqual(t.last_json(), {"ids": ["a", "b", "c"], "mailbox": "trash"})

    def test_move_none_restores_the_default_view(self):
        # null (not an omitted key) is how the worker is told to un-file a message.
        t = FakeTransport(body=b'{"ok":true,"updated":1}')
        _client(t).move_messages(["a"], None)
        self.assertEqual(t.last_json(), {"ids": ["a"], "mailbox": None})

    def test_delete_message_method_and_path(self):
        t = FakeTransport(body=b'{"ok":true,"deleted":"m 1"}')
        _client(t).delete_message("m 1")
        self.assertEqual(t.last.method, "DELETE")
        self.assertEqual(t.last_path(), "/api/messages/m%201")

    def test_delete_message_403_surfaces_the_scope_error(self):
        t = FakeTransport(status=403, body=b'{"ok":false,"error":"forbidden","message":"requires delete scope"}')
        with self.assertRaises(PosternError) as ctx:
            _client(t).delete_message("m")
        self.assertEqual(ctx.exception.status, 403)
        self.assertIn("delete scope", str(ctx.exception))


class DraftsTest(unittest.TestCase):
    def test_list_drafts(self):
        t = FakeTransport(body=b'{"ok":true,"drafts":[{"id":"d1"}]}')
        self.assertEqual(_client(t).list_drafts()[0]["id"], "d1")
        self.assertEqual(t.last_path(), "/api/drafts")
        self.assertEqual(t.last.method, "GET")

    def test_get_draft_404_returns_none(self):
        t = FakeTransport(status=404, body=b'{"ok":false,"error":"E_NOT_FOUND"}')
        self.assertIsNone(_client(t).get_draft("d1"))

    def test_create_draft_maps_to_worker_camel_case(self):
        t = FakeTransport(body=b'{"ok":true,"id":"d1","draft":{"id":"d1"}}')
        _client(t).create_draft(
            to="a@x.com",
            subject="S",
            body_text="hi",
            body_html="<p>hi</p>",
            in_reply_to="orig",
            thread_id="t1",
            compose_mode="reply",
            source_message_id="orig",
        )
        self.assertEqual(t.last.method, "POST")
        self.assertEqual(t.last_path(), "/api/drafts")
        self.assertEqual(
            t.last_json(),
            {
                "to": "a@x.com",
                "subject": "S",
                "bodyText": "hi",
                "bodyHtml": "<p>hi</p>",
                "inReplyTo": "orig",
                "threadId": "t1",
                "composeMode": "reply",
                "sourceMessageId": "orig",
            },
        )

    def test_update_draft_uses_put_and_carries_updated_at(self):
        t = FakeTransport(body=b'{"ok":true,"draft":{"id":"d 1"}}')
        _client(t).update_draft("d 1", subject="S2", updated_at="2026-07-26T00:00:00Z")
        self.assertEqual(t.last.method, "PUT")
        self.assertEqual(t.last_path(), "/api/drafts/d%201")
        self.assertEqual(t.last_json(), {"subject": "S2", "updatedAt": "2026-07-26T00:00:00Z"})

    def test_update_draft_conflict_carries_the_code(self):
        t = FakeTransport(status=409, body=b'{"ok":false,"error":"E_CONFLICT","current":{"id":"d1"}}')
        with self.assertRaises(PosternError) as ctx:
            _client(t).update_draft("d1", subject="S")
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.code, "E_CONFLICT")

    def test_send_draft_path(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m","threadId":"t"}')
        self.assertEqual(_client(t).send_draft("d1")["messageId"], "m")
        self.assertEqual(t.last.method, "POST")
        self.assertEqual(t.last_path(), "/api/drafts/d1/send")

    def test_delete_draft_path(self):
        t = FakeTransport(body=b'{"ok":true,"deleted":"d1"}')
        _client(t).delete_draft("d1")
        self.assertEqual(t.last.method, "DELETE")
        self.assertEqual(t.last_path(), "/api/drafts/d1")

    def test_draft_attachment_upload_is_raw_bytes_not_base64(self):
        # This route takes the FILE as the body (the base64-over-JSON shape is the
        # send path). Sending base64 here would store a corrupt attachment that
        # only shows up in someone's mailbox, so assert the raw bytes and the
        # percent-encoded filename header.
        t = FakeTransport(body=b'{"ok":true,"attachment":{"id":"a1"}}')
        att = _client(t).add_draft_attachment(
            "d1", b"\x00\xff bytes", filename="name with space.bin", mime_type="image/png"
        )
        self.assertEqual(att["id"], "a1")
        self.assertEqual(t.last.method, "POST")
        self.assertEqual(t.last_path(), "/api/drafts/d1/attachments")
        self.assertEqual(t.last.data, b"\x00\xff bytes")
        self.assertEqual(t.last.get_header("Content-type"), "image/png")
        self.assertEqual(t.last.get_header("X-postern-filename"), "name%20with%20space.bin")

    def test_draft_attachment_list_and_delete_paths(self):
        t = FakeTransport(body=b'{"ok":true,"attachments":[{"id":"a1"}]}')
        c = _client(t)
        self.assertEqual(c.list_draft_attachments("d1")[0]["id"], "a1")
        self.assertEqual(t.last_path(), "/api/drafts/d1/attachments")
        c.delete_draft_attachment("d1", "a 1")
        self.assertEqual(t.last.method, "DELETE")
        self.assertEqual(t.last_path(), "/api/drafts/d1/attachments/a%201")

    def test_drafts_identity_required_surfaces_honestly(self):
        # A static operator token cannot own drafts; the client must pass the
        # worker's reason through rather than pretending the box is empty.
        t = FakeTransport(
            status=403,
            body=b'{"ok":false,"error":"E_IDENTITY_REQUIRED","message":"drafts require a bound identity"}',
        )
        with self.assertRaises(PosternError) as ctx:
            _client(t).list_drafts()
        self.assertEqual(ctx.exception.code, "E_IDENTITY_REQUIRED")
        self.assertEqual(ctx.exception.status, 403)


class ErrorsTest(unittest.TestCase):
    def test_401_is_auth_error_with_code(self):
        t = FakeTransport(status=401, body=b'{"ok":false,"error":"unauthorized","message":"bad token"}')
        with self.assertRaises(PosternAuthError) as ctx:
            _client(t).list_messages()
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(ctx.exception.code, "unauthorized")

    def test_4xx_carries_code_and_message(self):
        t = FakeTransport(status=400, body=b'{"ok":false,"error":"E_FIELD_MISSING","message":"q is required"}')
        with self.assertRaises(PosternError) as ctx:
            _client(t).search("")
        self.assertEqual(ctx.exception.code, "E_FIELD_MISSING")
        self.assertIn("q is required", str(ctx.exception))

    def test_ping_true_false(self):
        self.assertTrue(_client(FakeTransport(body=b'{"ok":true,"items":[]}')).ping())
        self.assertFalse(_client(FakeTransport(status=401, body=b'{"ok":false}')).ping())

    def test_missing_token_at_construction(self):
        with self.assertRaises(PosternError):
            PosternClient("https://x", "")


if __name__ == "__main__":
    unittest.main()

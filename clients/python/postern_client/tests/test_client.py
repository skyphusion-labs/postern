"""Tests for PosternClient, using an injected transport (no network)."""

from __future__ import annotations

import json
import unittest

from postern_client.client import (
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

    def test_send_list_recipients_passthrough(self):
        t = FakeTransport(body=b'{"ok":true,"messageId":"m"}')
        _client(t).send(["a@x.com", "b@x.com"], "S", text="t")
        self.assertEqual(t.last_json()["to"], ["a@x.com", "b@x.com"])


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


class ListSearchTest(unittest.TestCase):
    def test_list_params_and_result(self):
        t = FakeTransport(body=b'{"ok":true,"items":[{"messageId":"m"}],"cursor":"c2"}')
        res = _client(t).list_messages(to="me@x.com", direction="inbound", limit=10, cursor="c1")
        self.assertEqual(res["cursor"], "c2")
        self.assertEqual(len(res["items"]), 1)
        url = t.last.full_url
        self.assertIn("to=me%40x.com", url)
        self.assertIn("direction=inbound", url)
        self.assertIn("limit=10", url)
        self.assertIn("cursor=c1", url)

    def test_search_params(self):
        t = FakeTransport(body=b'{"ok":true,"items":[],"cursor":null}')
        _client(t).search("invoice", mode="hybrid", limit=5)
        url = t.last.full_url
        self.assertIn("/api/search?", url)
        self.assertIn("q=invoice", url)
        self.assertIn("mode=hybrid", url)


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

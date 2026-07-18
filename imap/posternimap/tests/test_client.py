"""Tests for PosternClient against the fake transport (no Twisted, no network)."""

from __future__ import annotations

import unittest

from posternimap.client import PosternAuthError, PosternClient, PosternError
from posternimap.tests.fakes import make_message


class ClientTest(unittest.TestCase):
    def setUp(self):
        from posternimap.tests.fakes import FakeTransport

        self.msgs = [
            make_message("m3", direction="outbound", subject="reply about cats"),
            make_message("m2", subject="hello there"),
            make_message("m1", subject="welcome"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="good-token", page_size=2)
        self.client = PosternClient("https://postern.example", "good-token", transport=self.transport)

    def test_list_first_page(self):
        page = self.client.list_messages(limit=2)
        self.assertEqual([m.message_id for m in page.items], ["m3", "m2"])
        self.assertEqual(page.cursor, "2")

    def test_list_paged_to_end(self):
        seen = []
        cursor = None
        while True:
            page = self.client.list_messages(limit=2, cursor=cursor)
            seen.extend(m.message_id for m in page.items)
            cursor = page.cursor
            if not cursor:
                break
        self.assertEqual(seen, ["m3", "m2", "m1"])

    def test_list_direction_filter(self):
        page = self.client.list_messages(direction="outbound", limit=10)
        self.assertEqual([m.message_id for m in page.items], ["m3"])

    def test_list_to_filter_delivered_to_membership(self):
        from posternimap.tests.fakes import FakeTransport

        msgs = [
            make_message(
                "multi",
                to="Support <support@skyphusion.org>, Security <security@skyphusion.org>",
                deliveredTo=["support@skyphusion.org", "security@skyphusion.org"],
            )
        ]
        transport = FakeTransport(msgs, expected_token="good-token", page_size=10)
        client = PosternClient("https://postern.example", "good-token", transport=transport)
        for addr in ("support@skyphusion.org", "security@skyphusion.org"):
            page = client.list_messages(to=addr, limit=10)
            self.assertEqual([m.message_id for m in page.items], ["multi"])
        other = client.list_messages(to="nobody@skyphusion.org", limit=10)
        self.assertEqual(other.items, [])

    def test_list_to_filter_rejects_substring_false_positive(self):
        from posternimap.tests.fakes import FakeTransport

        msgs = [
            make_message(
                "support",
                to="support@skyphusion.org",
                deliveredTo=["support@skyphusion.org"],
            )
        ]
        transport = FakeTransport(msgs, expected_token="good-token", page_size=10)
        client = PosternClient("https://postern.example", "good-token", transport=transport)
        page = client.list_messages(to="port@skyphusion.org", limit=10)
        self.assertEqual(page.items, [])

    def test_list_to_filter_v1_fallback_on_to_field(self):
        from posternimap.tests.fakes import FakeTransport

        msgs = [make_message("old", to="conrad@skyphusion.org")]
        transport = FakeTransport(msgs, expected_token="good-token", page_size=10)
        client = PosternClient("https://postern.example", "good-token", transport=transport)
        page = client.list_messages(to="conrad@skyphusion.org", limit=10)
        self.assertEqual([m.message_id for m in page.items], ["old"])

    def test_get_message(self):
        msg = self.client.get_message("m2")
        self.assertIsNotNone(msg)
        self.assertEqual(msg.subject, "hello there")
        self.assertEqual(msg.body_text, "hello body")

    def test_get_missing_returns_none(self):
        self.assertIsNone(self.client.get_message("nope"))

    def test_search(self):
        hits = self.client.search("cats")
        self.assertEqual([h.message_id for h in hits], ["m3"])

    def test_summary_seen_defaults_true_but_reads_explicit_value(self):
        # #seen: an old API that omits `seen` renders as read (back-compat); an explicit
        # value is honored. The seed dicts have no seen key -> default True.
        page = self.client.list_messages(limit=10)
        self.assertTrue(all(m.seen for m in page.items))
        self.msgs.insert(0, make_message("u0", subject="unread", seen=False))
        first = self.client.list_messages(limit=1).items[0]
        self.assertEqual(first.message_id, "u0")
        self.assertFalse(first.seen)

    def test_set_seen_posts_and_returns_updated_count(self):
        # POST /api/messages/seen flips the backing dicts and returns the changed count.
        n = self.client.set_seen(["m1", "m2"], True)
        self.assertEqual(n, 2)
        self.assertTrue(all(m.get("seen") for m in self.msgs if m["messageId"] in ("m1", "m2")))
        last = self.transport.calls[-1]
        self.assertIn("/api/messages/seen", last)

    def test_set_seen_empty_is_a_noop_without_a_request(self):
        before = len(self.transport.calls)
        self.assertEqual(self.client.set_seen([], True), 0)
        self.assertEqual(len(self.transport.calls), before)

    def test_ping_good_token(self):
        self.assertTrue(self.client.ping())

    def test_get_attachment(self):
        self.msgs[0]["attachments"] = [{"filename": "photo.png", "mime": "image/png", "size": 7}]
        self.msgs[0]["attachmentBytes"] = [b"PNGDATA"]
        att = self.client.get_attachment("m3", 0)
        self.assertEqual(att.body, b"PNGDATA")
        self.assertEqual(att.mime, "image/png")
        self.assertEqual(att.filename, "photo.png")
        self.assertTrue(self.transport.calls[-1].endswith("/api/messages/m3/attachments/0"))

    def test_get_attachment_404_raises(self):
        with self.assertRaises(PosternError):
            self.client.get_attachment("m3", 99)

    def test_bad_token_raises_auth_error(self):
        bad = PosternClient("https://postern.example", "wrong", transport=self.transport)
        with self.assertRaises(PosternAuthError):
            bad.list_messages()
        self.assertFalse(bad.ping())

    def test_query_injection_is_encoded(self):
        # A query with & and = must not smuggle extra params; urlencode quotes it.
        self.client.list_messages(q="a&limit=999")
        last = self.transport.calls[-1]
        self.assertIn("q=a%26limit%3D999", last)

    def test_non_json_body_raises(self):
        class Garbage:
            def __call__(self, req):
                return 200, b"<<not json>>"

        c = PosternClient("https://x", "t", transport=Garbage())
        with self.assertRaises(PosternError):
            c.list_messages()


class ScopeFaithfulFakeTest(unittest.TestCase):
    """#352 core unblocker 6: the fake models imap vs read vs send vs delete token
    scopes (mirroring inbound/src/api.ts requiredScope()), so a test using the WRONG
    token for a route gets the SAME 403 the real worker would give -- catching a
    client wired to the wrong service token, not just a wrong-token 401."""

    def setUp(self):
        from posternimap.tests.fakes import FakeTransport

        self.msgs = [make_message("m1", subject="hello")]
        self.transport = FakeTransport(
            self.msgs,
            expected_token=None,
            page_size=10,
            token_scopes={
                "read-tok": "read",
                "delete-tok": "delete",
                "imap-tok": "imap",
                "both-tok": "both",
            },
        )

    def _client(self, token):
        return PosternClient("https://x", token, transport=self.transport)

    def test_read_scoped_token_403s_on_imap_drafts(self):
        c = self._client("read-tok")
        with self.assertRaises(PosternError) as ctx:
            c.list_imap_drafts("a@example.com")
        self.assertEqual(ctx.exception.status, 403)

    def test_read_scoped_token_403s_on_imap_import(self):
        c = self._client("read-tok")
        with self.assertRaises(PosternError) as ctx:
            c.import_message("a@example.com", "trash", b"From: a@x\r\n\r\nbody\r\n")
        self.assertEqual(ctx.exception.status, 403)

    def test_imap_scoped_token_403s_on_delete(self):
        c = self._client("imap-tok")
        with self.assertRaises(PosternError) as ctx:
            c.delete_message("m1")
        self.assertEqual(ctx.exception.status, 403)

    def test_imap_scoped_token_403s_on_read_list(self):
        c = self._client("imap-tok")
        with self.assertRaises(PosternError) as ctx:
            c.list_messages(limit=10)
        self.assertEqual(ctx.exception.status, 403)

    def test_delete_scoped_token_403s_on_read_list(self):
        c = self._client("delete-tok")
        with self.assertRaises(PosternError) as ctx:
            c.list_messages(limit=10)
        self.assertEqual(ctx.exception.status, 403)

    def test_delete_scoped_token_succeeds_on_delete(self):
        c = self._client("delete-tok")
        c.delete_message("m1")  # must not raise

    def test_imap_scoped_token_succeeds_on_drafts_and_import(self):
        c = self._client("imap-tok")
        draft = c.create_imap_draft("a@example.com", {"subject": "hi"})
        self.assertEqual(draft.identity, "a@example.com")
        c.import_message("a@example.com", "trash", b"From: a@x\r\n\r\nbody\r\n")

    def test_read_scoped_token_succeeds_on_list_and_search(self):
        c = self._client("read-tok")
        self.assertEqual([m.message_id for m in c.list_messages(limit=10).items], ["m1"])
        c.get_folders()

    def test_both_scope_token_succeeds_everywhere(self):
        c = self._client("both-tok")
        c.list_messages(limit=10)
        c.create_imap_draft("a@example.com", {"subject": "hi"})
        c.import_message("a@example.com", "trash", b"From: a@x\r\n\r\nbody\r\n")


if __name__ == "__main__":
    unittest.main()

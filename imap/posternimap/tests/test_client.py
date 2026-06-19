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

    def test_ping_good_token(self):
        self.assertTrue(self.client.ping())

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


if __name__ == "__main__":
    unittest.main()

"""Tests for the IMAP adapter layer (message + mailbox).

These import Twisted (the adapters implement Twisted interfaces), so the whole
module skips cleanly if Twisted is not installed; the pure layers above stay
covered regardless.
"""

from __future__ import annotations

import unittest

try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False

from posternimap.client import PosternClient
from posternimap.tests.fakes import FakeTransport, make_message


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class MailboxTest(unittest.TestCase):
    def setUp(self):
        # newest-first as the API returns it
        self.msgs = [
            make_message("m3", direction="outbound", subject="sent reply"),
            make_message("m2", subject="second", body="body two"),
            make_message("m1", subject="first", body="body one"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="t", page_size=2)
        self.client = PosternClient("https://x", "t", transport=self.transport)

    def _mailbox(self, direction=None):
        from posternimap.mailbox import PosternMailbox

        return PosternMailbox(self.client, direction=direction, page_size=2)

    def test_count_and_ordering_oldest_first(self):
        mb = self._mailbox()
        self.assertEqual(mb.getMessageCount(), 3)
        # seq 1 is oldest (m1), seq 3 newest (m3); fetch them all
        from twisted.mail.imap4 import MessageSet

        got = list(mb.fetch(MessageSet(1, 3), uid=False))
        seqs = [seq for seq, _ in got]
        self.assertEqual(seqs, [1, 2, 3])
        subjects = [m._msg.subject for _, m in got]
        self.assertEqual(subjects, ["first", "second", "sent reply"])

    def test_uid_equals_seq_in_snapshot(self):
        from twisted.mail.imap4 import MessageSet

        mb = self._mailbox()
        got = list(mb.fetch(MessageSet(1, 3), uid=False))
        for seq, msg in got:
            self.assertEqual(msg.getUID(), seq)

    def test_direction_filter_mailbox(self):
        mb = self._mailbox(direction="outbound")
        self.assertEqual(mb.getMessageCount(), 1)

    def test_request_status(self):
        mb = self._mailbox()
        status = mb.requestStatus(["MESSAGES", "UIDNEXT", "UIDVALIDITY", "RECENT"])
        self.assertEqual(status["MESSAGES"], 3)
        self.assertEqual(status["UIDNEXT"], 4)
        self.assertEqual(status["RECENT"], 0)

    def test_read_only_rejects_destructive_writes(self):
        from posternimap.mailbox import ReadOnlyError

        mb = self._mailbox()
        self.assertFalse(mb.isWriteable())
        with self.assertRaises(ReadOnlyError):
            mb.expunge()
        with self.assertRaises(ReadOnlyError):
            mb.store(None, ["\\Seen"], 1, False)

    def test_append_is_noop_success(self):
        # APPEND must NOT fail (a client copies its sent mail into Sent); it is a
        # no-op that returns a fired Deferred, so the post-send copy succeeds.
        from twisted.internet import defer

        mb = self._mailbox(direction="outbound")
        d = mb.addMessage(b"raw rfc822 bytes", flags=["\\Seen"], date=None)
        self.assertIsInstance(d, defer.Deferred)
        out = []
        d.addCallback(out.append)
        self.assertEqual(out, [None])  # already fired, no error

    def test_message_headers_and_body(self):
        from twisted.mail.imap4 import MessageSet

        mb = self._mailbox()
        got = dict((seq, m) for seq, m in mb.fetch(MessageSet(2, 2), uid=False))
        msg = got[2]
        headers = msg.getHeaders(False, "Subject", "From")
        self.assertEqual(headers["SUBJECT"], "second")
        self.assertEqual(msg.getBodyFile().read().decode().strip(), "body two")
        self.assertGreater(msg.getSize(), 0)
        self.assertFalse(msg.isMultipart())

    def test_flags_reflect_trust_and_direction(self):
        from twisted.mail.imap4 import MessageSet

        mb = self._mailbox(direction="outbound")
        (_, msg), = list(mb.fetch(MessageSet(1, 1), uid=False))
        flags = list(msg.getFlags())
        self.assertIn("\\Seen", flags)
        self.assertIn("Outbound", flags)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class AccountTest(unittest.TestCase):
    def setUp(self):
        from posternimap.config import Config
        from posternimap.client import PosternClient

        self.cfg = Config(api_url="https://x", auth_mode="token", api_timeout=5.0)
        # Back the account's client with a fake transport so no network is touched
        # and we can assert placeholder folders make zero API calls.
        self.transport = FakeTransport(
            [make_message("m1"), make_message("m2", direction="outbound")],
            expected_token="tok",
            page_size=2,
        )
        self._orig_client = None

        def _fake_client(acct_self):
            return PosternClient(acct_self._cfg.api_url, acct_self._token, transport=self.transport)

        from posternimap import account as account_mod

        self._orig_client = account_mod.PosternAccount._client
        account_mod.PosternAccount._client = _fake_client

    def tearDown(self):
        from posternimap import account as account_mod

        if self._orig_client is not None:
            account_mod.PosternAccount._client = self._orig_client

    def test_lists_special_use_folder_set(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        names = {name for name, _ in acct.listMailboxes("", "*")}
        self.assertEqual(names, {"INBOX", "Sent", "All", "Drafts", "Trash", "Junk", "Archive"})

    def test_list_advertises_rfc6154_special_use_attributes(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        flags = {name: set(box.getFlags()) for name, box in acct.listMailboxes("", "*")}
        # Each LIST entry carries its special-use attribute so a client auto-maps.
        self.assertIn("\\Sent", flags["Sent"])
        self.assertIn("\\Drafts", flags["Drafts"])
        self.assertIn("\\Trash", flags["Trash"])
        self.assertIn("\\Junk", flags["Junk"])
        self.assertIn("\\Archive", flags["Archive"])
        self.assertIn("\\All", flags["All"])
        # INBOX has no special-use attr, just the structural one.
        self.assertNotIn("\\Sent", flags["INBOX"])
        for name in flags:
            self.assertIn("\\HasNoChildren", flags[name])

    def test_selected_mailbox_reports_message_flags_not_special_use(self):
        # The SELECT instance must report message flags, NOT the LIST attributes.
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        sent = acct.select("Sent")
        self.assertEqual(set(sent.getFlags()), {"\\Seen"})

    def test_placeholder_folders_are_empty_without_api_calls(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        for name in ("Drafts", "Trash", "Junk", "Archive"):
            box = acct.select(name)
            self.assertEqual(box.getMessageCount(), 0, name)
        # An empty placeholder must not have touched the Postern API at all.
        self.assertEqual(self.transport.calls, [])

    def test_subscribe_unsubscribe_are_noops(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        self.assertIsNone(acct.subscribe("Sent"))
        self.assertIsNone(acct.unsubscribe("Sent"))
        for name in ("INBOX", "Sent", "Drafts", "Trash", "Junk", "Archive", "All"):
            self.assertTrue(acct.isSubscribed(name))

    def test_select_inbox_case_insensitive(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        self.assertIsNotNone(acct.select("inbox"))
        self.assertIsNotNone(acct.select("INBOX"))

    def test_select_unknown_returns_none(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        self.assertIsNone(acct.select("Nonexistent"))

    def test_create_rejected(self):
        from posternimap.account import PosternAccount, ReadOnlyAccountError

        acct = PosternAccount(self.cfg, "agent", "tok")
        with self.assertRaises(ReadOnlyAccountError):
            acct.create("Drafts")


if __name__ == "__main__":
    unittest.main()

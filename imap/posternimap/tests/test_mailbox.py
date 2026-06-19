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

    def test_read_only_rejects_writes(self):
        from posternimap.mailbox import ReadOnlyError

        mb = self._mailbox()
        self.assertFalse(mb.isWriteable())
        with self.assertRaises(ReadOnlyError):
            mb.expunge()
        with self.assertRaises(ReadOnlyError):
            mb.addMessage(b"raw")

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

        self.cfg = Config(api_url="https://x", auth_mode="token", api_timeout=5.0)

    def test_lists_three_fixed_mailboxes(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        names = {name for name, _ in acct.listMailboxes("", "*")}
        self.assertEqual(names, {"INBOX", "Sent", "All"})

    def test_select_inbox_case_insensitive(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        self.assertIsNotNone(acct.select("inbox"))
        self.assertIsNotNone(acct.select("INBOX"))

    def test_select_unknown_returns_none(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        self.assertIsNone(acct.select("Drafts"))

    def test_create_rejected(self):
        from posternimap.account import PosternAccount, ReadOnlyAccountError

        acct = PosternAccount(self.cfg, "agent", "tok")
        with self.assertRaises(ReadOnlyAccountError):
            acct.create("Drafts")


if __name__ == "__main__":
    unittest.main()

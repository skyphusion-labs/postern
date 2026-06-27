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

    def _mailbox(self, direction=None, *, window=0, poll_seconds=0, clock=None):
        from posternimap.mailbox import PosternMailbox

        return PosternMailbox(
            self.client,
            direction=direction,
            page_size=2,
            window=window,
            poll_seconds=poll_seconds,
            clock=clock,
        )

    def test_count_and_ordering_oldest_first(self):
        mb = self._mailbox()
        self.assertEqual(mb.getMessageCount(), 3)
        # seq 1 is oldest (m1), seq 3 newest (m3); fetch them all
        from twisted.mail.imap4 import MessageSet

        got = list(mb.fetch(MessageSet(1, 3), uid=False))
        seqs = [seq for seq, _ in got]
        self.assertEqual(seqs, [1, 2, 3])
        subjects = [m._summary.subject for _, m in got]
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
        self.assertEqual(headers["subject"], "second")
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


    # --- #102 Stage 1: lazy ENVELOPE, windowing, live refresh ---

    def test_envelope_scan_does_zero_body_fetches(self):
        # The headline #102 proof: a full ENVELOPE/FLAGS/INTERNALDATE scan must not
        # pull a single per-message body. Opening a message then costs exactly one.
        from twisted.mail.imap4 import MessageSet, getEnvelope

        mb = self._mailbox()
        msgs = [m for _, m in mb.fetch(MessageSet(1, 3), uid=False)]
        self.assertEqual(self.transport.body_fetches, 0)  # list pass only so far
        for m in msgs:
            getEnvelope(m)        # ENVELOPE -> getHeaders(True), summary-served
            list(m.getFlags())    # summary-served
            m.getInternalDate()   # summary-served
        self.assertEqual(self.transport.body_fetches, 0)
        # Envelope content is correct despite no body fetch.
        env_subjects = [getEnvelope(m)[1] for m in msgs]
        self.assertEqual(env_subjects, ["first", "second", "sent reply"])
        # Opening one message hydrates exactly once; a second access is memoized.
        msgs[0].getBodyFile()
        self.assertEqual(self.transport.body_fetches, 1)
        msgs[0].getSize()
        self.assertEqual(self.transport.body_fetches, 1)

    def test_body_field_fetch_from_summary_no_hydrate(self):
        from twisted.mail.imap4 import MessageSet

        mb = self._mailbox()
        (_, msg), = list(mb.fetch(MessageSet(2, 2), uid=False))
        hdrs = msg.getHeaders(False, "Subject", "From")
        self.assertEqual(hdrs["subject"], "second")
        self.assertEqual(self.transport.body_fetches, 0)

    def test_window_caps_to_recent_and_uid_is_global_ordinal(self):
        # 3 messages oldest-first [m1, m2, m3]; window=2 shows the recent two.
        mb = self._mailbox(window=2)
        self.assertEqual(mb.getMessageCount(), 2)
        from twisted.mail.imap4 import MessageSet

        got = list(mb.fetch(MessageSet(1, 2), uid=False))
        self.assertEqual([m._summary.subject for _, m in got], ["second", "sent reply"])
        # UID == global arrival ordinal (base = N - window = 1), not window position.
        self.assertEqual([m.getUID() for _, m in got], [2, 3])
        self.assertEqual(mb.getUID(1), 2)
        self.assertEqual(mb.getUID(2), 3)
        # UIDNEXT is the next global ordinal (total + 1), regardless of the window.
        self.assertEqual(mb.getUIDNext(), 4)
        self.assertEqual(mb.requestStatus(["MESSAGES", "UIDNEXT"]),
                         {"MESSAGES": 2, "UIDNEXT": 4})

    def test_uid_fetch_under_window_resolves_global_uids(self):
        from twisted.mail.imap4 import MessageSet

        mb = self._mailbox(window=2)
        # UID FETCH 1:* -> only the two present (global UIDs 2 and 3), keyed by seq.
        got = list(mb.fetch(MessageSet(1, None), uid=True))
        self.assertEqual([(seq, m.getUID()) for seq, m in got], [(1, 2), (2, 3)])

    def test_refresh_appends_new_arrivals_and_pushes_exists(self):
        mb = self._mailbox()
        mb.getMessageCount()  # force the initial snapshot
        listener = _FakeListener()
        mb.addListener(listener)  # poll_seconds=0 -> no LoopingCall, logic only
        # A new message arrives at the newest end (front of the newest-first list).
        self.msgs.insert(0, make_message("m4", subject="newest"))
        mb._poll_tick()
        self.assertEqual(mb.getMessageCount(), 4)
        self.assertEqual(listener.events, [(4, None)])
        # The new arrival keeps appending global ordinals: UID 4, seq 4.
        from twisted.mail.imap4 import MessageSet

        (seq, msg), = list(mb.fetch(MessageSet(4, 4), uid=False))
        self.assertEqual((seq, msg.getUID(), msg._summary.subject), (4, 4, "newest"))
        # No new mail -> no spurious EXISTS on the next tick.
        mb._poll_tick()
        self.assertEqual(listener.events, [(4, None)])

    def test_poll_loop_fires_and_stops_via_clock(self):
        # Deterministic LoopingCall coverage with a virtual clock (no real reactor).
        from twisted.internet.task import Clock

        clock = Clock()
        mb = self._mailbox(poll_seconds=5, clock=clock)
        mb.getMessageCount()
        listener = _FakeListener()
        mb.addListener(listener)
        self.assertIsNotNone(mb._poll)
        self.msgs.insert(0, make_message("m4", subject="newest"))
        clock.advance(5)  # one poll interval elapses
        self.assertEqual(listener.events, [(4, None)])
        # removeListener stops the loop cleanly (no pending calls leak).
        mb.removeListener(listener)
        self.assertIsNone(mb._poll)
        self.assertEqual(clock.getDelayedCalls(), [])

    def test_poll_self_prunes_dead_listener_and_stops(self):
        # connectionLost does not always removeListener; the poll must drop a dead
        # listener (transport gone) and stop itself.
        mb = self._mailbox(poll_seconds=0)
        mb.getMessageCount()
        dead = _FakeListener(connected=False)
        mb._listeners.append(dead)
        mb._poll_tick()
        self.assertEqual(mb._listeners, [])
        self.assertEqual(dead.events, [])


class _FakeListener:
    """Minimal IMailboxListener double capturing newMessages pushes."""

    def __init__(self, connected=True):
        self.events = []
        if connected:
            self.transport = type("_T", (), {"connected": 1})()
        else:
            self.transport = type("_T", (), {"connected": 0})()

    def newMessages(self, exists, recent):
        self.events.append((exists, recent))

    def flagsChanged(self, newFlags):
        pass

    def modeChanged(self, writeable):
        pass


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

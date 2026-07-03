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
from posternimap.tests.fakes import ErrorTransport, FakeTransport, make_message


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

    def test_uid_is_store_rowid_not_position(self):
        # UID is the store insertion key (rowid). For this contiguous fixture the
        # rowids happen to be 1..3, so UID coincides with the sequence number; the
        # backdated-arrival tests below prove the two DIVERGE the moment arrival
        # order and date order disagree (the whole point of fault F9).
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

    def test_append_to_placeholder_folder_is_rejected(self):
        # #109: a placeholder folder has no backing store; APPEND must FAIL (tagged
        # NO at the protocol layer) rather than fake-ack OK and drop the message.
        from twisted.internet import defer
        from posternimap.mailbox import AppendRejectedError, PosternMailbox

        mb = PosternMailbox(self.client, empty=True)
        d = mb.addMessage(b"raw rfc822 bytes", flags=["\\Seen"], date=None)
        self.assertIsInstance(d, defer.Deferred)
        errs = []
        d.addErrback(errs.append)  # consume the failure (no unhandled-error noise)
        self.assertEqual(len(errs), 1)
        self.assertTrue(errs[0].check(AppendRejectedError))

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


    # --- #189 envelope fidelity v2: ENVELOPE Cc/Reply-To + RFC822.SIZE ---

    def test_envelope_renders_cc_and_reply_to_from_summary(self):
        # #189: a FETCH ENVELOPE renders Cc/Reply-To from the stored raw header
        # strings, body-free (zero hydrate), and a comma-bearing display name stays
        # ONE mailbox -- never naively split on the comma.
        from twisted.mail.imap4 import MessageSet, getEnvelope

        cc = '"Doe, John" <john@x.com>, jane@y.com'
        mb, transport = self._custom_mailbox(
            [make_message("e1", subject="env", cc=cc, replyTo="list@example.com")]
        )
        (_, msg), = list(mb.fetch(MessageSet(1, 1), uid=False))
        env = getEnvelope(msg)
        # RFC 3501 ENVELOPE order: [date, subject, from, sender, reply-to, to, cc,
        # bcc, in-reply-to, message-id].
        reply_to, cc_field, bcc_field = env[4], env[6], env[7]
        self.assertEqual(transport.body_fetches, 0)  # served from the summary
        self.assertEqual([list(m[2:]) for m in reply_to], [["list", "example.com"]])
        # Two cc addresses; the quoted "Doe, John" display name kept its comma.
        self.assertEqual(len(cc_field), 2)
        self.assertEqual(cc_field[0][0], "Doe, John")
        self.assertEqual(list(cc_field[0][2:]), ["john", "x.com"])
        self.assertEqual(list(cc_field[1][2:]), ["jane", "y.com"])
        self.assertIsNone(bcc_field)  # no Bcc stored -> ENVELOPE NIL

    def test_html_message_envelope_scan_is_body_free_but_cold_header_serves_content_type(self):
        # #210 + #102: a message with an HTML part must still scan body-free (getEnvelope
        # reads the header map by per-key .get(), never a MIME header), AND a cold
        # whole-message header serve (iterating getHeaders(True), what the RFC822 /
        # BODY[] serializers do) must hydrate and carry Content-Type: text/html so the
        # client renders HTML instead of literal markup.
        from twisted.mail.imap4 import MessageSet, getEnvelope

        html = "<html><body><h1>hi</h1></body></html>"
        mb, transport = self._custom_mailbox([make_message("h1", subject="rich", bodyHtml=html)])
        (_, msg), = list(mb.fetch(MessageSet(1, 1), uid=False))
        # ENVELOPE scan: zero body fetch (the lazy header map serves per-key .get()).
        getEnvelope(msg)
        self.assertEqual(transport.body_fetches, 0)
        # Iterating the whole-header map hydrates and yields the MIME headers.
        headers = dict(msg.getHeaders(True).items())
        self.assertEqual(transport.body_fetches, 1)
        self.assertIn("text/html", headers.get("content-type", ""))
        self.assertEqual(headers.get("content-transfer-encoding"), "8bit")

    def test_envelope_nil_for_old_row_without_fidelity_fields(self):
        # An old row carries no Cc/Bcc/Sender/Reply-To: ENVELOPE renders them NIL
        # (Twisted maps an absent header to None), and Sender/Reply-To fall back to
        # the From address exactly as the pre-v2 render did.
        from twisted.mail.imap4 import MessageSet, getEnvelope

        mb, transport = self._custom_mailbox([make_message("o1", subject="old")])
        (_, msg), = list(mb.fetch(MessageSet(1, 1), uid=False))
        env = getEnvelope(msg)
        self.assertEqual(transport.body_fetches, 0)
        self.assertIsNone(env[6])  # cc NIL
        self.assertIsNone(env[7])  # bcc NIL

    def test_size_is_projected_length_even_when_wire_size_present(self):
        # RFC 3501: SIZE must byte-match the BODY[] literal, and this door serves the
        # rendered projection as BODY[] (raw wire bytes are NOT stored, CONTRACT 10.7).
        # So SIZE is the projected length REGARDLESS of a stored wire_size -- the two
        # must stay consistent, because a SIZE/literal mismatch is exactly what breaks
        # size-validating clients. wire_size here is API-only fidelity (#189/#207).
        from twisted.mail.imap4 import MessageSet
        from posternimap.client import Message
        from posternimap.rfc822 import render_rfc822

        raw = make_message("w1", subject="sized", body="a body to measure", wireSize=999999)
        mb, _ = self._custom_mailbox([raw])
        (_, msg), = list(mb.fetch(MessageSet(1, 1), uid=False))
        size = msg.getSize()
        # Equals the rendered RFC822 length (the BODY[] literal), NOT the divergent
        # stored wire_size the ENVELOPE-fidelity path carries.
        self.assertEqual(size, len(render_rfc822(Message.from_json(raw))))
        self.assertNotEqual(size, 999999)


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

    def test_header_fields_names_arrive_as_bytes_from_twisted(self):
        # Regression for #179: Twisted's FETCH parser passes the names inside
        # BODY[HEADER.FIELDS (...)] to getHeaders as BYTES. The old str-only
        # comparison matched nothing, so every HEADER.FIELDS FETCH answered an
        # empty header block and a HEADER.FIELDS-scanning client (the Gmail app)
        # showed "(no subject)" + a blank sender for every message. Both serving
        # paths must accept bytes: the summary-served envelope subset, and the
        # hydrated path (a non-envelope name like Content-Type in the set).
        from twisted.mail.imap4 import MessageSet

        mb = self._mailbox()
        (_, msg), = list(mb.fetch(MessageSet(2, 2), uid=False))
        # Summary-served (all names in the envelope set): no body fetch.
        hdrs = msg.getHeaders(False, b"subject", b"from", b"to")
        self.assertEqual(hdrs["subject"], "second")
        self.assertEqual(hdrs["from"], "m2@example.com")
        self.assertEqual(self.transport.body_fetches, 0)
        # Hydrated (content-type is not an envelope name): the Gmail-app scan
        # shape. Must return the real headers, not an empty block.
        hdrs = msg.getHeaders(
            False, b"date", b"subject", b"from", b"content-type", b"to", b"cc", b"message-id"
        )
        self.assertEqual(hdrs["subject"], "second")
        self.assertEqual(hdrs["from"], "m2@example.com")
        self.assertIn("content-type", hdrs)

    def test_window_caps_to_recent_and_uid_is_store_rowid(self):
        # 3 messages, store rowids 1..3 (uid == arrival ordinal); window=2 shows the
        # most-recent two (the highest uids), NOT a window-relative 1..2.
        mb = self._mailbox(window=2)
        self.assertEqual(mb.getMessageCount(), 2)
        from twisted.mail.imap4 import MessageSet

        got = list(mb.fetch(MessageSet(1, 2), uid=False))
        self.assertEqual([m._summary.subject for _, m in got], ["second", "sent reply"])
        # UID is the store rowid (2, 3), not the window position (1, 2).
        self.assertEqual([m.getUID() for _, m in got], [2, 3])
        self.assertEqual(mb.getUID(1), 2)
        self.assertEqual(mb.getUID(2), 3)
        # UIDNEXT is the next rowid above the highest UID, regardless of the window.
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

    def test_poll_now_refreshes_and_pushes_exists_with_poll_disabled(self):
        # #102 NOOP path: poll_now must surface new mail ON DEMAND, working even when
        # the timed poll is disabled (poll_seconds=0), and push an untagged EXISTS.
        mb = self._mailbox(poll_seconds=0)
        mb.getMessageCount()  # force the initial snapshot (3)
        listener = _FakeListener()
        mb.addListener(listener)
        self.assertIsNone(mb._poll)  # poll disabled: no LoopingCall running
        self.msgs.insert(0, make_message("m4", subject="newest"))
        self.assertEqual(mb.poll_now(), 1)
        self.assertEqual(mb.getMessageCount(), 4)
        self.assertEqual(listener.events, [(4, None)])  # untagged EXISTS pushed
        # Idempotent: no new mail -> no spurious EXISTS, no renumbering.
        self.assertEqual(mb.poll_now(), 0)
        self.assertEqual(listener.events, [(4, None)])

    def test_poll_now_before_load_is_a_safe_noop(self):
        # Called before the snapshot is loaded (a NOOP in the selected state races the
        # lazy load): no fetch, no push, no crash.
        mb = self._mailbox(poll_seconds=0)
        listener = _FakeListener()
        mb.addListener(listener)
        self.assertEqual(mb.poll_now(), 0)
        self.assertEqual(listener.events, [])


    # --- #102 fault F9: durable UID == store insertion key (uid-ordering) ---

    def _custom_mailbox(self, msgs, **kw):
        from posternimap.mailbox import PosternMailbox

        transport = FakeTransport(msgs, expected_token="t", page_size=2)
        client = PosternClient("https://x", "t", transport=transport)
        return PosternMailbox(client, page_size=2, **kw), transport

    def test_uidvalidity_is_config_driven(self):
        # #210 rider: UIDVALIDITY must be operator-configurable so a projection change
        # (the HTML/8bit fix flips existing messages' BODY[]/SIZE under the same UID)
        # can be signalled to clients (RFC 3501 message immutability). A configured
        # value flows through BOTH getUIDValidity and STATUS.
        mb, _ = self._custom_mailbox([make_message("u1", subject="x")], uidvalidity=42)
        self.assertEqual(mb.getUIDValidity(), 42)
        self.assertEqual(mb.requestStatus(["UIDVALIDITY"]), {"UIDVALIDITY": 42})

    def test_uidvalidity_defaults_to_historical_constant(self):
        # Default is the historical constant (1), so nothing changes until an operator
        # bumps POSTERN_IMAP_UIDVALIDITY.
        from posternimap.mailbox import _UID_VALIDITY

        mb, _ = self._custom_mailbox([make_message("u1", subject="x")])
        self.assertEqual(mb.getUIDValidity(), _UID_VALIDITY)

    def test_backdated_arrival_orders_by_uid_not_date(self):
        # F9: a NEW message carrying an OLD Date header must take the next-highest
        # UID and appear LAST (arrival order), NOT insert mid-order by date. The
        # fake derives uid from arrival position, so "back" (newest arrival, index 0)
        # gets the highest uid (3) despite the oldest Date header.
        from twisted.mail.imap4 import MessageSet

        msgs = [
            make_message("back", subject="backdated", date="2026-06-01T00:00:00Z"),
            make_message("b", subject="second", date="2026-06-20T00:00:00Z"),
            make_message("a", subject="first", date="2026-06-10T00:00:00Z"),
        ]
        mb, _ = self._custom_mailbox(msgs)
        got = list(mb.fetch(MessageSet(1, 3), uid=False))
        # Sorted by uid (arrival), NOT by date: date order would have put "back" first.
        self.assertEqual([m._summary.subject for _, m in got],
                         ["first", "second", "backdated"])
        self.assertEqual([m.getUID() for _, m in got], [1, 2, 3])
        # UIDs are strictly ascending with sequence number (RFC 3501).
        uids = [m.getUID() for _, m in got]
        self.assertEqual(uids, sorted(uids))

    def test_refresh_backdated_arrival_appends_without_shifting_uids(self):
        # A backdated NEW arrival (highest uid, old Date) that the poll DOES see must
        # append at the high end and leave every existing UID/seq untouched.
        msgs = [
            make_message("b", subject="second", date="2026-06-20T00:00:00Z"),
            make_message("a", subject="first", date="2026-06-10T00:00:00Z"),
        ]
        mb, _ = self._custom_mailbox(msgs)
        mb.getMessageCount()  # snapshot: a(uid1, seq1), b(uid2, seq2)
        listener = _FakeListener()
        mb.addListener(listener)
        # New arrival at the front (newest -> uid 3) but with an OLDER Date header.
        msgs.insert(0, make_message("back", subject="backdated",
                                    date="2026-06-01T00:00:00Z"))
        mb._poll_tick()
        self.assertEqual(mb.getMessageCount(), 3)
        self.assertEqual(listener.events, [(3, None)])
        from twisted.mail.imap4 import MessageSet

        got = list(mb.fetch(MessageSet(1, 3), uid=False))
        # Existing a/b keep uid 1/2 at seq 1/2; "back" appends as seq 3, uid 3.
        self.assertEqual([(seq, m.getUID(), m._summary.subject) for seq, m in got],
                         [(1, 1, "first"), (2, 2, "second"), (3, 3, "backdated")])

    def test_uid_fetch_resolves_sparse_rowids(self):
        # UIDs are store rowids, not 1..n; a UID FETCH must map each requested UID
        # back to its sequence number, and skip UIDs not present.
        from twisted.mail.imap4 import MessageSet

        msgs = [
            make_message("m30", subject="c", uid=30),
            make_message("m20", subject="b", uid=20),
            make_message("m10", subject="a", uid=10),
        ]
        mb, _ = self._custom_mailbox(msgs)
        # Snapshot sorted by uid: a(10, seq1), b(20, seq2), c(30, seq3).
        got = list(mb.fetch(MessageSet(20, 30), uid=True))
        self.assertEqual([(seq, m.getUID()) for seq, m in got], [(2, 20), (3, 30)])
        # UID '*' resolves to the highest UID present (30), not the message count.
        star = list(mb.fetch(MessageSet(1, None), uid=True))
        self.assertEqual([(seq, m.getUID()) for seq, m in star],
                         [(1, 10), (2, 20), (3, 30)])
        # A gap UID (25, absent) yields nothing rather than a wrong message.
        self.assertEqual(list(mb.fetch(MessageSet(25, 25), uid=True)), [])
        # UIDNEXT is one past the highest rowid.
        self.assertEqual(mb.getUIDNext(), 31)


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


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class MailboxLoadErrorTest(unittest.TestCase):
    """#144: an upstream store/auth failure on the lazy load must raise the typed
    MailboxLoadError (a MailboxException the server maps to a tagged NO), not let a
    raw PosternError/PosternAuthError escape -- and must leave the snapshot unloaded
    so a later command re-attempts the load."""

    def _mailbox(self, status):
        from posternimap.mailbox import PosternMailbox

        transport = ErrorTransport(status=status)
        client = PosternClient("https://x", "tok", transport=transport)
        return PosternMailbox(client, page_size=2), transport

    def test_401_load_raises_mailbox_load_error(self):
        from posternimap.mailbox import MailboxLoadError

        mb, _ = self._mailbox(401)
        with self.assertRaises(MailboxLoadError):
            mb.getMessageCount()

    def test_5xx_load_raises_mailbox_load_error(self):
        from posternimap.mailbox import MailboxLoadError

        mb, _ = self._mailbox(503)
        with self.assertRaises(MailboxLoadError):
            mb.getMessageCount()

    def test_load_error_message_is_generic_and_transient(self):
        # The client-facing text must not leak the token or internal detail; it is a
        # generic, retry-appropriate hint (the server prepends the [UNAVAILABLE] code).
        from posternimap.mailbox import MailboxLoadError

        mb, _ = self._mailbox(401)
        try:
            mb.getMessageCount()
            self.fail("expected MailboxLoadError")
        except MailboxLoadError as exc:
            text = str(exc).lower()
            self.assertIn("temporarily unavailable", text)
            self.assertNotIn("token", text)

    def test_snapshot_stays_unloaded_so_a_retry_reattempts(self):
        # First load fails (snapshot unloaded); a STATUS/SELECT retry must hit the API
        # again rather than caching the failure -- the failure is transient, not sticky.
        from posternimap.mailbox import MailboxLoadError

        mb, transport = self._mailbox(401)
        with self.assertRaises(MailboxLoadError):
            mb.getMessageCount()
        first = len(transport.calls)
        with self.assertRaises(MailboxLoadError):
            mb.requestStatus(["MESSAGES"])
        self.assertGreater(len(transport.calls), first)

    def test_requestStatus_propagates_load_error(self):
        # requestStatus is the STATUS entry point (#143); it must surface the typed
        # error so the server's __ebStatus override maps it to a NO.
        from posternimap.mailbox import MailboxLoadError

        mb, _ = self._mailbox(500)
        with self.assertRaises(MailboxLoadError):
            mb.requestStatus(["MESSAGES", "UIDNEXT"])

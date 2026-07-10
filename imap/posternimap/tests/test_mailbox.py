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

    def _mailbox(self, direction=None, *, window=0, poll_seconds=0, clock=None, seen_writable=False, delete_writable=False):
        from posternimap.mailbox import PosternMailbox

        return PosternMailbox(
            self.client,
            direction=direction,
            page_size=2,
            window=window,
            poll_seconds=poll_seconds,
            clock=clock,
            seen_writable=seen_writable,
            delete_writable=delete_writable,
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

    def test_to_filter_shows_multi_recipient_in_both_views(self):
        import urllib.parse

        msgs = [
            make_message(
                "multi",
                to="Support <support@skyphusion.org>, Security <security@skyphusion.org>",
                deliveredTo=["support@skyphusion.org", "security@skyphusion.org"],
            )
        ]
        for addr in ("support@skyphusion.org", "security@skyphusion.org"):
            mb, transport = self._custom_mailbox(msgs, to=addr)
            self.assertEqual(mb.getMessageCount(), 1)
            list_calls = [
                urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
                for u in transport.calls
                if "/api/messages" in u and "/api/messages/seen" not in u
            ]
            self.assertTrue(any(q.get("to") == [addr] for q in list_calls))

    def test_to_filter_v1_row_matches_to_header(self):
        msgs = [make_message("old", to="conrad@skyphusion.org")]
        mb, _ = self._custom_mailbox(msgs, to="conrad@skyphusion.org")
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
        # isWriteable() is False, so Twisted never calls expunge() on this mailbox; a
        # direct call is a clean no-op (nothing is deletable without a delete token,
        # #300). store() is the real read-only guard and still raises.
        self.assertEqual(mb.expunge(), [])
        with self.assertRaises(ReadOnlyError):
            mb.store(None, ["\\Seen"], 1, False)

    def test_store_deleted_and_expunge(self):
        from twisted.mail.imap4 import MessageSet

        msgs = [
            make_message("keep@x", subject="keep", uid=10),
            make_message("drop@x", subject="drop", uid=20),
        ]
        mb, transport = self._custom_mailbox(msgs, seen_writable=True, delete_writable=True)
        mb.getMessageCount()
        res = mb.store(MessageSet(2, 2), ["\\Deleted"], 1, uid=False)
        self.assertIn("\\Deleted", res[2])
        self.assertEqual(len(msgs), 2)
        # RFC 3501 7.4.1: EXPUNGE returns message SEQUENCE numbers, not UIDs. The
        # dropped message is at seq 2 (uid 20) in a 2-message mailbox (#300).
        seqs = mb.expunge()
        self.assertEqual(seqs, [2])
        self.assertEqual(mb.getMessageCount(), 1)
        self.assertEqual(msgs[0]["messageId"], "keep@x")
        self.assertTrue(any("drop%40x" in c for c in transport.calls))

    def test_expunge_without_deleted_is_noop(self):
        mb, _ = self._custom_mailbox([make_message("m1@x")], delete_writable=True)
        mb.getMessageCount()
        self.assertEqual(mb.expunge(), [])
        self.assertEqual(mb.getMessageCount(), 1)

    def test_expunge_uses_delete_client_not_read_client(self):
        from twisted.mail.imap4 import MessageSet

        msgs = [
            make_message("keep@x", subject="keep", uid=10),
            make_message("drop@x", subject="drop", uid=20),
        ]
        read_transport = FakeTransport(msgs, expected_token="read", page_size=2)
        delete_transport = FakeTransport(msgs, expected_token="delete", page_size=2)
        read_client = PosternClient("https://x", "read", transport=read_transport)
        delete_client = PosternClient("https://x", "delete", transport=delete_transport)
        from posternimap.mailbox import PosternMailbox

        mb = PosternMailbox(
            read_client,
            page_size=2,
            seen_writable=True,
            delete_writable=True,
            delete_client=delete_client,
        )
        mb.getMessageCount()
        mb.store(MessageSet(2, 2), ["\\Deleted"], 1, uid=False)
        mb.expunge()
        self.assertTrue(any("drop%40x" in c for c in delete_transport.calls))
        self.assertFalse(any("drop%40x" in c for c in read_transport.calls))

    def test_expunge_returns_sequence_numbers_high_to_low(self):
        # RFC 3501 7.4.1: untagged EXPUNGE carries message SEQUENCE numbers (Twisted
        # emits expunge()'s return verbatim as `<n> EXPUNGE`). With rowids != sequence
        # numbers and TWO deletes, the result must be the 1-based sequence numbers
        # high-to-low (so each removal leaves lower sequence numbers valid), never the
        # UIDs (#300).
        from twisted.mail.imap4 import MessageSet

        msgs = [
            make_message("a@x", subject="a", uid=10),  # seq 1
            make_message("b@x", subject="b", uid=20),  # seq 2 -> delete
            make_message("c@x", subject="c", uid=30),  # seq 3
            make_message("d@x", subject="d", uid=40),  # seq 4 -> delete
        ]
        mb, _ = self._custom_mailbox(msgs, seen_writable=True, delete_writable=True)
        mb.getMessageCount()
        mb.store(MessageSet(2, 2), ["\\Deleted"], 1, uid=False)
        mb.store(MessageSet(4, 4), ["\\Deleted"], 1, uid=False)
        self.assertEqual(mb.expunge(), [4, 2])  # seq numbers high-to-low, not [20, 40]
        self.assertEqual(mb.getMessageCount(), 2)

    def test_expunge_is_noop_without_delete_token(self):
        # A seen-writable-only mailbox (single read-token deploy) reports isWriteable()
        # True, so Twisted's do_CLOSE calls expunge() on it. With no delete token nothing
        # can be flagged \\Deleted, so EXPUNGE must be a clean no-op ([]), NOT raise --
        # raising made every CLOSE on INBOX/Sent/All return BAD (#300).
        mb, _ = self._custom_mailbox(
            [make_message("a@x", uid=10), make_message("b@x", uid=20)],
            seen_writable=True,
            delete_writable=False,
        )
        mb.getMessageCount()
        self.assertTrue(mb.isWriteable())  # so do_CLOSE will call expunge()
        self.assertEqual(mb.expunge(), [])
        self.assertEqual(mb.getMessageCount(), 2)

    def test_trash_expunge_returns_sequence_numbers(self):
        # Emptying Trash (Apple Mail) EXPUNGEs the staged summaries; the untagged
        # responses must be sequence numbers (1..n, high-to-low), not the staged UIDs (#300).
        from posternimap.client import MessageSummary
        from posternimap.mailbox import PosternMailbox

        def summary(uid, mid):
            return MessageSummary(
                uid=uid, message_id=mid, direction="inbound", thread_id=mid,
                from_addr="a@b", to_addr="c@d", subject="s", date="2026-07-09T00:00:00Z",
                in_reply_to=None, trusted=True, received_at="2026-07-09T00:00:01Z",
                attachment_count=0,
            )

        staging = [summary(50, "x@x"), summary(60, "y@y")]
        trash = PosternMailbox(
            PosternClient("https://x", "t", transport=FakeTransport([], page_size=2)),
            trash_sink=True,
            trash_staging=staging,
        )
        self.assertEqual(trash.getMessageCount(), 2)
        self.assertEqual(trash.expunge(), [2, 1])  # seq numbers, not [50, 60]
        self.assertEqual(len(staging), 0)

    def test_delete_fetched_messages(self):
        from twisted.mail.imap4 import MessageSet

        msgs = [
            make_message("keep@x", subject="keep", uid=10),
            make_message("drop@x", subject="drop", uid=20),
        ]
        delete_transport = FakeTransport(msgs, expected_token="delete", page_size=2)
        read_client = PosternClient(
            "https://x", "read", transport=FakeTransport(msgs, expected_token="read", page_size=2)
        )
        delete_client = PosternClient("https://x", "delete", transport=delete_transport)
        from posternimap.mailbox import PosternMailbox

        mb = PosternMailbox(
            read_client,
            page_size=2,
            delete_writable=True,
            delete_client=delete_client,
        )
        mb.getMessageCount()
        fetched = mb.fetch(MessageSet(2, 2), uid=False)
        mb.delete_fetched_messages(fetched)
        self.assertEqual(mb.getMessageCount(), 1)
        self.assertEqual(msgs[0]["messageId"], "keep@x")
        self.assertTrue(any("drop%40x" in c for c in delete_transport.calls))

    def test_delete_fetched_messages_stages_trash(self):
        from twisted.mail.imap4 import MessageSet
        from posternimap.mailbox import PosternMailbox

        msgs = [make_message("drop@x", subject="drop", uid=20)]
        staging: list = []
        read_transport = FakeTransport(msgs, expected_token="read", page_size=2)
        delete_transport = FakeTransport(msgs, expected_token="delete", page_size=2)
        mb = PosternMailbox(
            PosternClient("https://x", "read", transport=read_transport),
            page_size=2,
            delete_writable=True,
            delete_client=PosternClient("https://x", "delete", transport=delete_transport),
            trash_staging_sink=staging,
        )
        mb.getMessageCount()
        mb.delete_fetched_messages(mb.fetch(MessageSet(1, 1), uid=False))
        self.assertEqual(len(staging), 1)
        self.assertEqual(staging[0].message_id, "drop@x")

    def test_trash_mailbox_loads_staging(self):
        from posternimap.client import MessageSummary
        from posternimap.mailbox import PosternMailbox

        summary = MessageSummary(
            uid=20,
            message_id="drop@x",
            direction="inbound",
            thread_id="drop@x",
            from_addr="a@b.com",
            to_addr="c@d.com",
            subject="drop",
            date="2026-07-09T00:00:00Z",
            in_reply_to=None,
            trusted=True,
            received_at="2026-07-09T00:00:01Z",
            attachment_count=0,
        )
        staging = [summary]
        trash = PosternMailbox(
            PosternClient("https://x", "read", transport=FakeTransport([], page_size=2)),
            trash_sink=True,
            trash_staging=staging,
        )
        self.assertEqual(trash.getMessageCount(), 1)

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

    def test_message_with_attachment_renders_multipart(self):
        from twisted.mail.imap4 import MessageSet

        gz_name = "google.com!skyphusion.org!1783382400!1783468799!001.json.gz"
        att_data = b"\x1f\x8b\x08" + b"payload"
        raw = make_message(
            "tls1",
            subject="TLS report",
            body="This is an aggregate TLS report from google.com",
            attachments=[{"filename": gz_name, "mime": "application/gzip", "size": len(att_data)}],
            attachmentBytes=[att_data],
        )
        mb, transport = self._custom_mailbox([raw])
        (_, msg), = list(mb.fetch(MessageSet(1, 1), uid=False))
        self.assertTrue(msg.isMultipart())
        body_part = msg.getSubPart(0)
        self.assertIn("aggregate TLS report", body_part.getBodyFile().read().decode())
        att_part = msg.getSubPart(1)
        import base64

        wire = att_part.getBodyFile().read()
        self.assertEqual(base64.b64decode(wire), att_data)
        self.assertEqual(transport.body_fetches, 1)
        self.assertEqual(transport.attachment_fetches, 1)

    def test_flags_reflect_trust_and_direction(self):
        from twisted.mail.imap4 import MessageSet

        mb = self._mailbox(direction="outbound")
        (_, msg), = list(mb.fetch(MessageSet(1, 1), uid=False))
        flags = list(msg.getFlags())
        self.assertIn("\\Seen", flags)
        self.assertIn("Outbound", flags)

    # --- #seen: read/unread state ---

    def test_flags_omit_seen_when_message_is_unread(self):
        # A message stored unread (seen=False) reports NO \Seen flag, so a client shows
        # it as new; a read one carries \Seen. Both served from the summary (no body).
        from twisted.mail.imap4 import MessageSet

        mb, _ = self._custom_mailbox(
            [make_message("unread", subject="new", seen=False),
             make_message("read", subject="old", seen=True)]
        )
        got = dict((m._summary.message_id, list(m.getFlags())) for _, m in mb.fetch(MessageSet(1, 2), uid=False))
        self.assertNotIn("\\Seen", got["unread"])
        self.assertIn("\\Seen", got["read"])

    def test_unseen_count_and_first_unseen(self):
        # UNSEEN (STATUS) counts unread; firstUnseen points at the earliest-arrived
        # unread message by sequence number. Snapshot is uid/arrival-ascending: r1
        # (seq1, read), u2 (seq2, unread), u3 (seq3, unread) -> 2 unseen, first at 2.
        mb, _ = self._custom_mailbox(
            [make_message("u3", subject="c", seen=False),   # newest arrival
             make_message("u2", subject="b", seen=False),
             make_message("r1", subject="a", seen=True)]    # oldest arrival
        )
        self.assertEqual(mb.getUnseenCount(), 2)
        self.assertEqual(mb.firstUnseen(), 2)
        self.assertEqual(mb.requestStatus(["MESSAGES", "UNSEEN", "RECENT"]),
                         {"MESSAGES": 3, "UNSEEN": 2, "RECENT": 0})

    def test_first_unseen_zero_when_all_read(self):
        mb, _ = self._custom_mailbox([make_message("r1", seen=True), make_message("r2", seen=True)])
        self.assertEqual(mb.getUnseenCount(), 0)
        self.assertEqual(mb.firstUnseen(), 0)

    def test_store_add_seen_persists_and_returns_flags(self):
        # STORE +FLAGS (\Seen) on an unread message: persists via the API, flips the
        # local snapshot, and returns the post-update flags map {seq: [...\Seen...]}.
        from twisted.mail.imap4 import MessageSet

        msgs = [make_message("u1", subject="s", seen=False)]
        mb, transport = self._custom_mailbox(msgs, seen_writable=True)
        mb.getMessageCount()
        res = mb.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertIn(1, res)
        self.assertIn("\\Seen", res[1])
        # Persisted to the API (the fake flipped the backing dict)...
        self.assertTrue(msgs[0]["seen"])
        self.assertTrue(any("/api/messages/seen" in u for u in transport.calls))
        # ...and reflected in the live snapshot: a re-FETCH now shows \Seen.
        (_, m), = list(mb.fetch(MessageSet(1, 1), uid=False))
        self.assertIn("\\Seen", list(m.getFlags()))
        self.assertEqual(mb.getUnseenCount(), 0)

    def test_store_remove_seen_marks_unread(self):
        from twisted.mail.imap4 import MessageSet

        msgs = [make_message("r1", subject="s", seen=True)]
        mb, transport = self._custom_mailbox(msgs, seen_writable=True)
        mb.getMessageCount()
        res = mb.store(MessageSet(1, 1), ["\\Seen"], -1, uid=False)
        self.assertNotIn("\\Seen", res[1])
        self.assertFalse(msgs[0]["seen"])
        self.assertEqual(mb.getUnseenCount(), 1)

    def test_store_seen_idempotent_no_api_call_when_unchanged(self):
        # STORE +FLAGS (\Seen) on an ALREADY-read message changes nothing: no API call,
        # snapshot untouched, but the response still reports the current flags.
        from twisted.mail.imap4 import MessageSet

        msgs = [make_message("r1", subject="s", seen=True)]
        mb, transport = self._custom_mailbox(msgs, seen_writable=True)
        mb.getMessageCount()
        transport.calls.clear()
        res = mb.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertIn("\\Seen", res[1])
        self.assertFalse(any("/api/messages/seen" in u for u in transport.calls))

    def test_store_uid_mode_resolves_seen(self):
        from twisted.mail.imap4 import MessageSet

        msgs = [make_message("m20", subject="b", seen=False, uid=20),
                make_message("m10", subject="a", seen=False, uid=10)]
        mb, _ = self._custom_mailbox(msgs, seen_writable=True)
        mb.getMessageCount()
        res = mb.store(MessageSet(20, 20), ["\\Seen"], 1, uid=True)
        # Keyed by sequence number (uid 20 -> seq 2), per RFC 3501 / Twisted __cbStore.
        self.assertIn(2, res)
        self.assertTrue(msgs[0]["seen"])
        self.assertFalse(msgs[1]["seen"])  # uid 10 untouched

    def test_store_rejects_non_seen_flag(self):
        from twisted.mail.imap4 import MessageSet
        from posternimap.mailbox import ReadOnlyError

        mb, _ = self._custom_mailbox([make_message("m1", seen=False)], seen_writable=True)
        mb.getMessageCount()
        with self.assertRaises(ReadOnlyError):
            mb.store(MessageSet(1, 1), ["\\Flagged"], 1, uid=False)

    def test_store_refused_on_non_seen_writable_folder(self):
        from twisted.mail.imap4 import MessageSet
        from posternimap.mailbox import ReadOnlyError

        mb = self._mailbox()  # seen_writable=False by default
        with self.assertRaises(ReadOnlyError):
            mb.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)


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
        # #210 + #102 + #220: ENVELOPE scan stays body-free; a per-key Content-Type
        # lookup is served from the summary hasHtml signal without a body fetch; a
        # cold whole-message header iteration still hydrates for the full MIME tree.
        from twisted.mail.imap4 import MessageSet, getEnvelope

        html = "<html><body><h1>hi</h1></body></html>"
        mb, transport = self._custom_mailbox([make_message("h1", subject="rich", bodyHtml=html)])
        (_, msg), = list(mb.fetch(MessageSet(1, 1), uid=False))
        getEnvelope(msg)
        self.assertEqual(transport.body_fetches, 0)
        ctype = msg.getHeaders(False, b"content-type")
        self.assertIn("multipart/alternative", ctype.get("content-type", ""))
        self.assertEqual(transport.body_fetches, 1)
        headers = dict(msg.getHeaders(True).items())
        self.assertEqual(transport.body_fetches, 1)
        self.assertIn("multipart/alternative", headers.get("content-type", ""))

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

    # --- #148: server-side SEARCH pushdown (search_substr) ---

    def test_search_substr_pushes_and_maps_to_seq(self):
        # A SUBJECT substring search delegates to the substr endpoint and maps the
        # global hit back to this folder's sequence number. m2 ("second") is seq 2
        # in the uid-ascending snapshot (m1, m2, m3).
        mb = self._mailbox()
        seqs = mb.search_substr("subject", "second", uid=False)
        self.assertEqual(seqs, [2])
        # The pushed request carried mode=substr AND the field selector.
        self.assertTrue(
            any("mode=substr" in u and "field=subject" in u for u in self.transport.calls),
            self.transport.calls,
        )

    def test_search_substr_uid_mode_returns_uids(self):
        # UID SEARCH: the same match returns the store UID (m2 -> uid 2), not the seq.
        mb = self._mailbox()
        self.assertEqual(mb.search_substr("subject", "second", uid=True), [2])

    def test_search_substr_body_and_text_fields(self):
        mb = self._mailbox()
        # BODY over m2's body ("body two"); TEXT over m1's subject ("first").
        self.assertEqual(mb.search_substr("body", "body two", uid=False), [2])
        self.assertEqual(mb.search_substr("text", "first", uid=False), [1])

    def test_search_substr_drops_hits_outside_window(self):
        # window=2 shows only m2, m3 (highest uids); m1 is below the window. m1's
        # subject "first" matches globally but is dropped (not in the snapshot); m2
        # is in the window and maps to seq 1 of the windowed snapshot.
        mb = self._mailbox(window=2)
        self.assertEqual(mb.search_substr("subject", "first", uid=False), [])
        self.assertEqual(mb.search_substr("subject", "second", uid=False), [1])
        # UID mode over the window still yields the global UID (m2 -> uid 2).
        self.assertEqual(mb.search_substr("subject", "second", uid=True), [2])

    def test_search_substr_drops_hits_from_other_folder(self):
        # The /api/search endpoint is GLOBAL, so an outbound-only folder must drop a
        # hit that belongs to an inbound message. m1 (inbound) matches the query but
        # is not in the outbound snapshot; m3 ("sent reply") is.
        mb = self._mailbox(direction="outbound")
        self.assertEqual(mb.search_substr("text", "first", uid=False), [])
        self.assertEqual(mb.search_substr("subject", "sent reply", uid=False), [1])

    def test_search_substr_empty_folder_never_calls_api(self):
        # A placeholder (empty) folder returns no hits WITHOUT touching the API: the
        # snapshot is empty, so there is nothing to intersect against.
        from posternimap.mailbox import PosternMailbox

        mb = PosternMailbox(self.client, empty=True)
        self.assertEqual(mb.search_substr("text", "anything", uid=False), [])
        self.assertFalse(any("mode=substr" in u for u in self.transport.calls))

    def test_search_substr_paginates_the_full_result_set(self):
        # #148 no-silent-caps: /api/search pages (page_size=2 in the fake), and a
        # SEARCH must return EVERY match, not just the first page. field=text "s"
        # matches all three subjects (first / second / sent reply), so the cursor
        # loop must fetch BOTH pages and return the full, sorted set.
        mb = self._mailbox()
        self.assertEqual(mb.search_substr("text", "s", uid=False), [1, 2, 3])
        substr_calls = [u for u in self.transport.calls if "mode=substr" in u]
        # Page 2 was actually fetched (a call carried the cursor)...
        self.assertTrue(any("cursor=" in u for u in substr_calls), substr_calls)
        # ...and every page carried the mode + field selector.
        self.assertTrue(all("field=text" in u for u in substr_calls), substr_calls)

    def test_search_substr_paginates_in_uid_mode(self):
        # The same multi-page search in UID mode returns the store UIDs (1, 2, 3).
        mb = self._mailbox()
        self.assertEqual(mb.search_substr("text", "s", uid=True), [1, 2, 3])

    def test_search_substr_paginated_result_is_still_window_scoped(self):
        # Pagination and the window interact correctly: all three match, but window=2
        # keeps only the two highest uids (m2, m3). The dropped m1 is on page 2, so
        # this proves we PAGE and THEN intersect -- never truncate before the window
        # filter would have.
        mb = self._mailbox(window=2)
        self.assertEqual(mb.search_substr("text", "s", uid=False), [1, 2])

    def test_search_substr_cap_breach_is_logged_not_silent(self):
        # If the cursor loop reaches its page cap with results still pending, that is
        # surfaced LOUDLY (never a silent truncation). window=1 -> a 2-page cap; six
        # matching messages keep a cursor pending past page 2 (fake page_size=2).
        from twisted.python import log
        from posternimap.mailbox import PosternMailbox

        msgs = [make_message(f"n{i}", subject="match me") for i in range(6)]
        transport = FakeTransport(msgs, expected_token="t", page_size=2)
        client = PosternClient("https://x", "t", transport=transport)
        mb = PosternMailbox(client, page_size=2, window=1)
        events = []
        log.addObserver(events.append)
        try:
            mb.search_substr("subject", "match me", uid=False)
        finally:
            log.removeObserver(events.append)
        blob = " ".join(str(e) for e in events)
        self.assertIn("pagination hit", blob)


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
        self.cfg_delete = Config(
            api_url="https://x",
            auth_mode="token",
            api_timeout=5.0,
            service_delete_token="del",
        )
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

    def test_inbox_select_without_delete_token_is_seen_only(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        mb = acct.select("INBOX")
        self.assertIsNotNone(mb)
        self.assertIn("\\Seen", mb.getPermanentFlags())
        self.assertNotIn("\\Deleted", mb.getPermanentFlags())

    def test_trash_select_is_writable_signal(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        trash = acct.select("Trash")
        self.assertIsNotNone(trash)
        self.assertTrue(trash.isWriteable())

    def test_trash_staging_shared_across_account_instances(self):
        from posternimap.account import PosternAccount, _shared_trash_staging
        from posternimap.client import MessageSummary

        _shared_trash_staging("agent").clear()
        summary = MessageSummary(
            uid=20,
            message_id="drop@x",
            direction="inbound",
            thread_id="drop@x",
            from_addr="a@b.com",
            to_addr="c@d.com",
            subject="drop",
            date="2026-07-09T00:00:00Z",
            in_reply_to=None,
            trusted=True,
            received_at="2026-07-09T00:00:01Z",
            attachment_count=0,
        )
        a1 = PosternAccount(self.cfg, "agent", "tok")
        a2 = PosternAccount(self.cfg, "agent", "tok")
        a1._trash_staging.append(summary)
        self.assertEqual(len(a2._trash_staging), 1)

    def test_lists_special_use_folder_set(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        names = {name for name, _ in acct.listMailboxes("", "*")}

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
        # Notes has no RFC 6154 special-use attribute (none is defined): bare flags
        # (structural only), so iOS finds it in LIST and never CREATEs it (#218).
        self.assertEqual(flags["Notes"], {"\\HasNoChildren"})

    def test_selected_mailbox_reports_message_flags_not_special_use(self):
        # The SELECT instance must report message flags, NOT the LIST attributes.
        # #218: the SELECT FLAGS set is the honest union of every keyword a FETCH can
        # return -- \\Seen plus the trust + direction keywords -- so a client is never
        # handed an unannounced keyword. It must NOT contain the RFC 6154 special-use
        # LIST attributes (e.g. \\Sent), which belong to the list-view instance.
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg_delete, "agent", "tok")
        sent = acct.select("Sent")
        self.assertEqual(
            set(sent.getFlags()),
            {"\\Seen", "\\Deleted", "Trusted", "Untrusted", "Inbound", "Outbound"},
        )
        # regression guard: the special-use LIST attribute must not leak into SELECT.
        self.assertNotIn("\\Sent", set(sent.getFlags()))

    def test_placeholder_folders_are_empty_without_api_calls(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        for name in ("Drafts", "Trash", "Junk", "Archive", "Notes"):
            box = acct.select(name)
            self.assertEqual(box.getMessageCount(), 0, name)
        # An empty placeholder must not have touched the Postern API at all.
        self.assertEqual(self.transport.calls, [])

    def test_subscribe_unsubscribe_are_noops(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        self.assertIsNone(acct.subscribe("Sent"))
        self.assertIsNone(acct.unsubscribe("Sent"))
        for name in ("INBOX", "Sent", "Drafts", "Trash", "Junk", "Archive", "All", "Notes"):
            self.assertTrue(acct.isSubscribed(name))

    def test_notes_placeholder_folder_prevents_ios_create(self):
        # #218 round 3 (live-convicted): iOS Mail issues `CREATE Notes` during setup
        # and aborts the whole sync on the read-only NO. Notes is advertised as an
        # existing present-but-empty placeholder so iOS finds it in LIST and never
        # CREATEs it: it appears in LIST/LSUB with bare structural flags (no RFC 6154
        # special-use), is selectable + empty, and costs zero API calls.
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        listed = dict(acct.listMailboxes("", "*"))
        self.assertIn("Notes", listed)
        self.assertEqual(set(listed["Notes"].getFlags()), {"\\HasNoChildren"})
        self.assertTrue(acct.isSubscribed("Notes"))
        box = acct.select("Notes")
        self.assertIsNotNone(box)
        self.assertEqual(box.getMessageCount(), 0)
        self.assertEqual(self.transport.calls, [])  # no API hit for the placeholder

    def test_account_advertises_personal_namespace(self):
        # #218 round 6: the account provides INamespacePresenter with one personal
        # namespace ("" / "/") and no shared/other-user namespaces, so do_NAMESPACE
        # answers (("" "/")) NIL NIL instead of the stock NIL NIL NIL.
        from posternimap.account import PosternAccount
        from twisted.mail import imap4

        acct = PosternAccount(self.cfg, "agent", "tok")
        self.assertTrue(imap4.INamespacePresenter.providedBy(acct))
        self.assertEqual(acct.getPersonalNamespaces(), [["", "/"]])
        self.assertIsNone(acct.getSharedNamespaces())
        self.assertIsNone(acct.getUserNamespaces())

    def test_writable_matrix_real_views_and_notes(self):
        # SELECT reports READ-WRITE for the real backed views (INBOX/Sent/All), which
        # persist the \Seen flag (#seen), for Notes (#218 iOS provisioning signal),
        # and for Trash (Apple Mail move-to-trash COPY target, #278). Other empty
        # placeholders stay READ-ONLY.
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        for name in ("INBOX", "Sent", "All", "Notes", "Trash"):
            self.assertTrue(acct.select(name).isWriteable(), name)
        for name in ("Drafts", "Junk", "Archive"):
            self.assertFalse(acct.select(name).isWriteable(), name)

    def test_permanent_flags_matrix(self):
        # PERMANENTFLAGS reflect what each folder actually persists: (\Seen) for the
        # real seen-writable views, the full writable set + \* for Notes (#218), and
        # nothing for the read-only placeholders.
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg_delete, "agent", "tok")
        for name in ("INBOX", "Sent", "All"):
            self.assertEqual(acct.select(name).getPermanentFlags(), ["\\Seen", "\\Deleted"], name)
        self.assertIn("\\*", acct.select("Notes").getPermanentFlags())
        self.assertIn("\\*", acct.select("Trash").getPermanentFlags())
        for name in ("Drafts", "Junk", "Archive"):
            self.assertEqual(acct.select(name).getPermanentFlags(), [], name)

    def test_appendability_classifies_folders(self):
        # #233: the server uses this to answer APPEND with no store read. Real backed
        # views accept the Sent-copy no-op; placeholders reject; unknown -> TRYCREATE.
        from posternimap.account import PosternAccount

        acct = PosternAccount(self.cfg, "agent", "tok")
        for name in ("INBOX", "inbox", "Sent", "All"):
            self.assertEqual(acct.appendability(name), "real", name)
        for name in ("Drafts", "Trash", "Junk", "Archive", "Notes"):
            self.assertEqual(acct.appendability(name), "placeholder", name)
        self.assertEqual(acct.copyability("Trash"), "trash_delete")
        self.assertEqual(acct.copyability("Drafts"), "placeholder")
        self.assertEqual(acct.copyability("Nonexistent"), "unknown")

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

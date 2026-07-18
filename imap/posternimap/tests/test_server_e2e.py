"""End-to-end: drive the real Twisted IMAP4 server with a real IMAP4 client.

Spins the actual PosternIMAPFactory (portal + auth + account + mailbox) on a
loopback port, connects Twisted's own IMAP4Client, and exercises the real wire
protocol: LOGIN -> LIST -> SELECT -> FETCH -> SEARCH -> LOGOUT. The Postern API
is faked via the injectable client transport (no network), but everything from
the IMAP socket down to the rendered RFC822 is the production code path.

Skipped cleanly if Twisted is not installed. Uses Twisted trial's
inlineCallbacks; runnable via `python -m twisted.trial` or stdlib unittest (trial
TestCase subclasses unittest.TestCase).
"""

from __future__ import annotations

import unittest

try:
    from twisted.cred import portal
    from twisted.internet import defer, reactor
    from twisted.internet.protocol import ClientCreator
    from twisted.mail import imap4
    from twisted.trial import unittest as twisted_unittest

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False
    twisted_unittest = unittest  # type: ignore

from posternimap.config import Config
from posternimap.proxyproto import ProxyProtocolConfig, parse_trusted
from posternimap.tests.fakes import ErrorTransport, FakeTransport, make_message


def _patched_factory(cfg, transport):
    """Build the real factory but with the account's PosternClient transport
    swapped for the fake, so no network is touched."""
    from posternimap import account as account_mod
    from posternimap.auth import build_portal
    from posternimap.client import PosternClient
    from posternimap.server import PosternIMAPFactory

    # Verifier that accepts the fake's token without a live ping.
    verify = lambda tok: tok == transport.expected_token

    # Make PosternAccount build clients on the fake transport.
    orig_client = account_mod.PosternAccount._client

    def fake_client(self):
        return PosternClient(self._cfg.api_url, self._token, transport=transport)

    account_mod.PosternAccount._client = fake_client
    orig_delete_client = account_mod.PosternAccount._delete_client

    def fake_delete_client(self):
        tok = self._cfg.service_delete_token
        if not tok:
            return None
        return PosternClient(self._cfg.api_url, tok, transport=transport)

    account_mod.PosternAccount._delete_client = fake_delete_client

    factory = PosternIMAPFactory.__new__(PosternIMAPFactory)
    factory._cfg = cfg
    factory._portal = build_portal(cfg, verify=verify)
    return factory, (
        account_mod.PosternAccount,
        "_client",
        orig_client,
        "_delete_client",
        orig_delete_client,
    )


def _restore_account(restore):
    cls, attr1, orig1, attr2, orig2 = restore
    setattr(cls, attr1, orig1)
    setattr(cls, attr2, orig2)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerE2ETest(twisted_unittest.TestCase):
    def setUp(self):
        self.msgs = [
            make_message("m3", direction="outbound", subject="sent note"),
            make_message("m2", subject="meeting tuesday", body="lunch?"),
            make_message("m1", subject="welcome aboard", body="hello"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        # poll disabled: these exercise LOGIN/LIST/SELECT/FETCH, not live refresh,
        # so no LoopingCall is scheduled to dirty trial's reactor. The poll has
        # its own deterministic coverage in test_mailbox (via twisted Clock).
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def _client(self):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_login_select_fetch(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            mailboxes = yield proto.list("", "*")
            names = {m[2] for m in mailboxes}
            self.assertIn("INBOX", names)
            self.assertIn("Sent", names)
            # RFC 6154 special-use: the Sent entry must carry the \\Sent attribute
            # (m[0] is the LIST flags) so a client auto-maps its Sent folder.
            flags_by_name = {m[2]: set(m[0]) for m in mailboxes}
            self.assertIn("\\Sent", flags_by_name["Sent"])
            self.assertIn("Drafts", names)
            self.assertIn("\\Drafts", flags_by_name["Drafts"])

            # INBOX is inbound-only (m1, m2); m3 is outbound -> in Sent.
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)

            # FETCH message 2 (oldest-first within INBOX: m1=1, m2=2).
            result = yield proto.fetchMessage("2")
            raw = result[2]["RFC822"]
            text = raw.decode() if isinstance(raw, bytes) else raw
            self.assertIn("meeting tuesday", text)
            self.assertIn("lunch?", text)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_bad_token_login_fails(self):
        proto = yield self._client()
        d = proto.login(b"agent", b"wrong-token")
        yield self.assertFailure(d, imap4.IMAP4Exception)
        yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_header_fields_fetch_returns_headers(self):
        # Regression for #179, at the wire: a client that scans with
        # BODY.PEEK[HEADER.FIELDS (...)] instead of ENVELOPE (the Gmail app's
        # dialect) must get the real headers back. Twisted's FETCH parser hands
        # the parenthesized field names to IMessagePart.getHeaders as BYTES; the
        # old str-only name matching returned an empty header block for EVERY
        # message, which Gmail rendered as "(no subject)" + a blank sender.
        proto = yield self._client()
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            yield proto.select(b"INBOX")
            # The Gmail-app scan shape (content-type forces the hydrated path;
            # a pure envelope subset is covered at the unit layer).
            result = yield proto.fetchSpecific(
                "1:*",
                headerType="HEADER.FIELDS",
                headerArgs=["DATE", "SUBJECT", "FROM", "CONTENT-TYPE", "TO", "CC"],
                peek=True,
            )
            self.assertEqual(len(result), 2)  # both INBOX messages answered
            for seq, parts in result.items():
                blob = "".join(
                    p.decode("utf-8", "replace") if isinstance(p, bytes) else str(p)
                    for part in parts
                    for p in part
                )
                self.assertIn("Subject", blob)
                self.assertIn("From", blob)
            # And the values are the stored ones, not an empty block.
            flat = repr(result)
            self.assertIn("meeting tuesday", flat)
            self.assertIn("welcome aboard", flat)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_sent_mailbox_is_outbound_only(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"Sent")
            self.assertEqual(info["EXISTS"], 1)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_namespace_advertises_personal_namespace(self):
        # #218 round 6: NAMESPACE must report our real personal namespace (prefix "",
        # delimiter "/") -- not the NIL the stock account produced -- matching a
        # known-good server (Dovecot answers `(("" "/")) NIL NIL`). iOS uses the
        # personal namespace to place/verify folders.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            ns = yield proto.namespace()
            self.assertEqual(ns[0], [["", "/"]])  # one personal namespace
            self.assertEqual(ns[1], [])           # no shared
            self.assertEqual(ns[2], [])           # no other-user
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_placeholder_folder_selectable_and_empty(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"Drafts")
            self.assertEqual(info["EXISTS"], 0)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_empty_folder_uid_search_completes_over_the_wire(self):
        # #218 round 4 end-to-end: a UID SEARCH over an EMPTY placeholder must complete
        # cleanly through a real client, exercising the always-emit-untagged path
        # (__cbManualSearch override) iOS needs. A Twisted client cannot distinguish a
        # missing untagged reply from an empty one, so the exact bare `* SEARCH` bytes
        # are asserted at the unit layer (IDCommandSelectAndTraceTest); this is the
        # end-to-end smoke that the path returns no ids and does not hang or error.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"Drafts")
            self.assertEqual(info["EXISTS"], 0)
            res = yield proto.search(imap4.Query(undeleted=True), uid=True)
            self.assertEqual(list(res), [])
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_select_announces_permanentflags_and_flag_keywords(self):
        # #218/#seen: through the REAL client, SELECT INBOX must carry PERMANENTFLAGS
        # (\Seen) when no delete token is configured -- the one flag a real view
        # persists without POSTERN_API_TOKEN_DELETE, so a client's mark-read sticks --
        # and READ-WRITE, plus a FLAGS list that announces the custom keywords a FETCH
        # actually returns, so a strict client (Apple Mail) is never handed an
        # unadvertised keyword. (UIDNEXT is asserted at the unit layer -- the stock
        # IMAP4Client.select does not surface it.)
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertIn("PERMANENTFLAGS", info)
            pf = list(info["PERMANENTFLAGS"])
            self.assertIn("\\Seen", pf)
            self.assertIn("\\Flagged", pf)
            self.assertIn("\\Answered", pf)
            self.assertNotIn("\\Deleted", pf)
            self.assertTrue(info["READ-WRITE"], info)
            flags = set(info["FLAGS"])
            self.assertIn("\\Seen", flags)
            self.assertIn("\\Flagged", flags)
            self.assertNotIn("\\Deleted", flags)
            self.assertTrue({"Trusted", "Untrusted", "Inbound", "Outbound"} & flags, flags)
            self.assertNotIn("\\Sent", flags)  # special-use LIST attr must not leak
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_select_announces_deleted_when_delete_token_configured(self):
        cfg = Config(
            api_url="https://x",
            auth_mode="token",
            api_timeout=5.0,
            imap_poll_seconds=0,
            service_delete_token="del",
        )
        factory, restore = _patched_factory(cfg, self.transport)
        port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        addr = port.getHost()
        try:
            cc = ClientCreator(reactor, imap4.IMAP4Client)
            proto = yield cc.connectTCP("127.0.0.1", addr.port)
            try:
                yield proto.login(b"agent", b"tok")
                info = yield proto.select(b"INBOX")
                pf = list(info["PERMANENTFLAGS"])
                self.assertIn("\\Seen", pf)
                self.assertIn("\\Flagged", pf)
                self.assertIn("\\Deleted", pf)
                self.assertIn("\\Deleted", set(info["FLAGS"]))
            finally:
                yield proto.logout()
        finally:
            _restore_account(restore)
            yield port.stopListening()

    @defer.inlineCallbacks
    def test_copy_to_trash_deletes_from_inbox(self):
        # Apple Mail deletes by COPY to Trash, not in-place EXPUNGE (#278).
        cfg = Config(
            api_url="https://x",
            auth_mode="token",
            api_timeout=5.0,
            imap_poll_seconds=0,
            service_delete_token="tok",
        )
        factory, restore = _patched_factory(cfg, self.transport)
        port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        addr = port.getHost()
        try:
            cc = ClientCreator(reactor, imap4.IMAP4Client)
            proto = yield cc.connectTCP("127.0.0.1", addr.port)
            try:
                yield proto.login(b"agent", b"tok")
                info = yield proto.select(b"INBOX")
                self.assertTrue(info["READ-WRITE"])
                self.assertEqual(info["EXISTS"], 2)
                trash = yield proto.select(b"Trash")
                self.assertTrue(trash["READ-WRITE"])
                yield proto.select(b"INBOX")
                yield proto.copy(imap4.MessageSet(2, 2), "Trash", uid=False)
                info = yield proto.select(b"INBOX")
                self.assertEqual(info["EXISTS"], 1)
                trash = yield proto.select(b"Trash")
                self.assertEqual(trash["EXISTS"], 1)
                self.assertTrue(
                    any("/api/messages/move" in c for c in self.transport.calls),
                    "expected soft-move API for m2",
                )
                self.assertEqual(self.transport.last_move_payload.get("mailbox"), "trash")

            finally:
                yield proto.logout()
        finally:
            _restore_account(restore)
            yield port.stopListening()

    @defer.inlineCallbacks
    def test_store_seen_round_trips_read_state(self):
        # #seen end-to-end: an unread INBOX message reported without \Seen; a STORE
        # +FLAGS (\Seen) over the real wire persists to the API and a fresh STATUS then
        # reports zero unseen -- so a human's mark-read sticks across the session.
        m1 = next(m for m in self.msgs if m["messageId"] == "m1")
        m1["seen"] = False  # oldest inbound message starts unread (INBOX seq 1)
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"INBOX")
            before = yield proto.status(b"INBOX", "UNSEEN")
            self.assertEqual(int(before["UNSEEN"]), 1)
            # STORE +FLAGS (\Seen) on sequence 1 (the unread message).
            res = yield proto.addFlags(imap4.MessageSet(1, 1), ["\\Seen"], silent=False, uid=False)
            self.assertIn("\\Seen", res[1]["FLAGS"])
            self.assertTrue(m1["seen"])  # round-tripped to the (fake) API
            after = yield proto.status(b"INBOX", "UNSEEN")
            self.assertEqual(int(after["UNSEEN"]), 0)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_append_to_sent_succeeds(self):
        # Thunderbird APPENDs its own copy of a sent message into Sent after
        # submission; the fallback matcher (#352) treats a recent outbound with
        # matching from+to+subject as already-stored and returns OK.
        import io

        self.transport.messages.insert(
            0,
            make_message(
                "core-sent",
                direction="outbound",
                **{
                    "from": "a@example.com",
                    "to": "b@example.com",
                    "subject": "copy",
                    "receivedAt": "2026-07-18T12:00:00Z",
                    "date": "2026-07-18T12:00:00Z",
                },
            ),
        )
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            msg = io.BytesIO(
                b"From: a@example.com\r\nTo: b@example.com\r\nSubject: copy\r\n"
                b"Date: Sat, 18 Jul 2026 12:00:05 +0000\r\n\r\nbody\r\n"
            )
            yield proto.append("Sent", msg, ("\\Seen",))
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_notes_reports_read_write_signal_but_writes_are_refused(self):
        # #218 Experiment A: SELECT Notes must report READ-WRITE with a real
        # PERMANENTFLAGS set (the writability signal Apple Notes needs to finish
        # provisioning the account), while an actual APPEND to Notes is still refused
        # with a tagged NO -- a loud failure at authoring time, never a silent drop.
        # Other placeholders keep their READ-ONLY posture (scoped to Notes only).
        import io

        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"Notes")
            self.assertTrue(info["READ-WRITE"], info)
            pf = set(info["PERMANENTFLAGS"])
            self.assertIn("\\*", pf)       # the "normal read-write mailbox" signal
            self.assertIn("\\Seen", pf)
            # round-6 FLAGS/PF coherence: the writable Notes folder advertises the
            # standard system FLAGS (no trust/direction keywords -- it stores nothing),
            # and FLAGS is a subset of PERMANENTFLAGS (matching a normal writable folder).
            flags = set(info["FLAGS"])
            self.assertEqual(
                flags, {"\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft"}
            )
            self.assertNotIn("Trusted", flags)
            self.assertTrue(flags <= pf, (flags, pf))
            # Drafts is durable (#352): READ-WRITE with \Draft + \Deleted.
            info2 = yield proto.select(b"Drafts")
            self.assertTrue(info2["READ-WRITE"], info2)
            self.assertIn("\\Draft", info2["PERMANENTFLAGS"])
            # the READ-WRITE signal does NOT make Notes writable: APPEND is still NO.
            msg = io.BytesIO(b"From: a@example.com\r\nSubject: note\r\n\r\nbody\r\n")
            d = proto.append("Notes", msg, ("\\Seen",))
            yield self.assertFailure(d, imap4.IMAP4Exception)
        finally:
            yield proto.logout()


    @defer.inlineCallbacks
    def test_append_to_drafts_succeeds_as_persist(self):
        # Apple Mail auto-saves mid-compose via APPEND Drafts; #352 persists it.
        import io

        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            msg = io.BytesIO(b"From: a@example.com\r\nSubject: draft\r\n\r\nbody\r\n")
            yield proto.append("Drafts", msg, ("\\Draft",))
            self.assertEqual(len(self.transport.drafts), 1)
            info = yield proto.select(b"Drafts")
            self.assertEqual(info["EXISTS"], 1)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_append_to_other_placeholder_folder_is_rejected(self):
        # #109 stays intact for placeholders other than the Drafts compatibility path.
        import io

        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            msg = io.BytesIO(b"From: a@example.com\r\nSubject: junk\r\n\r\nbody\r\n")
            d = proto.append("Junk", msg, ("\\Seen",))
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertTrue(
                "Message-ID" in str(exc) or "not supported" in str(exc) or "APPEND" in str(exc),
                str(exc),
            )
        finally:
            yield proto.logout()


    @defer.inlineCallbacks
    def test_uid_fetch_returns_ascending_and_stable_uids(self):
        # F9 end-to-end: a UID FETCH over the real wire must return UIDs that are
        # strictly ascending and equal to the store rowids (the All folder is
        # unfiltered, so all three: rowids 1, 2, 3), and the SAME UIDs across a
        # re-SELECT -- the stability a client relies on to reconcile its cache.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"All")
            self.assertEqual(info["EXISTS"], 3)
            result = yield proto.fetchUID("1:*")
            # result maps sequence number -> {"UID": <value>}; key in seq order.
            uids = [int(result[seq]["UID"]) for seq in sorted(result, key=int)]
            self.assertEqual(uids, [1, 2, 3])
            self.assertEqual(uids, sorted(uids))  # strictly ascending (RFC 3501)
            # Re-SELECT and re-fetch: identical UIDs (stable within UIDVALIDITY).
            yield proto.select(b"All")
            again = yield proto.fetchUID("1:*")
            self.assertEqual(
                [int(again[seq]["UID"]) for seq in sorted(again, key=int)], [1, 2, 3]
            )
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_search_all_over_the_wire(self):
        # Regression: SEARCH used to crash the server. PosternMailbox is not an
        # ISearchableMailbox, so IMAP4Server.do_SEARCH takes its manual-search
        # fallback (__cbManualSearch), which subscripts the IMailbox.fetch result
        # (result[-1][0]). fetch() returned a GENERATOR, so the server raised
        # `TypeError: 'generator' object is not subscriptable` and answered
        # `BAD [SEARCH failed: ...]`. The fix materializes fetch() to a list. This
        # asserts a plain SEARCH ALL completes and returns the sequence numbers.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"All")
            self.assertEqual(info["EXISTS"], 3)
            # SEARCH ALL -> message sequence numbers (1-based, oldest-first).
            seqs = yield proto.search(imap4.Query(all=True))
            self.assertEqual(sorted(int(n) for n in seqs), [1, 2, 3])
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_uid_search_all_over_the_wire(self):
        # The exact failure Conrad's --phase-on run hit: `UID SEARCH` returned
        # `BAD [SEARCH failed: 'generator' object is not subscriptable']`. With the
        # fetch()-returns-a-list fix the manual-search path can subscript/slice the
        # result, so UID SEARCH ALL completes and returns the store UIDs (the All
        # folder is unfiltered: rowids 1, 2, 3).
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"All")
            self.assertEqual(info["EXISTS"], 3)
            uids = yield proto.search(imap4.Query(all=True), uid=True)
            self.assertEqual(sorted(int(n) for n in uids), [1, 2, 3])
        finally:
            yield proto.logout()

    def _substr_calls(self):
        return [u for u in self.transport.calls if "mode=substr" in u]

    @defer.inlineCallbacks
    def test_search_subject_pushed_over_the_wire(self):
        # #148: SEARCH SUBJECT "meeting" is a single pushable key. The server pushes
        # it to the substr endpoint (field=subject) and returns the matching sequence
        # number. In All (m1,m2,m3 uid-ascending) m2's subject is "meeting tuesday"
        # -> seq 2.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"All")
            seqs = yield proto.search(imap4.Query(subject="meeting"))
            self.assertEqual(sorted(int(n) for n in seqs), [2])
            pushed = self._substr_calls()
            self.assertTrue(pushed, "expected a mode=substr push")
            self.assertTrue(any("field=subject" in u for u in pushed), pushed)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_search_body_and_text_pushed_over_the_wire(self):
        # BODY and TEXT are pushable too. BODY "lunch" -> m2 (body "lunch?") = seq 2;
        # TEXT "welcome" -> m1 (subject "welcome aboard") = seq 1.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"All")
            body_seqs = yield proto.search(imap4.Query(body="lunch"))
            self.assertEqual(sorted(int(n) for n in body_seqs), [2])
            text_seqs = yield proto.search(imap4.Query(text="welcome"))
            self.assertEqual(sorted(int(n) for n in text_seqs), [1])
            self.assertTrue(any("field=body" in u for u in self.transport.calls))
            self.assertTrue(any("field=text" in u for u in self.transport.calls))
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_uid_search_subject_pushed_returns_uids(self):
        # #148: UID SEARCH SUBJECT "meeting" routes through do_UID -> the same
        # select_SEARCH override with uid=1, so it pushes and returns the store UID
        # (m2 -> uid 2), not the sequence number.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"All")
            uids = yield proto.search(imap4.Query(subject="meeting"), uid=True)
            self.assertEqual(sorted(int(n) for n in uids), [2])
            self.assertTrue(self._substr_calls(), "expected a mode=substr push")
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_search_paginates_over_the_wire(self):
        # #148 no-silent-caps end-to-end: the fake API pages at page_size=2, so a
        # match set larger than one page must still come back complete. All three
        # subjects (sent note / meeting tuesday / welcome aboard) contain "e", so
        # SEARCH TEXT "e" spans two pages -> the full [1, 2, 3] and a cursor call.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"All")
            seqs = yield proto.search(imap4.Query(text="e"))
            self.assertEqual(sorted(int(n) for n in seqs), [1, 2, 3])
            self.assertTrue(
                any("cursor=" in u for u in self._substr_calls()),
                self._substr_calls(),
            )
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_search_from_over_the_wire(self):
        # #222 at the wire: FROM is NOT pushable (the substr endpoint has no
        # field=from, and field=text cannot isolate a single header), so it stays on
        # Twisted's stock manual search and must NEVER mis-push to mode=substr. That
        # manual path used to raise on the wire BYTES token (upstream str/bytes bug),
        # returning BAD. do_SEARCH now decodes the string VALUE arg to str on the
        # fallback, so FROM returns CORRECT results with no BAD and no logged error:
        # in All (m1=1, m2=2, m3=3) only m1's From is m1@example.com -> seq 1.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"All")
            seqs = yield proto.search(imap4.Query(**{"from": "m1@example.com"}))
            self.assertEqual(sorted(int(n) for n in seqs), [1])
            # Correct results AND no mis-push to the substr endpoint.
            self.assertEqual(self._substr_calls(), [])
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_search_compound_over_the_wire(self):
        # A compound query (SUBJECT ... BODY ...) is not a single key, so it is not
        # pushable and must never be mis-routed to the substr endpoint (which takes
        # one field only). It stays on the stock manual path, which the decoded
        # fallback un-breaks: SUBJECT's arg is decoded to str (str header match) while
        # BODY's arg stays wire bytes (text.strFile over the BytesIO body). Only m2
        # has subject "meeting" AND body "lunch" -> seq 2, with no substr push.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"All")
            seqs = yield proto.search(imap4.Query(subject="meeting", body="lunch"))
            self.assertEqual(sorted(int(n) for n in seqs), [2])
            self.assertEqual(self._substr_calls(), [])
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_uid_search_since_over_the_wire(self):
        # #218 wire-convicted (Strummer's replay): iOS Mail / Evolution populate a
        # folder via UID SEARCH SINCE <date>. The date arg reached Twisted's parseTime
        # as wire BYTES and crashed ("cannot use a string pattern on a bytes-like
        # object"), returning BAD -- so the folder existed but never filled. The
        # decoded fallback fixes it: all three All messages are dated 2026-06-18, so
        # SINCE 1-Jun-2026 returns their store UIDs, and the date is really parsed
        # (SINCE 1-Jul-2026 returns nothing, not everything, and still never BADs).
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"All")
            uids = yield proto.search(imap4.Query(since="1-Jun-2026"), uid=True)
            self.assertEqual(sorted(int(n) for n in uids), [1, 2, 3])
            none = yield proto.search(imap4.Query(since="1-Jul-2026"), uid=True)
            self.assertEqual(list(none), [])
            # A pure date search must not touch the substr push path.
            self.assertEqual(self._substr_calls(), [])
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_uid_search_undeleted_since_compound_over_the_wire(self):
        # #218 secondary shape, also wire-convicted: UID SEARCH UNDELETED SINCE
        # <date> (the compound iOS/Evolution issue). UNDELETED takes no arg; SINCE's
        # date arg is decoded on the fallback. None of the messages are \Deleted and
        # all are dated 2026-06-18, so UNDELETED SINCE 1-Jun-2026 returns every UID.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"All")
            uids = yield proto.search(
                imap4.Query(undeleted=True, since="1-Jun-2026"), uid=True
            )
            self.assertEqual(sorted(int(n) for n in uids), [1, 2, 3])
            self.assertEqual(self._substr_calls(), [])
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_list_empty_pattern_returns_delimiter_reply(self):
        # #218 / RFC 3501 6.3.8: LIST "" "" is a delimiter probe, not a wildcard.
        # iOS Mail / Evolution issue it to learn the hierarchy delimiter before they
        # build any folder path; the stock server returned the whole folder set, so
        # they never learned it. We must answer with exactly the \Noselect root row
        # carrying delimiter "/" and an empty root name -- NOT the folder list.
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            result = yield proto.list("", "")
            self.assertEqual(len(result), 1, result)
            flags, delim, name = result[0]
            self.assertIn("\\Noselect", set(flags))
            self.assertEqual(delim, "/")
            self.assertEqual(name, "")
            # A real wildcard LIST still returns the full set (override is scoped to
            # the empty pattern only).
            full = yield proto.list("", "*")
            self.assertIn("INBOX", {m[2] for m in full})
        finally:
            yield proto.logout()


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class SearchPushdownPredicateTest(unittest.TestCase):
    """Unit coverage for PosternIMAP4Server._pushable_substr_search (#148): which
    parsed SEARCH queries push to the substr endpoint and which fall back. Pure (no
    server/socket), so it is unaffected by the stock manual-search bytes bug."""

    def _p(self, charset, query):
        from posternimap.server import PosternIMAP4Server

        return PosternIMAP4Server._pushable_substr_search(charset, query)

    def test_single_subject_body_text_are_pushable(self):
        # Flat (SEARCH SUBJECT "x") and the parenthesized form Twisted's own client
        # emits (SEARCH (SUBJECT "x")) both normalize to one pushable key.
        self.assertEqual(self._p(None, [b"SUBJECT", b"lunch"]), ("subject", "lunch"))
        self.assertEqual(self._p(None, [[b"SUBJECT", b"lunch"]]), ("subject", "lunch"))
        self.assertEqual(self._p(None, [[b"BODY", b"hi"]]), ("body", "hi"))
        self.assertEqual(self._p(None, [[b"TEXT", b"x"]]), ("text", "x"))
        # Key match is case-insensitive.
        self.assertEqual(self._p(None, [[b"subject", b"x"]]), ("subject", "x"))

    def test_from_to_compound_set_flag_are_not_pushable(self):
        for q in (
            [[b"FROM", b"a@b"]],
            [[b"TO", b"a@b"]],
            [[b"SUBJECT", b"a", b"BODY", b"b"]],  # compound
            [b"ALL"],
            [b"1:3"],  # message set
            [[b"SEEN"]],  # flag
            [],  # empty
        ):
            self.assertIsNone(self._p(None, q), q)

    def test_charset_or_non_ascii_is_not_pushable(self):
        # A declared CHARSET or a non-ASCII term must fall back (the substr endpoint
        # takes a plain ASCII term with no charset).
        self.assertIsNone(self._p(b"UTF-8", [[b"SUBJECT", b"x"]]))
        self.assertIsNone(self._p(None, [[b"SUBJECT", "caf\u00e9".encode("utf-8")]]))


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerErrorPathE2ETest(twisted_unittest.TestCase):
    """#143/#144 over the wire: a failing upstream store read on SELECT or STATUS must
    return a clean tagged NO (no server-side TypeError, no unhandled traceback), not a
    BAD 'Server error' or a str/bytes crash in __ebStatus."""

    def _spin(self, status):
        transport = ErrorTransport(status=status)
        cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        factory, restore = _patched_factory(cfg, transport)
        port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        self._restore = restore
        self._port = port
        return port.getHost(), transport

    def tearDown(self):
        _restore_account(self._restore)
        return self._port.stopListening()

    @defer.inlineCallbacks
    def _client(self, addr):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_select_upstream_401_returns_tagged_no(self):
        # #144: SELECT INBOX with a stale read token (upstream 401) must be a tagged NO
        # the client can retry, not a BAD 'Server error' + logged traceback.
        addr, _ = self._spin(401)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            d = proto.select(b"INBOX")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            msg = str(exc)
            self.assertIn("UNAVAILABLE", msg)
            self.assertIn("temporarily unavailable", msg)
            self.assertNotIn("Server error", msg)
        finally:
            yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_select_upstream_5xx_returns_tagged_no(self):
        addr, _ = self._spin(503)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            d = proto.select(b"INBOX")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertIn("UNAVAILABLE", str(exc))
        finally:
            yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_status_upstream_error_returns_tagged_no_no_crash(self):
        # #143: STATUS INBOX whose backend read FAILS must NOT trip the Twisted 26.4.0
        # __ebStatus str/bytes TypeError; it returns a clean tagged NO. (Pre-fix this
        # raised `can't concat str to bytes` in the errback and produced no clean
        # response.) Trial fails the test if any error is logged and unflushed, which is
        # exactly the "no unhandled traceback" guarantee the issue asks for.
        addr, _ = self._spin(401)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            d = proto.status(b"INBOX", "MESSAGES", "UIDNEXT")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            msg = str(exc)
            self.assertIn("UNAVAILABLE", msg)
            self.assertIn("STATUS", msg)
        finally:
            yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_status_5xx_returns_tagged_no(self):
        addr, _ = self._spin(502)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            d = proto.status(b"INBOX", "MESSAGES")
            exc = yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertIn("UNAVAILABLE", str(exc))
        finally:
            yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_append_to_sent_refuses_when_store_unreachable(self):
        # #352: Sent APPEND runs the fallback matcher (needs a store read). Under a
        # hard store failure the door refuses with NO -- never silent OK+drop.
        import io

        addr, transport = self._spin(503)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            msg = io.BytesIO(b"From: conrad@skyphusion.org\r\nSubject: External Submission Test\r\n\r\nbody\r\n")
            d = proto.append("Sent", msg, ("\\Seen",))
            yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertTrue(len(transport.calls) > 0)
        finally:
            yield proto.transport.loseConnection()


    @defer.inlineCallbacks
    def test_append_to_drafts_refuses_when_store_unreachable(self):
        # Drafts APPEND persists via /api/drafts; a store failure is a loud NO.
        import io

        addr, transport = self._spin(503)
        proto = yield self._client(addr)
        try:
            yield proto.login(b"agent", b"tok")
            msg = io.BytesIO(b"From: a@b.com\r\nSubject: draft\r\n\r\nx\r\n")
            d = proto.append("Drafts", msg, ("\\Draft",))
            yield self.assertFailure(d, imap4.IMAP4Exception)
            self.assertTrue(any("/api/drafts" in c for c in transport.calls))
        finally:
            yield proto.transport.loseConnection()



@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerEnvelopeUnicodeE2ETest(twisted_unittest.TestCase):
    """#161 over the wire: a FETCH (ENVELOPE) scan over a mailbox holding a message
    with non-ASCII envelope fields (U+2026 + CJK in Subject + display-name) must NOT
    raise Twisted's UnicodeEncodeError and drop the connection. It must return valid
    RFC 2047 encoded-words. This is the exact failure that aborted Conrad's live 0.6
    measurement scan (every MUA runs `1:* (ENVELOPE ...)` on folder open)."""

    UNICODE_SUBJECT = "Re: café … 日本語 meeting"
    UNICODE_FROM = "Élodie Café … <elodie@example.com>"

    def setUp(self):
        self.msgs = [
            make_message("m2", subject=self.UNICODE_SUBJECT, **{"from": self.UNICODE_FROM}),
            make_message("m1", subject="plain ascii", body="hello"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def _client(self):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_fetch_envelope_over_unicode_mailbox_does_not_crash(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)
            # The whole-mailbox ENVELOPE scan every MUA does on folder open. Pre-fix
            # this raised UnicodeEncodeError server-side and the client saw socket EOF.
            result = yield proto.fetchEnvelope("1:*")
            self.assertEqual(len(result), 2)
            # The unicode message is seq 2 (oldest-first: m1=1, m2=2). Its ENVELOPE
            # subject (index 1) must be an ASCII RFC 2047 encoded-word.
            envelope = result[2]["ENVELOPE"]
            subject = envelope[1]
            subject_s = subject.decode() if isinstance(subject, bytes) else str(subject)
            self.assertIn("=?", subject_s)  # RFC 2047 encoded-word
            self.assertTrue(all(ord(c) < 128 for c in subject_s))
            # And it decodes back to the original Subject.
            from email.header import decode_header, make_header

            self.assertEqual(str(make_header(decode_header(subject_s))), self.UNICODE_SUBJECT)
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_fetch_full_envelope_specific_unicode_message(self):
        # A direct ENVELOPE fetch of just the unicode message (a client opening it).
        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"INBOX")
            result = yield proto.fetchEnvelope("2")
            envelope = result[2]["ENVELOPE"]
            # from (index 2) is a list of (name, source-route, mailbox, host); the
            # display-name carries the encoded-word, the mailbox/host stay ASCII.
            from_field = envelope[2]
            flat = repr(from_field)
            self.assertIn("=?", flat)
            self.assertIn("elodie", flat)
        finally:
            yield proto.logout()


if HAVE_TWISTED:
    class _ProxyHeaderIMAP4Client(imap4.IMAP4Client):
        """An IMAP4 client that prepends a PROXY protocol v1 header on connect, the
        way the L4 load balancer would. Server-speaks-first, so writing the header
        before waiting for the greeting is correct (the wrapper strips it, then the
        real IMAP greeting flows)."""

        PROXY_HEADER = b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\r\n"

        def connectionMade(self):
            self.transport.write(self.PROXY_HEADER)
            imap4.IMAP4Client.connectionMade(self)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerProxyProtocolE2ETest(twisted_unittest.TestCase):
    """#155 over a real socket: with PROXY require + a trusted loopback source, a
    client that prepends a v1 PROXY header logs in and selects normally. This proves
    the header is stripped off the raw stream BEFORE the IMAP parser sees a byte (a
    leftover header byte would corrupt the very first IMAP command), end to end with
    real TCP segmentation -- not just the unit-level wrapper."""

    def setUp(self):
        self.msgs = [
            make_message("m2", subject="meeting tuesday", body="lunch?"),
            make_message("m1", subject="welcome aboard", body="hello"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        # require + loopback trusted; a generous timeout that resolve() cancels the
        # instant the (immediately-sent) header is parsed, so no callLater is left to
        # dirty trial's reactor.
        self.cfg = Config(
            api_url="https://x",
            auth_mode="token",
            api_timeout=5.0,
            imap_poll_seconds=0,
            proxy_protocol=ProxyProtocolConfig(
                mode="require", trusted=parse_trusted("127.0.0.0/8"), timeout=5.0
            ),
        )
        factory, self._restore = _patched_factory(self.cfg, self.transport)
        from posternimap.proxywrap import wrap_listener_factory

        wrapped = wrap_listener_factory(self.cfg.proxy_protocol, factory, reactor=reactor)
        self.port = reactor.listenTCP(0, wrapped, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def test_login_select_through_proxy_header(self):
        cc = ClientCreator(reactor, _ProxyHeaderIMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)
        finally:
            yield proto.logout()


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ProxyOverTLSChainTest(unittest.TestCase):
    """#155 on the real 993 path (PROXY then implicit TLS): prove the composed chain
    raw -> PROXY strip -> TLS engages a real handshake. The wrapper hands `self` to
    the TLSMemoryBIOProtocol as its transport, so this confirms the wrapper-as-
    transport delegation (write/registerProducer/disconnecting) works for the TLS
    protocol too, not just the IMAP LineReceiver covered by the socket e2e above. In
    memory (no reactor): feed a real ClientHello after the header and assert the TLS
    server wrote a handshake response back through the wrapper."""

    def setUp(self):
        try:
            from OpenSSL import SSL  # noqa: F401
            from posternimap.tests.test_tls import _gen_self_signed
        except ImportError:
            self.skipTest("pyOpenSSL / TLS extra not installed")
        import tempfile

        from twisted.internet import reactor

        self._reactor = reactor
        # Snapshot pre-existing reactor timers so tearDown cancels ONLY the ones this
        # in-memory test creates (a real TLS engine + the inner IMAP server schedule
        # real-reactor calls: the TLS small-write flush and the IMAP idle timeout).
        # We drive no real socket, so nothing here runs them; cancelling our own keeps
        # the reactor clean for the next test without touching anyone else's timers.
        self._pre_calls = {id(c) for c in reactor.getDelayedCalls()}
        self._proto = None
        self._dir = tempfile.TemporaryDirectory()
        self.cert, self.key = _gen_self_signed(self._dir.name)

    def tearDown(self):
        from twisted.internet import protocol

        if self._proto is not None:
            # Tear the wrapper down: this propagates connectionLost into the TLS
            # protocol and the inner IMAP server, cancelling the IMAP idle timeout.
            self._proto.connectionLost(protocol.connectionDone)
        for call in list(self._reactor.getDelayedCalls()):
            if id(call) not in self._pre_calls and call.active():
                call.cancel()
        self._dir.cleanup()

    def test_proxy_then_tls_engages_handshake(self):
        import ssl as stdssl
        from twisted.internet.address import IPv4Address
        from twisted.internet.task import Clock
        from twisted.internet.testing import StringTransport
        from twisted.protocols.tls import TLSMemoryBIOFactory

        from posternimap.proxyproto import ProxyProtocolConfig, parse_trusted
        from posternimap.proxywrap import ProxyProtocolWrappingFactory
        from posternimap.server import _build_tls_context_factory

        msgs = [make_message("m1", subject="x", body="y")]
        fake = FakeTransport(msgs, expected_token="tok", page_size=2)
        cfg = Config(api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0)
        factory, restore = _patched_factory(cfg, fake)
        self.addCleanup(lambda: setattr(restore[0], restore[1], restore[2]))

        ctx = _build_tls_context_factory(self.cert, self.key)
        tls_factory = TLSMemoryBIOFactory(ctx, False, factory)
        proxy_cfg = ProxyProtocolConfig(
            mode="require", trusted=parse_trusted("127.0.0.0/8"), timeout=5.0
        )
        wf = ProxyProtocolWrappingFactory(proxy_cfg, tls_factory, reactor=Clock())
        proto = wf.buildProtocol(None)
        self._proto = proto
        st = StringTransport(peerAddress=IPv4Address("TCP", "127.0.0.1", 5000))
        proto.makeConnection(st)

        # A real TLS ClientHello from a stdlib memory-BIO client. PROTOCOL_TLS_CLIENT
        # is the recommended secure constant (no deprecated SSLv2/SSLv3/TLSv1/TLSv1.1),
        # and the 1.2 floor matches the server floor _build_tls_context_factory enforces
        # (#106), so only TLS 1.2+ is ever offered. Verification is off: this client
        # only needs to emit a ClientHello to drive the server handshake through the
        # wrapper, not to trust the self-signed test cert.
        client_ctx = stdssl.SSLContext(stdssl.PROTOCOL_TLS_CLIENT)
        client_ctx.minimum_version = stdssl.TLSVersion.TLSv1_2
        client_ctx.check_hostname = False
        client_ctx.verify_mode = stdssl.CERT_NONE
        incoming, outgoing = stdssl.MemoryBIO(), stdssl.MemoryBIO()
        client = client_ctx.wrap_bio(incoming, outgoing, server_hostname="postern.test")
        try:
            client.do_handshake()
        except stdssl.SSLWantReadError:
            pass
        client_hello = outgoing.read()

        header = b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\r\n"
        proto.dataReceived(header + client_hello)

        # The TLS server, reached through the wrapper transport, must have written a
        # handshake response (ServerHello, ...) back out. Empty output would mean the
        # header was not stripped (TLS saw garbage) or the wrapper transport failed.
        self.assertGreater(len(st.value()), 0)
        # And the wrapper presents the recovered client to everything downstream.
        self.assertEqual(proto.getPeer().host, "198.51.100.7")


if HAVE_TWISTED:
    class _RecordingIMAP4Client(imap4.IMAP4Client):
        """Captures unsolicited EXISTS (the IMailboxListener.newMessages callback the
        client fires when the server pushes an untagged EXISTS)."""

        def __init__(self, *a, **k):
            imap4.IMAP4Client.__init__(self, *a, **k)
            self.exists_events = []

        def newMessages(self, exists, recent):
            if exists is not None:
                self.exists_events.append(int(exists))


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerNoopRefreshE2ETest(twisted_unittest.TestCase):
    """#102 over the wire: a NOOP must surface mail that arrived mid-session as an
    untagged EXISTS, EVEN with the timed poll disabled (poll_seconds=0). Proves the
    do_NOOP override drives mailbox.poll_now()."""

    def setUp(self):
        self.msgs = [
            make_message("m2", subject="meeting tuesday", body="lunch?"),
            make_message("m1", subject="welcome aboard", body="hello"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        # poll_seconds=0: no LoopingCall (keeps trial's reactor clean); NOOP must still
        # surface new mail via the synchronous poll_now.
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def _client(self):
        cc = ClientCreator(reactor, _RecordingIMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_noop_surfaces_new_mail_mid_session(self):
        proto = yield self._client()
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)
            # New inbound mail arrives at the newest end AFTER the snapshot loaded.
            self.transport.messages.insert(0, make_message("m3", subject="fresh", body="new"))
            # noop() returns the untagged status the server pushed during NOOP; the
            # refresh must have surfaced the new arrival as an untagged EXISTS = 3.
            lines = yield proto.noop()
            exists = [ln for ln in lines if len(ln) == 2 and ln[1] == b"EXISTS"]
            self.assertTrue(exists, "no untagged EXISTS on NOOP: %r" % (lines,))
            self.assertEqual(int(exists[-1][0]), 3)
        finally:
            yield proto.logout()


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerIdleCapabilityE2ETest(twisted_unittest.TestCase):
    """#102 RFC 2177: advertise IDLE only when a live push path (the timed poll) exists.
    With the poll off, advertising IDLE while never pushing would be non-compliant.
    CAPABILITY needs no SELECT, so no LoopingCall is started (reactor stays clean)."""

    def _spin(self, poll_seconds):
        transport = FakeTransport([make_message("m1", subject="x", body="y")],
                                  expected_token="tok", page_size=2)
        cfg = Config(api_url="https://x", auth_mode="token", api_timeout=5.0,
                     imap_poll_seconds=poll_seconds)
        factory, self._restore = _patched_factory(cfg, transport)
        self._port = reactor.listenTCP(0, factory, interface="127.0.0.1")
        return self._port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self._port.stopListening()

    @defer.inlineCallbacks
    def _caps(self, addr):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", addr.port)
        try:
            caps = yield proto.getCapabilities()
        finally:
            yield proto.transport.loseConnection()
        defer.returnValue(caps)

    @defer.inlineCallbacks
    def test_idle_advertised_when_poll_enabled(self):
        caps = yield self._caps(self._spin(30))
        self.assertIn(b"IDLE", caps)

    @defer.inlineCallbacks
    def test_idle_not_advertised_when_poll_disabled(self):
        caps = yield self._caps(self._spin(0))
        self.assertNotIn(b"IDLE", caps)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerIdlePushTest(unittest.TestCase):
    """#102 RFC 2177: while a client IDLEs, the timed poll's new-mail push must reach it
    as an untagged EXISTS. do_IDLE keeps the connection selected (still a registered
    mailbox listener), so a poll tick that finds new mail forwards an EXISTS straight to
    the idling client. Deterministic: a StringTransport + a manual poll tick, no reactor,
    no LoopingCall (mailbox default poll_seconds=0, so addListener starts no loop)."""

    def test_poll_pushes_exists_to_a_client_in_idle(self):
        from twisted.internet.testing import StringTransport
        from posternimap.server import PosternIMAP4Server
        from posternimap.mailbox import PosternMailbox
        from posternimap.client import PosternClient

        fake = FakeTransport(
            [make_message("m1", subject="a", body="x")], expected_token="tok", page_size=2
        )
        client = PosternClient("https://x", "tok", transport=fake)
        mbox = PosternMailbox(client, page_size=2, direction="inbound")
        self.assertEqual(mbox.getMessageCount(), 1)  # load the snapshot

        proto = PosternIMAP4Server()
        proto.makeConnection(StringTransport())
        # makeConnection schedules the IMAP idle-timeout on the real reactor; cancel it
        # so this reactor-less test leaves no DelayedCall for the next trial test.
        self.addCleanup(proto.setTimeout, None)
        # What SELECT wires up: the mailbox and the server-as-listener.
        proto.mbox = mbox
        mbox.addListener(proto)
        proto.do_IDLE(b"t1")  # enter IDLE (continuation request)
        proto.transport.clear()  # drop greeting + continuation; keep only the push

        # New inbound mail arrives; a poll tick surfaces it and pushes to the idler.
        fake.messages.insert(0, make_message("m2", subject="b", body="y"))
        mbox._poll_tick()

        wire = proto.transport.value()
        self.assertIn(b"EXISTS", wire)
        self.assertIn(b"2", wire)  # the new mailbox size

        mbox.removeListener(proto)  # clean teardown (no loop was running)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerHtmlBodyE2ETest(twisted_unittest.TestCase):
    """#210/#220 over the wire: an HTML mail whose body contains quoted-printable-looking
    runs ("token=abc=def") + non-ASCII must reach the client UNCORRUPTED. Post-fix the
    body is projected as multipart/alternative (plain + html, both 8bit); this FETCHes
    the whole RFC822 off the real server and asserts the html part decodes intact."""

    HTML = "<html><body><h1>H\u00e9llo</h1><p>verify token=abc=def link " + ("x" * 90) + "</p></body></html>"
    TEXT = "Verify token=abc=def and don\u2019t worry \u2014 " + ("word " * 15)

    def setUp(self):
        self.msgs = [
            make_message("h1", subject="cloudflare marketing", body=self.TEXT, bodyHtml=self.HTML),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=2)
        self.cfg = Config(
            api_url="https://x", auth_mode="token", api_timeout=5.0, imap_poll_seconds=0
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def _client(self):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_html_body_fetches_uncorrupted(self):
        import email as _email

        proto = yield self._client()
        try:
            yield proto.login(b"agent@skyphusion.org", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 1)
            result = yield proto.fetchMessage("1")
            raw = result[1]["RFC822"]
            if isinstance(raw, str):
                # Twisted may hand the literal back as a byte-preserving latin-1 str;
                # latin-1 round-trips 0..255 exactly, so this recovers the wire bytes
                # (a utf-8 re-encode would double-encode multibyte chars).
                raw = raw.encode("latin-1", "replace")
            parsed = _email.message_from_bytes(raw)
            self.assertEqual(parsed.get_content_type(), "multipart/alternative")
            html = next(
                p for p in parsed.walk()
                if p.get_content_type() == "text/html"
            )
            # The client honours the part CTE and decodes ONCE; the "=abc=def" run and
            # the non-ASCII survive intact (pre-fix the double-decode corrupted them).
            body = html.get_payload(decode=True).decode("utf-8")
            self.assertIn("token=abc=def", body)
            self.assertIn("H\u00e9llo", body)
            self.assertEqual(body.rstrip("\n"), self.HTML)
        finally:
            yield proto.logout()


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class IDCommandSelectAndTraceTest(unittest.TestCase):
    """Unit coverage (#218): the RFC 2971 ID command, the RFC 3501 6.3.1 SELECT
    completeness fields, and the POSTERN_IMAP_WIRE_TRACE redaction. Pure protocol
    (StringTransport), no socket/account, so these are deterministic and fast."""

    def _server(self):
        from twisted.internet.testing import StringTransport
        from posternimap.server import PosternIMAP4Server

        srv = PosternIMAP4Server()
        srv.makeConnection(StringTransport())
        # connectionMade schedules the TimeoutMixin inactivity timer; disable it so no
        # DelayedCall leaks into the trial reactor (these unit servers never disconnect).
        srv.setTimeout(None)
        self.addCleanup(srv.setTimeout, None)
        return srv

    def test_connection_disables_nagle(self):
        # #229 perf: TCP_NODELAY must be set on the accepted socket. Without it, the
        # multi-segment RFC822/BODY[] write stalls ~40ms per message on Nagle +
        # delayed-ACK (measured: FETCH RFC822 ~50ms -> ~7ms with NODELAY on loopback).
        from twisted.internet.testing import StringTransport
        from posternimap.server import PosternIMAP4Server

        calls = []

        class _RecordingTransport(StringTransport):
            def setTcpNoDelay(self, enabled):
                calls.append(enabled)

        srv = PosternIMAP4Server()
        srv.makeConnection(_RecordingTransport())  # calls connectionMade
        srv.setTimeout(None)
        self.addCleanup(srv.setTimeout, None)
        self.assertEqual(calls, [True])

    def test_connection_survives_transport_without_nodelay(self):
        # A PROXY-wrapped / TLS transport may not expose setTcpNoDelay; connectionMade
        # must not raise (the guard swallows AttributeError). _server() uses a plain
        # StringTransport (no setTcpNoDelay), so simply building one proves it.
        self._server()

    def test_capability_advertises_id(self):
        self.assertIn(b"ID", self._server().listCapabilities())

    def test_id_dispatch_replies_for_list_nil_and_empty(self):
        # RFC 2971 grammar: a parenthesized field list, NIL, and (lenient) empty -- all
        # answered with our fixed non-sensitive server ID and a tagged OK, via the real
        # dispatch tuple (not by calling do_ID directly), in the authenticated state.
        for arg in (b'("name" "iPhone Mail" "version" "21F90")', b"NIL", b""):
            srv = self._server()
            srv.state = "auth"
            srv.transport.clear()
            srv.dispatchCommand(b"x1", b"ID", arg)
            out = srv.transport.value()
            self.assertIn(b'* ID ("name" "postern-imap")', out, arg)
            self.assertIn(b"x1 OK ID completed", out, arg)

    def test_id_valid_in_unauth_auth_and_select_states(self):
        for state in ("unauth", "auth", "select"):
            srv = self._server()
            srv.state = state
            srv.transport.clear()
            srv.dispatchCommand(b"x2", b"ID", b"NIL")
            self.assertIn(b"x2 OK ID completed", srv.transport.value(), state)

    def test_select_response_emits_uidnext_permanentflags_and_flag_keywords(self):
        # Drive the SELECT callback with a fake mailbox and assert the wire bytes carry
        # the RFC 3501 6.3.1 SHOULD fields the stock Twisted response omitted.
        class _FakeSelMbox:
            def getFlags(self):
                return ["\\Seen", "Trusted", "Untrusted", "Inbound", "Outbound"]

            def getMessageCount(self):
                return 42

            def getRecentCount(self):
                return 0

            def getUIDValidity(self):
                return 20260704

            def getUIDNext(self):
                return 99

            def isWriteable(self):
                return False

            def addListener(self, _):
                return None

        srv = self._server()
        srv.transport.clear()
        srv._cbSelectWork(_FakeSelMbox(), b"SELECT", b"t1")
        out = srv.transport.value()
        self.assertIn(b"42 EXISTS", out)
        self.assertIn(b"FLAGS (\\Seen Trusted Untrusted Inbound Outbound)", out)
        self.assertIn(b"[PERMANENTFLAGS ()]", out)      # read-only -> empty, no \*
        self.assertIn(b"[UIDVALIDITY 20260704]", out)
        self.assertIn(b"[UIDNEXT 99]", out)             # the field Apple Mail needs
        self.assertIn(b"t1 OK [READ-ONLY] SELECT successful", out)

    def test_wire_trace_redacts_login_and_authenticate(self):
        from posternimap.server import _redact_wire_trace

        for line, secret in [
            (b'a1 LOGIN "joan" "hunter2pw"', b"hunter2pw"),
            (b'a1 login "joan" "hunter2pw"', b"hunter2pw"),
            (b"a1 AUTHENTICATE PLAIN dGVzdHNlY3JldA==", b"dGVzdHNlY3JldA=="),
        ]:
            red = _redact_wire_trace(line)
            self.assertNotIn(secret, red)
            self.assertIn(b"<REDACTED>", red)
        # non-credential lines pass through byte-for-byte
        for line in (b"a2 SELECT INBOX", b"a3 UID SEARCH SINCE 1-Jun-2026", b"* OK ready"):
            self.assertEqual(_redact_wire_trace(line), line)

    def test_wire_trace_never_logs_a_login_password_verbatim(self):
        # End-to-end at the hook: with the trace ON, a LOGIN line fed through
        # lineReceived must never put the password in the log -- redaction is at capture.
        from twisted.python import log as tlog

        events = []
        tlog.addObserver(events.append)
        try:
            srv = self._server()

            class _Cfg:
                imap_wire_trace = True

            class _F:
                _cfg = _Cfg()

            srv.factory = _F()
            try:
                srv.lineReceived(b'z9 LOGIN "joan" "topsecretpw123"')
            except Exception:
                pass  # downstream LOGIN parsing may error; we only assert the trace
        finally:
            tlog.removeObserver(events.append)
        blob = " ".join(repr(e.get("message", e)) for e in events)
        self.assertNotIn("topsecretpw123", blob)
        self.assertIn("wire C:", blob)
        self.assertIn("<REDACTED>", blob)

    def test_manual_search_empty_result_still_sends_bare_untagged(self):
        # #218 round 4 / RFC 3501 7.2.5: a successful SEARCH over an empty folder MUST
        # still send the untagged reply -- a BARE `* SEARCH` (no ids, NO trailing
        # space). Twisted 24.3.0 skipped it entirely on empty; iOS stalled forever.
        srv = self._server()
        srv.transport.clear()
        srv._IMAP4Server__cbManualSearch([], b"t1", None, [b"ALL"], 0)
        out = srv.transport.value()
        self.assertIn(b"* SEARCH\r\n", out)        # bare untagged reply present
        self.assertNotIn(b"* SEARCH \r\n", out)     # NOT the old trailing-space form
        self.assertIn(b"t1 OK SEARCH completed", out)

    def test_manual_search_nonempty_result_sends_ids(self):
        # Non-empty behavior unchanged: the untagged reply carries the matching ids.
        class _Msg:
            def __init__(self, uid):
                self._uid = uid

            def getUID(self):
                return self._uid

        result = [(1, _Msg(11)), (2, _Msg(22))]
        srv = self._server()
        srv.transport.clear()
        srv._IMAP4Server__cbManualSearch(result, b"t2", None, [b"ALL"], 0)
        out = srv.transport.value()
        self.assertIn(b"* SEARCH 1 2\r\n", out)     # sequence ids (uid=0), ALL matches
        self.assertIn(b"t2 OK SEARCH completed", out)

    def test_pushdown_search_empty_result_sends_bare_untagged(self):
        # The #148 pushdown reply path gets the same normalization: empty -> bare
        # `* SEARCH`, not the old `b"SEARCH " + b""` trailing-space form.
        srv = self._server()
        srv.transport.clear()
        srv._cb_push_search([], b"t3")
        out = srv.transport.value()
        self.assertIn(b"* SEARCH\r\n", out)
        self.assertNotIn(b"* SEARCH \r\n", out)
        self.assertIn(b"t3 OK SEARCH completed", out)

    def test_pushdown_search_nonempty_result_sends_ids(self):
        srv = self._server()
        srv.transport.clear()
        srv._cb_push_search([5, 7], b"t4")
        out = srv.transport.value()
        self.assertIn(b"* SEARCH 5 7\r\n", out)
        self.assertIn(b"t4 OK SEARCH completed", out)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class MoveUntaggedSequencingTest(unittest.TestCase):
    """RFC 6851 sec 3 + RFC 3501 7.4.1 (#304): a MOVE to the Trash delete sink emits an
    untagged EXPUNGE per moved message, carrying the 1-based message SEQUENCE number
    (never the UID), high-to-low, BEFORE the tagged OK. COPY emits none. Deterministic
    StringTransport; the response callback is driven directly with a UID != seq fixture
    so a sequence/UID mix-up cannot hide behind uid == seq (the #300 class)."""

    def _server(self):
        from twisted.internet.testing import StringTransport
        from posternimap.server import PosternIMAP4Server

        srv = PosternIMAP4Server()
        srv.makeConnection(StringTransport())
        srv.setTimeout(None)
        self.addCleanup(srv.setTimeout, None)
        return srv

    def _fetched_uid_ne_seq(self):
        # A non-contiguous move set: seq 1 -> uid 101, seq 3 -> uid 103. uid != seq so a
        # UID leak into the untagged EXPUNGE would read 101/103, not the sequence 1/3.
        class _S:
            def __init__(self, uid, mid):
                self.uid = uid
                self.message_id = mid

        class _M:
            def __init__(self, uid, mid):
                self._summary = _S(uid, mid)

        return [(1, _M(101, "a")), (3, _M(103, "c"))]

    def _mbox(self, deleted):
        class _Mbox:
            _delete_writable = True

            def delete_fetched_messages(self, fetched):
                deleted.append([seq for seq, _m in fetched])

        return _Mbox()

    def test_move_emits_untagged_expunge_sequence_numbers_high_to_low(self):
        srv = self._server()
        deleted = []
        srv.mbox = self._mbox(deleted)
        srv.transport.clear()
        srv._cbCopyToTrashDelete(self._fetched_uid_ne_seq(), b"t1", is_move=True)
        out = srv.transport.value()
        self.assertIn(b"* 3 EXPUNGE\r\n", out)
        self.assertIn(b"* 1 EXPUNGE\r\n", out)
        # high-to-low, and both before the tagged OK
        self.assertLess(out.index(b"* 3 EXPUNGE"), out.index(b"* 1 EXPUNGE"))
        self.assertLess(out.index(b"* 1 EXPUNGE"), out.index(b"t1 OK MOVE completed"))
        # the UIDs (101/103) must never surface as EXPUNGE sequence ids
        self.assertNotIn(b"101 EXPUNGE", out)
        self.assertNotIn(b"103 EXPUNGE", out)
        self.assertEqual(deleted, [[1, 3]])

    def test_copy_emits_no_untagged_expunge(self):
        srv = self._server()
        srv.mbox = self._mbox([])
        srv.transport.clear()
        srv._cbCopyToTrashDelete(self._fetched_uid_ne_seq(), b"t2", is_move=False)
        out = srv.transport.value()
        self.assertNotIn(b"EXPUNGE", out)
        self.assertIn(b"t2 OK COPY completed", out)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ServerMoveRFC6851E2ETest(twisted_unittest.TestCase):
    """RFC 6851 MOVE (#304) end to end over the real wire: MOVE is advertised in
    CAPABILITY and, for the Trash delete sink, hard-deletes from the source mailbox like
    COPY. UID != seq fixture (pinned uids 101/102) so a sequence/UID confusion in the
    move set cannot pass (the #300 class)."""

    def setUp(self):
        # Two inbound messages, pinned uids 101/102 (seq 1/2) so uid != seq.
        self.msgs = [
            make_message("mb", subject="second", body="two", uid=102),
            make_message("ma", subject="first", body="one", uid=101),
        ]
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=50)
        self.cfg = Config(
            api_url="https://x",
            auth_mode="token",
            api_timeout=5.0,
            imap_poll_seconds=0,
            service_delete_token="tok",
        )
        self.factory, self._restore = _patched_factory(self.cfg, self.transport)
        self.port = reactor.listenTCP(0, self.factory, interface="127.0.0.1")
        self.addr = self.port.getHost()

    def tearDown(self):
        _restore_account(self._restore)
        return self.port.stopListening()

    @defer.inlineCallbacks
    def _client(self):
        cc = ClientCreator(reactor, imap4.IMAP4Client)
        proto = yield cc.connectTCP("127.0.0.1", self.addr.port)
        defer.returnValue(proto)

    @defer.inlineCallbacks
    def test_move_advertised_in_capability(self):
        proto = yield self._client()
        try:
            caps = yield proto.getCapabilities()
            self.assertIn(b"MOVE", caps)
        finally:
            yield proto.transport.loseConnection()

    @defer.inlineCallbacks
    def test_move_to_trash_deletes_from_inbox(self):
        from twisted.mail.imap4 import Command

        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 2)
            # Twisted's client has no move(); send the raw RFC 6851 command. MOVE
            # sequence 2 (uid 102, "mb") to Trash: hard-delete from INBOX + untagged
            # EXPUNGE, then a tagged OK the client's sendCommand fires on.
            yield proto.sendCommand(Command(b"MOVE", b"2 Trash"))
            info = yield proto.select(b"INBOX")
            self.assertEqual(info["EXISTS"], 1)
            self.assertTrue(
                any("/api/messages/move" in c for c in self.transport.calls),
                "expected soft-move API for the moved message mb",
            )
        finally:
            yield proto.logout()

    @defer.inlineCallbacks
    def test_move_to_placeholder_is_rejected(self):
        from twisted.mail.imap4 import Command

        proto = yield self._client()
        try:
            yield proto.login(b"agent", b"tok")
            yield proto.select(b"INBOX")
            d = proto.sendCommand(Command(b"MOVE", b"1 Drafts"))
            yield self.assertFailure(d, imap4.IMAP4Exception)
        finally:
            yield proto.logout()

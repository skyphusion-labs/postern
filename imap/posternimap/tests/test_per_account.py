"""Per-account view scoping for the IMAP door (#357).

Covers, at the level the door actually decides:
  * derive_viewer: login -> viewer address V (rule + override map + fail cases).
  * Config: per_account requires a viewer domain (fail loud, never silent estate).
  * client.set_seen / search_page carry the per-recipient `for` and viewer `to`.
  * PosternAccount wires each folder to the right lens (to=V / from=V / for=V), and
    estate mode is byte-identical (all None).
  * A \\Seen STORE routes for=V on the INBOX (to=V) lens and NO for on the Sent lens.
  * Fail-closed: per_account with an underivable login serves nothing (never estate).

The recipient-relative PREDICATE itself (which rows INBOX returns) is worker SQL; the
faithful fake models CONTRACT 10.9 for a wiring-level check here, and the live door is
the artifact-level proof.
"""

from __future__ import annotations

import unittest

from posternimap.config import Config, ConfigError
from posternimap.client import PosternClient
from posternimap.tests.fakes import FakeTransport, make_message

try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False


def _cfg(**over) -> Config:
    env = {"POSTERN_API_URL": "https://x"}
    env.update(over)
    return Config.from_env(env)


class ConfigViewerTest(unittest.TestCase):
    def test_estate_is_the_default(self):
        cfg = _cfg()
        self.assertEqual(cfg.viewer_mode, "estate")
        self.assertIsNone(cfg.viewer_domain)
        self.assertEqual(cfg.viewer_map, {})

    def test_per_account_requires_domain(self):
        with self.assertRaises(ConfigError):
            _cfg(POSTERN_IMAP_VIEWER_MODE="per_account")

    def test_per_account_with_domain_ok(self):
        cfg = _cfg(
            POSTERN_IMAP_VIEWER_MODE="per_account",
            POSTERN_IMAP_VIEWER_DOMAIN="Example.ORG",
        )
        self.assertEqual(cfg.viewer_mode, "per_account")
        self.assertEqual(cfg.viewer_domain, "example.org")

    def test_bad_mode_is_loud(self):
        with self.assertRaises(ConfigError):
            _cfg(POSTERN_IMAP_VIEWER_MODE="whatever")

    def test_viewer_map_parses_and_lowercases(self):
        cfg = _cfg(
            POSTERN_IMAP_VIEWER_MODE="per_account",
            POSTERN_IMAP_VIEWER_DOMAIN="example.org",
            POSTERN_IMAP_VIEWER_MAP=" Crock = Conrad@Example.org , svc=robot@example.org ",
        )
        self.assertEqual(
            cfg.viewer_map, {"crock": "conrad@example.org", "svc": "robot@example.org"}
        )

    def test_viewer_map_malformed_is_loud(self):
        for bad in ("noequals", "a=", "=b@x", "a=notanaddress"):
            with self.assertRaises(ConfigError):
                _cfg(
                    POSTERN_IMAP_VIEWER_MODE="per_account",
                    POSTERN_IMAP_VIEWER_DOMAIN="example.org",
                    POSTERN_IMAP_VIEWER_MAP=bad,
                )


class ClientViewerParamTest(unittest.TestCase):
    def _client(self):
        t = FakeTransport([make_message("m1", seen=False)], expected_token="t", page_size=2)
        return PosternClient("https://x", "t", transport=t), t

    def test_set_seen_sends_for_when_given(self):
        c, t = self._client()
        c.set_seen(["m1"], True, for_addr="v@example.org")
        self.assertIsNotNone(t.last_seen_payload)
        self.assertEqual(t.last_seen_payload.get("for"), "v@example.org")

    def test_set_seen_omits_for_by_default(self):
        c, t = self._client()
        c.set_seen(["m1"], True)
        self.assertIsNotNone(t.last_seen_payload)
        self.assertNotIn("for", t.last_seen_payload)

    def test_search_page_sends_to(self):
        c, t = self._client()
        c.search_page("hello", mode="substr", to="v@example.org")
        self.assertTrue(any("to=v%40example.org" in u for u in t.calls))

    def test_search_page_omits_to_by_default(self):
        c, t = self._client()
        c.search_page("hello", mode="substr")
        self.assertFalse(any("to=" in u for u in t.calls))


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class DeriveViewerTest(unittest.TestCase):
    def _d(self, login, domain="example.org", vmap=None):
        from posternimap.account import derive_viewer

        return derive_viewer(login, domain, vmap or {})

    def test_bare_login_gets_domain(self):
        self.assertEqual(self._d("conrad"), "conrad@example.org")

    def test_typed_domain_is_stripped_and_relowered(self):
        self.assertEqual(self._d("Conrad@ELSEWHERE.NET"), "conrad@example.org")

    def test_domain_is_lowercased(self):
        self.assertEqual(self._d("conrad", domain="Example.ORG"), "conrad@example.org")

    def test_map_wins_over_rule_on_full_login(self):
        self.assertEqual(
            self._d("crock", vmap={"crock": "conrad@example.org"}), "conrad@example.org"
        )

    def test_map_matches_localpart_of_typed_login(self):
        self.assertEqual(
            self._d("crock@example.org", vmap={"crock": "conrad@example.org"}),
            "conrad@example.org",
        )

    def test_empty_localpart_is_underivable(self):
        self.assertIsNone(self._d("@host"))

    def test_no_domain_and_no_map_is_underivable(self):
        self.assertIsNone(self._d("conrad", domain=None))


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class AccountScopingTest(unittest.TestCase):
    def _account(self, **over):
        from posternimap.account import PosternAccount

        cfg = _cfg(**over)
        return PosternAccount(cfg, "conrad", "tok")

    def test_estate_mode_scopes_nothing(self):
        acct = self._account()  # default estate
        for name in ("INBOX", "Sent", "All"):
            mb = acct.select(name)
            self.assertIsNone(mb._to, name)
            self.assertIsNone(mb._from, name)
            self.assertIsNone(mb._viewer, name)

    def test_per_account_inbox_is_to_v_lens(self):
        acct = self._account(
            POSTERN_IMAP_VIEWER_MODE="per_account", POSTERN_IMAP_VIEWER_DOMAIN="example.org"
        )
        mb = acct.select("INBOX")
        self.assertEqual(mb._to, "conrad@example.org")
        self.assertIsNone(mb._from)
        self.assertEqual(mb._viewer, "conrad@example.org")  # seen writes carry for=V
        self.assertEqual(mb._direction, "inbound")

    def test_per_account_sent_is_from_v_lens(self):
        acct = self._account(
            POSTERN_IMAP_VIEWER_MODE="per_account", POSTERN_IMAP_VIEWER_DOMAIN="example.org"
        )
        mb = acct.select("Sent")
        self.assertEqual(mb._from, "conrad@example.org")
        self.assertIsNone(mb._to)
        self.assertIsNone(mb._viewer)  # Sent seen stays estate (read/write consistency)
        self.assertEqual(mb._direction, "outbound")

    def test_per_account_all_is_to_v_both_directions(self):
        acct = self._account(
            POSTERN_IMAP_VIEWER_MODE="per_account", POSTERN_IMAP_VIEWER_DOMAIN="example.org"
        )
        mb = acct.select("All")
        self.assertEqual(mb._to, "conrad@example.org")
        self.assertIsNone(mb._from)
        self.assertEqual(mb._viewer, "conrad@example.org")
        self.assertIsNone(mb._direction)  # both directions

    def test_per_account_trash_junk_archive_are_to_v_lens(self):
        # #352 review: Trash/Junk/Archive MUST scope to the viewer exactly like
        # INBOX/All (viewer_to + viewer_seen) -- the placement filter (mailbox=X)
        # alone is estate-wide, so without this a viewer boundary layered on top
        # would be missing and user A could see user B's trash/junk/archive.
        acct = self._account(
            POSTERN_IMAP_VIEWER_MODE="per_account", POSTERN_IMAP_VIEWER_DOMAIN="example.org"
        )
        for name in ("Trash", "Junk", "Archive"):
            mb = acct.select(name)
            self.assertEqual(mb._to, "conrad@example.org", name)
            self.assertIsNone(mb._from, name)
            self.assertEqual(mb._viewer, "conrad@example.org", name)

    def test_map_override_applies(self):
        from posternimap.account import PosternAccount

        cfg = _cfg(
            POSTERN_IMAP_VIEWER_MODE="per_account",
            POSTERN_IMAP_VIEWER_DOMAIN="example.org",
            POSTERN_IMAP_VIEWER_MAP="crock=conrad@example.org",
        )
        acct = PosternAccount(cfg, "crock", "tok")
        self.assertEqual(acct.select("INBOX")._to, "conrad@example.org")

    def test_fail_closed_when_viewer_underivable(self):
        from posternimap.account import PosternAccount

        cfg = _cfg(
            POSTERN_IMAP_VIEWER_MODE="per_account", POSTERN_IMAP_VIEWER_DOMAIN="example.org"
        )
        # "@host" has an empty local part -> no derivable V -> fail closed.
        acct = PosternAccount(cfg, "@host", "tok")
        self.assertIsNone(acct.select("INBOX"))
        self.assertEqual(acct.listMailboxes("", "*"), [])


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class SeenForRoutingTest(unittest.TestCase):
    def _mailbox(self, msgs, **kw):
        from posternimap.mailbox import PosternMailbox

        transport = FakeTransport(msgs, expected_token="t", page_size=2)
        client = PosternClient("https://x", "t", transport=transport)
        return PosternMailbox(client, page_size=2, seen_writable=True, **kw), transport

    def test_inbox_lens_writes_for_v(self):
        from twisted.mail.imap4 import MessageSet

        mb, t = self._mailbox(
            [make_message("u1", to="conrad@example.org", seen=False)],
            to="conrad@example.org",
            viewer="conrad@example.org",
        )
        mb.getMessageCount()
        mb.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertEqual(t.last_seen_payload.get("for"), "conrad@example.org")

    def test_sent_lens_writes_no_for(self):
        from twisted.mail.imap4 import MessageSet

        # from=V so the message survives the Sent from-filter.
        sent = make_message("s1", direction="outbound", seen=False)
        sent["from"] = "conrad@example.org"
        mb, t = self._mailbox(
            [sent],
            direction="outbound",
            from_addr="conrad@example.org",
            viewer=None,  # Sent keeps estate seen
        )
        self.assertEqual(mb.getMessageCount(), 1)
        mb.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertNotIn("for", t.last_seen_payload)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class InboxLensIntegrationTest(unittest.TestCase):
    """Wiring-level check through the 10.9-faithful fake: a same-domain send (stored
    outbound) shows up in V's INBOX lens, which the estate door was blind to (#357)."""

    def _account_mb(self, name, msgs, **over):
        from posternimap.account import PosternAccount

        cfg = _cfg(
            POSTERN_IMAP_VIEWER_MODE="per_account",
            POSTERN_IMAP_VIEWER_DOMAIN="example.org",
            **over,
        )
        transport = FakeTransport(msgs, expected_token="tok", page_size=50)
        acct = PosternAccount(cfg, "conrad", "tok")
        # swap in the fake-backed client (the account builds its own otherwise)
        acct._client = lambda: PosternClient("https://x", "tok", transport=transport)
        mb = acct.select(name)
        return mb, transport

    def test_inbox_includes_same_domain_send_from_other(self):
        msgs = [
            # a colleague's same-domain send TO conrad, stored outbound (the fc#792 case)
            make_message("s1", direction="outbound", subject="same-domain"),
            make_message("i1", direction="inbound", subject="external in"),
        ]
        msgs[0]["from"] = "joan@example.org"
        msgs[0]["to"] = "conrad@example.org"
        msgs[0]["deliveredTo"] = ["conrad@example.org"]
        msgs[1]["to"] = "conrad@example.org"
        msgs[1]["deliveredTo"] = ["conrad@example.org"]
        mb, _ = self._account_mb("INBOX", msgs)
        self.assertEqual(mb.getMessageCount(), 2)  # inbound + the same-domain send

    def test_inbox_excludes_own_sends(self):
        # conrad's OWN outbound to an external party is NOT in his inbox lens.
        msgs = [make_message("o1", direction="outbound", subject="my send")]
        msgs[0]["from"] = "conrad@example.org"
        msgs[0]["to"] = "someone@external.test"
        msgs[0]["deliveredTo"] = ["someone@external.test"]
        mb, _ = self._account_mb("INBOX", msgs)
        self.assertEqual(mb.getMessageCount(), 0)

    def _account_for(self, login, msgs):
        from posternimap.account import PosternAccount

        cfg = _cfg(
            POSTERN_IMAP_VIEWER_MODE="per_account", POSTERN_IMAP_VIEWER_DOMAIN="example.org"
        )
        transport = FakeTransport(msgs, expected_token="tok", page_size=50)
        acct = PosternAccount(cfg, login, "tok")
        acct._client = lambda: PosternClient("https://x", "tok", transport=transport)
        return acct, transport

    def test_user_a_cannot_list_user_bs_trash(self):
        # #352 review: two viewers, two messages each placed in trash by their own
        # delivered-set membership; A's Trash view must show only A's row, never B's.
        a_trashed = make_message("ta", subject="a's trash", mailbox="trash", folderUid=1)
        a_trashed["to"] = "alice@example.org"
        a_trashed["deliveredTo"] = ["alice@example.org"]
        b_trashed = make_message("tb", subject="b's trash", mailbox="trash", folderUid=2)
        b_trashed["to"] = "bob@example.org"
        b_trashed["deliveredTo"] = ["bob@example.org"]
        msgs = [a_trashed, b_trashed]

        acct_a, _ = self._account_for("alice", msgs)
        trash_a = acct_a.select("Trash")
        self.assertEqual(trash_a.getMessageCount(), 1)

        acct_b, _ = self._account_for("bob", msgs)
        trash_b = acct_b.select("Trash")
        self.assertEqual(trash_b.getMessageCount(), 1)

    def test_user_a_cannot_move_or_expunge_user_bs_trash(self):
        # A's live snapshot never contains B's row in the first place (the viewer
        # filter above), so a MOVE/EXPUNGE issued by A's session -- which only ever
        # operates on fetched rows from A's OWN snapshot -- cannot target it.
        from twisted.mail.imap4 import MessageSet

        a_trashed = make_message("ta", subject="a's trash", mailbox="trash", folderUid=1)
        a_trashed["to"] = "alice@example.org"
        a_trashed["deliveredTo"] = ["alice@example.org"]
        b_trashed = make_message("tb", subject="b's trash", mailbox="trash", folderUid=2)
        b_trashed["to"] = "bob@example.org"
        b_trashed["deliveredTo"] = ["bob@example.org"]
        msgs = [a_trashed, b_trashed]

        acct_a, transport = self._account_for("alice", msgs)
        trash_a = acct_a.select("Trash")
        trash_a.getMessageCount()
        self.assertEqual(trash_a.getMessageCount(), 1)
        # A's only fetchable sequence is her own row -- there is no sequence number
        # that could resolve to B's message_id "tb".
        fetched = list(trash_a.fetch(MessageSet(1, 1), uid=False))
        self.assertEqual(len(fetched), 1)
        self.assertEqual(fetched[0][1]._summary.message_id, "ta")
        trash_a.soft_move_fetched_messages(fetched, None)
        self.assertEqual(b_trashed.get("mailbox"), "trash")  # untouched
        self.assertIsNone(a_trashed.get("mailbox"))  # restored (soft-moved to null)


if __name__ == "__main__":
    unittest.main()

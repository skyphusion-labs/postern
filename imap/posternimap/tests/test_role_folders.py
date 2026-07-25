"""Role-address queues for the IMAP door (#404).

Conrad ruling (2026-07-25): role mail gets its OWN FOLDER per role address, never
merged into anyone INBOX. A viewer resolves to a SET (V plus every role V belongs
to); INBOX stays personal; per-viewer seen (#350 message_seen_by) is KEPT, so
"Ada read it" never renders as "the queue is handled" (queue-handled workflow is
explicitly not modeled yet).

What is proven here, at the level the door actually decides:
  * config: the ROLES map parses, and every malformed shape is a loud refusal.
  * a member sees Roles/<role>; a non-member cannot see or SELECT it.
  * the boundary in BOTH directions: the role folder excludes personal mail, and
    INBOX excludes role mail.
  * per-viewer seen isolation between two members of one queue, through a fake that
    models message_seen_by for real -- plus the control that the fake records and
    renders overrides, and the negative control showing a role read WITHOUT seenFor
    is blind to the member override (that is the whole reason seenFor exists).
  * write posture: read plus \\Seen only. Every other write refuses honestly.
  * fail-closed: underivable viewer serves nothing; roles in estate mode refuse.
  * estate mode stays byte-identical.

The recipient predicate itself is worker SQL; the faithful fake models CONTRACT 10.9
for the wiring check here, and the live door is the artifact-level proof.
"""

from __future__ import annotations

import unittest

from posternimap.client import PosternClient
from posternimap.config import Config, ConfigError, role_folder_name
from posternimap.tests.fakes import FakeTransport, make_message

try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False

ROLE = "abuse@example.org"
ROLES = "abuse@example.org=ada@example.org+ben@example.org"
ROLE_FOLDER = "Roles/abuse"


def _cfg(**over) -> Config:
    env = {"POSTERN_API_URL": "https://x"}
    env.update(over)
    return Config.from_env(env)


def _per_account(**over) -> Config:
    return _cfg(
        POSTERN_IMAP_VIEWER_MODE="per_account",
        POSTERN_IMAP_VIEWER_DOMAIN="example.org",
        **over,
    )


def _role_message(message_id="r1", **over):
    m = make_message(message_id, direction="inbound", seen=False, **over)
    m["to"] = ROLE
    m["deliveredTo"] = [ROLE]
    return m


def _personal_message(message_id="p1", addr="ada@example.org", **over):
    m = make_message(message_id, direction="inbound", seen=False, **over)
    m["to"] = addr
    m["deliveredTo"] = [addr]
    return m


class ConfigRolesTest(unittest.TestCase):
    def test_estate_default_has_no_roles(self):
        self.assertEqual(_cfg().viewer_roles, {})

    def test_parses_lowercases_and_tolerates_whitespace(self):
        cfg = _per_account(
            POSTERN_IMAP_VIEWER_ROLES=" Abuse@Example.ORG = Ada@example.org + ben@example.org ,"
            " security@example.org=ada@example.org "
        )
        self.assertEqual(
            cfg.viewer_roles,
            {
                "abuse@example.org": ("ada@example.org", "ben@example.org"),
                "security@example.org": ("ada@example.org",),
            },
        )

    def test_duplicate_member_is_collapsed_not_duplicated(self):
        cfg = _per_account(
            POSTERN_IMAP_VIEWER_ROLES="abuse@example.org=ada@example.org+ada@example.org"
        )
        self.assertEqual(cfg.viewer_roles, {"abuse@example.org": ("ada@example.org",)})

    def test_malformed_shapes_are_loud(self):
        bad = [
            "noequals",
            "abuse@example.org=",
            "=ada@example.org",
            "abuse@example.org=ada",
            "abuse=ada@example.org",
            "abuse@example.org=ada@example.org,abuse@example.org=ben@example.org",
            "abuse@example.org=abuse@example.org",
            "abuse@example.org=ada@example.org,security@example.org=abuse@example.org",
            "abuse@example.org=ada@example.org,abuse@other.test=ben@example.org",
        ]
        for raw in bad:
            with self.assertRaises(ConfigError, msg=raw):
                _per_account(POSTERN_IMAP_VIEWER_ROLES=raw)

    def test_roles_without_per_account_is_loud(self):
        # Estate mode has no viewer address to check membership against, so a role map
        # there would look configured and silently do nothing. Refuse at startup.
        with self.assertRaises(ConfigError):
            _cfg(POSTERN_IMAP_VIEWER_ROLES=ROLES)

    def test_folder_name_is_the_local_part(self):
        self.assertEqual(role_folder_name(ROLE), ROLE_FOLDER)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class RoleFolderVisibilityTest(unittest.TestCase):
    def _acct(self, login, msgs=None, **over):
        from posternimap.account import PosternAccount

        cfg = _per_account(POSTERN_IMAP_VIEWER_ROLES=ROLES, **over)
        transport = FakeTransport(msgs or [], expected_token="tok", page_size=50)
        acct = PosternAccount(cfg, login, "tok")
        acct._client = lambda: PosternClient("https://x", "tok", transport=transport)
        return acct, transport

    def _names(self, acct, wildcard="*"):
        return [name for name, _box in acct.listMailboxes("", wildcard)]

    def test_member_sees_the_role_folder_and_its_parent(self):
        acct, _ = self._acct("ada")
        names = self._names(acct)
        self.assertIn(ROLE_FOLDER, names)
        self.assertIn("Roles", names)

    def test_parent_is_noselect_and_not_selectable(self):
        acct, _ = self._acct("ada")
        parent = dict(acct.listMailboxes("", "*"))["Roles"]
        self.assertIn("\\Noselect", parent.getFlags())
        self.assertIn("\\HasChildren", parent.getFlags())
        self.assertEqual(parent.getHierarchicalDelimiter(), "/")
        # \\Noselect means exactly this: SELECT of the parent is refused.
        self.assertIsNone(acct.select("Roles"))

    def test_percent_wildcard_reaches_the_parent(self):
        # A strictly-conforming client whose discovery is LIST "" "%" does not cross
        # the "/" delimiter, so without the parent node it could never learn the
        # children exist. (This door matches a LIST wildcard with re.match, i.e.
        # prefix-anchored, inherited from the Twisted account model, so in practice
        # the children come back too. That looseness is pre-existing and deliberately
        # NOT changed here: tightening it would alter estate-mode LIST output, which
        # this change is required to keep byte-identical.)
        acct, _ = self._acct("ada")
        self.assertIn("Roles", self._names(acct, "%"))

    def test_non_member_sees_nothing_and_cannot_select(self):
        acct, _ = self._acct("carol")
        names = self._names(acct)
        self.assertNotIn(ROLE_FOLDER, names)
        self.assertNotIn("Roles", names)
        self.assertIsNone(acct.select(ROLE_FOLDER))
        self.assertFalse(acct.isSubscribed(ROLE_FOLDER))
        self.assertFalse(acct.isSubscribed("Roles"))

    def test_member_subscription_covers_folder_and_parent(self):
        acct, _ = self._acct("ada")
        self.assertTrue(acct.isSubscribed(ROLE_FOLDER))
        self.assertTrue(acct.isSubscribed("Roles"))

    def test_map_override_decides_membership_by_address(self):
        # Membership is keyed on the viewer ADDRESS, so a login repointed by the 1:1
        # VIEWER_MAP carries its role with it (and a login that is not repointed does
        # not accidentally inherit one).
        acct, _ = self._acct("ada2", POSTERN_IMAP_VIEWER_MAP="ada2=ada@example.org")
        self.assertIn(ROLE_FOLDER, self._names(acct))
        other, _ = self._acct("ada2")
        self.assertNotIn(ROLE_FOLDER, self._names(other))

    def test_role_lens_wiring(self):
        acct, _ = self._acct("ada")
        box = acct.select(ROLE_FOLDER)
        self.assertEqual(box._to, ROLE)  # membership filter: the ROLE address
        self.assertEqual(box._seen_for, "ada@example.org")  # read state: the member
        self.assertEqual(box._viewer, "ada@example.org")  # \\Seen writes carry for=V
        self.assertIsNone(box._from)
        # #403: the queue arrival view is the NAMED lens, never direction=inbound
        # (which is the stored wire fact and would drop same-domain sends to R).
        self.assertEqual(box._lens, "inbox")
        self.assertIsNone(box._direction)

    def test_personal_folders_are_untouched_by_roles(self):
        acct, _ = self._acct("ada")
        inbox = acct.select("INBOX")
        self.assertEqual(inbox._to, "ada@example.org")
        self.assertIsNone(inbox._seen_for)  # personal lens keys seen off `to`
        self.assertEqual(inbox._lens, "inbox")  # unchanged by #404
        self.assertIsNone(inbox._direction)

    def test_role_folder_uidvalidity_matches_the_arrival_views(self):
        # Role folders are arrival views (UID = messages.id), so they take the config
        # UIDVALIDITY as-is. Introducing them cannot invalidate any existing folder:
        # the names are new, and no existing folder value changes.
        acct, _ = self._acct("ada", POSTERN_IMAP_UIDVALIDITY="7")
        self.assertEqual(acct.select(ROLE_FOLDER).getUIDValidity(), 7)
        self.assertEqual(acct.select("INBOX").getUIDValidity(), 7)

    def test_fail_closed_when_viewer_underivable(self):
        # per_account with an underivable login already serves nothing; roles must not
        # be an exception, and membership is unanswerable without V anyway.
        acct, _ = self._acct("@host")
        self.assertEqual(acct.listMailboxes("", "*"), [])
        self.assertIsNone(acct.select(ROLE_FOLDER))
        self.assertIsNone(acct.select("INBOX"))

    def test_estate_mode_lists_exactly_the_historical_set(self):
        from posternimap.account import PosternAccount

        acct = PosternAccount(_cfg(), "conrad", "tok")
        self.assertEqual(
            sorted(name for name, _b in acct.listMailboxes("", "*")),
            ["All", "Archive", "Drafts", "INBOX", "Junk", "Notes", "Sent", "Trash"],
        )


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class RoleFolderBoundaryTest(unittest.TestCase):
    """The queue and the person are separate views, in BOTH directions."""

    def _shared(self, msgs):
        from posternimap.account import PosternAccount

        cfg = _per_account(POSTERN_IMAP_VIEWER_ROLES=ROLES)
        transport = FakeTransport(msgs, expected_token="tok", page_size=50)

        def acct(login):
            a = PosternAccount(cfg, login, "tok")
            a._client = lambda: PosternClient("https://x", "tok", transport=transport)
            return a

        return acct, transport

    def test_role_folder_holds_role_mail_only(self):
        acct, _ = self._shared([_role_message("r1"), _personal_message("p1")])
        box = acct("ada").select(ROLE_FOLDER)
        self.assertEqual(box.getMessageCount(), 1)
        self.assertEqual(box._summaries[0].message_id, "r1")

    def test_inbox_holds_personal_mail_only(self):
        acct, _ = self._shared([_role_message("r1"), _personal_message("p1")])
        box = acct("ada").select("INBOX")
        self.assertEqual(box.getMessageCount(), 1)
        self.assertEqual(box._summaries[0].message_id, "p1")

    def test_queue_sees_a_same_domain_send_delivered_to_it(self):
        # #403/#404: a colleague sending TO the queue from inside the domain is
        # stored direction=outbound. Reading the queue with direction=inbound would
        # drop it -- the fc#792 blindness class -- so the folder asks for lens=inbox.
        inbound_mail = _role_message("r1", subject="external report")
        same_domain = _role_message("r2", subject="internal escalation")
        same_domain["direction"] = "outbound"
        same_domain["from"] = "joan@example.org"
        acct, _ = self._shared([inbound_mail, same_domain])
        box = acct("ada").select(ROLE_FOLDER)
        self.assertEqual(box.getMessageCount(), 2)

    def test_queue_excludes_its_own_outbound_replies(self):
        # A reply sent AS the queue is the queue own Sent copy, not new queue mail.
        reply = _role_message("r2", subject="our reply")
        reply["direction"] = "outbound"
        reply["from"] = ROLE
        acct, _ = self._shared([_role_message("r1"), reply])
        box = acct("ada").select(ROLE_FOLDER)
        self.assertEqual(box.getMessageCount(), 1)
        self.assertEqual(box._summaries[0].message_id, "r1")

    def test_search_in_a_role_folder_scopes_to_the_role(self):
        msgs = [_role_message("r1", subject="widget outage")]
        acct, transport = self._shared(msgs)
        box = acct("ada").select(ROLE_FOLDER)
        box.getMessageCount()
        box.search_substr("subject", "widget", uid=False)
        substr = [u for u in transport.calls if "mode=substr" in u]
        self.assertTrue(substr, transport.calls)
        self.assertTrue(any("to=abuse%40example.org" in u for u in substr), substr)
        self.assertTrue(any("seenFor=ada%40example.org" in u for u in substr), substr)
        self.assertTrue(any("lens=inbox" in u for u in substr), substr)
        self.assertFalse(any("direction=" in u for u in substr), substr)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class RoleQueueSeenIsolationTest(unittest.TestCase):
    """Two members, one queue: "Ada read it" must not read as "the queue is handled"."""

    def setUp(self):
        from posternimap.account import PosternAccount

        self.msgs = [_role_message("r1")]
        self.cfg = _per_account(POSTERN_IMAP_VIEWER_ROLES=ROLES)
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=50)

        def acct(login):
            a = PosternAccount(self.cfg, login, "tok")
            a._client = lambda: PosternClient("https://x", "tok", transport=self.transport)
            return a

        self.acct = acct

    def _mark_read(self, login):
        from twisted.mail.imap4 import MessageSet

        box = self.acct(login).select(ROLE_FOLDER)
        self.assertEqual(box.getMessageCount(), 1)
        box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        return box

    def _unseen(self, login):
        box = self.acct(login).select(ROLE_FOLDER)
        box.getMessageCount()
        return box.getUnseenCount()

    def test_seen_write_carries_the_member_not_the_role(self):
        self._mark_read("ada")
        self.assertEqual(self.transport.last_seen_payload.get("for"), "ada@example.org")

    def test_control_the_fake_records_the_override_and_leaves_the_row_alone(self):
        # CONTROL for the isolation assertions below: if the fake did not record a
        # per-recipient override (the pre-#404 behavior, which flipped the row flag
        # whatever `for` said), every per-viewer assertion here would pass by
        # construction and prove nothing.
        self.assertEqual(self.transport.seen_overrides, {})
        self._mark_read("ada")
        self.assertEqual(
            self.transport.seen_overrides, {("r1", "ada@example.org"): True}
        )
        self.assertFalse(self.msgs[0]["seen"])  # row-level flag untouched

    def test_one_member_read_state_does_not_leak_to_the_other(self):
        self.assertEqual(self._unseen("ada"), 1)
        self.assertEqual(self._unseen("ben"), 1)
        self._mark_read("ada")
        self.assertEqual(self._unseen("ada"), 0)  # sticks for the reader
        self.assertEqual(self._unseen("ben"), 1)  # and only for the reader

    def test_negative_control_a_role_read_without_seen_for_is_blind_to_it(self):
        # Why seenFor exists at all (#404): the worker keys effective seen off the
        # membership filter by default, so a to=R read renders the QUEUE state and
        # never sees the (id, V) override the door just wrote. Without the decoupling
        # a member \\Seen would silently fail to stick on the next SELECT.
        self._mark_read("ada")
        client = PosternClient("https://x", "tok", transport=self.transport)
        queue_lens = client.list_messages(to=ROLE, direction="inbound")
        self.assertFalse(queue_lens.items[0].seen)
        member_lens = client.list_messages(
            to=ROLE, direction="inbound", seen_for="ada@example.org"
        )
        self.assertTrue(member_lens.items[0].seen)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class RoleQueueWritePostureTest(unittest.TestCase):
    """Read plus per-viewer \\Seen. Every other write refuses honestly, never silently."""

    def setUp(self):
        from posternimap.account import PosternAccount

        self.msgs = [_role_message("r1")]
        cfg = _per_account(POSTERN_IMAP_VIEWER_ROLES=ROLES)
        self.transport = FakeTransport(self.msgs, expected_token="tok", page_size=50)
        self.acct = PosternAccount(cfg, "ada", "tok")
        self.acct._client = lambda: PosternClient(
            "https://x", "tok", transport=self.transport
        )
        self.box = self.acct.select(ROLE_FOLDER)
        self.box.getMessageCount()

    def test_permanent_flags_advertise_seen_only(self):
        self.assertEqual(self.box.getPermanentFlags(), ["\\Seen"])

    def test_flagged_and_answered_are_refused(self):
        from posternimap.mailbox import ReadOnlyError
        from twisted.mail.imap4 import MessageSet

        for flag in ("\\Flagged", "\\Answered", "\\Deleted"):
            with self.assertRaises(ReadOnlyError, msg=flag):
                self.box.store(MessageSet(1, 1), [flag], 1, uid=False)

    def test_expunge_removes_nothing(self):
        self.assertEqual(self.box.expunge(), [])

    def test_move_out_of_the_queue_is_refused(self):
        from posternimap.mailbox import ReadOnlyError
        from twisted.mail.imap4 import MessageSet

        fetched = list(self.box.fetch(MessageSet(1, 1), uid=False))
        with self.assertRaises(ReadOnlyError):
            self.box.soft_move_fetched_messages(fetched, "trash")
        self.assertIsNone(self.msgs[0].get("mailbox"))  # store untouched

    def test_append_and_copy_into_the_queue_are_refused(self):
        self.assertEqual(self.acct.appendability(ROLE_FOLDER), "refuse")
        self.assertEqual(self.acct.copyability(ROLE_FOLDER), "placeholder")
        self.assertIsNone(self.acct.placement_mailbox(ROLE_FOLDER))


class ClientSeenForParamTest(unittest.TestCase):
    def _client(self):
        t = FakeTransport([make_message("m1", seen=False)], expected_token="t", page_size=2)
        return PosternClient("https://x", "t", transport=t), t

    def test_list_emits_seen_for_when_it_differs_from_to(self):
        c, t = self._client()
        c.list_messages(to=ROLE, seen_for="ada@example.org")
        self.assertTrue(any("seenFor=ada%40example.org" in u for u in t.calls), t.calls)

    def test_list_omits_seen_for_when_it_equals_to(self):
        # A personal lens keys seen off its own address: nothing extra on the wire, so
        # every pre-#404 call stays byte-identical.
        c, t = self._client()
        c.list_messages(to="ada@example.org", seen_for="ada@example.org")
        self.assertFalse(any("seenFor=" in u for u in t.calls), t.calls)

    def test_list_omits_seen_for_by_default(self):
        c, t = self._client()
        c.list_messages(to="ada@example.org")
        self.assertFalse(any("seenFor=" in u for u in t.calls), t.calls)

    def test_search_emits_seen_for_when_it_differs_from_to(self):
        c, t = self._client()
        c.search_page("hello", mode="substr", to=ROLE, seen_for="ada@example.org")
        self.assertTrue(any("seenFor=ada%40example.org" in u for u in t.calls), t.calls)

    def test_search_omits_seen_for_by_default(self):
        c, t = self._client()
        c.search_page("hello", mode="substr", to=ROLE)
        self.assertFalse(any("seenFor=" in u for u in t.calls), t.calls)


if __name__ == "__main__":
    unittest.main()

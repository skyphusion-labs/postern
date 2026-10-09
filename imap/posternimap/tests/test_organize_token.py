"""#686: the door presents its imap-scoped token for the organize routes.

#685 moved POST /api/messages/{seen,flags,move} to the `organize` scope. The door called
all three through `self._client`, which holds its PRIMARY token, and in the common
native/ldap/system configuration that token is the read-scoped service token. So `\\Seen`
stopped persisting and soft-move to Trash/Junk/Archive stopped working, with a worker 403
relayed through IMAP as the only clue.

The fix gives the mailbox an organize client beside its read client. Three states, and the
third is a judgement call this file documents by testing it:

  POSTERN_API_TOKEN_IMAP set
      That is the organize credential. This is the fix: the door picks the right token
      itself instead of an operator having to widen the door's primary read token.

  unset, auth_mode token/fixed
      The primary token is the END USER'S OWN credential (in token mode the IMAP password
      IS the Postern token), so it may legitimately be a `both` or `imap` token. Falling
      back to it keeps a working door working; the worker stays the authority on that
      token's scope.

  unset, auth_mode native/ldap/system
      The primary token is the DOOR-HELD service token, documented as the token the proxy
      reads the store with. Presenting it can only earn a 403, so the write is refused
      HERE, loudly, naming the variable to set. This is the one case where the door KNOWS
      its token is wrong, and it is the case #686 was filed about.

What this file deliberately does NOT do: fall back to the primary token on a 403. A silent
fallback turns a loud failure into a quiet one, and the token it would fall back to is
exactly the one the worker refuses. There is a test that no retry happens.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any, List, Optional, Tuple

from posternimap.client import PosternClient
from posternimap.config import SERVICE_TOKEN_MODES, Config
from posternimap.tests.fakes import (
    FakeTransport,
    _required_scope,
    _scope_satisfies,
    make_message,
)

try:
    from twisted.mail import imap4  # noqa: F401
    from twisted.mail.imap4 import MessageSet

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False

READ_TOKEN = "read-tok"
IMAP_TOKEN = "imap-tok"
REPO_ROOT = Path(__file__).resolve().parents[3]
ROUTES_PATH = REPO_ROOT / "contracts" / "api-routes.json"


def _cfg(*, auth_mode: str = "system", imap_token: Optional[str] = IMAP_TOKEN) -> Config:
    """A Config built directly, so the matrix can name a mode without also satisfying
    that mode's unrelated startup requirements (native wants a transport token, ldap
    wants a TLS URL). The only fields this decision reads are auth_mode and
    service_imap_token."""
    return Config(
        api_url="https://x",
        auth_mode=auth_mode,
        service_token=READ_TOKEN,
        service_imap_token=imap_token,
    )


def _worker(msgs=None, *, imap_scope: str = "imap") -> FakeTransport:
    """A scope-faithful fake worker with a SPLIT credential set: the primary token is
    read-scoped, exactly as native/ldap/system documents it, and the imap token carries
    `imap`. A door reaching for the wrong client gets the 403 production would give.

    `imap_scope` is a knob for one test only: setting it to "read" makes even the imap
    token insufficient, which is how the no-retry-on-403 case is driven."""
    return FakeTransport(
        msgs if msgs is not None else [make_message("m1", direction="inbound", seen=False)],
        expected_token=None,
        token_scopes={READ_TOKEN: "read", IMAP_TOKEN: imap_scope},
        page_size=50,
    )


def _acct(cfg: Config, transport: FakeTransport):
    """An account pointed at the fake, with the two clients the config implies.

    _imap_client returns None when the config has no imap token, mirroring production
    (account.py builds it from cfg.service_imap_token), so the refusal path is reached
    the same way a real door reaches it rather than by patching the decision itself.
    """
    from posternimap.account import PosternAccount

    acct: Any = PosternAccount(cfg, "ada", READ_TOKEN)
    acct._client = lambda: PosternClient("https://x", READ_TOKEN, transport=transport)
    acct._imap_client = lambda: (
        PosternClient("https://x", IMAP_TOKEN, transport=transport)
        if cfg.service_imap_token
        else None
    )
    return acct


def _posts(transport: FakeTransport, path: str) -> List[Tuple[Any, ...]]:
    return [(m, p, t) for (m, p, t) in transport.auth_log if m == "POST" and p == path]


def _inbox(acct):
    box = acct.select("INBOX")
    box.getMessageCount()
    return box


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class OrganizeWritesPresentTheImapTokenTest(unittest.TestCase):
    """The fix: organize writes carry the imap token, reads carry the primary."""

    def test_seen_write_presents_the_imap_token(self):
        transport = _worker()
        box = _inbox(_acct(_cfg(), transport))
        box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        seen_posts = _posts(transport, "/api/messages/seen")
        self.assertEqual(len(seen_posts), 1, transport.auth_log)
        self.assertEqual(seen_posts[0][2], IMAP_TOKEN)

    def test_reads_still_present_the_PRIMARY_token(self):
        # The other half of the ask, and the one a careless fix breaks: swapping the
        # client wholesale would have moved the reads onto the imap token too.
        transport = _worker()
        box = _inbox(_acct(_cfg(), transport))
        box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        gets = [(m, p, t) for (m, p, t) in transport.auth_log if m == "GET"]
        self.assertTrue(gets, transport.auth_log)
        for method, path, token in gets:
            self.assertEqual(token, READ_TOKEN, f"{method} {path} used the wrong token")

    def test_flag_write_presents_the_imap_token(self):
        transport = _worker()
        box = _inbox(_acct(_cfg(), transport))
        box.store(MessageSet(1, 1), ["\\Flagged"], 1, uid=False)
        flag_posts = _posts(transport, "/api/messages/flags")
        self.assertEqual(len(flag_posts), 1, transport.auth_log)
        self.assertEqual(flag_posts[0][2], IMAP_TOKEN)

    def test_answered_write_presents_the_imap_token(self):
        transport = _worker()
        box = _inbox(_acct(_cfg(), transport))
        box.store(MessageSet(1, 1), ["\\Answered"], 1, uid=False)
        self.assertEqual(_posts(transport, "/api/messages/flags")[0][2], IMAP_TOKEN)

    def test_soft_move_presents_the_imap_token(self):
        transport = _worker()
        box = _inbox(_acct(_cfg(), transport))
        fetched = list(box.fetch(MessageSet(1, 1), uid=False))
        box.soft_move_fetched_messages(fetched, "trash")
        move_posts = _posts(transport, "/api/messages/move")
        self.assertEqual(len(move_posts), 1, transport.auth_log)
        self.assertEqual(move_posts[0][2], IMAP_TOKEN)

    def test_the_write_actually_LANDS_in_the_store(self):
        # CONTROL on all of the above: asserting the token alone would pass for a door
        # that presented the right credential and still wrote nothing.
        msgs = [make_message("m1", direction="inbound", seen=False)]
        transport = _worker(msgs)
        box = _inbox(_acct(_cfg(), transport))
        box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertTrue(msgs[0]["seen"], "the \\Seen write did not reach the fake store")

    def test_a_move_actually_LANDS_in_the_store(self):
        msgs = [make_message("m1", direction="inbound", seen=False)]
        transport = _worker(msgs)
        box = _inbox(_acct(_cfg(), transport))
        fetched = list(box.fetch(MessageSet(1, 1), uid=False))
        box.soft_move_fetched_messages(fetched, "trash")
        self.assertEqual(msgs[0].get("mailbox"), "trash")


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class UnsetImapTokenFailsLoudlyTest(unittest.TestCase):
    """POSTERN_API_TOKEN_IMAP unset in a service-token mode: refuse, do not degrade."""

    def _refusing_box(self, auth_mode="system"):
        transport = _worker()
        box = _inbox(_acct(_cfg(auth_mode=auth_mode, imap_token=None), transport))
        return box, transport

    def test_seen_refuses_at_the_point_of_use(self):
        from posternimap.mailbox import OrganizeRejectedError

        box, transport = self._refusing_box()
        with self.assertRaises(OrganizeRejectedError) as caught:
            box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        message = str(caught.exception)
        # It has to NAME the variable. An operator reading a tagged NO has nothing else
        # to go on, and "403" was exactly the unhelpful answer this replaces.
        self.assertIn("POSTERN_API_TOKEN_IMAP", message)
        self.assertIn("system", message)
        # And it must be a tagged NO, not a protocol injection: this text reaches the
        # IMAP stream (see test_error_passthrough.py).
        self.assertNotIn("\r", message)
        self.assertNotIn("\n", message)

    def test_nothing_is_SENT_when_there_is_no_credential(self):
        # "Refuse at the point of use" means no request at all, not a request that 403s.
        # Sending the read token anyway would be the silent-degrade this forbids.
        box, transport = self._refusing_box()
        from posternimap.mailbox import OrganizeRejectedError

        with self.assertRaises(OrganizeRejectedError):
            box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertEqual(_posts(transport, "/api/messages/seen"), [], transport.auth_log)

    def test_the_store_is_left_UNTOUCHED_by_a_refused_write(self):
        msgs = [make_message("m1", direction="inbound", seen=False)]
        transport = _worker(msgs)
        box = _inbox(_acct(_cfg(imap_token=None), transport))
        from posternimap.mailbox import OrganizeRejectedError

        with self.assertRaises(OrganizeRejectedError):
            box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertFalse(msgs[0]["seen"])

    def test_flags_and_move_refuse_the_same_way(self):
        from posternimap.mailbox import OrganizeRejectedError

        box, transport = self._refusing_box()
        with self.assertRaises(OrganizeRejectedError):
            box.store(MessageSet(1, 1), ["\\Flagged"], 1, uid=False)
        box2, transport2 = self._refusing_box()
        fetched = list(box2.fetch(MessageSet(1, 1), uid=False))
        with self.assertRaises(OrganizeRejectedError):
            box2.soft_move_fetched_messages(fetched, "trash")
        self.assertEqual(_posts(transport, "/api/messages/flags"), [])
        self.assertEqual(_posts(transport2, "/api/messages/move"), [])

    def test_every_service_token_mode_refuses(self):
        from posternimap.mailbox import OrganizeRejectedError

        for mode in SERVICE_TOKEN_MODES:
            transport = _worker()
            box = _inbox(_acct(_cfg(auth_mode=mode, imap_token=None), transport))
            with self.assertRaises(OrganizeRejectedError, msg=mode) as caught:
                box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
            self.assertIn(mode, str(caught.exception))

    def test_READS_still_work_in_the_refusing_configuration(self):
        # CONTROL, and the important one: the refusal is scoped to three writes. A fix
        # that broke the door's reads would satisfy every assertion above.
        box, _transport = self._refusing_box()
        self.assertEqual(box.getMessageCount(), 1)
        fetched = list(box.fetch(MessageSet(1, 1), uid=False))
        self.assertEqual(len(fetched), 1)

    def test_an_APPEND_placement_refusal_keeps_the_APPEND_shape(self):
        # _append_placement converts the organize refusal to AppendRejectedError,
        # because APPEND's documented contract is persist-or-refuse in that shape
        # (#352 3.2). The reason text must survive the conversion.
        #
        # The refusal text here is a SENTINEL, not the production wording, and that is
        # the whole reliability of this test. The other exit from this method,
        # _import_or_reject, ALSO raises AppendRejectedError and ALSO names
        # POSTERN_API_TOKEN_IMAP, so asserting on the variable name would pass whether
        # or not the organize branch was ever reached. Only the sentinel distinguishes
        # them, and the APPEND payload below is built from the stored row so the
        # placement branch is the one taken (a non-matching payload falls through to
        # the import seam, which is how the first draft of this test passed for the
        # wrong reason).
        from posternimap.mailbox import AppendRejectedError, PosternMailbox

        sentinel = "ORGANIZE-REFUSAL-SENTINEL-686"
        stored = make_message("m1", direction="inbound", seen=False)
        transport = FakeTransport(
            [stored], expected_token=None, token_scopes={READ_TOKEN: "both"}, page_size=50
        )
        box = PosternMailbox(
            PosternClient("https://x", READ_TOKEN, transport=transport),
            mailbox_filter="trash",
            seen_writable=True,
            flags_writable=True,
            organize_refusal=sentinel,
        )
        raw = (
            "Message-ID: <%s>\r\nFrom: %s\r\nSubject: %s\r\n\r\n%s"
            % (stored["messageId"], stored["from"], stored["subject"], stored["bodyText"])
        ).encode("utf-8")
        # addMessage returns a Deferred, so the refusal arrives on the errback rather
        # than as a raise (the pattern test_mailbox.py uses for every APPEND refusal).
        errs: List[Any] = []
        box.addMessage(raw).addErrback(errs.append)
        self.assertEqual(len(errs), 1)
        self.assertTrue(errs[0].check(AppendRejectedError))
        self.assertIn(sentinel, str(errs[0].value))
        # And nothing was filed: the refusal replaced the move, it did not follow it.
        self.assertEqual(_posts(transport, "/api/messages/move"), [], transport.auth_log)
        self.assertIsNone(stored.get("mailbox"))

    def test_CONTROL_the_same_APPEND_SUCCEEDS_when_organize_is_available(self):
        # Without this, the test above could be passing because the payload never
        # reaches the placement branch at all. Same fixture, same payload, organize
        # available: the move must actually happen.
        from posternimap.mailbox import PosternMailbox

        stored = make_message("m1", direction="inbound", seen=False)
        transport = FakeTransport(
            [stored], expected_token=None, token_scopes={READ_TOKEN: "both"}, page_size=50
        )
        box = PosternMailbox(
            PosternClient("https://x", READ_TOKEN, transport=transport),
            mailbox_filter="trash",
            seen_writable=True,
            flags_writable=True,
        )
        raw = (
            "Message-ID: <%s>\r\nFrom: %s\r\nSubject: %s\r\n\r\n%s"
            % (stored["messageId"], stored["from"], stored["subject"], stored["bodyText"])
        ).encode("utf-8")
        out: List[Any] = []
        box.addMessage(raw).addCallback(out.append)
        self.assertEqual(out, [None], "the APPEND did not complete cleanly")
        self.assertEqual(len(_posts(transport, "/api/messages/move")), 1, transport.auth_log)
        self.assertEqual(stored.get("mailbox"), "trash")


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class TokenModeKeepsWorkingTest(unittest.TestCase):
    """token/fixed mode: the primary token is the USER'S own, so do not refuse it."""

    def _box(self, auth_mode, transport):
        return _inbox(_acct(_cfg(auth_mode=auth_mode, imap_token=None), transport))

    def test_token_mode_falls_back_to_the_primary_client(self):
        # The regression guard for a `both`-token door. In token mode the IMAP password
        # IS the Postern token, so refusing here would break doors that work today.
        msgs = [make_message("m1", direction="inbound", seen=False)]
        transport = FakeTransport(
            msgs, expected_token=None, token_scopes={READ_TOKEN: "both"}, page_size=50
        )
        box = self._box("token", transport)
        box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        seen_posts = _posts(transport, "/api/messages/seen")
        self.assertEqual(len(seen_posts), 1, transport.auth_log)
        self.assertEqual(seen_posts[0][2], READ_TOKEN)
        self.assertTrue(msgs[0]["seen"])

    def test_fixed_mode_falls_back_too(self):
        msgs = [make_message("m1", direction="inbound", seen=False)]
        transport = FakeTransport(
            msgs, expected_token=None, token_scopes={READ_TOKEN: "both"}, page_size=50
        )
        box = self._box("fixed", transport)
        box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertTrue(msgs[0]["seen"])

    def test_an_imap_token_still_WINS_in_token_mode_when_configured(self):
        # Falling back is what happens when there is nothing better, not a preference.
        transport = _worker()
        box = _inbox(_acct(_cfg(auth_mode="token"), transport))
        box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        self.assertEqual(_posts(transport, "/api/messages/seen")[0][2], IMAP_TOKEN)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class NoFallbackOnForbiddenTest(unittest.TestCase):
    def test_a_403_is_NOT_retried_with_the_primary_token(self):
        # The dispatch's hard line: no fallback to the primary token on a 403, because a
        # silent fallback turns a loud failure into a quiet one. Driven by giving the
        # imap token a scope that does not satisfy organize, so the write genuinely 403s.
        from posternimap.client import PosternError

        msgs = [make_message("m1", direction="inbound", seen=False)]
        transport = _worker(msgs, imap_scope="read")
        box = _inbox(_acct(_cfg(), transport))
        with self.assertRaises(PosternError):
            box.store(MessageSet(1, 1), ["\\Seen"], 1, uid=False)
        seen_posts = _posts(transport, "/api/messages/seen")
        # EXACTLY one attempt, and it carried the imap token. A second entry here, or a
        # first one carrying READ_TOKEN, would be the fallback this forbids.
        self.assertEqual(len(seen_posts), 1, transport.auth_log)
        self.assertEqual(seen_posts[0][2], IMAP_TOKEN)
        self.assertFalse(msgs[0]["seen"])


class FakeWorkerScopeTableIsPinnedToTheContractTest(unittest.TestCase):
    """The fake's scope table is a COPY of the worker's, and it forked.

    #685 moved seen/flags/move to `organize` and nothing moved the fake, so until #686
    the fake still demanded `read` on those three routes. Every door test asserting one
    of those writes therefore passed under a token the real worker refuses: a fake more
    permissive than the thing it stands in for.

    Fixing the rows alone would only reset the clock, so this pins the fake to the
    generated contract. The mechanism is the point, not the three rows.
    """

    def _routes(self):
        with open(ROUTES_PATH, encoding="utf-8") as fh:
            return json.load(fh)["routes"]

    def _scope_of(self, route_id: str) -> str:
        for row in self._routes():
            if row["id"] == route_id:
                return row["scope"]
        raise AssertionError(f"no route {route_id} in {ROUTES_PATH}")

    def test_CONTROL_the_contract_loads_and_is_not_empty(self):
        # Without this, every lookup below could be reading an empty file and the
        # assertions would be comparing nothing to nothing.
        routes = self._routes()
        self.assertGreater(len(routes), 20)
        self.assertEqual(self._scope_of("messages-list"), "read")

    def test_the_fake_demands_what_the_contract_declares(self):
        for method, path, route_id in [
            ("POST", "/api/messages/seen", "messages-seen"),
            ("POST", "/api/messages/flags", "messages-flags"),
            ("POST", "/api/messages/move", "messages-move"),
            ("GET", "/api/messages", "messages-list"),
            ("GET", "/api/search", "search"),
            ("GET", "/api/folders", "folders"),
            ("POST", "/api/imap/import", "imap-import"),
            ("GET", "/api/imap/roles", "imap-roles"),
        ]:
            self.assertEqual(
                _required_scope(method, path),
                self._scope_of(route_id),
                f"the fake and the contract disagree on {method} {path}",
            )

    def test_the_three_organize_routes_are_organize_and_NOT_read(self):
        # Stated as its own case so the regression has a name: this is the exact row
        # that was stale, and `read` here is what made the fake unable to see #686.
        for path in ("/api/messages/seen", "/api/messages/flags", "/api/messages/move"):
            self.assertEqual(_required_scope("POST", path), "organize", path)
            self.assertNotEqual(_required_scope("POST", path), "read", path)

    def test_the_fake_mirrors_the_worker_scope_matrix(self):
        # inbound/src/routes.ts scopeSatisfies, arm for arm. The imap -> organize arm is
        # the one this door depends on.
        self.assertTrue(_scope_satisfies("imap", "organize"))
        self.assertTrue(_scope_satisfies("organize", "organize"))
        self.assertTrue(_scope_satisfies("both", "organize"))
        self.assertFalse(_scope_satisfies("read", "organize"))
        self.assertFalse(_scope_satisfies("send", "organize"))
        self.assertFalse(_scope_satisfies("delete", "organize"))
        # One-way: an organize token reaches organize and nothing else.
        for need in ("read", "send", "delete", "imap", "admin"):
            self.assertFalse(_scope_satisfies("organize", need), need)
        # admin is satisfied only by both.
        self.assertTrue(_scope_satisfies("both", "admin"))
        self.assertFalse(_scope_satisfies("imap", "admin"))


if __name__ == "__main__":
    unittest.main()

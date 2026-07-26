"""Reading role membership FROM THE WORKER (#438).

#425 shipped the same membership twice: POSTERN_VIEWER_ROLES on the worker and
POSTERN_IMAP_VIEWER_ROLES on this door, one syntax, one refusal set, kept equal by hand.
Two configurations of one fact drift, and the drift is the exact divergence the feature
exists to close. The worker map is the single source now and the door reads it.

What has to hold, and is proven here rather than asserted in a comment:

  * STRUCTURE is validated, SEMANTICS are not re-derived. The worker owns the refusal set
    (a role that lists itself, an address that is both a queue and a person, ...) and an
    unusable config reaches this door as an EMPTY projection, so the door inherits the
    whole-map refusal. What the door checks is what the worker cannot: that the response
    has the shape folders get built from, and that two roles do not collide on one folder
    name. Either violation drops the WHOLE map, for the worker reason exactly.
  * FAIL CLOSED, EVERY WAY IT CAN FAIL. Unreachable, timed out, 403 from the wrong token,
    404 from a worker older than #438, or a body this door will not parse: all of them
    serve NO queue, and none of them is cached, so the next login retries.
  * AN EXPIRED MAP IS NOT A FALLBACK. The TTL is a REVOCATION bound: once it lapses, a
    refetch that fails must serve nothing rather than the membership it used to hold, or
    a member the operator removed keeps reading the queue indefinitely.
  * THE CREDENTIAL IS THE DOOR ONE. The map is read on the imap-scoped per-function token
    (#352), never the mailbox read token and never an admin token.
  * A WORKER OUTAGE COSTS THE QUEUE, NEVER THE MAILBOX. The account-level case at the
    bottom is the user-visible statement of all of the above.
"""

from __future__ import annotations

import json
import unittest
from typing import Any, List, Optional
from unittest import mock

from posternimap import roles
from posternimap.client import PosternClient
from posternimap.config import Config
from posternimap.roles import RolePayloadError, parse_role_payload, reset_cache, viewer_roles
from posternimap.tests.fakes import ErrorTransport, FakeTransport, make_message

try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False

ROLE = "abuse@example.org"
ADA = "ada@example.org"
BEN = "ben@example.org"
IMAP_TOKEN = "itok"
ROLE_FOLDER = "Roles/abuse"


def _cfg(**over) -> Config:
    env = {
        "POSTERN_API_URL": "https://x",
        "POSTERN_IMAP_VIEWER_MODE": "per_account",
        "POSTERN_IMAP_VIEWER_DOMAIN": "example.org",
        "POSTERN_API_TOKEN_IMAP": IMAP_TOKEN,
    }
    env.update(over)
    return Config.from_env(env)


def _payload(*entries) -> dict:
    return {"ok": True, "roles": [{"address": a, "members": list(m)} for a, m in entries]}


class RecordingTransport:
    """Answers with a canned body, recording the path AND the credential used.

    The credential is half the point: the map is an imap-seam read, so it must go out on
    the per-function door token, not on the mailbox read token the same account holds.
    """

    def __init__(self, payload: Any = None, status: int = 200) -> None:
        self.payload = _payload((ROLE, (ADA, BEN))) if payload is None else payload
        self.status = status
        self.calls: List[str] = []
        self.tokens: List[Optional[str]] = []

    def __call__(self, req):
        self.calls.append(req.full_url)
        auth = req.get_header("Authorization") or ""
        self.tokens.append(auth[len("Bearer "):] if auth.startswith("Bearer ") else None)
        if isinstance(self.payload, bytes):
            return self.status, self.payload
        return self.status, json.dumps(self.payload).encode()


class _Clock:
    """A monotonic clock a test can advance, so the TTL is exercised without sleeping."""

    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def monotonic(self) -> float:
        return self.now


def _client(transport, token: str = IMAP_TOKEN) -> PosternClient:
    return PosternClient("https://x", token, transport=transport)


class ParsePayloadTest(unittest.TestCase):
    def test_parses_the_canonical_projection(self):
        self.assertEqual(
            parse_role_payload(_payload((ROLE, (ADA, BEN)))),
            {ROLE: (ADA, BEN)},
        )

    def test_lowercases_trims_and_dedupes_members(self):
        parsed = parse_role_payload(
            {"ok": True, "roles": [{"address": " Abuse@Example.ORG ", "members": [" Ada@example.org ", ADA, BEN]}]}
        )
        self.assertEqual(parsed, {ROLE: (ADA, BEN)})

    def test_an_empty_map_is_the_normal_unconfigured_answer_not_an_error(self):
        self.assertEqual(parse_role_payload({"ok": True, "roles": []}), {})

    def test_structural_violations_drop_the_whole_map(self):
        bad = {
            "not an object": ["roles"],
            "no roles list": {"ok": True},
            "roles is not a list": {"ok": True, "roles": {"a": "b"}},
            "an entry is not an object": {"ok": True, "roles": ["abuse@example.org"]},
            "no address": {"ok": True, "roles": [{"members": [ADA]}]},
            "address is not a string": {"ok": True, "roles": [{"address": 7, "members": [ADA]}]},
            "address is not an address": {"ok": True, "roles": [{"address": "abuse", "members": [ADA]}]},
            "no members list": {"ok": True, "roles": [{"address": ROLE}]},
            "members is not a list": {"ok": True, "roles": [{"address": ROLE, "members": ADA}]},
            "a member is not a string": {"ok": True, "roles": [{"address": ROLE, "members": [7]}]},
            "a member is not an address": {"ok": True, "roles": [{"address": ROLE, "members": ["ada"]}]},
            "no members at all": {"ok": True, "roles": [{"address": ROLE, "members": []}]},
            "the role is listed twice": _payload((ROLE, (ADA,)), (ROLE, (BEN,))),
            "two roles share a local part": _payload((ROLE, (ADA,)), ("abuse@other.test", (BEN,))),
        }
        for name, payload in bad.items():
            with self.subTest(name), self.assertRaises(RolePayloadError):
                parse_role_payload(payload)

    def test_a_good_entry_beside_a_bad_one_is_dropped_too(self):
        # The worker rule, kept: half a membership map is indistinguishable from having
        # been taken off the queue, so a partly-usable map is no map.
        with self.assertRaises(RolePayloadError):
            parse_role_payload(_payload((ROLE, (ADA,)), ("security@example.org", ("nope",))))

    def test_POSITIVE_CONTROL_the_same_map_without_the_bad_entry_parses(self):
        self.assertEqual(
            parse_role_payload(_payload((ROLE, (ADA,)), ("security@example.org", (BEN,)))),
            {ROLE: (ADA,), "security@example.org": (BEN,)},
        )

    def test_the_semantic_refusals_stay_the_workers_and_are_not_re_derived(self):
        # A role listing itself is refused by inbound/src/roles.ts (proved in
        # inbound/roles.test.ts), so it never reaches this door as a map -- an unusable
        # config arrives as the EMPTY projection. Re-checking it here would rebuild the
        # second parser #438 exists to delete, and a second parser is exactly what drifts.
        # This test records that boundary deliberately; it is not an oversight.
        self.assertEqual(parse_role_payload(_payload((ROLE, (ROLE,)))), {ROLE: (ROLE,)})


class FetchTest(unittest.TestCase):
    def setUp(self):
        reset_cache()
        self.addCleanup(reset_cache)

    def test_reads_the_map_on_the_imap_scoped_door_token(self):
        t = RecordingTransport()
        self.assertEqual(viewer_roles(_cfg(), _client(t)), {ROLE: (ADA, BEN)})
        self.assertEqual(t.calls, ["https://x/api/imap/roles"])
        self.assertEqual(t.tokens, [IMAP_TOKEN])

    def test_caches_within_the_ttl_and_re_reads_after_a_reset(self):
        t = RecordingTransport()
        cfg = _cfg()
        self.assertEqual(viewer_roles(cfg, _client(t)), {ROLE: (ADA, BEN)})
        self.assertEqual(viewer_roles(cfg, _client(t)), {ROLE: (ADA, BEN)})
        self.assertEqual(len(t.calls), 1)  # one fetch per TTL for the whole door
        reset_cache()
        self.assertEqual(viewer_roles(cfg, _client(t)), {ROLE: (ADA, BEN)})
        self.assertEqual(len(t.calls), 2)  # CONTROL: the count can move

    def test_a_zero_ttl_reads_every_time(self):
        t = RecordingTransport()
        cfg = _cfg(POSTERN_IMAP_ROLES_TTL_SECONDS="0")
        viewer_roles(cfg, _client(t))
        viewer_roles(cfg, _client(t))
        self.assertEqual(len(t.calls), 2)

    def test_an_expired_map_is_re_read(self):
        t = RecordingTransport()
        cfg = _cfg(POSTERN_IMAP_ROLES_TTL_SECONDS="60")
        clock = _Clock()
        with mock.patch.object(roles, "time", clock):
            viewer_roles(cfg, _client(t))
            clock.now += 59
            viewer_roles(cfg, _client(t))
            self.assertEqual(len(t.calls), 1)  # still inside the TTL
            clock.now += 2
            viewer_roles(cfg, _client(t))
        self.assertEqual(len(t.calls), 2)

    def test_an_expired_map_is_NOT_a_fallback_when_the_re_read_fails(self):
        # The revocation bound. Serving the last known map here would keep a member the
        # operator removed reading the queue for as long as the worker stayed unreachable,
        # which is unbounded. Nothing is the only honest answer.
        t = RecordingTransport()
        cfg = _cfg(POSTERN_IMAP_ROLES_TTL_SECONDS="60")
        clock = _Clock()
        with mock.patch.object(roles, "time", clock):
            self.assertEqual(viewer_roles(cfg, _client(t)), {ROLE: (ADA, BEN)})
            clock.now += 61
            t.status = 500
            self.assertEqual(viewer_roles(cfg, _client(t)), {})
            # ... and the dead map is gone, not merely skipped this once.
            self.assertEqual(viewer_roles(cfg, _client(t)), {})

    def test_every_transport_failure_serves_nothing_and_caches_nothing(self):
        for status in (401, 403, 404, 500):
            with self.subTest(status=status):
                reset_cache()
                t = ErrorTransport(status=status)
                cfg = _cfg()
                self.assertEqual(viewer_roles(cfg, _client(t)), {})
                self.assertEqual(viewer_roles(cfg, _client(t)), {})
                # Not cached: a failure must be retried, never inherited by the next login.
                self.assertEqual(len(t.calls), 2)

    def test_a_body_this_door_will_not_parse_serves_nothing(self):
        for payload in (b"not json at all", {"ok": True}, _payload((ROLE, ("nope",)))):
            with self.subTest(repr(payload)[:40]):
                reset_cache()
                t = RecordingTransport(payload=payload)
                self.assertEqual(viewer_roles(_cfg(), _client(t)), {})

    def test_estate_mode_never_asks_the_worker(self):
        # Membership is unanswerable without a viewer address, so there is nothing for a
        # map to apply TO here. It still applies on the worker, where webmail reads it.
        t = RecordingTransport()
        cfg = Config.from_env({"POSTERN_API_URL": "https://x", "POSTERN_API_TOKEN_IMAP": IMAP_TOKEN})
        self.assertEqual(viewer_roles(cfg, _client(t)), {})
        self.assertEqual(t.calls, [])

    def test_per_account_without_the_imap_token_serves_nothing(self):
        # The named cost of gating the map on the least-privilege door token: a
        # deployment that wants role queues must provision it. Loud, and fail-closed.
        cfg = Config.from_env(
            {
                "POSTERN_API_URL": "https://x",
                "POSTERN_IMAP_VIEWER_MODE": "per_account",
                "POSTERN_IMAP_VIEWER_DOMAIN": "example.org",
            }
        )
        self.assertIsNone(cfg.service_imap_token)
        self.assertEqual(viewer_roles(cfg, None), {})


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class AccountDegradationTest(unittest.TestCase):
    """A worker that cannot answer about ROLES costs the queue, never the mailbox."""

    def setUp(self):
        reset_cache()
        self.addCleanup(reset_cache)
        from posternimap.account import PosternAccount

        message = make_message("p1", direction="inbound", seen=False)
        message["to"] = ADA
        message["deliveredTo"] = [ADA]
        self.mailbox_transport = FakeTransport([message], expected_token="tok", page_size=50)
        self.acct = PosternAccount(_cfg(), "ada", "tok")
        self.acct._client = lambda: _client(self.mailbox_transport, token="tok")

    def _names(self):
        return [name for name, _box in self.acct.listMailboxes("", "*")]

    def test_a_role_fetch_failure_hides_the_queue_and_leaves_the_mailbox_whole(self):
        self.acct._imap_client = lambda: _client(ErrorTransport(status=500))
        names = self._names()
        self.assertNotIn(ROLE_FOLDER, names)
        self.assertNotIn("Roles", names)
        self.assertIsNone(self.acct.select(ROLE_FOLDER))
        # The mailbox itself is untouched: this is an access failure, never a mail one.
        self.assertIn("INBOX", names)
        inbox = self.acct.select("INBOX")
        self.assertEqual(inbox.getMessageCount(), 1)

    def test_POSITIVE_CONTROL_the_same_account_serves_the_queue_when_the_worker_answers(self):
        self.acct._imap_client = lambda: _client(RecordingTransport())
        names = self._names()
        self.assertIn(ROLE_FOLDER, names)
        self.assertIn("Roles", names)
        self.assertIsNotNone(self.acct.select(ROLE_FOLDER))

    def test_no_synchronous_accessor_can_trigger_the_fetch_on_a_COLD_cache(self):
        # The reactor-safety invariant, enforced rather than argued (raised by rollins on
        # #457). Twisted wraps select and listMailboxes in maybeDeferred, so
        # ThreadedAccount runs those in the pool and a worker call there is correct. It
        # does NOT wrap these: they are answered inline on the REACTOR thread, so a fetch
        # reachable from one of them would be a new blocking call in exactly the place
        # #416 and #457 exist to keep clear. A WARM cache would hide that, so this drives
        # every one of them with a COLD cache and asserts the map was never asked for.
        transport = RecordingTransport()
        self.acct._imap_client = lambda: _client(transport)
        self.assertIsNone(self.acct._role_folders_cache)  # control: cold, not warm

        self.acct.isSubscribed(ROLE_FOLDER)
        self.acct.isSubscribed("Roles")
        self.acct.appendability(ROLE_FOLDER)
        self.acct.copyability(ROLE_FOLDER)
        self.acct.placement_mailbox(ROLE_FOLDER)
        self.acct.restore_direction(ROLE_FOLDER)
        self.acct.subscribe(ROLE_FOLDER)
        self.acct.unsubscribe(ROLE_FOLDER)
        self.acct.getPersonalNamespaces()
        self.assertEqual(transport.calls, [])
        self.assertIsNone(self.acct._role_folders_cache)

        # CONTROL: the pooled entry point DOES ask, so the zero above is a real refusal
        # to fetch and not a transport that records nothing.
        self._names()
        self.assertEqual(transport.calls, ["https://x/api/imap/roles"])

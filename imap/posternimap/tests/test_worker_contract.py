"""Cross-seam guard: what the DOOR emits, against the worker's own route table (#417).

Every suite in this repo used to mock its own idea of the worker: this package fakes
the API in tests/fakes.py, clients/python injects a fake transport, mcp fakes fetch. A
fake can never disagree with the client it was written beside, which is how the
published clients drifted a feature generation behind the worker with green CI.

This reads `inbound/route-table.json`, the projection of the worker's declared route
table (`inbound/src/routes.ts`). That table is not a second opinion:
`inbound/route-table.test.ts` proves every declared parameter is LIVE against the real
handler, proves the derived scope gate is equivalent to the if-chain it replaced, and
proves the committed JSON matches its source. So this file answers only:

  A. SOUNDNESS: does the door emit any path, method, parameter, or body key the worker
     does not route or read?
  B. PARITY: can the door still reach everything the worker honors on the surfaces the
     door actually owns?

The door is the client with the widest surface (it is the only one on the
/api/imap/* service seam), so it is the one whose drift would be least visible.

Skips cleanly when the worker tree is absent (the door ships as a container image with
no inbound/ beside it), so this is a source-checkout guard.
"""

from __future__ import annotations

import json
import unittest
import urllib.parse
from pathlib import Path
from typing import Any, Optional

from posternimap.client import PosternClient

# imap/posternimap/tests/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
ROUTES_PATH = REPO_ROOT / "contracts" / "api-routes.json"
PARAMS_PATH = REPO_ROOT / "contracts" / "api-params.json"
HAVE_TABLE = ROUTES_PATH.is_file() and PARAMS_PATH.is_file()
SKIP_REASON = "contracts/api-*.json are not in this tree: the cross-seam guard is source-checkout only"

ROUTES: list[dict[str, Any]] = (
    json.loads(ROUTES_PATH.read_text(encoding="utf-8"))["routes"] if HAVE_TABLE else []
)
PARAMS: dict[str, dict[str, Any]] = (
    json.loads(PARAMS_PATH.read_text(encoding="utf-8"))["params"] if HAVE_TABLE else {}
)


def match_route(method: str, path: str) -> Optional[dict[str, Any]]:
    """The matching rules api-routes.json documents, as any client implements them."""
    for row in ROUTES:
        if row["method"] != "ANY" and row["method"] != method:
            continue
        if row["match"] == "exact":
            hit = path == row["path"]
        elif row.get("exclude") and row["exclude"] in path:
            hit = False
        elif row.get("requireSeparator"):
            # The bare path or a child under it, never a SIBLING: /api/drafts2 is not
            # /api/drafts. The flag exists because a plain prefix cannot say that.
            hit = path == row["path"] or path.startswith(row["path"] + "/")
        else:
            least = 1 if row.get("requireChild") else 0
            hit = path.startswith(row["path"]) and len(path) - len(row["path"]) >= least
        if hit:
            return row
    return None


def accepted(row: Optional[dict[str, Any]], kind: str) -> set[str]:
    """The query/body names api-params.json declares for a matched route row."""
    if not row:
        return set()
    return set(PARAMS.get(row["id"], {}).get(kind) or [])


class RecordingTransport:
    """Records the door's requests. The door transport returns (status, body)."""

    def __init__(self) -> None:
        self.requests: list = []
        self.last_headers: dict[str, str] = {}

    def __call__(self, req):
        self.requests.append(req)
        return 200, b"{}"


def _emitted() -> list[dict[str, Any]]:
    """Drive every door method with every argument, and describe what went out.

    A client-side parse error on the stub response is swallowed: the request has
    already been recorded by then, and the contract under test is what the door PUT ON
    THE WIRE, not what it made of a canned reply. Anything that raises before emitting
    would show up as a missing call, which the control assertions below catch.
    """
    t = RecordingTransport()
    c = PosternClient("https://postern.example", "tok", transport=t)
    identity = "member@skyphusion.org"

    def run(fn):
        try:
            fn()
        except Exception:  # noqa: BLE001 - see the docstring: the wire is the contract
            pass

    # `to` and `seen_for` MUST differ here. The door sends seenFor ONLY when it differs
    # from `to` (deliberate, so every pre-#404 call stays byte-identical on the wire),
    # so a fixture where they match would capture no seenFor at all and the parity check
    # below would report a gap the door does not have. Same conditional shape for
    # `lens`, which the door sends instead of direction= for arrival views since #403.
    # A role folder is exactly the case that makes both fire, so the fixture is one.
    run(lambda: c.list_messages(
        to="role@skyphusion.org", seen_for=identity, from_addr="b@x.com", thread="t1",
        direction="inbound", mailbox="archive", q="hi", limit=5, cursor="c1",
    ))
    # lens and direction are mutually exclusive at the worker, so each gets its own call.
    run(lambda: c.list_messages(to="role@skyphusion.org", lens="inbox", seen_for=identity))
    run(lambda: c.search_page(
        "q", mode="substr", field="subject", direction="inbound", to="role@skyphusion.org",
        seen_for=identity, from_addr="b@x.com", mailbox="trash", cursor="c1", limit=5,
    ))
    run(lambda: c.search_page("q", lens="sent", to=identity))
    run(lambda: c.get_message("m1"))
    run(lambda: c.get_thread("t1"))
    run(lambda: c.get_attachment("m1", 0))
    run(lambda: c.get_folders(to=identity))
    run(lambda: c.set_seen(["m1"], True, identity))
    run(lambda: c.set_flags(["m1"], flagged=True, answered=True))
    run(lambda: c.move_messages(["m1"], "archive"))
    run(lambda: c.delete_message("m1"))
    run(lambda: c.list_imap_drafts(identity))
    run(lambda: c.get_imap_draft(identity, "d1"))
    run(lambda: c.create_imap_draft(identity, {"to": "a@x.com", "subject": "s", "bodyText": "t"}))
    run(lambda: c.update_imap_draft(identity, "d1", {"subject": "s2"}, updated_at="2026-07-26T00:00:00Z"))
    run(lambda: c.delete_imap_draft(identity, "d1"))
    run(lambda: c.import_message(identity, "sent", b"raw mime bytes"))
    run(lambda: c.get_roles())
    run(lambda: c.ping())

    out: list[dict[str, Any]] = []
    for req in t.requests:
        parts = urllib.parse.urlsplit(req.full_url)
        body: list[str] = []
        if req.data and (req.get_header("Content-type") or "").startswith("application/json"):
            payload = json.loads(req.data.decode("utf-8"))
            if isinstance(payload, dict):
                body = list(payload)
                nested = payload.get("set")
                if isinstance(nested, dict):
                    body += [f"set.{k}" for k in nested]
        out.append(
            {
                "method": req.get_method(),
                "path": parts.path,
                "query": sorted(set(urllib.parse.parse_qs(parts.query))),
                "body": body,
            }
        )
    return out


@unittest.skipUnless(HAVE_TABLE, SKIP_REASON)
class FixtureTest(unittest.TestCase):
    def test_the_table_loaded_and_carries_the_door_routes(self):
        self.assertGreater(len(ROUTES), 20)
        self.assertGreater(len(PARAMS), 10)
        for path in (
            "/api/messages", "/api/search", "/api/folders", "/api/imap/drafts",
            "/api/imap/import", "/api/imap/roles",
        ):
            self.assertTrue(any(r["path"] == path for r in ROUTES), f"{path} missing from the table")
        # The two files must JOIN, or every param lookup below silently returns empty.
        self.assertTrue(accepted(match_route("GET", "/api/imap/drafts"), "query"))
        self.assertTrue(accepted(match_route("POST", "/api/messages/seen"), "body"))

    def test_the_matcher_resolves_the_declared_shapes_and_can_miss(self):
        self.assertEqual(match_route("GET", "/api/messages")["id"], "messages-list")
        self.assertEqual(match_route("GET", "/api/imap/drafts")["scope"], "imap")
        self.assertEqual(match_route("PUT", "/api/imap/drafts/d1")["scope"], "imap")
        self.assertEqual(match_route("DELETE", "/api/messages/m1")["scope"], "delete")
        self.assertIsNone(match_route("GET", "/api/not-a-route"))
        self.assertIsNone(match_route("PUT", "/api/messages"))

    def test_the_role_map_is_read_on_the_imap_seam_not_the_operator_route(self):
        # #438: the door reads membership from the worker. It must land on the seam its
        # own least-privilege token opens, NOT on the operator /api/roles, which is admin
        # and would mean handing a proxy credential-provisioning and estate-delete power
        # to learn who is on a queue.
        self.assertEqual(match_route("GET", "/api/imap/roles")["scope"], "imap")
        self.assertEqual(match_route("GET", "/api/roles")["scope"], "admin")

    def test_the_imap_seam_is_its_own_scope(self):
        # The door holds an `imap` token for the service seam and a read/delete token
        # for the mailbox surface. If these ever collapsed into one scope, the door's
        # credential split would be silently meaningless.
        self.assertEqual(match_route("POST", "/api/imap/import")["scope"], "imap")
        self.assertEqual(match_route("GET", "/api/messages")["scope"], "read")
        self.assertEqual(match_route("POST", "/api/messages/seen")["scope"], "read")


@unittest.skipUnless(HAVE_TABLE, SKIP_REASON)
class SoundnessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.calls = _emitted()

    def test_driving_the_door_emitted_requests(self):
        self.assertGreater(len(self.calls), 15)
        self.assertTrue(any(c["path"].startswith("/api/imap/") for c in self.calls))
        # The door role read is on the wire here, so the soundness checks below cover it
        # rather than passing because nobody drove it (#438).
        self.assertTrue(any(c["path"] == "/api/imap/roles" for c in self.calls))

    def test_the_conditional_emissions_actually_fired(self):
        """seenFor and lens are sent CONDITIONALLY, so prove the fixture triggered them.

        Without this, a later edit that makes `to` equal `seen_for` would silently stop
        capturing seenFor, and the parity check would start reporting a gap the door
        does not have. Verified by mutation: setting to == seen_for makes this fail with
        "the fixture never made the door send seenFor", alongside the parity failure it
        is there to explain.
        """
        emitted = {name for c in self.calls for name in c["query"]}
        self.assertIn("seenFor", emitted, "the fixture never made the door send seenFor")
        self.assertIn("lens", emitted, "the fixture never made the door send lens")

    def test_every_emitted_path_and_method_is_routed(self):
        unrouted = [
            f"{c['method']} {c['path']}" for c in self.calls if match_route(c["method"], c["path"]) is None
        ]
        self.assertEqual([], unrouted)

    def test_every_emitted_query_parameter_is_read_on_that_route(self):
        bad = []
        for c in self.calls:
            allowed = accepted(match_route(c["method"], c["path"]), "query")
            bad += [f"{c['method']} {c['path']}?{n}=" for n in c["query"] if n not in allowed]
        self.assertEqual([], bad)

    def test_every_emitted_body_key_is_read_on_that_route(self):
        bad = []
        for c in self.calls:
            allowed = accepted(match_route(c["method"], c["path"]), "body")
            bad += [f"{c['method']} {c['path']} body.{k}" for k in c["body"] if k not in allowed]
        self.assertEqual([], bad)


@unittest.skipUnless(HAVE_TABLE, SKIP_REASON)
class ParityTest(unittest.TestCase):
    """Everything the worker honors on the door's own surfaces must be reachable.

    The door does not implement /api/send, /api/reply or the session-owned /api/drafts
    (it sends only through the structured API and has its own /api/imap/drafts seam),
    so those are out of scope here rather than silently counted as passing.
    """

    OWNED = ("messages-list", "search", "folders", "imap-drafts")

    # Worker filters the door deliberately does NOT push down, with the reason. IMAP
    # SEARCH criteria are evaluated by Twisted over the summaries already loaded for
    # the selected folder (server.py dispatches them; only a substring search goes
    # server-side via search_substr), so SINCE/BEFORE/UNSEEN/attachment predicates are
    # answered locally by design. This is an exclusion with a rationale, not a gap
    # ledger: if the door ever pushes one of these down, the stale check below fails
    # and the entry has to leave, so the exclusion cannot quietly outlive its reason.
    NOT_PUSHED_DOWN = {"search": {"after", "before", "hasAttachment", "seen"}}

    def setUp(self) -> None:
        self.calls = _emitted()

    def _reachable(self, path: str) -> set[str]:
        names: set[str] = set()
        for c in self.calls:
            if c["path"] == path or c["path"].startswith(path + "/"):
                names |= set(c["query"])
        return names

    def test_every_honored_query_parameter_on_a_door_surface_is_reachable(self):
        missing = {}
        for row in ROUTES:
            if row["id"] not in self.OWNED:
                continue
            declared = set(PARAMS.get(row["id"], {}).get("query") or [])
            excluded = self.NOT_PUSHED_DOWN.get(row["id"], set())
            gap = sorted(declared - self._reachable(row["path"]) - excluded)
            if gap:
                missing[row["id"]] = gap
        self.assertEqual({}, missing)

    def test_no_stale_exclusions(self):
        # An exclusion that the door now DOES send is stale, and a stale exclusion is
        # how a list like this rots into a permanent excuse.
        stale = {}
        for route_id, names in self.NOT_PUSHED_DOWN.items():
            path = next(r["path"] for r in ROUTES if r["id"] == route_id)
            now_sent = sorted(names & self._reachable(path))
            if now_sent:
                stale[route_id] = now_sent
        self.assertEqual({}, stale, "the door now sends these: delete them from NOT_PUSHED_DOWN")

    def test_the_exclusions_are_exactly_the_criteria_twisted_evaluates_locally(self):
        # Pin WHICH filters are excluded, so widening the exclusion is a deliberate,
        # reviewable edit rather than a quiet way to make this test pass.
        self.assertEqual({"search": {"after", "before", "hasAttachment", "seen"}}, self.NOT_PUSHED_DOWN)

    def test_control_the_parity_check_can_fail(self):
        self.assertNotIn("nOtApArAm", self._reachable("/api/messages"))
        self.assertTrue(self._reachable("/api/messages"), "no parameters recorded at all")


if __name__ == "__main__":
    unittest.main()

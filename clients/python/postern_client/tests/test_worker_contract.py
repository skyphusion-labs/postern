"""Cross-seam guard: what this client emits, against the worker's own route table.

The rest of the suite drives a FAKE transport, and a fake can never disagree with the
client it was written beside. That is exactly how postern-client drifted a full feature
generation behind the worker with green tests (#413).

This file closes that by reading `inbound/route-table.json`, the projection of the
worker's declared route table (`inbound/src/routes.ts`). That table is not a second
opinion: `inbound/route-table.test.ts` proves every declared parameter is LIVE against
the real handler (refused when bogus, or demonstrably changing the answer), proves the
derived scope gate is equivalent to the if-chain it replaced, and proves the committed
JSON matches the source. So here we only have to answer two questions:

  A. SOUNDNESS: does this client emit anything the worker does not route or read?
  B. PARITY: can this client reach everything the worker honors?

Both are hard failures for this package (it is at parity as of #413). The file skips
cleanly when the worker source is absent, because the published wheel ships neither
these tests nor the worker tree; it is a source-checkout guard (#417).
"""

from __future__ import annotations

import json
import unittest
import urllib.parse
from pathlib import Path
from typing import Any, Optional

from postern_client.client import OutboundAttachment, PosternClient

# clients/python/postern_client/tests/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
ROUTES_PATH = REPO_ROOT / "contracts" / "api-routes.json"
PARAMS_PATH = REPO_ROOT / "contracts" / "api-params.json"
HAVE_TABLE = ROUTES_PATH.is_file() and PARAMS_PATH.is_file()
SKIP_REASON = (
    "contracts/api-routes.json + api-params.json are not in this tree (installed "
    "package): the cross-seam guard is source-checkout only"
)

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
    """Records every emitted request and answers with an empty JSON object."""

    def __init__(self) -> None:
        self.requests: list = []

    def __call__(self, req):
        self.requests.append(req)
        return 200, {}, b"{}"


def _emitted() -> list[dict[str, Any]]:
    """Drive every client method with every argument, and describe what went out."""
    t = RecordingTransport()
    c = PosternClient("https://postern.example", "tok", transport=t)

    c.list_messages(
        to="a@x.com", from_addr="b@x.com", thread="t1", direction="inbound",
        mailbox="archive", seen_for="a@x.com", q="hi", limit=5, cursor="c1",
    )
    # lens is mutually exclusive with direction at the worker, so it gets its own call.
    c.list_messages(to="a@x.com", lens="inbox")
    c.search(
        "q", mode="substr", field="subject", direction="inbound", to="a@x.com",
        from_addr="b@x.com", mailbox="trash", seen_for="a@x.com", after="2026-01-01",
        before="2026-02-01", has_attachment=True, seen=False, limit=5, cursor="c1",
    )
    c.search("q", lens="sent", to="a@x.com")
    c.get_message("m1")
    c.get_thread("t1")
    c.get_attachment("m1", 0)
    c.get_folders(to="a@x.com")
    c.send(
        "a@x.com", "S", text="t", html="<p>t</p>", from_addr="me@x.com", reply_to="r@x.com",
        cc="c@x.com", bcc="b@x.com", headers={"X-Tag": "v"},
        attachments=[OutboundAttachment(content=b"z", filename="z.txt", mime_type="text/plain")],
        forward_message_id="orig",
    )
    c.reply(
        "m1", text="t", html="<p>t</p>", from_addr="me@x.com", cc="c@x.com", bcc="b@x.com",
        mode="replyAll", quote_original=True,
        attachments=[OutboundAttachment(content=b"z")],
    )
    c.set_seen(["m1"], True, for_addr="a@x.com")
    c.set_flags(["m1"], flagged=True, answered=True)
    c.move_messages(["m1"], "archive")
    c.delete_message("m1")
    c.list_drafts()
    c.get_draft("d1")
    c.create_draft(
        to="a@x.com", cc="c@x.com", bcc="b@x.com", subject="S", body_text="t",
        body_html="<p>t</p>", in_reply_to="orig", thread_id="t1", compose_mode="reply",
        source_message_id="orig",
    )
    c.update_draft("d1", subject="S", updated_at="2026-07-26T00:00:00Z")
    c.delete_draft("d1")
    c.send_draft("d1")
    c.list_draft_attachments("d1")
    c.add_draft_attachment("d1", b"bytes", filename="a.bin", mime_type="image/png")
    c.delete_draft_attachment("d1", "a1")

    out: list[dict[str, Any]] = []
    for req in t.requests:
        parts = urllib.parse.urlsplit(req.full_url)
        body: list[str] = []
        if req.data and req.get_header("Content-type") == "application/json":
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
    def test_the_table_loaded_and_carries_the_routes_we_key_on(self):
        self.assertGreater(len(ROUTES), 20)
        self.assertGreater(len(PARAMS), 10)
        for path in ("/api/send", "/api/reply", "/api/messages", "/api/search", "/api/folders", "/api/drafts"):
            self.assertTrue(any(r["path"] == path for r in ROUTES), f"{path} missing from the table")
        # The two files must JOIN, or every param lookup below silently returns empty.
        self.assertTrue(accepted(match_route("GET", "/api/messages"), "query"))
        self.assertTrue(accepted(match_route("POST", "/api/send"), "body"))

    def test_the_matcher_resolves_the_declared_shapes_and_can_miss(self):
        self.assertEqual(match_route("GET", "/api/messages")["id"], "messages-list")
        self.assertEqual(match_route("GET", "/api/messages/m1")["id"], "message-get")
        self.assertEqual(match_route("GET", "/api/messages/m1/attachments/0")["scope"], "read")
        self.assertEqual(match_route("DELETE", "/api/messages/m1")["scope"], "delete")
        self.assertEqual(match_route("POST", "/api/drafts/d1/send")["scope"], "send")
        # A miss is possible, so a passing match means something.
        self.assertIsNone(match_route("GET", "/api/not-a-route"))
        self.assertIsNone(match_route("PUT", "/api/messages"))


@unittest.skipUnless(HAVE_TABLE, SKIP_REASON)
class SoundnessTest(unittest.TestCase):
    """Everything the client emits must exist in the worker's table."""

    def setUp(self) -> None:
        self.calls = _emitted()

    def test_driving_the_client_emitted_requests(self):
        # Control: an empty emission set would make every check below vacuous.
        self.assertGreater(len(self.calls), 15)
        self.assertTrue(any(c["path"] == "/api/search" for c in self.calls))

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
    """Everything the worker honors must be reachable from this client.

    This package is at parity as of #413, so there is no gap ledger here: any gap is a
    failure. Asserted per ENDPOINT, because a merged set lets one endpoint cover for
    another and hides exactly the drift this exists to catch.
    """

    def setUp(self) -> None:
        self.calls = _emitted()

    def _reachable(self, path: str) -> set[str]:
        names: set[str] = set()
        for c in self.calls:
            if c["path"] == path:
                names |= set(c["query"])
        return names

    def test_every_honored_query_parameter_is_reachable(self):
        missing = {}
        for row in ROUTES:
            declared = set(PARAMS.get(row["id"], {}).get("query") or [])
            if not declared or row["match"] != "exact":
                continue
            if row["id"] in ("recipients-recent", "imap-drafts", "session", "smtp-auth"):
                continue  # not this client's surface: the door and webmail own those
            gap = sorted(declared - self._reachable(row["path"]))
            if gap:
                missing[row["path"]] = gap
        self.assertEqual({}, missing)

    def test_control_the_parity_check_can_fail(self):
        # A parameter the worker does not have must read as unreachable, so the empty
        # result above is a real pass and not a broken lookup.
        self.assertNotIn("nOtApArAm", self._reachable("/api/messages"))
        self.assertTrue(self._reachable("/api/messages"), "no parameters recorded at all")


if __name__ == "__main__":
    unittest.main()

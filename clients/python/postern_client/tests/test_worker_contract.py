"""Cross-seam guard: every name this client emits must exist in the worker source.

Why this file exists: the rest of the suite drives a FAKE transport, and a fake
can never disagree with the client. That is exactly how postern-client drifted a
full feature generation behind the worker with green tests (#413). These tests
read the ACCEPTED names straight out of `inbound/src/*.ts` and assert the client
emits only names the worker actually reads, so a worker-side rename or removal
fails here instead of silently becoming a dropped filter in production.

Scope: this is a name-level guard, not the full cross-seam contract harness
(#417 tracks that). It runs from a source checkout only; the published wheel
ships no tests and no worker source, so it skips cleanly when the worker tree is
absent rather than failing an installed-package test run.
"""

from __future__ import annotations

import json
import re
import unittest
import urllib.parse
from pathlib import Path
from typing import Optional

from postern_client.client import OutboundAttachment, PosternClient

# clients/python/postern_client/tests/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
API_TS = REPO_ROOT / "inbound" / "src" / "api.ts"
MAILBOX_TS = REPO_ROOT / "inbound" / "src" / "mailbox.ts"
TRANSPORT_TS = REPO_ROOT / "inbound" / "src" / "transport" / "index.ts"

HAVE_WORKER_SOURCE = API_TS.is_file() and MAILBOX_TS.is_file() and TRANSPORT_TS.is_file()
SKIP_REASON = "worker source not in this tree (installed package): cross-seam guard is source-checkout only"


class RecordingTransport:
    """Records every emitted request and answers with an empty JSON object."""

    def __init__(self) -> None:
        self.requests: list = []

    def __call__(self, req):
        self.requests.append(req)
        return 200, {}, b"{}"


def _accepted_query_params(source: str) -> set[str]:
    """Query parameter names the worker reads (searchParams.get / p.get)."""
    return set(re.findall(r'(?:searchParams|\bp)\.get\("([^"]+)"\)', source))


def _accepted_body_keys(source: str) -> set[str]:
    """JSON body keys the worker reads: body.x / raw.x plus draftInput's text("x")."""
    keys = set(re.findall(r"\b(?:body|raw)\.([A-Za-z_][A-Za-z0-9_]*)", source))
    keys |= set(re.findall(r'\btext\("([^"]+)"\)', source))
    return keys


def _interface_fields(source: str, name: str) -> set[str]:
    """Field names declared on a TypeScript interface."""
    match = re.search(r"export interface " + re.escape(name) + r" \{(.*?)\n\}", source, re.S)
    if not match:
        return set()
    return set(re.findall(r"^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:", match.group(1), re.M))


def _emitted(transport: RecordingTransport) -> tuple[set[str], set[str]]:
    """(query names, body keys) across every recorded request."""
    query: set[str] = set()
    body: set[str] = set()
    for names in _emitted_by_path(transport).values():
        query |= names
    for req in transport.requests:
        if req.data and req.get_header("Content-type") == "application/json":
            payload = json.loads(req.data.decode("utf-8"))
            if isinstance(payload, dict):
                body |= set(payload.keys())
                nested = payload.get("set")
                if isinstance(nested, dict):
                    body |= set(nested.keys())
    return query, body


def _emitted_by_path(transport: RecordingTransport) -> dict[str, set[str]]:
    """Query names per endpoint path.

    Per-PATH, deliberately: a union across every call hides exactly the defect
    this guards (a filter the worker honors on /api/search but that only
    /api/messages can send stays invisible in a merged set).
    """
    by_path: dict[str, set[str]] = {}
    for req in transport.requests:
        parts = urllib.parse.urlsplit(req.full_url)
        by_path.setdefault(parts.path, set()).update(urllib.parse.parse_qs(parts.query).keys())
    return by_path


def _drive_reads(client: PosternClient) -> None:
    """Every read call with EVERY optional filter populated, so nothing is missed."""
    client.list_messages(
        to="a@x.com",
        from_addr="b@x.com",
        thread="t1",
        direction="inbound",
        mailbox="archive",
        seen_for="a@x.com",
        q="hi",
        limit=5,
        cursor="c1",
    )
    # lens is mutually exclusive with direction at the worker, so it gets its own call.
    client.list_messages(to="a@x.com", lens="inbox")
    client.search(
        "q",
        mode="substr",
        field="subject",
        direction="inbound",
        to="a@x.com",
        from_addr="b@x.com",
        mailbox="trash",
        seen_for="a@x.com",
        after="2026-01-01",
        before="2026-02-01",
        has_attachment=True,
        seen=False,
        limit=5,
        cursor="c1",
    )
    client.search("q", lens="sent", to="a@x.com")
    client.get_folders(to="a@x.com")


def _drive_state_writes(client: PosternClient) -> None:
    client.set_seen(["m1"], True, for_addr="a@x.com")
    client.set_flags(["m1"], flagged=True, answered=True)
    client.move_messages(["m1"], "archive")


def _drive_drafts(client: PosternClient) -> None:
    client.create_draft(
        to="a@x.com",
        cc="c@x.com",
        bcc="b@x.com",
        subject="S",
        body_text="t",
        body_html="<p>t</p>",
        in_reply_to="orig",
        thread_id="t1",
        compose_mode="reply",
        source_message_id="orig",
    )
    client.update_draft("d1", subject="S", updated_at="2026-07-26T00:00:00Z")


@unittest.skipUnless(HAVE_WORKER_SOURCE, SKIP_REASON)
class QueryParamContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.accepted = _accepted_query_params(API_TS.read_text(encoding="utf-8"))

    def test_extraction_found_the_worker_parameters(self):
        # Positive control: a broken regex would make every subset assertion below
        # pass vacuously against an empty set. These names are read by api.ts today.
        self.assertGreater(len(self.accepted), 5)
        for name in ("direction", "lens", "mailbox", "seenFor", "field", "cursor", "limit", "to", "from"):
            self.assertIn(name, self.accepted, f"api.ts no longer reads the {name} query parameter")

    def test_extraction_can_fail(self):
        # Mutation check: the guard rejects a name the worker does not read, so a
        # passing subset assertion means something.
        self.assertNotIn("nOtAwOrKeRpArAm", self.accepted)

    def test_every_emitted_query_param_is_read_by_the_worker(self):
        t = RecordingTransport()
        client = PosternClient("https://postern.example", "tok", transport=t)
        _drive_reads(client)
        _drive_state_writes(client)
        _drive_drafts(client)
        emitted, _ = _emitted(t)
        self.assertTrue(emitted, "the read calls emitted no query parameters at all")
        self.assertEqual(
            set(),
            emitted - self.accepted,
            "client sends query parameters inbound/src/api.ts does not read",
        )

    def test_the_full_honored_filter_set_is_reachable_on_each_endpoint(self):
        # The #413 defect in guard form: the worker honored filters the client had
        # no way to send. Asserted PER ENDPOINT, because a merged set lets one
        # endpoint cover for another and hides the gap.
        t = RecordingTransport()
        client = PosternClient("https://postern.example", "tok", transport=t)
        _drive_reads(client)
        by_path = _emitted_by_path(t)
        expected = {
            "/api/messages": {
                "to", "from", "thread", "direction", "lens", "mailbox", "seenFor", "q", "limit", "cursor",
            },
            "/api/search": {
                "q", "mode", "field", "direction", "lens", "to", "from", "mailbox", "seenFor",
                "after", "before", "hasAttachment", "seen", "limit", "cursor",
            },
            "/api/folders": {"to"},
        }
        for path, names in expected.items():
            missing = names - by_path.get(path, set())
            self.assertEqual(set(), missing, f"{path} cannot send: {sorted(missing)}")


@unittest.skipUnless(HAVE_WORKER_SOURCE, SKIP_REASON)
class BodyKeyContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.accepted = _accepted_body_keys(API_TS.read_text(encoding="utf-8"))

    def test_extraction_found_the_worker_body_keys(self):
        self.assertGreater(len(self.accepted), 5)
        for name in ("ids", "seen", "for", "set", "mailbox", "updatedAt", "bodyText", "composeMode"):
            self.assertIn(name, self.accepted, f"api.ts no longer reads the {name} body key")

    def test_extraction_can_fail(self):
        self.assertNotIn("nOtAbOdYkEy", self.accepted)

    def test_state_write_and_draft_bodies_use_worker_keys(self):
        t = RecordingTransport()
        client = PosternClient("https://postern.example", "tok", transport=t)
        _drive_state_writes(client)
        _drive_drafts(client)
        _, emitted = _emitted(t)
        self.assertTrue(emitted, "the write calls emitted no JSON body keys at all")
        self.assertEqual(
            set(),
            emitted - self.accepted,
            "client sends body keys inbound/src/api.ts does not read",
        )


@unittest.skipUnless(HAVE_WORKER_SOURCE, SKIP_REASON)
class SendContractTest(unittest.TestCase):
    def setUp(self) -> None:
        source = MAILBOX_TS.read_text(encoding="utf-8")
        self.send_fields = _interface_fields(source, "SendRequest")
        self.reply_fields = _interface_fields(source, "ReplyRequest")
        self.attachment_fields = _interface_fields(
            TRANSPORT_TS.read_text(encoding="utf-8"), "OutboundAttachment"
        )

    def test_extraction_found_the_request_interfaces(self):
        for name in ("to", "subject", "text", "html", "attachments", "forwardMessageId"):
            self.assertIn(name, self.send_fields, f"SendRequest no longer declares {name}")
        for name in ("messageId", "mode", "quoteOriginal", "attachments"):
            self.assertIn(name, self.reply_fields, f"ReplyRequest no longer declares {name}")
        self.assertEqual(self.attachment_fields, {"filename", "mimeType", "content"})

    def test_send_body_keys_are_declared_on_send_request(self):
        t = RecordingTransport()
        client = PosternClient("https://postern.example", "tok", transport=t)
        client.send(
            "a@x.com",
            "S",
            text="t",
            html="<p>t</p>",
            from_addr="me@x.com",
            reply_to="r@x.com",
            cc="c@x.com",
            bcc="b@x.com",
            headers={"X-Tag": "v"},
            attachments=[OutboundAttachment(content=b"z", filename="z.txt", mime_type="text/plain")],
            forward_message_id="orig",
        )
        _, emitted = _emitted(t)
        self.assertEqual(set(), emitted - self.send_fields, "send emits keys SendRequest does not declare")

    def test_reply_body_keys_are_declared_on_reply_request(self):
        t = RecordingTransport()
        client = PosternClient("https://postern.example", "tok", transport=t)
        client.reply(
            "orig",
            text="t",
            html="<p>t</p>",
            from_addr="me@x.com",
            cc="c@x.com",
            bcc="b@x.com",
            mode="replyAll",
            quote_original=True,
            attachments=[OutboundAttachment(content=b"z")],
        )
        _, emitted = _emitted(t)
        self.assertEqual(set(), emitted - self.reply_fields, "reply emits keys ReplyRequest does not declare")

    def test_attachment_keys_match_the_worker_attachment_type(self):
        emitted = set(OutboundAttachment(content=b"z", filename="z.txt", mime_type="text/plain").to_json())
        self.assertEqual(emitted, self.attachment_fields)


@unittest.skipUnless(HAVE_WORKER_SOURCE, SKIP_REASON)
class RouteContractTest(unittest.TestCase):
    """Every path this client calls must be routed by api.ts."""

    def setUp(self) -> None:
        self.source = API_TS.read_text(encoding="utf-8")

    def _assert_routed(self, path: str, prefix: Optional[str] = None) -> None:
        needle = prefix or path
        self.assertIn(f'"{needle}"', self.source, f"api.ts does not route {needle}")

    def test_extraction_can_fail(self):
        self.assertNotIn('"/api/not-a-real-route"', self.source)

    def test_client_routes_exist(self):
        for path in (
            "/api/send",
            "/api/reply",
            "/api/messages",
            "/api/search",
            "/api/folders",
            "/api/messages/seen",
            "/api/messages/flags",
            "/api/messages/move",
            "/api/drafts",
        ):
            self._assert_routed(path)
        # Parametric paths are matched by prefix in api.ts, so assert the prefix.
        for prefix in ("/api/messages/", "/api/threads/", "/api/drafts/"):
            self._assert_routed(prefix)


if __name__ == "__main__":
    unittest.main()

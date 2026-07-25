"""#416 part 1: the door surfaces the worker reason instead of a bare status code.

The worker answers every failure with {ok: false, error, message}. The door parsed that
away, so an operator watching a mail client saw "Postern API error (HTTP 403)" where the
mailbox had already said "requires delete scope". Both sibling clients surface the body
(mcp safeErrorMessage, clients/python), so the door was the odd one out, and it is the
one a HUMAN reads.

Two properties carry this, and the second is the one worth the file: the reason reaches
the tagged NO, and it can NEVER carry the response stream with it. IMAP is line-oriented,
so a body with CR/LF spliced into a NO would inject a protocol line; the worker does not
emit one today, and the door refuses to depend on that, because the trust boundary is the
wire and not the implementation on the other side of it.
"""

from __future__ import annotations

import json
import unittest

from posternimap.client import (
    PosternAuthError,
    PosternClient,
    PosternError,
    _api_error,
    _safe_error_message,
    _wire_safe,
    _MAX_ERROR_DETAIL,
)


def body(**kw) -> bytes:
    payload = {"ok": False}
    payload.update(kw)
    return json.dumps(payload).encode("utf-8")


class SafeErrorMessageTest(unittest.TestCase):
    def test_prefers_message_then_error(self):
        self.assertEqual(
            _safe_error_message(body(error="forbidden", message="requires delete scope")),
            "requires delete scope",
        )
        self.assertEqual(_safe_error_message(body(error="E_NOT_FOUND")), "E_NOT_FOUND")

    def test_unparseable_or_empty_yields_no_detail_and_never_raises(self):
        for raw in (
            b"",
            b"not json at all",
            b"[1, 2, 3]",
            b"null",
            b"\xff\xfe\x00 invalid utf-8",
            body(),
            body(message="   "),
            body(message=42),
            json.dumps("a bare string").encode("utf-8"),
        ):
            self.assertEqual(_safe_error_message(raw), "", raw)


class WireSafetyTest(unittest.TestCase):
    def test_crlf_can_never_reach_the_imap_stream(self):
        detail = _safe_error_message(body(message="line one\r\nA001 OK injected\r\n"))
        self.assertNotIn("\r", detail)
        self.assertNotIn("\n", detail)
        self.assertEqual(detail, "line one A001 OK injected")

    def test_control_characters_and_runs_of_space_collapse(self):
        self.assertEqual(_wire_safe("a\tb\x00c   d"), "a b c d")

    def test_long_detail_is_truncated_to_the_cap(self):
        out = _wire_safe("x" * 500)
        self.assertEqual(len(out), _MAX_ERROR_DETAIL)
        self.assertTrue(out.endswith("..."))

    def test_a_clean_message_passes_through_unchanged(self):
        # POSITIVE CONTROL: sanitizing must not mangle the ordinary case, which is the
        # entire point of the change.
        self.assertEqual(_wire_safe("requires delete scope"), "requires delete scope")


class ApiErrorTest(unittest.TestCase):
    def test_status_and_reason(self):
        err = _api_error(403, body(error="forbidden", message="requires delete scope"))
        self.assertEqual(str(err), "Postern API error (HTTP 403): requires delete scope")
        self.assertEqual(err.status, 403)

    def test_falls_back_to_the_status_only_error_when_there_is_no_body(self):
        err = _api_error(502, b"")
        self.assertEqual(str(err), "Postern API error (HTTP 502)")
        self.assertEqual(err.status, 502)


class FailingTransport:
    """Answers every request with one status and one body (no routing, by design)."""

    def __init__(self, status: int, raw: bytes) -> None:
        self.status = status
        self.raw = raw
        self.last_headers: dict = {}

    def __call__(self, req):
        return self.status, self.raw


class ClientSurfacesTheReasonTest(unittest.TestCase):
    """Every non-401 failure path, since the defect was per-call-site, not central."""

    def client(self, status=403, raw=None):
        raw = body(error="forbidden", message="requires delete scope") if raw is None else raw
        return PosternClient(
            "https://postern.example", "tok", transport=FailingTransport(status, raw)
        )

    def assertReason(self, fn, *args, **kw):
        with self.assertRaises(PosternError) as ctx:
            fn(*args, **kw)
        self.assertIn("HTTP 403", str(ctx.exception))
        self.assertIn("requires delete scope", str(ctx.exception))
        return ctx.exception

    def test_get(self):
        self.assertReason(self.client().list_messages, limit=1)

    def test_get_raw_attachment(self):
        self.assertReason(self.client().get_attachment, "m1", 0)

    def test_post(self):
        self.assertReason(self.client().set_seen, ["m1"], True)

    def test_delete(self):
        # DELETE has its own 403 message (admin scope), so drive a different status
        # through the shared path and require the worker reason to arrive.
        c = PosternClient(
            "https://postern.example",
            "tok",
            transport=FailingTransport(502, body(error="E_UPSTREAM", message="upstream refused")),
        )
        with self.assertRaises(PosternError) as ctx:
            c.delete_message("m1")
        self.assertIn("HTTP 502", str(ctx.exception))
        self.assertIn("upstream refused", str(ctx.exception))

    def test_401_is_unchanged_and_still_its_own_type(self):
        # CONTROL: the auth error keeps its own message and class; #416 is about the
        # NON-401 failures, and an auth error must not start echoing a worker body.
        c = self.client(status=401)
        with self.assertRaises(PosternAuthError) as ctx:
            c.list_messages(limit=1)
        self.assertEqual(str(ctx.exception), "Postern API rejected the token")

    def test_a_bodyless_failure_still_raises_the_status_error(self):
        # CONTROL: the pre-#416 behavior is the floor, never a traceback.
        c = self.client(status=500, raw=b"")
        with self.assertRaises(PosternError) as ctx:
            c.list_messages(limit=1)
        self.assertEqual(str(ctx.exception), "Postern API error (HTTP 500)")


try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ReasonReachesTheTaggedNoTest(unittest.TestCase):
    """The point of the change: the reason has to reach the CLIENT, not just the log.

    A better exception string that the adapter layer swallows would be a change nobody
    can see from a mail client, which is where the complaint came from.
    """

    def test_a_failed_move_says_why(self):
        from twisted.mail.imap4 import MessageSet
        from posternimap.mailbox import PosternMailbox, ReadOnlyError
        from posternimap.tests.fakes import FakeTransport, make_message

        # A real listing (so the mailbox has a message to act on), then the SAME client
        # switched to a transport whose writes fail with a structured worker body.
        listing = FakeTransport([make_message("m1@x", subject="first")], expected_token="t")
        client = PosternClient("https://x", "t", transport=listing)
        mailbox = PosternMailbox(
            client, direction=None, page_size=2, seen_writable=True, flags_writable=True
        )
        mailbox.getMessageCount()
        fetched = mailbox.fetch(MessageSet(1, 1), uid=False)

        client._transport = FailingTransport(
            403, body(error="forbidden", message="requires delete scope")
        )
        with self.assertRaises(ReadOnlyError) as ctx:
            mailbox.soft_move_fetched_messages(fetched, "trash")
        # What an operator now reads in the tagged NO, instead of a bare HTTP 403.
        self.assertIn("requires delete scope", str(ctx.exception))
        self.assertIn("HTTP 403", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()

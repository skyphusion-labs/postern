"""#529 over BOTH engines: the worker's rfc822Project.ts and the door's rfc822.py
must render the SAME logical message to the SAME bytes.

WHY THIS TEST EXISTS AND WHAT IT IS NOT. #529 was a one-byte Date day-of-month skew
(the worker emitted "1 Aug", the door emitted "01 Aug") that shipped with both suites
green, because every existing "shared golden" test (test_rfc822.py
test_unicode_projection_sizes_match_worker_goldens / inbound/projected-size.test.ts
"matches Python golden sizes") only ever executes ONE engine and compares its output
to a hand-copied magic NUMBER in the OTHER language's test file. Both files agreeing
on a number proves the number was copied correctly; it does not prove the two
renderers agree with each other, and their existing fixtures all happen to use a
double-digit day (2026-06-18), so the skew was invisible to them by construction.

This test instead RUNS BOTH renderers, on the SAME input, in the SAME test process,
and asserts the actual output BYTES are identical -- not lengths, not hand-copied
numbers. inbound/scripts/render-golden.mjs is the seam: rfc822Project.ts has zero
imports of its own (no Workers bindings), so a plain `node` subprocess renders it
with no build step, no npm install, no wrangler, no vitest-pool-workers. See that
script's own header comment for the mechanics.

Attachments are rendered with ZERO-FILLED placeholder bytes on BOTH sides, matching
each engine's own size-projection convention exactly (project_rfc822_size here,
renderRfc822Projection's buildAttachment/base64Wire there) -- this is what makes a
byte comparison meaningful instead of merely a length comparison that could hide a
content-shape difference.

Runs under plain `python -m unittest` (no Twisted needed, matching the other pure
rfc822.py layer tests) as well as under trial. Skips cleanly (not silently in CI --
see .github/workflows/ci.yml, which pins Node for exactly this job) if `node` is not
on PATH.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import unittest
from pathlib import Path

from posternimap.client import Attachment, Message
from posternimap.rfc822 import render_rfc822

_INBOUND_DIR = Path(__file__).resolve().parents[3] / "inbound"
_GOLDEN_SCRIPT = _INBOUND_DIR / "scripts" / "render-golden.mjs"

_NODE = shutil.which("node")


def _render_ts(project_input: dict) -> bytes:
    """Render `project_input` through the REAL inbound/src/rfc822Project.ts."""
    proc = subprocess.run(
        [
            _NODE,
            "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
            str(_GOLDEN_SCRIPT),
            json.dumps(project_input),
        ],
        cwd=str(_INBOUND_DIR),
        capture_output=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise AssertionError(
            "render-golden.mjs failed (rc=%d): %s" % (proc.returncode, proc.stderr.decode(errors="replace"))
        )
    return base64.b64decode(proc.stdout.decode().strip())


def _render_py(message: Message) -> bytes:
    """Render the equivalent Message through the REAL imap/posternimap/rfc822.py,
    using the SAME zero-filled placeholder convention project_rfc822_size uses."""
    placeholders = [b"\0" * max(0, int(a.size)) for a in message.attachments] or None
    return render_rfc822(message, attachment_bytes=placeholders)


# One logical message per shape, expressed twice: once for each engine's own field
# names (TS: camelCase ProjectInput; Python: snake_case Message/Attachment). `date`
# is filled in per-case by the test (single-digit vs double-digit day) so the SAME
# four shapes exercise both.
def _shapes(date_iso: str, message_id: str):
    att = {"filename": "inv.pdf", "mime": "application/pdf", "size": 265}
    py_att = Attachment(filename=att["filename"], mime=att["mime"], size=att["size"])

    def py_msg(**over) -> Message:
        base = dict(
            message_id=message_id,
            direction="inbound",
            thread_id=message_id,
            from_addr="alice@example.com",
            to_addr="agent@skyphusion.org",
            subject="Hello",
            date=date_iso,
            in_reply_to=None,
            body_text="line one\nline two",
            trusted=True,
            received_at=date_iso,
            attachments=[],
        )
        base.update(over)
        return Message(**base)

    def ts_input(**over) -> dict:
        base = {
            "messageId": message_id,
            "from": "alice@example.com",
            "to": "agent@skyphusion.org",
            "subject": "Hello",
            "date": date_iso,
            "bodyText": "line one\nline two",
        }
        base.update(over)
        return base

    return {
        "plain": (py_msg(), ts_input()),
        "html": (
            py_msg(body_html="<p>hi</p>"),
            ts_input(bodyHtml="<p>hi</p>"),
        ),
        "attachment": (
            py_msg(attachments=[py_att]),
            ts_input(attachments=[att]),
        ),
        "html+attachment": (
            py_msg(body_html="<p>hi</p>", attachments=[py_att]),
            ts_input(bodyHtml="<p>hi</p>", attachments=[att]),
        ),
    }


@unittest.skipUnless(_NODE, "node not on PATH -- cannot run the TS engine for a cross-engine comparison")
class ProjectionCrossEngineByteEqualityTest(unittest.TestCase):
    def _assert_byte_identical(self, label: str, py_message: Message, ts_input: dict) -> None:
        py_bytes = _render_py(py_message)
        ts_bytes = _render_ts(ts_input)
        if py_bytes != ts_bytes:
            # A byte-level diff is far more useful here than assertEqual's default
            # bytes repr diff once the messages run past a couple hundred bytes.
            first_diff = next(
                (i for i in range(min(len(py_bytes), len(ts_bytes))) if py_bytes[i] != ts_bytes[i]),
                min(len(py_bytes), len(ts_bytes)),
            )
            window = slice(max(0, first_diff - 20), first_diff + 20)
            self.fail(
                "%s: engines disagree (py=%d bytes, ts=%d bytes), first diff at byte %d\n"
                "  py: %r\n  ts: %r"
                % (label, len(py_bytes), len(ts_bytes), first_diff, py_bytes[window], ts_bytes[window])
            )
        # Control: a byte-identical EMPTY render from both sides would pass the
        # comparison above trivially and prove nothing.
        self.assertGreater(len(py_bytes), 50, "%s: suspiciously short render" % label)

    def test_single_digit_day_every_shape(self):
        # The literal date class #529 broke: days 1-9 of the month.
        shapes = _shapes("2026-08-01T12:00:00Z", "single-digit-day")
        for label, (py_message, ts_input) in shapes.items():
            with self.subTest(shape=label):
                self._assert_byte_identical(label, py_message, ts_input)

    def test_double_digit_day_every_shape(self):
        # The class that was ALREADY covered by every existing fixture, and stayed
        # green throughout #529 -- kept here so a regression in the other direction
        # (e.g. someone "fixing" this by stripping the leading zero door-side) is
        # caught by the SAME test file, not assumed safe because it used to pass.
        shapes = _shapes("2026-08-15T12:00:00Z", "double-digit-day")
        for label, (py_message, ts_input) in shapes.items():
            with self.subTest(shape=label):
                self._assert_byte_identical(label, py_message, ts_input)


if __name__ == "__main__":
    unittest.main()

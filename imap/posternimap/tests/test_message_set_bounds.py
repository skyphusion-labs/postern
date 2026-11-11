"""A UID or sequence range is answered from the snapshot, not by counting every integer."""

from __future__ import annotations

import unittest

from twisted.mail import imap4

from posternimap.client import MessageSummary
from posternimap.mailbox import PosternMailbox


def _summary(uid: int) -> MessageSummary:
    return MessageSummary(
        uid=uid,
        message_id=f"m{uid}@example.com",
        direction="inbound",
        thread_id="t",
        from_addr="a@example.com",
        to_addr="b@example.com",
        subject="s",
        date="d",
        in_reply_to=None,
        trusted=False,
        received_at="r",
        attachment_count=0,
        seen=True,
    )


def _box(uids: list[int]) -> PosternMailbox:
    box = PosternMailbox(client=None, seen_writable=True)  # type: ignore[arg-type]
    box._loaded = True
    box._summaries = [_summary(u) for u in uids]
    return box


class _Walk(Exception):
    pass


def _wide(high: int = 4294967295) -> imap4.MessageSet:
    ms = imap4.MessageSet(1, high)
    steps = {"n": 0}

    def explode(prev):
        steps["n"] += 1
        if steps["n"] > 1000:
            raise _Walk("range was walked one number at a time")
        return prev + 1

    ms.getnext = explode
    return ms


class MessageSetBoundsTest(unittest.TestCase):
    def test_uid_fetch_uses_the_snapshot(self):
        box = _box([2, 10, 40])
        got = box.fetch(_wide(), uid=True)
        self.assertEqual([m.getUID() for _seq, m in got], [2, 10, 40])

    def test_sequence_fetch_uses_the_snapshot(self):
        box = _box([2, 10, 40])
        got = box.fetch(_wide(), uid=False)
        self.assertEqual(len(got), 3)

    def test_uid_store_uses_the_snapshot(self):
        box = _box([2, 10])
        stored = box.store(_wide(), ["\\Seen"], 1, True)
        self.assertEqual(set(stored), {1, 2})

    def test_sequence_store_uses_the_snapshot(self):
        box = _box([2, 10, 40])
        stored = box.store(_wide(), ["\\Seen"], 1, False)
        self.assertEqual(set(stored), {1, 2, 3})

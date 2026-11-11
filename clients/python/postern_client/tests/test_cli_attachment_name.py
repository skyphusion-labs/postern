"""Where `postern attachment` writes when -o is omitted.

The remote filename is only a hint. The CLI keeps a single path segment,
refuses an empty or hidden name, and does not replace a file that is already
there. -o still writes the path the caller named.
"""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from unittest import mock

from postern_client.cli import main
from postern_client.client import PosternClient
from postern_client.tests.test_client import FakeTransport


def _run(argv, transport):
    client = PosternClient("https://postern.example", "tok", transport=transport)
    out, err = io.StringIO(), io.StringIO()
    with mock.patch("postern_client.cli.from_env", return_value=client):
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
    return code, out.getvalue(), err.getvalue()


@contextmanager
def _cwd(path: str):
    prev = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(prev)


def _attachment(filename: str, body: bytes = b"payload-bytes") -> FakeTransport:
    disp = f'attachment; filename="{filename}"'
    return FakeTransport(
        status=200,
        headers={"Content-Type": "text/plain", "Content-Disposition": disp},
        body=body,
    )


class AttachmentNameTest(unittest.TestCase):
    def test_remote_name_is_only_a_basename(self):
        t = _attachment("../../outside.txt", b"new")
        with tempfile.TemporaryDirectory() as root:
            cwd = os.path.join(root, "a", "b")
            os.makedirs(cwd)
            outside = os.path.join(root, "outside.txt")
            with _cwd(cwd):
                code, _, err = _run(["attachment", "m1", "0"], t)
            self.assertEqual(code, 0, err)
            self.assertFalse(os.path.exists(outside))
            written = os.path.join(cwd, "outside.txt")
            self.assertTrue(os.path.isfile(written))
            with open(written, "rb") as fh:
                self.assertEqual(fh.read(), b"new")

    def test_hidden_remote_name_is_refused(self):
        t = _attachment(".bashrc", b"replaced\n")
        with tempfile.TemporaryDirectory() as root:
            kept = os.path.join(root, ".bashrc")
            with open(kept, "w", encoding="utf-8") as fh:
                fh.write("original\n")
            with _cwd(root):
                code, _, err = _run(["attachment", "m1", "0"], t)
            self.assertNotEqual(code, 0)
            self.assertIn("hidden", err.lower())
            with open(kept, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "original\n")

    def test_dot_remote_names_are_refused(self):
        for name in (".", ".."):
            t = _attachment(name, b"x")
            with tempfile.TemporaryDirectory() as root:
                with _cwd(root):
                    code, _, err = _run(["attachment", "m1", "0"], t)
                self.assertNotEqual(code, 0, name)
                self.assertTrue(err, name)
                self.assertEqual(os.listdir(root), [], name)

    def test_existing_file_is_not_replaced(self):
        t = _attachment("notes.txt", b"new")
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "notes.txt")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("keep")
            with _cwd(root):
                code, _, err = _run(["attachment", "m1", "0"], t)
            self.assertNotEqual(code, 0)
            self.assertIn("already exists", err)
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "keep")

    def test_output_flag_still_writes_the_chosen_path(self):
        t = _attachment(".bashrc", b"chosen-body")
        with tempfile.TemporaryDirectory() as root:
            kept = os.path.join(root, ".bashrc")
            with open(kept, "w", encoding="utf-8") as fh:
                fh.write("original\n")
            chosen = os.path.join(root, "chosen.bin")
            with _cwd(root):
                code, _, err = _run(["attachment", "m1", "0", "-o", chosen], t)
            self.assertEqual(code, 0, err)
            with open(kept, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "original\n")
            with open(chosen, "rb") as fh:
                self.assertEqual(fh.read(), b"chosen-body")

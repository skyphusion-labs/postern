"""Guard (INCIDENT postern#539): no string constant anywhere in this package may
contain a lone UTF-16 surrogate code point (U+D800..U+DFFF).

WHY THIS EXISTS. imap/posternimap/rfc822.py once carried, inside a plain (non-raw)
docstring, a literal backslash-u escape sequence meant to SHOW two backslash
escapes as visible text (documenting what compat32's surrogateescape handling
looks like on the wire). But a non-raw string interprets a backslash-u sequence
as an actual escape, not as the four characters it looks like, so the compiled
constant ended up holding two real, unpaired surrogate code points. CPython
3.13+ refuses to compile a module containing such a constant at all, so the
module could not even be imported. The `imap` CI job pinned Python 3.12 (which
still tolerated it), while the production image is built FROM python:3.14-slim,
so 686 passing trial tests and a clean mypy run said nothing about whether the
shipped image could import its own code, and it could not. Production doors
crashlooped on the v1.3.7 image roll as a direct result; see the incident issue
for the full timeline.

Ordinary source code cannot normally contain a lone surrogate without visibly
ugly escapes, so this is a narrow, high-signal check: it should never
legitimately fire, and a run that DOES find one is exactly this class of
latent, version-gated import crash, however innocent the source looks (this
file's own source was pure ASCII; nothing looked wrong on inspection, which is
precisely the danger).

NOTE ON THIS FILE'S OWN SOURCE: the "poisoned" string in the control test below
is built with chr(), never as a literal backslash-u escape sequence in source,
so this guard file cannot become a second instance of the exact bug it exists
to catch.

Runs under plain `python -m unittest` (no Twisted needed) as well as trial.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _lone_surrogates(text: str) -> str:
    """Every character in `text` that is a lone (unpaired) UTF-16 surrogate."""
    return "".join(ch for ch in text if 0xD800 <= ord(ch) <= 0xDFFF)


def _string_constants(tree: ast.AST):
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            yield node


class NoLoneSurrogatesInSourceTest(unittest.TestCase):
    def test_no_string_constant_contains_a_lone_surrogate(self):
        offenders = []
        py_files = sorted(_PACKAGE_ROOT.glob("**/*.py"))
        self.assertGreater(
            len(py_files), 10, "suspiciously few .py files found -- glob is probably wrong"
        )
        for path in py_files:
            source = path.read_text(encoding="utf-8", errors="surrogateescape")
            try:
                tree = ast.parse(source, filename=str(path))
            except SyntaxError as exc:
                self.fail("%s does not even parse: %s" % (path, exc))
            for node in _string_constants(tree):
                bad = _lone_surrogates(node.value)
                if bad:
                    offenders.append(
                        "%s:%d: string constant contains %d lone surrogate(s) (e.g. U+%04X)"
                        % (path.relative_to(_PACKAGE_ROOT.parent), node.lineno, len(bad), ord(bad[0]))
                    )
        self.assertEqual(
            offenders,
            [],
            "lone surrogate(s) in a compiled string constant -- this module CANNOT be "
            "imported on Python 3.13+ (postern#539): " + "; ".join(offenders),
        )

    def test_control_the_check_itself_can_fail(self):
        # A guard never seen red is not a guard. Prove the detector actually fires on
        # the EXACT shape that took production down, without touching the real source
        # and without writing a literal backslash-u escape in THIS file's own source
        # (chr() builds the surrogate at runtime, so this file stays import-safe on
        # every Python version regardless of what the assertion below is testing).
        poisoned = "prefix caf" + chr(0xDCC3) + chr(0xDCA9) + " suffix"
        tree = ast.parse("x = %r" % poisoned)
        found = [n for n in _string_constants(tree) if _lone_surrogates(n.value)]
        self.assertEqual(
            len(found), 1, "control failed: the detector did not fire on a known-bad constant"
        )


if __name__ == "__main__":
    unittest.main()

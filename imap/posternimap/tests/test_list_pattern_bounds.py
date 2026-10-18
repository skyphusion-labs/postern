"""LIST/LSUB pattern bounds: no wildcard pattern may stall the reactor (CWE-1333).

This is the class of CVE-2026-106454 / GHSA-8pqf-f4m5-798g ("Twisted: IMAP
wildcardToRegexp() ReDoS"). The upstream cause is NOT live on this door:
`imap4.wildcardToRegexp` has exactly one production call site in Twisted 26.4.0,
inside `MemoryAccountWithoutNamespaces.listMailboxes`, and `PosternAccount`
implements `imap4.IAccount` directly and does its own matching (#427). There is
no fixed Twisted release; OSV carries `last_affected: 26.4.0` and no `fixed`
event, so the pin cannot be bumped out of it.

What #427 did NOT bound is the wildcard COUNT. Each wildcard compiles to its own
lazy quantifier, so several of them matched against one name backtrack
combinatorially, and Twisted's reactor is single-threaded: that time is a stall
for every connected client, not only the caller.

These tests assert the bound, never the blowup. A test that actually triggered
catastrophic backtracking to prove backtracking exists would hang CI, which is a
worse defect than the one being fixed. The exact, fast check is that a refused
pattern never reaches `re.compile` at all.
"""

from __future__ import annotations

import re
import time
import unittest
from typing import Any, List, Tuple

from posternimap.client import PosternClient
from posternimap.config import Config
from posternimap.roles import reset_cache
from posternimap.tests.fakes import FakeTransport

try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False

ROLE_MAP = {"abuse@example.org": ("ada@example.org", "ben@example.org")}
ROLE_FOLDER = "Roles/abuse"
IMAP_TOKEN = "itok"

# Generous on purpose. The point is to exclude EXPONENTIAL cost, not to measure
# the runner: the shapes refused here cost 13s and up unbounded when compiled, so
# a 1s ceiling separates the two states by more than an order of magnitude while
# staying immune to a loaded GitHub-hosted runner.
_TIME_CEILING_S = 1.0


def _cfg(**over: str) -> Config:
    env = {"POSTERN_API_URL": "https://x"}
    env.update(over)
    return Config.from_env(env)


class _CompileSpy:
    """Records every pattern handed to re.compile, and delegates.

    A spy rather than a stub: it never changes behavior, so it cannot itself be
    the reason a case passes. Delegating also means an unexpected compile
    elsewhere in the window is recorded instead of crashing the test.
    """

    def __init__(self) -> None:
        self.patterns: List[str] = []
        self._real = re.compile

    def __enter__(self) -> "_CompileSpy":
        def spy(pattern: Any, flags: int = 0) -> Any:
            if isinstance(pattern, str):
                self.patterns.append(pattern)
            return self._real(pattern, flags)

        self._patched = spy
        re.compile = spy
        return self

    def __exit__(self, *exc: Any) -> None:
        re.compile = self._real


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ListPatternBoundsTest(unittest.TestCase):
    def _acct(self) -> Any:
        from posternimap.account import PosternAccount

        cfg = _cfg(
            POSTERN_IMAP_VIEWER_MODE="per_account",
            POSTERN_IMAP_VIEWER_DOMAIN="example.org",
            POSTERN_API_TOKEN_IMAP=IMAP_TOKEN,
        )
        reset_cache()
        transport = FakeTransport(
            [],
            expected_token="tok",
            token_scopes={"tok": "both", IMAP_TOKEN: "imap"},
            roles=ROLE_MAP,
            page_size=50,
        )
        acct = PosternAccount(cfg, "ada", "tok")
        acct._client = lambda: PosternClient("https://x", "tok", transport=transport)  # type: ignore[method-assign]
        acct._imap_client = lambda: PosternClient("https://x", IMAP_TOKEN, transport=transport)  # type: ignore[method-assign]
        return acct

    def _names(self, wildcard: str) -> List[str]:
        return [name for name, _box in self._acct().listMailboxes("", wildcard)]

    # --- the refusal ------------------------------------------------------

    # The counts below are LITERAL on purpose. Deriving them from _MAX_WILDCARDS
    # makes the test self-referential: raising the cap moves the test's own
    # goalposts and the suite stays green for exactly the regression that
    # matters (someone loosening the cap to settle a client complaint). This was
    # watched happening: a mutation setting the cap to 99 was PROVEN loaded and
    # the derived form of these two cases still passed.
    WILDCARD_HEAVY = "*********z"  # 9 wildcards

    def test_wildcard_heavy_pattern_is_refused(self) -> None:
        from posternimap.account import _list_pattern_refusal

        self.assertEqual(self.WILDCARD_HEAVY.count("*"), 9)
        self.assertIsNotNone(_list_pattern_refusal(self.WILDCARD_HEAVY))
        self.assertEqual(self._names(self.WILDCARD_HEAVY), [])

    def test_refused_pattern_never_reaches_re_compile(self) -> None:
        # The exact, fast check: not "it was quick", but "it was never compiled".
        with _CompileSpy() as spy:
            self.assertEqual(self._names(self.WILDCARD_HEAVY), [])
        for compiled in spy.patterns:
            self.assertNotIn("z", compiled, compiled)
        self.assertEqual([p for p in spy.patterns if p.count("(?:.*?)") > 4], [])

    def test_the_cap_is_pinned(self) -> None:
        # Pins the constants so loosening either one has to edit a test, where a
        # reviewer sees it, instead of passing silently. Change these only with
        # a fresh measurement of the backtracking cost in the commit message.
        from posternimap.account import _MAX_PATTERN_LEN, _MAX_WILDCARDS

        self.assertEqual(_MAX_WILDCARDS, 4)
        self.assertEqual(_MAX_PATTERN_LEN, 128)

    def test_an_allowed_pattern_does_reach_re_compile(self) -> None:
        # The positive control for the test above. Without it, that assertion
        # would also pass if listMailboxes compiled nothing for ANY pattern, or
        # if the spy were simply never installed.
        with _CompileSpy() as spy:
            self._names("INBOX")
        self.assertTrue(
            any("INBOX" in p for p in spy.patterns),
            "the spy observed no compile for an ALLOWED pattern, so its negative "
            "result on a refused pattern would prove nothing: %r" % (spy.patterns,),
        )

    def test_over_long_pattern_is_refused(self) -> None:
        from posternimap.account import _MAX_PATTERN_LEN, _list_pattern_refusal

        long_literal = "a" * (_MAX_PATTERN_LEN + 1)
        self.assertIsNotNone(_list_pattern_refusal(long_literal))
        self.assertEqual(self._names(long_literal), [])

    def test_refusal_is_deterministic_and_fast(self) -> None:
        over = self.WILDCARD_HEAVY
        results = []
        start = time.perf_counter()
        for _ in range(5):
            results.append(self._names(over))
        elapsed = time.perf_counter() - start
        self.assertEqual(results, [[]] * 5, "refusal is not deterministic")
        self.assertLess(elapsed, _TIME_CEILING_S, "refusal took %.3fs" % elapsed)

    def test_the_boundary_is_the_cap_itself(self) -> None:
        # At the cap the pattern is ALLOWED, one over it is refused. Without this
        # the suite would pass with the cap set to zero, which would refuse every
        # pattern and break folder listing entirely.
        from posternimap.account import _MAX_WILDCARDS, _list_pattern_refusal

        self.assertIsNone(_list_pattern_refusal("*" * _MAX_WILDCARDS))
        self.assertIsNotNone(_list_pattern_refusal("*" * (_MAX_WILDCARDS + 1)))

    # --- ordinary listing must not regress --------------------------------

    def test_legitimate_patterns_still_list(self) -> None:
        # The hierarchy delimiter on this door is "/" (getPersonalNamespaces
        # returns [["", "/"]]), so the one-level pattern is Roles/%, not Roles.%.
        self.assertIn("INBOX", self._names("*"))
        self.assertIn("Roles", self._names("%"))
        self.assertEqual(self._names("INBOX"), ["INBOX"])
        self.assertEqual(self._names("IN*"), ["INBOX"])
        self.assertEqual(self._names("Roles/%"), [ROLE_FOLDER])
        self.assertIn(ROLE_FOLDER, self._names("Roles/*"))

    def test_every_ascii_punctuation_character_stays_literal(self) -> None:
        # The property an allowlist of "safe" characters would be trying to buy.
        # #427 escapes per character, which is stronger than an allowlist (it
        # neutralises characters an allowlist author would forget), so assert the
        # PROPERTY: no punctuation character can act as regex syntax, and none of
        # them can make a pattern match a name it should not.
        for ch in "!\"#$&'()+,-.:;<=>?@[\\]^_`{|}~":
            pattern = "INBO" + ch
            self.assertEqual(self._names(pattern), [], "%r acted as syntax" % ch)
        # A metacharacter in the middle must not match the real name either.
        for pattern in ("IN.OX", "IN(BOX", "IN[BOX", "IN|Sent", "INBOX$", "^INBOX"):
            self.assertEqual(self._names(pattern), [], pattern)

"""Linear IMAP LIST glob (#761): identical to the old regex, without backtracking.

The #427/#759 matcher converted a glob to a backtracking regex. #761 replaces
the engine. The risk is a subtle semantic difference in how ``*`` and ``%``
treat the hierarchy delimiter, which IMAP (RFC 3501 6.3.8) defines differently
from shell globbing. The old matcher stays here as a reference oracle, and a
seeded corpus of pattern/name pairs asserts identical verdicts inside the
existing length and wildcard bounds.
"""

from __future__ import annotations

import random
import re
import time
import unittest
from collections.abc import Callable
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
IMAP_TOKEN = "itok"

# Seeded corpus. 5000 random pairs plus the handcrafted cases below; the
# random count is a literal so shrinking the corpus has to edit a test.
_CORPUS_SEED = 761
_CORPUS_RANDOM_PAIRS = 5000

# Generous on a loaded GitHub-hosted runner; the linear matcher finishes
# the pathological shape in milliseconds, so this is "well under a second".
_TIME_CEILING_S = 0.25

_Pair = Tuple[str, str, str]


def _old_wildcard_matcher(pattern: str, delim: str = "/") -> re.Pattern[str]:
    """The #427/#759 glob-to-regex converter, kept as the differential oracle.

    Copied verbatim from account.py as of #759. Not imported from production:
    the production function is gone, and importing a resurrected helper from
    the module under test would make this oracle a mirror of the new code.
    """
    parts = []
    for ch in pattern:
        if ch == "*":
            parts.append("(?:.*?)")
        elif ch == "%":
            parts.append("(?:[^" + re.escape(delim) + "]*?)")
        else:
            parts.append(re.escape(ch))
    return re.compile("".join(parts), re.I)


def _old_wildcard_match(pattern: str, name: str, delim: str = "/") -> bool:
    return _old_wildcard_matcher(pattern, delim).fullmatch(name) is not None


def _within_bounds(pattern: str) -> bool:
    from posternimap.account import _MAX_PATTERN_LEN, _MAX_WILDCARDS

    if len(pattern) > _MAX_PATTERN_LEN:
        return False
    return (pattern.count("*") + pattern.count("%")) <= _MAX_WILDCARDS


def _handcrafted_pairs() -> List[_Pair]:
    names = [
        "",
        "INBOX",
        "inbox",
        "Inbox",
        "Sent",
        "All",
        "Drafts",
        "Trash",
        "Junk",
        "Archive",
        "Notes",
        "Roles",
        "Roles/abuse",
        "Roles/abuse/x",
        "a/b/c",
        "/",
        "//",
        "*",
        "%",
        "IN.OX",
        "café",
        "CAFÉ",
        "邮箱",
        "📧folder",
        "日本語",
        "ß",
        "İ",
        "ı",
        "I",
        "i",
        "σ",
        "ς",
        "Σ",
        "a",
        "ab",
        "axb",
        "axbyc",
        "axc",
        "axxax",
        "x/x",
        "fooXbar",
        "\\",
        "[",
        ".",
        "^INBOX",
        "INBOX$",
    ]
    patterns = [
        "",
        "*",
        "%",
        "**",
        "%%",
        "*%",
        "%*",
        "%*%",
        "INBOX",
        "inbox",
        "IN",
        "IN*",
        "*BOX",
        "Roles/%",
        "Roles/*",
        "Roles/%/%",
        "IN.OX",
        "IN(BOX",
        "IN[BOX",
        "IN|Sent",
        "INBOX$",
        "^INBOX",
        "a%b",
        "a*b",
        "a%b%c",
        "%x%x",
        "*a",
        "a*",
        "foo*bar",
        "/",
        "\\",
        "[",
        ".",
        "café%",
        "日本語*",
        "ß",
        "İ",
        "Σ",
        "****",  # four wildcards, the cap itself
        "%%%%",
    ]
    meta = list("!\"#$&'()+,-.:;<=>?@[\\]^_`{|}~")
    patterns.extend("INBO" + ch for ch in meta)
    names.extend("INBO" + ch for ch in meta)
    pairs: List[_Pair] = []
    for delim in ("/", "."):
        for pattern in patterns:
            if not _within_bounds(pattern):
                continue
            for name in names:
                pairs.append((pattern, name, delim))
    return pairs


def _random_string(rng: random.Random, alphabet: str, max_len: int) -> str:
    n = rng.randint(0, max_len)
    return "".join(rng.choice(alphabet) for _ in range(n))


def _clip_to_bounds(pattern: str) -> str:
    from posternimap.account import _MAX_PATTERN_LEN, _MAX_WILDCARDS

    if len(pattern) > _MAX_PATTERN_LEN:
        pattern = pattern[:_MAX_PATTERN_LEN]
    out: List[str] = []
    wildcards = 0
    for ch in pattern:
        if ch in "*%":
            if wildcards >= _MAX_WILDCARDS:
                continue
            wildcards += 1
        out.append(ch)
    return "".join(out)


def _random_pairs(seed: int, count: int) -> List[_Pair]:
    rng = random.Random(seed)
    alphabet = (
        "abcABCxyzXYZ012INBOXrolesabuse"
        "*/%"
        ".[](){}+?|^$\\"
        "éß伊📧İıσςΣ"
        "/"
    )
    pairs: List[_Pair] = []
    while len(pairs) < count:
        pattern = _clip_to_bounds(_random_string(rng, alphabet, 24))
        # Inject up to four wildcards so the corpus is not mostly literals.
        if rng.random() < 0.6:
            chars = list(pattern)
            for _ in range(rng.randint(0, 4)):
                chars.insert(rng.randint(0, len(chars)), rng.choice("*%"))
            pattern = _clip_to_bounds("".join(chars))
        name = _random_string(rng, alphabet, 48)
        delim = rng.choice(("/", ".", "X"))
        pairs.append((pattern, name, delim))
    return pairs


def _corpus() -> List[_Pair]:
    return _handcrafted_pairs() + _random_pairs(_CORPUS_SEED, _CORPUS_RANDOM_PAIRS)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class LinearGlobMatchTest(unittest.TestCase):
    _match: Callable[[str, str, str], bool]

    def setUp(self) -> None:
        from posternimap.account import _wildcard_match

        self._match = _wildcard_match

    def test_star_crosses_the_delimiter_and_percent_does_not(self) -> None:
        self.assertTrue(self._match("*", "Roles/abuse", "/"))
        self.assertFalse(self._match("%", "Roles/abuse", "/"))
        self.assertTrue(self._match("%", "Roles", "/"))
        self.assertTrue(self._match("Roles/%", "Roles/abuse", "/"))
        self.assertFalse(self._match("Roles/%", "Roles/abuse/x", "/"))
        self.assertTrue(self._match("Roles/*", "Roles/abuse/x", "/"))

    def test_percent_honors_the_delimiter_argument(self) -> None:
        # If the advertised delimiter were ".", % would cross "/".
        self.assertFalse(self._match("%", "Roles/abuse", "/"))
        self.assertTrue(self._match("%", "Roles/abuse", "."))
        self.assertFalse(self._match("%", "Roles.abuse", "."))
        self.assertTrue(self._match("%", "Roles.abuse", "/"))

    def test_literals_are_literal_including_regex_metacharacters(self) -> None:
        self.assertFalse(self._match("IN.OX", "INBOX", "/"))
        self.assertTrue(self._match("IN.OX", "IN.OX", "/"))
        self.assertFalse(self._match("IN(BOX", "INBOX", "/"))
        self.assertFalse(self._match("IN[BOX", "INBOX", "/"))
        self.assertTrue(self._match("IN[BOX", "IN[BOX", "/"))

    def test_inbox_is_case_insensitive(self) -> None:
        self.assertTrue(self._match("inbox", "INBOX", "/"))
        self.assertTrue(self._match("INBOX", "inbox", "/"))

    def test_empty_pattern_matches_only_the_empty_name(self) -> None:
        self.assertTrue(self._match("", "", "/"))
        self.assertFalse(self._match("", "INBOX", "/"))
        self.assertTrue(self._match("*", "", "/"))
        self.assertTrue(self._match("%", "", "/"))

    def test_linear_matcher_agrees_with_regex_oracle_on_generated_corpus(self) -> None:
        pairs = _corpus()
        self.assertGreaterEqual(
            len(pairs),
            5000,
            "corpus shrank below the #761 floor: %d" % len(pairs),
        )
        self.assertEqual(len(_random_pairs(_CORPUS_SEED, _CORPUS_RANDOM_PAIRS)), 5000)
        disagreements: List[str] = []
        for pattern, name, delim in pairs:
            self.assertTrue(_within_bounds(pattern), pattern)
            got = self._match(pattern, name, delim)
            want = _old_wildcard_match(pattern, name, delim)
            if got != want:
                disagreements.append(
                    "pattern=%r name=%r delim=%r linear=%s oracle=%s"
                    % (pattern, name, delim, got, want)
                )
                if len(disagreements) >= 10:
                    break
        self.assertEqual(disagreements, [], "\n".join(disagreements))

    def test_pathological_glob_finishes_in_well_under_a_second(self) -> None:
        # Beyond the old bounds, calling the matcher directly. Many * and %
        # against a long non-matching name is the shape that made the
        # backtracking engine combinatorial; we do not run the oracle on it.
        from posternimap.account import _MAX_WILDCARDS

        pattern = "*%" * 40 + "z"
        name = ("a/" * 200) + "a"
        self.assertGreater(pattern.count("*") + pattern.count("%"), _MAX_WILDCARDS)
        self.assertGreater(len(pattern), 4)
        start = time.perf_counter()
        result = self._match(pattern, name, "/")
        elapsed = time.perf_counter() - start
        self.assertFalse(result)
        self.assertLess(
            elapsed,
            _TIME_CEILING_S,
            "pathological glob took %.3fs" % elapsed,
        )


def _cfg(**over: str) -> Config:
    env = {"POSTERN_API_URL": "https://x"}
    env.update(over)
    return Config.from_env(env)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ListGlobUsesNamespaceDelimiterTest(unittest.TestCase):
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

    def test_the_advertised_delimiter_is_slash(self) -> None:
        acct = self._acct()
        delim = acct.getPersonalNamespaces()[0][1]
        self.assertEqual(delim, "/")
        names = [name for name, _box in acct.listMailboxes("", "%")]
        self.assertIn("Roles", names)
        self.assertNotIn("Roles/abuse", names)

    def test_list_reads_the_delimiter_from_namespace(self) -> None:
        # Prove listMailboxes does not hardcode "/": when NAMESPACE advertises
        # ".", % may cross the slash that role folders actually use.
        acct = self._acct()
        acct.getPersonalNamespaces = lambda: [["", "."]]
        names = [name for name, _box in acct.listMailboxes("", "%")]
        self.assertIn("Roles/abuse", names)

"""LIST/LSUB mailbox-pattern matching, RFC 3501 6.3.8 (#427).

6.3.8 gives the mailbox pattern exactly TWO wildcards:

  *  matches zero or more characters, INCLUDING the hierarchy delimiter
  %  matches zero or more characters, EXCLUDING the hierarchy delimiter

Everything else in the pattern is a LITERAL character, and the pattern is matched
against the WHOLE mailbox name. Twisted's account model gave us neither half of
that: `imap4.wildcardToRegexp` substitutes the two wildcards but leaves every
other character to the regex engine, and `listMailboxes` applied the result with
`re.match`, which anchors at the START only. So `LIST "" "IN"` returned every
folder (IN is a prefix of INBOX), `LIST "" "%"` returned children below the
delimiter (the empty prefix of `Roles/abuse` satisfies the pattern), `IN.OX`
matched INBOX, and a pattern with an unbalanced paren raised re.error instead of
listing nothing.

Every case here was watched FAILING against the pre-#427 matcher, and the four
compliant behaviors (the * tree, the % parent, INBOX case-insensitivity, exact
literals) are the controls: they pass before and after, so the tightening cannot
be mistaken for having simply stopped matching things.
"""

from __future__ import annotations

import unittest

from posternimap.client import PosternClient
from posternimap.config import Config
from posternimap.tests.fakes import FakeTransport

try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False

ROLES = "abuse@example.org=ada@example.org+ben@example.org"
ROLE_FOLDER = "Roles/abuse"


def _cfg(**over) -> Config:
    env = {"POSTERN_API_URL": "https://x"}
    env.update(over)
    return Config.from_env(env)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ListWildcardMatchTest(unittest.TestCase):
    """The matcher itself, exercised through the real listMailboxes decision."""

    def _acct(self, login="ada", roles=True):
        from posternimap.account import PosternAccount

        over = {
            "POSTERN_IMAP_VIEWER_MODE": "per_account",
            "POSTERN_IMAP_VIEWER_DOMAIN": "example.org",
        }
        if roles:
            over["POSTERN_IMAP_VIEWER_ROLES"] = ROLES
        cfg = _cfg(**over)
        transport = FakeTransport([], expected_token="tok", page_size=50)
        acct = PosternAccount(cfg, login, "tok")
        acct._client = lambda: PosternClient("https://x", "tok", transport=transport)
        return acct

    def _names(self, wildcard, login="ada", roles=True):
        acct = self._acct(login, roles)
        return [name for name, _box in acct.listMailboxes("", wildcard)]

    # --- controls: the compliant behavior that must NOT change -------------

    def test_star_matches_the_whole_tree(self):
        names = self._names("*")
        self.assertIn("INBOX", names)
        self.assertIn("Sent", names)
        self.assertIn("Roles", names)
        self.assertIn(ROLE_FOLDER, names)

    def test_percent_still_reaches_the_parent_node(self):
        # The compliant half of the % rule: a client whose discovery is LIST "" "%"
        # must still see the Roles parent, or it could never learn the children
        # exist (that is why the \\Noselect node is published at all, #404).
        self.assertIn("Roles", self._names("%"))

    def test_exact_literal_name_matches_itself(self):
        self.assertEqual(self._names("INBOX"), ["INBOX"])
        self.assertEqual(self._names("Sent"), ["Sent"])
        self.assertEqual(self._names(ROLE_FOLDER), [ROLE_FOLDER])

    def test_inbox_is_case_insensitive(self):
        # Preserved from the inherited matcher (re.I). RFC 3501 5.1 makes INBOX
        # case-insensitive; our other names are fixed, so a case-insensitive match
        # is the pre-existing, unchanged behavior.
        self.assertEqual(self._names("inbox"), ["INBOX"])

    def test_star_suffix_and_prefix_patterns_still_work(self):
        self.assertEqual(self._names("IN*"), ["INBOX"])
        self.assertEqual(self._names("*BOX"), ["INBOX"])
        self.assertIn(ROLE_FOLDER, self._names("Roles/*"))

    # --- the deviations #427 fixes ----------------------------------------

    def test_prefix_of_a_name_is_not_a_match(self):
        # Was: every folder came back, because IN is a prefix of INBOX and re.match
        # never required the pattern to consume the whole name.
        self.assertEqual(self._names("IN"), [])
        self.assertEqual(self._names("Sen"), [])
        self.assertEqual(self._names("Role"), [])

    def test_percent_does_not_cross_the_delimiter(self):
        # Was: Roles/abuse came back for "%", because the empty prefix of the child
        # satisfied a non-delimiter-crossing class under an unanchored match.
        names = self._names("%")
        self.assertIn("Roles", names)
        self.assertNotIn(ROLE_FOLDER, names)

    def test_percent_matches_one_level_when_anchored_at_the_parent(self):
        # The other side of the same rule: Roles/% DOES reach the child, and only
        # the child level.
        self.assertEqual(self._names("Roles/%"), [ROLE_FOLDER])

    def test_regex_metacharacters_are_literal(self):
        # Was: `.` matched any character, so IN.OX listed INBOX; the parens and the
        # character class were regex syntax rather than literal name characters.
        for pattern in ("IN.OX", "INBO.", "Roles/(abuse)", "Roles/[a-z]buse", "IN|Sent"):
            self.assertEqual(self._names(pattern), [], pattern)

    def test_invalid_regex_syntax_lists_nothing_instead_of_raising(self):
        # Was: re.error escaped listMailboxes, so a client sending a paren got a
        # protocol error instead of an empty list.
        for pattern in ("IN(BOX", "INBOX)", "IN[BOX", "*+", "IN{1", "\\"):
            self.assertEqual(self._names(pattern), [], pattern)

    def test_star_is_not_swallowed_by_literal_escaping(self):
        # Guard against the obvious way to break this fix: escaping the pattern
        # wholesale would turn * and % into literals and LIST "" "*" would return
        # nothing at all.
        self.assertNotEqual(self._names("*"), [])
        self.assertNotEqual(self._names("%"), [])

    def test_estate_mode_matching_is_the_same_rule(self):
        # Estate mode (no per_account viewer, no role folders) shares the matcher;
        # the tightening is not per_account-only.
        names = self._names("IN", login="agent", roles=False)
        self.assertEqual(names, [])
        self.assertEqual(self._names("INBOX", login="agent", roles=False), ["INBOX"])

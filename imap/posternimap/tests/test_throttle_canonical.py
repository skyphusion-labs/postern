"""The throttle key is the identity the backend will check."""

from __future__ import annotations

import unittest

from posternimap.throttle import throttle_account, throttle_key


class ThrottleCanonicalTest(unittest.TestCase):
    def test_key_strips_the_same_prefix_the_worker_trims(self):
        self.assertEqual(throttle_key("\ufeffAlice"), "alice")
        self.assertEqual(throttle_key("  Alice@Example.ORG "), "alice@example.org")

    def test_system_mode_keys_the_local_part(self):
        self.assertEqual(throttle_account("system", "alice@a.example"), "alice")
        self.assertEqual(throttle_account("system", "Alice@b.example"), "alice")
        self.assertEqual(throttle_account("system", "\ufeffalice@c.example"), "alice")
        self.assertEqual(throttle_account("native", "alice@example.org"), "alice@example.org")

"""Integration: the REAL config -> account -> emit path lights the default sink.

The #138 read-path tests inject an already-ENABLED meter straight into the client
and mailbox. Nothing exercised the PRODUCTION path end to end:

    POSTERN_IMAP_MEASURE -> Config.from_env -> PosternAccount(Meter(cfg.measure))
        -> a real SELECT -> the DEFAULT twisted-log sink -> a `@measure` line.

That gap let #102 ship with the layer wired but never verified through the real
config-built meter and the real default sink (the go-live found the box emitting
nothing). These tests close it: with the flag on, a SELECT must emit a `cold_sync`
`@measure` line through the default sink; with the flag off, the same path stays
silent. Only the network is faked (FakeTransport); the meter, its construction from
config, and the sink are all the production objects.

NOTE: a green CI here does NOT prove the running box emits -- a stale deploy is
invisible to repo tests. The standing post-deploy emit-sanity in imap/DEPLOY.md is
the guard for that. This test guards the wiring against a code regression.
"""

from __future__ import annotations

import json
import unittest
from typing import Any, Dict, List, Tuple

try:
    from twisted.mail import imap4  # noqa: F401

    HAVE_TWISTED = True
except ImportError:
    HAVE_TWISTED = False

from posternimap.config import Config
from posternimap.tests.fakes import FakeTransport, make_message


def _capture_measure(test: unittest.TestCase) -> List[Dict[str, Any]]:
    """Attach a twisted log observer; return the list it collects events into."""
    from twisted.python import log

    captured: List[Dict[str, Any]] = []
    log.addObserver(captured.append)
    test.addCleanup(log.removeObserver, captured.append)
    return captured


def _measure_lines(captured: List[Dict[str, Any]]) -> List[Tuple[str, Dict[str, Any]]]:
    """Pull (event_name, fields) from every `@measure ...` line the sink wrote."""
    out: List[Tuple[str, Dict[str, Any]]] = []
    for e in captured:
        for part in (e.get("message") or ()):
            if isinstance(part, str) and part.startswith("@measure "):
                _tag, name, payload = part.split(" ", 2)
                out.append((name, json.loads(payload)))
    return out


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ConfigToEmitIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.token = "secret-tok-xyz789"
        # newest-first, as the API returns
        self.msgs = [
            make_message("m2", subject="second"),
            make_message("m1", subject="first"),
        ]
        self.transport = FakeTransport(self.msgs, expected_token=self.token, page_size=2)
        # Patch the account's client constructor to inject the fake transport while
        # keeping the account's OWN config-built meter. So the meter, its build from
        # cfg.measure, the account->mailbox threading, and the emit are all real; only
        # the network is faked.
        import posternimap.account as account_mod
        from posternimap.client import PosternClient as RealClient

        self._real_client = account_mod.PosternClient
        transport = self.transport

        def _factory(base_url: str, token: str, timeout: float = 15.0, meter: Any = None) -> Any:
            return RealClient(base_url, token, timeout=timeout, transport=transport, meter=meter)

        account_mod.PosternClient = _factory  # type: ignore[assignment]
        self.addCleanup(setattr, account_mod, "PosternClient", self._real_client)

    def _account(self, env: Dict[str, str]) -> Any:
        from posternimap.account import PosternAccount

        cfg = Config.from_env(env)
        return PosternAccount(cfg, "conrad", self.token)

    def test_flag_on_select_emits_cold_sync_via_default_sink(self) -> None:
        captured = _capture_measure(self)
        acct = self._account({"POSTERN_API_URL": "https://x", "POSTERN_IMAP_MEASURE": "on"})
        mb = acct.select("INBOX")
        # getMessageCount triggers the cold-sync load (a real SELECT does the same).
        self.assertEqual(mb.getMessageCount(), 2)

        lines = _measure_lines(captured)
        names = [n for n, _ in lines]
        # The regression guard: the real config-built path must actually emit.
        self.assertIn("cold_sync", names)
        self.assertIn("api_request", names)

        cs = next(f for n, f in lines if n == "cold_sync")
        self.assertEqual(cs["direction"], "inbound")
        self.assertEqual(cs["collected"], 2)
        self.assertEqual(cs["presented"], 2)
        self.assertIn("elapsed_ms", cs)
        # The token must never appear in a measurement line (counts/sizes/paths only).
        self.assertNotIn(self.token, json.dumps(lines))

    def test_flag_off_select_is_silent(self) -> None:
        captured = _capture_measure(self)
        # POSTERN_IMAP_MEASURE unset -> the production default (off).
        acct = self._account({"POSTERN_API_URL": "https://x"})
        mb = acct.select("INBOX")
        self.assertEqual(mb.getMessageCount(), 2)
        self.assertEqual(_measure_lines(captured), [])


if __name__ == "__main__":
    unittest.main()

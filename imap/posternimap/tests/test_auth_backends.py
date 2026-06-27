"""Functional tests for the #77 production auth backends (LDAPBinder, PAMAuthenticator).

These exercise the binder wiring (simple bind, search+bind, empty-password
short-circuit, PAM local-part handling) WITHOUT a live directory or PAM stack and
WITHOUT requiring the optional ldap3 / python-pam packages: fake modules are
injected into sys.modules so the lazy `import ldap3` / `import pam` inside the
backends resolves to a controllable double. The real backends are integration-
tested against live LDAP/PAM at deploy (Strummer supplies the DN/service values).
"""

from __future__ import annotations

import sys
import types
import unittest

from posternimap.auth import AuthBackendError, LDAPBinder, PAMAuthenticator
from posternimap.config import Config


def _cfg(**over) -> Config:
    base = dict(api_url="https://x", auth_mode="ldap", service_token="svc")
    base.update(over)
    return Config(**base)


# --- fake ldap3 -------------------------------------------------------------


class _FakeEntry:
    def __init__(self, dn: str) -> None:
        self.entry_dn = dn


class _FakeConnection:
    """Scripted ldap3 Connection. `directory` maps (dn, password) -> bind ok."""

    def __init__(self, server, user=None, password=None, directory=None, search_result=None):
        self._user = user
        self._password = password
        self._directory = directory or {}
        self._search_result = search_result if search_result is not None else []
        self.entries = []
        self.opened = False
        self.started_tls = False

    def open(self):
        self.opened = True

    def start_tls(self):
        self.started_tls = True
        return True

    def bind(self):
        return self._directory.get((self._user, self._password), False)

    def search(self, base, flt, attributes=None):
        self.entries = list(self._search_result)
        return bool(self.entries)


def _install_fake_ldap3(directory, search_result=None, record=None):
    """Register a fake ldap3 (+ submodules) in sys.modules; return a teardown."""
    saved = {k: sys.modules.get(k) for k in (
        "ldap3", "ldap3.core", "ldap3.core.exceptions", "ldap3.utils",
        "ldap3.utils.conv", "ldap3.utils.dn",
    )}

    ldap3 = types.ModuleType("ldap3")
    ldap3.NONE = "NONE"

    def _server(url, use_ssl=False, get_info=None, connect_timeout=None):
        if record is not None:
            record["use_ssl"] = use_ssl
            record["url"] = url
            record["connect_timeout"] = connect_timeout
        return ("server", url)

    def _connection(server, user=None, password=None, receive_timeout=None):
        if record is not None:
            record.setdefault("binds", []).append((user, password))
            record.setdefault("receive_timeouts", []).append(receive_timeout)
        return _FakeConnection(server, user=user, password=password,
                               directory=directory, search_result=search_result)

    ldap3.Server = _server
    ldap3.Connection = _connection

    core = types.ModuleType("ldap3.core")
    exceptions = types.ModuleType("ldap3.core.exceptions")

    class LDAPException(Exception):
        pass

    exceptions.LDAPException = LDAPException
    core.exceptions = exceptions

    utils = types.ModuleType("ldap3.utils")
    conv = types.ModuleType("ldap3.utils.conv")
    dn = types.ModuleType("ldap3.utils.dn")
    conv.escape_filter_chars = lambda s: s
    dn.escape_rdn = lambda s: s
    utils.conv = conv
    utils.dn = dn

    sys.modules["ldap3"] = ldap3
    sys.modules["ldap3.core"] = core
    sys.modules["ldap3.core.exceptions"] = exceptions
    sys.modules["ldap3.utils"] = utils
    sys.modules["ldap3.utils.conv"] = conv
    sys.modules["ldap3.utils.dn"] = dn

    def teardown():
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    return teardown


class LDAPSimpleBindTest(unittest.TestCase):
    def _cfg(self):
        return _cfg(
            ldap_url="ldaps://dir.example:636",
            ldap_bind_dn_template="uid=%s,ou=people,dc=ex,dc=com",
        )

    def test_good_password_binds(self):
        record = {}
        td = _install_fake_ldap3(
            directory={("uid=joan,ou=people,dc=ex,dc=com", "right"): True}, record=record
        )
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
            self.assertTrue(record["use_ssl"])  # ldaps:// -> SSL
        finally:
            td()

    def test_bad_password_fails(self):
        td = _install_fake_ldap3(directory={("uid=joan,ou=people,dc=ex,dc=com", "right"): True})
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", "wrong"))
        finally:
            td()

    def test_empty_password_never_binds(self):
        # No directory entry needed: the empty-password guard short-circuits.
        td = _install_fake_ldap3(directory={("uid=joan,ou=people,dc=ex,dc=com", ""): True})
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", ""))
        finally:
            td()


class LDAPSearchBindTest(unittest.TestCase):
    def _cfg(self):
        return _cfg(
            ldap_url="ldaps://dir.example:636",
            ldap_bind_dn="cn=svc,dc=ex,dc=com",
            ldap_bind_password="svcpw",
            ldap_search_base="ou=people,dc=ex,dc=com",
            ldap_search_filter="(uid=%s)",
        )

    def test_search_then_user_bind(self):
        directory = {
            ("cn=svc,dc=ex,dc=com", "svcpw"): True,  # service account
            ("uid=joan,ou=people,dc=ex,dc=com", "right"): True,  # the user
        }
        td = _install_fake_ldap3(
            directory=directory, search_result=[_FakeEntry("uid=joan,ou=people,dc=ex,dc=com")]
        )
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
        finally:
            td()

    def test_service_bind_failure_is_backend_fault(self):
        td = _install_fake_ldap3(directory={})  # service bind returns False
        try:
            with self.assertRaises(AuthBackendError):
                LDAPBinder(self._cfg())("joan", "right")
        finally:
            td()

    def test_no_such_user_fails(self):
        td = _install_fake_ldap3(
            directory={("cn=svc,dc=ex,dc=com", "svcpw"): True}, search_result=[]
        )
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", "right"))
        finally:
            td()

    def test_ambiguous_user_fails(self):
        td = _install_fake_ldap3(
            directory={("cn=svc,dc=ex,dc=com", "svcpw"): True},
            search_result=[_FakeEntry("uid=a,dc=ex,dc=com"), _FakeEntry("uid=b,dc=ex,dc=com")],
        )
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", "right"))
        finally:
            td()


# --- fake pam ---------------------------------------------------------------


def _install_fake_pam(directory, record=None):
    saved = sys.modules.get("pam")
    mod = types.ModuleType("pam")

    class _PamAuth:
        def authenticate(self, username, password, service=None):
            if record is not None:
                record["call"] = (username, password, service)
            return directory.get((username, password), False)

    mod.pam = lambda: _PamAuth()
    sys.modules["pam"] = mod

    def teardown():
        if saved is None:
            sys.modules.pop("pam", None)
        else:
            sys.modules["pam"] = saved

    return teardown


class PAMAuthTest(unittest.TestCase):
    def _cfg(self, **over):
        return _cfg(auth_mode="system", **over)

    def test_good_password_authenticates(self):
        record = {}
        td = _install_fake_pam(directory={("joan", "right"): True}, record=record)
        try:
            self.assertTrue(PAMAuthenticator(self._cfg())("joan", "right"))
            # default PAM service is "postern".
            self.assertEqual(record["call"], ("joan", "right", "postern"))
        finally:
            td()

    def test_strips_domain_to_local_part(self):
        record = {}
        td = _install_fake_pam(directory={("joan", "right"): True}, record=record)
        try:
            self.assertTrue(PAMAuthenticator(self._cfg())("joan@skyphusion.org", "right"))
            self.assertEqual(record["call"][0], "joan")  # local part only
        finally:
            td()

    def test_custom_service_name(self):
        record = {}
        td = _install_fake_pam(directory={("joan", "right"): True}, record=record)
        try:
            PAMAuthenticator(self._cfg(pam_service="imap"))("joan", "right")
            self.assertEqual(record["call"][2], "imap")
        finally:
            td()

    def test_bad_password_fails(self):
        td = _install_fake_pam(directory={("joan", "right"): True})
        try:
            self.assertFalse(PAMAuthenticator(self._cfg())("joan", "wrong"))
        finally:
            td()

    def test_empty_password_short_circuits(self):
        td = _install_fake_pam(directory={("joan", ""): True})
        try:
            self.assertFalse(PAMAuthenticator(self._cfg())("joan", ""))
        finally:
            td()


if __name__ == "__main__":
    unittest.main()


class LDAPTimeoutTest(unittest.TestCase):
    """LDAP_TIMEOUT must bound BOTH connect and every bind/search (mirrors the Go
    relay's DialWithDialer + SetTimeout), so a dead/slow directory cannot hang a
    login. Shared cross-language knob name, default 10s, 0 disables."""

    def _cfg(self, **over):
        return _cfg(
            ldap_url="ldaps://dir.example:636",
            ldap_bind_dn_template="uid=%s,ou=people,dc=ex,dc=com",
            **over,
        )

    def test_default_timeout_applied_to_connect_and_bind(self):
        record = {}
        td = _install_fake_ldap3(
            directory={("uid=joan,ou=people,dc=ex,dc=com", "right"): True}, record=record
        )
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
            self.assertEqual(record["connect_timeout"], 10)  # Server connect timeout
            self.assertTrue(record["receive_timeouts"])  # at least one bind
            self.assertTrue(all(rt == 10 for rt in record["receive_timeouts"]))
        finally:
            td()

    def test_search_bind_applies_timeout_to_every_connection(self):
        record = {}
        td = _install_fake_ldap3(
            directory={
                ("cn=svc,dc=ex,dc=com", "svcpw"): True,
                ("uid=joan,ou=people,dc=ex,dc=com", "right"): True,
            },
            search_result=[_FakeEntry("uid=joan,ou=people,dc=ex,dc=com")],
            record=record,
        )
        try:
            cfg = _cfg(
                ldap_url="ldaps://dir.example:636",
                ldap_bind_dn="cn=svc,dc=ex,dc=com",
                ldap_bind_password="svcpw",
                ldap_search_base="ou=people,dc=ex,dc=com",
                ldap_search_filter="(uid=%s)",
            )
            self.assertTrue(LDAPBinder(cfg)("joan", "right"))
            # service-account bind + user bind both carry the timeout.
            self.assertEqual(record["connect_timeout"], 10)
            self.assertEqual(len(record["receive_timeouts"]), 2)
            self.assertTrue(all(rt == 10 for rt in record["receive_timeouts"]))
        finally:
            td()

    def test_zero_timeout_disables(self):
        record = {}
        td = _install_fake_ldap3(
            directory={("uid=joan,ou=people,dc=ex,dc=com", "right"): True}, record=record
        )
        try:
            self.assertTrue(LDAPBinder(self._cfg(ldap_timeout=0))("joan", "right"))
            self.assertIsNone(record["connect_timeout"])  # 0 -> None == no timeout
            self.assertTrue(all(rt is None for rt in record["receive_timeouts"]))
        finally:
            td()

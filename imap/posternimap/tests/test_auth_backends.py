"""Functional tests for the #77 production auth backends (LDAPBinder, PAMAuthenticator).

These exercise the binder wiring (direct-bind, the #182 group gate, the #153 TLS
trust knobs, empty-password short-circuit, PAM local-part handling) WITHOUT a live
directory or PAM stack and WITHOUT requiring the optional ldap3 / python-pam
packages: fake modules are injected into sys.modules so the lazy `import ldap3` /
`import pam` inside the backends resolves to a controllable double. The real
backends are integration-tested against live LDAP/PAM at deploy.
"""

from __future__ import annotations

import hashlib
import ssl
import sys
import types
import unittest

from posternimap.auth import AuthBackendError, LDAPBinder, PAMAuthenticator
from posternimap.config import Config, ConfigError

# The DER bytes the fake TLS socket presents; pin tests hash these.
PEER_DER = b"fake-leaf-der-bytes"
PEER_PIN = hashlib.sha256(PEER_DER).hexdigest()

GROUP = "cn=mail-users,ou=groups,dc=ex,dc=com"
JOAN_DN = "uid=joan,ou=people,dc=ex,dc=com"


def _cfg(**over) -> Config:
    base = dict(api_url="https://x", auth_mode="ldap", service_token="svc")
    base.update(over)
    return Config(**base)


# --- fake ldap3 -------------------------------------------------------------


class _FakeEntry:
    def __init__(self, dn: str, attrs=None) -> None:
        self.entry_dn = dn
        self.entry_attributes_as_dict = attrs or {}


class _FakeSocket:
    def __init__(self, der):
        self._der = der

    def getpeercert(self, binary_form=False):
        return self._der if binary_form else {}


class _FakeConnection:
    """Scripted ldap3 Connection. `directory` maps (dn, password) -> bind ok."""

    def __init__(self, server, user=None, password=None, directory=None,
                 search_result=None, record=None, peer_der=PEER_DER,
                 search_raises=None):
        self._user = user
        self._password = password
        self._directory = directory or {}
        self._search_result = search_result if search_result is not None else []
        self._record = record if record is not None else {}
        self._search_raises = search_raises
        self.entries = []
        self.opened = False
        self.started_tls = False
        self.socket = _FakeSocket(peer_der)

    def open(self):
        self.opened = True
        self._record.setdefault("events", []).append("open")

    def start_tls(self):
        self.started_tls = True
        self._record.setdefault("events", []).append("start_tls")
        return True

    def bind(self):
        self._record.setdefault("events", []).append("bind")
        return self._directory.get((self._user, self._password), False)

    def search(self, base, flt, search_scope=None, attributes=None):
        self._record.setdefault("events", []).append("search")
        self._record.setdefault("searches", []).append(
            {"base": base, "filter": flt, "scope": search_scope, "attributes": attributes}
        )
        if self._search_raises is not None:
            raise self._search_raises
        self.entries = list(self._search_result)
        return bool(self.entries)


def _install_fake_ldap3(directory, search_result=None, record=None,
                        peer_der=PEER_DER, search_raises_ldap=False):
    """Register a fake ldap3 (+ submodules) in sys.modules; return a teardown."""
    saved = {k: sys.modules.get(k) for k in (
        "ldap3", "ldap3.core", "ldap3.core.exceptions", "ldap3.utils",
        "ldap3.utils.conv", "ldap3.utils.dn",
    )}

    ldap3 = types.ModuleType("ldap3")
    ldap3.NONE = "NONE"
    ldap3.BASE = "BASE"

    class LDAPException(Exception):
        pass

    class _Tls:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            if record is not None:
                record["tls"] = kwargs

    def _server(url, use_ssl=False, get_info=None, connect_timeout=None, tls=None):
        if record is not None:
            record["use_ssl"] = use_ssl
            record["url"] = url
            record["connect_timeout"] = connect_timeout
            record["server_tls"] = tls
        return ("server", url)

    def _connection(server, user=None, password=None, receive_timeout=None):
        if record is not None:
            record.setdefault("binds", []).append((user, password))
            record.setdefault("receive_timeouts", []).append(receive_timeout)
        return _FakeConnection(
            server, user=user, password=password, directory=directory,
            search_result=search_result, record=record, peer_der=peer_der,
            search_raises=LDAPException("directory fault") if search_raises_ldap else None,
        )

    ldap3.Server = _server
    ldap3.Connection = _connection
    ldap3.Tls = _Tls

    core = types.ModuleType("ldap3.core")
    exceptions = types.ModuleType("ldap3.core.exceptions")
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


class LDAPDirectBindTest(unittest.TestCase):
    def _cfg(self, **over):
        return _cfg(
            ldap_url="ldaps://dir.example:636",
            ldap_bind_dn_template="uid=%s,ou=people,dc=ex,dc=com",
            **over,
        )

    def test_good_password_binds(self):
        record = {}
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, record=record)
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
            self.assertTrue(record["use_ssl"])  # ldaps:// -> SSL
        finally:
            td()

    def test_bad_password_fails(self):
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True})
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", "wrong"))
        finally:
            td()

    def test_empty_password_never_binds(self):
        # No directory entry needed: the empty-password guard short-circuits.
        td = _install_fake_ldap3(directory={(JOAN_DN, ""): True})
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", ""))
        finally:
            td()

    def test_no_gate_means_no_self_read(self):
        # Without LDAP_REQUIRE_GROUP a successful bind IS the pass criterion;
        # no self-read is performed (today's behavior, preserved).
        record = {}
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, record=record)
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
            self.assertNotIn("searches", record)
        finally:
            td()

    def test_search_bind_config_is_retired(self):
        # #182: no LDAP_BIND_DN_TEMPLATE -> the binder refuses to construct
        # (the search+bind path is gone; parity with the Go relay).
        with self.assertRaises(ConfigError):
            LDAPBinder(_cfg(ldap_url="ldaps://dir.example:636"))


class LDAPGroupGateTest(unittest.TestCase):
    """LDAP_REQUIRE_GROUP: fail-closed memberOf self-read gate (#182, contract 5b)."""

    def _cfg(self, **over):
        return _cfg(
            ldap_url="ldaps://dir.example:636",
            ldap_bind_dn_template="uid=%s,ou=people,dc=ex,dc=com",
            ldap_require_group=GROUP,
            **over,
        )

    def _member_entry(self, groups):
        return _FakeEntry(JOAN_DN, {"memberOf": list(groups)})

    def test_member_passes_gate(self):
        record = {}
        td = _install_fake_ldap3(
            directory={(JOAN_DN, "right"): True},
            search_result=[self._member_entry([GROUP, "cn=other,ou=groups,dc=ex,dc=com"])],
            record=record,
        )
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
            # Self-read: base scope, the user's OWN DN, the group attribute.
            search = record["searches"][0]
            self.assertEqual(search["base"], JOAN_DN)
            self.assertEqual(search["scope"], "BASE")
            self.assertEqual(search["attributes"], ["memberOf"])
        finally:
            td()

    def test_non_member_denied(self):
        td = _install_fake_ldap3(
            directory={(JOAN_DN, "right"): True},
            search_result=[self._member_entry(["cn=other,ou=groups,dc=ex,dc=com"])],
        )
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", "right"))
        finally:
            td()

    def test_dn_spelling_variants_match(self):
        # Case + whitespace around RDN separators must not defeat the gate
        # (mirrors relay normalizeDN).
        td = _install_fake_ldap3(
            directory={(JOAN_DN, "right"): True},
            search_result=[self._member_entry(["CN=Mail-Users, OU=groups, DC=ex, DC=com"])],
        )
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
        finally:
            td()

    def test_empty_self_read_fails_closed(self):
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, search_result=[])
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", "right"))
        finally:
            td()

    def test_entry_without_group_attr_fails_closed(self):
        td = _install_fake_ldap3(
            directory={(JOAN_DN, "right"): True}, search_result=[_FakeEntry(JOAN_DN, {})]
        )
        try:
            self.assertFalse(LDAPBinder(self._cfg())("joan", "right"))
        finally:
            td()

    def test_self_read_fault_is_backend_error(self):
        # A directory fault on the self-read is an infra fault (logged loud,
        # never counted as a bad password) -- and the login still fails.
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, search_raises_ldap=True)
        try:
            with self.assertRaises(AuthBackendError):
                LDAPBinder(self._cfg())("joan", "right")
        finally:
            td()

    def test_custom_group_attr(self):
        record = {}
        td = _install_fake_ldap3(
            directory={(JOAN_DN, "right"): True},
            search_result=[_FakeEntry(JOAN_DN, {"groupMembership": [GROUP]})],
            record=record,
        )
        try:
            self.assertTrue(
                LDAPBinder(self._cfg(ldap_group_attr="groupMembership"))("joan", "right")
            )
            self.assertEqual(record["searches"][0]["attributes"], ["groupMembership"])
        finally:
            td()


class LDAPTLSPinTest(unittest.TestCase):
    """LDAP_TLS_PIN_SHA256: exact-leaf pin, checked BEFORE any credential flows (#153)."""

    def _cfg(self, pin=PEER_PIN, url="ldaps://dir.example:636", starttls=False):
        return _cfg(
            ldap_url=url,
            ldap_starttls=starttls,
            ldap_bind_dn_template="uid=%s,ou=people,dc=ex,dc=com",
            ldap_tls_pin_sha256=pin,
        )

    def test_matching_pin_binds(self):
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True})
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
        finally:
            td()

    def test_pin_accepts_colons_and_case(self):
        colons = ":".join(PEER_PIN[i:i + 2] for i in range(0, len(PEER_PIN), 2)).upper()
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True})
        try:
            self.assertTrue(LDAPBinder(self._cfg(pin=colons))("joan", "right"))
        finally:
            td()

    def test_mismatched_pin_refuses_before_bind(self):
        # The load-bearing property: a swapped cert (MITM) is refused BEFORE the
        # bind would send the user's password down the channel.
        record = {}
        td = _install_fake_ldap3(
            directory={(JOAN_DN, "right"): True}, record=record,
            peer_der=b"a-different-certificate",
        )
        try:
            with self.assertRaises(AuthBackendError):
                LDAPBinder(self._cfg())("joan", "right")
            self.assertNotIn("bind", record.get("events", []))
        finally:
            td()

    def test_pin_checked_after_starttls_upgrade(self):
        record = {}
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, record=record)
        try:
            cfg = self._cfg(url="ldap://dir.example:389", starttls=True)
            self.assertTrue(LDAPBinder(cfg)("joan", "right"))
            self.assertEqual(record["events"], ["open", "start_tls", "bind"])
        finally:
            td()

    def test_missing_peer_cert_is_backend_fault(self):
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, peer_der=None)
        try:
            with self.assertRaises(AuthBackendError):
                LDAPBinder(self._cfg())("joan", "right")
        finally:
            td()

    def test_pin_and_ca_mutually_exclusive(self):
        with self.assertRaises(ConfigError):
            LDAPBinder(
                _cfg(
                    ldap_url="ldaps://dir.example:636",
                    ldap_bind_dn_template="uid=%s,dc=ex,dc=com",
                    ldap_tls_pin_sha256=PEER_PIN,
                    ldap_tls_ca="/etc/ca.pem",
                )
            )

    def test_malformed_pin_is_config_error(self):
        for bad in ("zz" * 32, "abcd"):
            with self.subTest(pin=bad):
                with self.assertRaises(ConfigError):
                    LDAPBinder(self._cfg(pin=bad))


class LDAPTLSWiringTest(unittest.TestCase):
    """The ldap3 Tls object mirrors relay buildLDAPTLSConfig semantics."""

    def _cfg(self, **over):
        return _cfg(
            ldap_url="ldaps://dir.example:636",
            ldap_bind_dn_template="uid=%s,ou=people,dc=ex,dc=com",
            **over,
        )

    def test_ca_pin_is_full_verification(self):
        record = {}
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, record=record)
        try:
            cfg = self._cfg(
                ldap_tls_ca="/etc/authentik-ca.pem", ldap_tls_server_name="dir.internal"
            )
            self.assertTrue(LDAPBinder(cfg)("joan", "right"))
            tls = record["tls"]
            self.assertEqual(tls["validate"], ssl.CERT_REQUIRED)
            self.assertEqual(tls["ca_certs_file"], "/etc/authentik-ca.pem")
            self.assertEqual(tls["valid_names"], ["dir.internal"])
            self.assertIsNotNone(record["server_tls"])  # handed to the Server
        finally:
            td()

    def test_default_is_cert_none_with_tls12_floor(self):
        # No trust knob -> today's unauthenticated channel (warned at startup),
        # but never below TLS 1.2 (symmetric with the relay's MinVersion doctrine).
        record = {}
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, record=record)
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
            tls = record["tls"]
            self.assertEqual(tls["validate"], ssl.CERT_NONE)
            for opt in (ssl.OP_NO_SSLv3, ssl.OP_NO_TLSv1, ssl.OP_NO_TLSv1_1):
                self.assertIn(opt, tls["ssl_options"])
        finally:
            td()


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
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, record=record)
        try:
            self.assertTrue(LDAPBinder(self._cfg())("joan", "right"))
            self.assertEqual(record["connect_timeout"], 10)  # Server connect timeout
            self.assertTrue(record["receive_timeouts"])  # at least one bind
            self.assertTrue(all(rt == 10 for rt in record["receive_timeouts"]))
        finally:
            td()

    def test_zero_timeout_disables(self):
        record = {}
        td = _install_fake_ldap3(directory={(JOAN_DN, "right"): True}, record=record)
        try:
            self.assertTrue(LDAPBinder(self._cfg(ldap_timeout=0))("joan", "right"))
            self.assertIsNone(record["connect_timeout"])  # 0 -> None == no timeout
            self.assertTrue(all(rt is None for rt in record["receive_timeouts"]))
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

"""LDAP directory TLS on a REAL handshake (real ldap3, real ssl, local listener).

test_auth_backends.py checks the ldap3 Tls arguments against a fake ldap3. These
tests run the shipped LDAPBinder against a local fake directory that speaks TLS,
and assert the one property that matters: whether the bind password reaches the
peer. An untrusted directory certificate must be refused BEFORE the bind, on both
ldaps:// and ldap:// + StartTLS.

The URL host is `localhost` (a DNS name): ldap3 matches the certificate against
DNS SANs only, which is why LDAP_TLS_SERVER_NAME exists for a URL that dials an IP.

"System roots" are made controllable through SSL_CERT_FILE, which OpenSSL reads
when ssl.create_default_context() loads the default verify paths. That is the
real system-roots code path, pointed at a test CA.

ldap3 is the optional [ldap] extra. CI installs it, and under CI a missing ldap3
FAILS this module rather than skipping it, so the suite cannot go green unrun.
"""

from __future__ import annotations

import datetime
import os
import shutil
import socket
import ssl
import tempfile
import threading
import unittest
from typing import Any, Optional
from unittest import mock

from posternimap.auth import AuthBackendError, LDAPBinder
from posternimap.config import Config

try:
    import ldap3  # noqa: F401
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    HAVE_DEPS = True
except ImportError:  # pragma: no cover - exercised only without the extras
    HAVE_DEPS = False

PASSWORD = "wire-test-bind-password-canary"


def _key() -> Any:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _name(cn: str) -> Any:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def _cert(subject_key: Any, cn: str, issuer: Optional[tuple] = None,
          san_dns: Optional[str] = None, ca: bool = False) -> Any:
    now = datetime.datetime.now(datetime.timezone.utc)
    issuer_key, issuer_name = issuer if issuer else (subject_key, _name(cn))
    b = (
        x509.CertificateBuilder()
        .subject_name(_name(cn))
        .issuer_name(issuer_name)
        .public_key(subject_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(hours=1))
        .not_valid_after(now + datetime.timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        # Key identifiers: Python 3.13+ verifies with VERIFY_X509_STRICT, which
        # refuses a chain without them.
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(subject_key.public_key()), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False
        )
    )
    if ca:
        b = b.add_extension(
            x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                          data_encipherment=False, key_agreement=False, key_cert_sign=True,
                          crl_sign=True, encipher_only=False, decipher_only=False),
            critical=True,
        )
    if san_dns:
        b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(san_dns)]), critical=False)
    return b.sign(issuer_key, hashes.SHA256())


class _Directory:
    """A one-shot fake directory. It serves TLS with the given cert (directly for
    ldaps, or after answering the StartTLS extended op), then records whether the
    bind password arrived."""

    def __init__(self, cert: Any, key: Any, starttls: bool, tmp: str) -> None:
        cert_path = os.path.join(tmp, "srv-%d.pem" % id(self))
        with open(cert_path, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))
            f.write(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            ))
        self._ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._ctx.load_cert_chain(cert_path)
        self._starttls = starttls
        self._ls = socket.socket()
        self._ls.bind(("127.0.0.1", 0))
        self._ls.listen(1)
        self.port = self._ls.getsockname()[1]
        self.password_received = False
        self.handshake_ok = False
        self._t = threading.Thread(target=self._serve, daemon=True)
        self._t.start()

    def _serve(self) -> None:
        try:
            c, _ = self._ls.accept()
        except OSError:
            return
        c.settimeout(5)
        try:
            if self._starttls:
                req = c.recv(4096)
                # LDAPMessage, short form: 30 len 02 01 <messageID> 77 ...
                mid = req[4]
                ext = bytes([0x0A, 1, 0, 0x04, 0, 0x04, 0])  # resultCode success
                body = bytes([0x02, 1, mid, 0x78, len(ext)]) + ext
                c.sendall(bytes([0x30, len(body)]) + body)
            t = self._ctx.wrap_socket(c, server_side=True)
            self.handshake_ok = True
            data = t.recv(4096)
            self.password_received = PASSWORD.encode() in data
            t.close()
        except (OSError, ssl.SSLError, IndexError):
            pass
        finally:
            c.close()

    def close(self) -> None:
        self._t.join(6)
        self._ls.close()


@unittest.skipUnless(HAVE_DEPS or os.environ.get("CI"), "needs the [ldap] and [tls] extras")
class LDAPDirectoryTLSWireTest(unittest.TestCase):
    """The bind password reaches the directory ONLY over a verified channel."""

    def setUp(self) -> None:
        if not HAVE_DEPS:
            self.fail("ldap3/cryptography missing under CI: install the [ldap,tls] extras")
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.ca_key = _key()
        self.ca = _cert(self.ca_key, "postern wire test CA", ca=True)
        self.ca_path = os.path.join(self.tmp, "ca.pem")
        with open(self.ca_path, "wb") as f:
            f.write(self.ca.public_bytes(serialization.Encoding.PEM))
        issuer = (self.ca_key, self.ca.subject)
        self.good_key = _key()
        self.good = _cert(self.good_key, "directory", issuer=issuer, san_dns="localhost")
        self.wrongname_key = _key()
        self.wrongname = _cert(self.wrongname_key, "directory", issuer=issuer, san_dns="other.test")
        self.evil_key = _key()
        self.evil = _cert(self.evil_key, "evil", san_dns="localhost")  # self-signed impostor

    def _bind(self, cert: Any, key: Any, starttls: bool, **over: Any) -> tuple:
        d = _Directory(cert, key, starttls, self.tmp)
        scheme = "ldap" if starttls else "ldaps"
        cfg = Config(
            api_url="https://x", auth_mode="ldap", service_token="svc",
            ldap_url="%s://localhost:%d" % (scheme, d.port),
            ldap_bind_dn_template="cn=%s,dc=example",
            ldap_starttls=starttls, ldap_timeout=5, **over,
        )
        err: Optional[Exception] = None
        try:
            LDAPBinder(cfg)("alice", PASSWORD)
        except AuthBackendError as exc:
            err = exc
        d.close()
        return d, err

    def _system_roots(self, path: Optional[str]) -> Any:
        env = {"SSL_CERT_FILE": path} if path else {"SSL_CERT_FILE": os.path.join(self.tmp, "none.pem")}
        return mock.patch.dict(os.environ, env)

    def _both(self):
        for starttls in (False, True):
            yield ("starttls" if starttls else "ldaps"), starttls

    def test_default_refuses_an_untrusted_directory(self) -> None:
        for name, starttls in self._both():
            with self.subTest(transport=name), self._system_roots(None):
                d, err = self._bind(self.evil, self.evil_key, starttls)
                self.assertFalse(d.password_received, "the bind password reached an untrusted directory")
                self.assertIsNotNone(err, "an untrusted directory certificate must be refused")

    def test_default_refuses_a_trusted_cert_for_another_host(self) -> None:
        for name, starttls in self._both():
            with self.subTest(transport=name), self._system_roots(self.ca_path):
                d, err = self._bind(self.wrongname, self.wrongname_key, starttls)
                self.assertFalse(d.password_received, "the bind password reached a directory whose cert names another host")
                self.assertIsNotNone(err)

    def test_default_connects_to_a_directory_the_system_roots_trust(self) -> None:
        # Positive control: the same harness DOES deliver the bind when the
        # certificate verifies, so the refusals above are verification, not a
        # broken harness.
        for name, starttls in self._both():
            with self.subTest(transport=name), self._system_roots(self.ca_path):
                d, _ = self._bind(self.good, self.good_key, starttls)
                self.assertTrue(d.password_received, "a trusted directory did not receive the bind")

    def test_ca_pin_connects_and_refuses(self) -> None:
        for name, starttls in self._both():
            with self.subTest(transport=name), self._system_roots(None):
                d, _ = self._bind(self.good, self.good_key, starttls, ldap_tls_ca=self.ca_path)
                self.assertTrue(d.password_received, "LDAP_TLS_CA did not trust its own CA")
                d, err = self._bind(self.evil, self.evil_key, starttls, ldap_tls_ca=self.ca_path)
                self.assertFalse(d.password_received)
                self.assertIsNotNone(err)

    def test_leaf_pin_connects_and_refuses(self) -> None:
        pin = self.evil.fingerprint(hashes.SHA256()).hex()
        other = self.good.fingerprint(hashes.SHA256()).hex()
        for name, starttls in self._both():
            with self.subTest(transport=name), self._system_roots(None):
                d, _ = self._bind(self.evil, self.evil_key, starttls, ldap_tls_pin_sha256=pin)
                self.assertTrue(d.password_received, "LDAP_TLS_PIN_SHA256 did not accept its pinned leaf")
                d, err = self._bind(self.evil, self.evil_key, starttls, ldap_tls_pin_sha256=other)
                self.assertFalse(d.password_received, "a mismatched pin let the bind through")
                self.assertIsNotNone(err)


if __name__ == "__main__":
    unittest.main()

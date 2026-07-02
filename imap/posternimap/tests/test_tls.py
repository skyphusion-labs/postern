"""TLS 1.2 floor on the IMAPS listener (#106).

The proxy must never offer the deprecated TLS 1.0/1.1; server.py raises the
context's minimum protocol to TLS 1.2 (mirroring the relay). pyOpenSSL exposes no
getter for the minimum version, so we PROVE the floor with an in-memory BIO
handshake: a client capped below TLS 1.2 must fail, a normal client must succeed
and negotiate >= TLS 1.2. Skips cleanly where the optional TLS stack is absent.
"""

from __future__ import annotations

import datetime
import os
import tempfile
import unittest

try:
    from OpenSSL import SSL, crypto
    from twisted.internet import ssl as _twisted_ssl  # noqa: F401  (proves [tls] extra present)

    HAVE_TLS = True
except ImportError:
    HAVE_TLS = False


def _gen_self_signed(dirpath: str):
    key = crypto.PKey()
    key.generate_key(crypto.TYPE_RSA, 2048)
    cert = crypto.X509()
    cert.get_subject().CN = "localhost"
    cert.set_serial_number(1)
    cert.gmtime_adj_notBefore(0)
    cert.gmtime_adj_notAfter(3600)
    cert.set_issuer(cert.get_subject())
    cert.set_pubkey(key)
    cert.sign(key, "sha256")
    cert_path = os.path.join(dirpath, "cert.pem")
    key_path = os.path.join(dirpath, "key.pem")
    with open(cert_path, "wb") as f:
        f.write(crypto.dump_certificate(crypto.FILETYPE_PEM, cert))
    with open(key_path, "wb") as f:
        f.write(crypto.dump_privatekey(crypto.FILETYPE_PEM, key))
    return cert_path, key_path


def _drive_handshake(client_conn, server_conn) -> None:
    """Pump bytes between two memory-BIO Connections until both handshakes finish.

    Raises OpenSSL.SSL.Error if either side rejects the negotiation (the negative
    case). Raises AssertionError if it neither completes nor fails (should not).
    """
    client_conn.set_connect_state()
    server_conn.set_accept_state()
    done = {id(client_conn): False, id(server_conn): False}
    for _ in range(100):
        for conn, peer in ((client_conn, server_conn), (server_conn, client_conn)):
            if not done[id(conn)]:
                try:
                    conn.do_handshake()
                    done[id(conn)] = True
                except SSL.WantReadError:
                    pass
            try:
                while True:
                    peer.bio_write(conn.bio_read(65536))
            except SSL.WantReadError:
                pass
        if all(done.values()):
            return
    raise AssertionError("handshake neither completed nor failed")


@unittest.skipUnless(HAVE_TLS, "pyOpenSSL / Twisted TLS extra not installed")
class TLSFloorTest(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.cert, self.key = _gen_self_signed(self._dir.name)

    def tearDown(self):
        self._dir.cleanup()

    def _server_context(self):
        from posternimap.server import _build_tls_context_factory

        return _build_tls_context_factory(self.cert, self.key).getContext()

    def test_factory_builds(self):
        # The cert/key load and the min-version call must not raise.
        self.assertIsNotNone(self._server_context())

    def test_modern_client_negotiates_tls12_or_higher(self):
        # Build the client from the door's own factory (the TLSChainTest pattern)
        # so this test constructs no bare, insecure-by-default SSL.Context; both
        # ends carry the TLS 1.2 floor and the handshake must land on >= 1.2.
        # The floor itself is proven by the negative test below.
        server = SSL.Connection(self._server_context(), None)
        client = SSL.Connection(self._server_context(), None)
        _drive_handshake(client, server)
        self.assertIn(client.get_protocol_version_name(), ("TLSv1.2", "TLSv1.3"))

    def test_client_capped_below_tls12_is_rejected(self):
        server = SSL.Connection(self._server_context(), None)
        # This client context DELIBERATELY allows pre-TLS-1.2 protocols: the test
        # exists to prove the production floor (server.py set_min_proto_version
        # TLS1_2) REJECTS such a client. CodeQL py/insecure-protocol flags this
        # line (alert 20); the insecure offer IS the test fixture, it is never
        # used as a server posture. Do not "fix" it to TLS 1.2+, that would
        # reduce the test to a tautology.
        client_ctx = SSL.Context(SSL.TLS_METHOD)
        # Force the client to offer nothing newer than TLS 1.1; the TLS 1.2 floor
        # must refuse it (a downgraded MUA can never connect).
        client_ctx.set_max_proto_version(SSL.TLS1_1_VERSION)
        client = SSL.Connection(client_ctx, None)
        with self.assertRaises(SSL.Error):
            _drive_handshake(client, server)


def _gen_chain(dirpath: str):
    """Generate a leaf signed by a separate intermediate CA, and write a
    fullchain.pem (leaf + intermediate) plus the leaf key.

    Built with the modern `cryptography` x509 API (pyOpenSSL removed
    X509.add_extensions in 23.3+, which diverged local from CI). cryptography is
    a pyOpenSSL dependency, so it is present wherever HAVE_TLS is true. Mirrors a
    real Let's Encrypt fullchain so we can prove the 993 door presents the
    intermediate, not just the leaf (#175). Fixed validity dates keep it
    deterministic and clock-independent.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    not_before = datetime.datetime(2020, 1, 1)
    not_after = datetime.datetime(2100, 1, 1)

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "Postern Test Intermediate CA")]
    )
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(100)
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(ca_key, hashes.SHA256())
    )

    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(leaf_name)
        .issuer_name(ca_name)
        .public_key(leaf_key.public_key())
        .serial_number(101)
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .sign(ca_key, hashes.SHA256())
    )

    fullchain_path = os.path.join(dirpath, "fullchain.pem")
    key_path = os.path.join(dirpath, "leaf.key")
    with open(fullchain_path, "wb") as f:
        f.write(leaf_cert.public_bytes(serialization.Encoding.PEM))
        f.write(ca_cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, "wb") as f:
        f.write(
            leaf_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
    return fullchain_path, key_path


@unittest.skipUnless(HAVE_TLS, "pyOpenSSL / Twisted TLS extra not installed")
class TLSChainTest(unittest.TestCase):
    """The door must present leaf + intermediate, not the leaf alone (#175).

    DefaultOpenSSLContextFactory loads the leaf only (use_certificate_file), which
    yields Verify code 21 at the client. The fix reloads the cert as a chain
    (use_certificate_chain_file), so a client must see BOTH certs in the chain.
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.fullchain, self.key = _gen_chain(self._dir.name)

    def tearDown(self):
        self._dir.cleanup()

    def test_server_presents_full_chain(self):
        from posternimap.server import _build_tls_context_factory

        # Build BOTH ends from the door's own factory so the test never
        # constructs a bare (insecure-by-default) SSL context; both inherit the
        # TLS 1.2 floor. The client never sends its loaded cert (the server does
        # not request one), it just drives the handshake and reads the chain.
        server = SSL.Connection(
            _build_tls_context_factory(self.fullchain, self.key).getContext(), None
        )
        client = SSL.Connection(
            _build_tls_context_factory(self.fullchain, self.key).getContext(), None
        )
        _drive_handshake(client, server)
        chain = client.get_peer_cert_chain()
        self.assertEqual(
            len(chain),
            2,
            "server must present leaf + intermediate (use_certificate_chain_file)",
        )
        subjects = [c.get_subject().CN for c in chain]
        self.assertEqual(subjects[0], "localhost")
        self.assertEqual(subjects[1], "Postern Test Intermediate CA")


if __name__ == "__main__":
    unittest.main()

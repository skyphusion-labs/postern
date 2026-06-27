"""TLS 1.2 floor on the IMAPS listener (#106).

The proxy must never offer the deprecated TLS 1.0/1.1; server.py raises the
context's minimum protocol to TLS 1.2 (mirroring the relay). pyOpenSSL exposes no
getter for the minimum version, so we PROVE the floor with an in-memory BIO
handshake: a client capped below TLS 1.2 must fail, a normal client must succeed
and negotiate >= TLS 1.2. Skips cleanly where the optional TLS stack is absent.
"""

from __future__ import annotations

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
        server = SSL.Connection(self._server_context(), None)
        client_ctx = SSL.Context(SSL.TLS_METHOD)
        client = SSL.Connection(client_ctx, None)
        _drive_handshake(client, server)
        self.assertIn(client.get_protocol_version_name(), ("TLSv1.2", "TLSv1.3"))

    def test_client_capped_below_tls12_is_rejected(self):
        server = SSL.Connection(self._server_context(), None)
        client_ctx = SSL.Context(SSL.TLS_METHOD)
        # Force the client to offer nothing newer than TLS 1.1; the TLS 1.2 floor
        # must refuse it (a downgraded MUA can never connect).
        client_ctx.set_max_proto_version(SSL.TLS1_1_VERSION)
        client = SSL.Connection(client_ctx, None)
        with self.assertRaises(SSL.Error):
            _drive_handshake(client, server)


if __name__ == "__main__":
    unittest.main()

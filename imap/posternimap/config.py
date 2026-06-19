"""Env-driven configuration for the postern-imap proxy.

House style (see worker/relay): config comes from the environment, no flag
parsing, so it drops cleanly into a systemd EnvironmentFile or a container. The
proxy is a *client* of the Postern mailbox API, so its only hard requirement is
where that API lives (POSTERN_API_URL). How a login maps to an API token is the
#32 auth question, handled in auth.py and summarized here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional


class ConfigError(ValueError):
    """A required setting is missing or malformed."""


@dataclass(frozen=True)
class Config:
    # Where the Postern mailbox API lives (the worker origin), e.g.
    # https://postern.example. The proxy reads through its token-gated endpoints.
    api_url: str

    # IMAP listener. Default to loopback: like the relay, this is an internal
    # bridge, not an internet-facing service (auth is a Postern token, but TLS
    # termination and exposure are the operator's call). 1143 avoids needing root.
    listen_host: str = "127.0.0.1"
    listen_port: int = 1143

    # Optional TLS (recommended whenever the listener is not loopback): paths to
    # a PEM cert + key. If both are set the proxy serves IMAPS over the listener.
    tls_cert: Optional[str] = None
    tls_key: Optional[str] = None

    # Auth mode (see auth.py / #32):
    #   "token"  (default): the IMAP *password* IS the Postern API token; the
    #            username is a free label. Zero secrets stored in the proxy.
    #   "fixed": a single configured (username, token) pair; the proxy holds the
    #            token so a normal mail client logs in with a chosen password.
    auth_mode: str = "token"

    # Used only in "fixed" mode.
    fixed_username: Optional[str] = None
    fixed_token: Optional[str] = None

    # Per-request timeout to the Postern API, seconds.
    api_timeout: float = 15.0

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Config":
        e = os.environ if env is None else env

        api_url = (e.get("POSTERN_API_URL") or "").strip()
        if not api_url:
            raise ConfigError("POSTERN_API_URL is required (the Postern mailbox API origin)")
        if not api_url.startswith(("http://", "https://")):
            raise ConfigError("POSTERN_API_URL must start with http:// or https://")

        auth_mode = (e.get("POSTERN_IMAP_AUTH_MODE") or "token").strip().lower()
        if auth_mode not in ("token", "fixed"):
            raise ConfigError("POSTERN_IMAP_AUTH_MODE must be 'token' or 'fixed'")

        fixed_username = (e.get("POSTERN_IMAP_USERNAME") or "").strip() or None
        # The token is a secret: read it, never echo it.
        fixed_token = e.get("POSTERN_API_TOKEN") or None

        if auth_mode == "fixed":
            if not fixed_username or not fixed_token:
                raise ConfigError(
                    "fixed auth mode needs both POSTERN_IMAP_USERNAME and POSTERN_API_TOKEN"
                )

        cert = (e.get("POSTERN_IMAP_TLS_CERT") or "").strip() or None
        key = (e.get("POSTERN_IMAP_TLS_KEY") or "").strip() or None
        if bool(cert) != bool(key):
            raise ConfigError("set both POSTERN_IMAP_TLS_CERT and POSTERN_IMAP_TLS_KEY, or neither")

        return cls(
            api_url=api_url.rstrip("/"),
            listen_host=(e.get("POSTERN_IMAP_HOST") or "127.0.0.1").strip(),
            listen_port=_int(e, "POSTERN_IMAP_PORT", 1143),
            tls_cert=cert,
            tls_key=key,
            auth_mode=auth_mode,
            fixed_username=fixed_username,
            fixed_token=fixed_token,
            api_timeout=_float(e, "POSTERN_API_TIMEOUT", 15.0),
        )


def _int(e: Mapping[str, str], name: str, default: int) -> int:
    raw = e.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(str(raw).strip())
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc


def _float(e: Mapping[str, str], name: str, default: float) -> float:
    raw = e.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return float(str(raw).strip())
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number") from exc

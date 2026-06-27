"""Env-driven configuration for the postern-imap proxy.

House style (see worker/relay): config comes from the environment, no flag
parsing, so it drops cleanly into a systemd EnvironmentFile or a container. The
proxy is a *client* of the Postern mailbox API, so its only hard requirement is
where that API lives (POSTERN_API_URL). How a login maps to an API token is the
#32 auth question, handled in auth.py and summarized here.

#77 shared-credential parity: the proxy mirrors the SMTP relay's pluggable auth
(relay/auth.go) so ONE credential opens BOTH doors (IMAP read + SMTP send). Five
modes now (see auth.py):

  token / fixed   the original #32 modes. The IMAP password resolves directly to
                  an API token (password IS the token, or one configured pair);
                  the proxy holds no per-user secret (token) or one pair (fixed).
  native          validate {username, secret} against the worker POST
                  /api/smtp-auth, the SAME endpoint the Go relay's native backend
                  uses (gated by POSTERN_TRANSPORT_TOKEN).
  ldap            bind username/password against the directory over TLS.
  system          authenticate against local Unix accounts via PAM.

In native/ldap/system the proxy authenticates the USER, then reads the store with
a per-function SERVICE token it holds (POSTERN_API_TOKEN). The env var names
mirror relay/config.go so an operator configures both doors from one vocabulary.
This is a documented posture shift: in token mode the proxy holds NO secret; in
native/ldap/system it holds a per-function service token (see imap/DEPLOY.md).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional

# The auth modes that authenticate the USER and then read the store with the
# proxy-held service token (POSTERN_API_TOKEN). Kept as a set so resolve_token and
# from_env agree on exactly one definition of "service-token mode".
SERVICE_TOKEN_MODES = ("native", "ldap", "system")
ALL_AUTH_MODES = ("token", "fixed") + SERVICE_TOKEN_MODES


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

    # Auth mode (see auth.py / #32 / #77):
    #   "token"  (default): the IMAP *password* IS the Postern API token; the
    #            username is a free label. Zero secrets stored in the proxy.
    #   "fixed": a single configured (username, token) pair; the proxy holds the
    #            token so a normal mail client logs in with a chosen password.
    #   "native": validate the login against the worker POST /api/smtp-auth.
    #   "ldap":  bind the login against the directory over TLS.
    #   "system": authenticate the login against local Unix accounts via PAM.
    auth_mode: str = "token"

    # Used only in "fixed" mode.
    fixed_username: Optional[str] = None
    fixed_token: Optional[str] = None

    # The per-function SERVICE token (POSTERN_API_TOKEN) the proxy uses to READ the
    # store in native/ldap/system modes, AFTER the user is authenticated. Cleanly
    # separated from the auth-the-user step: this token never authenticates the
    # client, it only lets the proxy act as an API client on the client's behalf.
    service_token: Optional[str] = None

    # --- native mode: worker POST /api/smtp-auth (mirrors relay native) ---
    # The endpoint that validates {username, secret}; defaults to the api_url
    # origin + /api/smtp-auth. Gated by the transport token, NOT the API token.
    smtp_auth_url: Optional[str] = None
    transport_token: Optional[str] = None  # POSTERN_TRANSPORT_TOKEN

    # --- ldap mode (mirrors relay/auth_ldap.go env knobs) ---
    ldap_url: Optional[str] = None  # ldaps://host:636 (preferred) or ldap://host:389
    ldap_starttls: bool = False  # upgrade an ldap:// connection before binding
    ldap_bind_dn_template: Optional[str] = None  # simple bind, e.g. uid=%s,ou=people,dc=ex,dc=com
    ldap_bind_dn: Optional[str] = None  # service-account DN for search+bind
    ldap_bind_password: Optional[str] = None  # service-account password
    ldap_search_base: Optional[str] = None  # e.g. ou=people,dc=ex,dc=com
    ldap_search_filter: Optional[str] = None  # e.g. (uid=%s)
    ldap_mail_attr: str = "mail"  # attribute carrying the mail address (informational here)
    # LDAP_TIMEOUT (integer seconds, default 10): bounds BOTH the directory connect
    # and the bind/search operations, so a dead or slow directory cannot hang a
    # login. Shared cross-language contract name: must match the Go relay 1:1
    # (relay/auth_ldap.go DialWithDialer + SetTimeout). 0 disables (no timeout).
    ldap_timeout: int = 10

    # --- system mode (mirrors relay AUTH_SYSTEM_* env knobs) ---
    pam_service: str = "postern"  # AUTH_SYSTEM_PAM_SERVICE, the PAM service name
    system_domain: Optional[str] = None  # AUTH_SYSTEM_DOMAIN, optional display suffix

    # Per-request timeout to the Postern API, seconds.
    api_timeout: float = 15.0

    # --- mailbox windowing + live refresh (#102 Stage 1) ---
    # POSTERN_IMAP_WINDOW: cap INBOX/Sent to the most-recent N messages at SELECT
    # time. Load-on-demand for older mail is via the unbounded All folder, or by
    # raising this value; IMAP cannot grow a folder downward mid-session, so there
    # is no in-folder scroll-back. 0 means unlimited. 500 is a measurement-informed
    # starting point, not gospel: it bounds the cold-sync cost a client pays until a
    # message-size field lands (a client that fetches RFC822.SIZE still hydrates up
    # to W bodies once; envelope/header scans stay body-free regardless).
    imap_window: int = 500
    # POSTERN_IMAP_POLL_SECONDS: while a mailbox is selected, re-poll the store
    # (summary-only, recent end only) on this interval and push untagged EXISTS so
    # new mail surfaces mid-session and IDLE is a real capability, not just an
    # advertised one. The poll uses the same blocking urllib as fetch (one I/O model
    # per stage); a deferToThread variant is a clean follow-up if measurement shows
    # reactor stalls under concurrent SELECTs.
    imap_poll_seconds: int = 30

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Config":
        e = os.environ if env is None else env

        api_url = (e.get("POSTERN_API_URL") or "").strip()
        if not api_url:
            raise ConfigError("POSTERN_API_URL is required (the Postern mailbox API origin)")
        if not api_url.startswith(("http://", "https://")):
            raise ConfigError("POSTERN_API_URL must start with http:// or https://")
        api_url = api_url.rstrip("/")

        # Accept "pam" as a friendly alias for the canonical "system" mode (the Go
        # relay names it AUTH_BACKEND=system; the lead's brief said system/pam).
        auth_mode = (e.get("POSTERN_IMAP_AUTH_MODE") or "token").strip().lower()
        if auth_mode == "pam":
            auth_mode = "system"
        if auth_mode not in ALL_AUTH_MODES:
            raise ConfigError(
                "POSTERN_IMAP_AUTH_MODE must be one of: " + ", ".join(ALL_AUTH_MODES) + " (or 'pam' for system)"
            )

        fixed_username = (e.get("POSTERN_IMAP_USERNAME") or "").strip() or None
        # The token is a secret: read it, never echo it. POSTERN_API_TOKEN doubles
        # as the fixed-mode token AND the native/ldap/system service token.
        api_token = e.get("POSTERN_API_TOKEN") or None

        if auth_mode == "fixed":
            if not fixed_username or not api_token:
                raise ConfigError(
                    "fixed auth mode needs both POSTERN_IMAP_USERNAME and POSTERN_API_TOKEN"
                )

        # native/ldap/system all need the per-function service token to read the
        # store after authenticating the user.
        if auth_mode in SERVICE_TOKEN_MODES and not api_token:
            raise ConfigError(
                f"{auth_mode} auth mode needs POSTERN_API_TOKEN (the per-function service token the proxy reads the store with)"
            )

        smtp_auth_url = (e.get("POSTERN_SMTP_AUTH_URL") or "").strip() or None
        transport_token = e.get("POSTERN_TRANSPORT_TOKEN") or None
        if auth_mode == "native":
            if not transport_token:
                raise ConfigError(
                    "native auth mode needs POSTERN_TRANSPORT_TOKEN (the transport-seam bearer for POST /api/smtp-auth)"
                )
            if not smtp_auth_url:
                # Mirror the relay default: the smtp-auth check lives on the same origin.
                smtp_auth_url = api_url + "/api/smtp-auth"
            if not smtp_auth_url.startswith(("http://", "https://")):
                raise ConfigError("POSTERN_SMTP_AUTH_URL must start with http:// or https://")

        ldap_url = (e.get("LDAP_URL") or "").strip() or None
        ldap_starttls = _bool(e, "LDAP_STARTTLS", False)
        ldap_bind_dn_template = (e.get("LDAP_BIND_DN_TEMPLATE") or "").strip() or None
        ldap_bind_dn = (e.get("LDAP_BIND_DN") or "").strip() or None
        ldap_bind_password = e.get("LDAP_BIND_PASSWORD") or None
        ldap_search_base = (e.get("LDAP_SEARCH_BASE") or "").strip() or None
        ldap_search_filter = (e.get("LDAP_SEARCH_FILTER") or "").strip() or None
        ldap_mail_attr = (e.get("LDAP_MAIL_ATTR") or "mail").strip() or "mail"
        ldap_timeout = _int(e, "LDAP_TIMEOUT", 10)
        if ldap_timeout < 0:
            raise ConfigError("LDAP_TIMEOUT must be >= 0 (0 disables the timeout)")
        if auth_mode == "ldap":
            if not ldap_url:
                raise ConfigError("ldap auth mode needs LDAP_URL")
            secure = ldap_url.lower().startswith("ldaps://") or ldap_starttls
            if not secure:
                raise ConfigError(
                    "ldap auth requires TLS: use an ldaps:// LDAP_URL or set LDAP_STARTTLS=true"
                )
            has_simple = bool(ldap_bind_dn_template)
            has_search = bool(ldap_bind_dn and ldap_search_base and ldap_search_filter)
            if not has_simple and not has_search:
                raise ConfigError(
                    "ldap auth needs LDAP_BIND_DN_TEMPLATE (simple bind) or "
                    "LDAP_BIND_DN + LDAP_SEARCH_BASE + LDAP_SEARCH_FILTER (search+bind)"
                )

        pam_service = (e.get("AUTH_SYSTEM_PAM_SERVICE") or "postern").strip() or "postern"
        system_domain = (e.get("AUTH_SYSTEM_DOMAIN") or "").strip() or None

        cert = (e.get("POSTERN_IMAP_TLS_CERT") or "").strip() or None
        key = (e.get("POSTERN_IMAP_TLS_KEY") or "").strip() or None
        if bool(cert) != bool(key):
            raise ConfigError("set both POSTERN_IMAP_TLS_CERT and POSTERN_IMAP_TLS_KEY, or neither")

        imap_window = _int(e, "POSTERN_IMAP_WINDOW", 500)
        if imap_window < 0:
            raise ConfigError("POSTERN_IMAP_WINDOW must be >= 0 (0 means unlimited)")
        imap_poll_seconds = _int(e, "POSTERN_IMAP_POLL_SECONDS", 30)
        if imap_poll_seconds < 0:
            raise ConfigError("POSTERN_IMAP_POLL_SECONDS must be >= 0 (0 disables the poll)")

        return cls(
            api_url=api_url,
            listen_host=(e.get("POSTERN_IMAP_HOST") or "127.0.0.1").strip(),
            listen_port=_int(e, "POSTERN_IMAP_PORT", 1143),
            tls_cert=cert,
            tls_key=key,
            auth_mode=auth_mode,
            fixed_username=fixed_username,
            fixed_token=api_token if auth_mode == "fixed" else None,
            service_token=api_token,
            smtp_auth_url=smtp_auth_url,
            transport_token=transport_token,
            ldap_url=ldap_url,
            ldap_starttls=ldap_starttls,
            ldap_bind_dn_template=ldap_bind_dn_template,
            ldap_bind_dn=ldap_bind_dn,
            ldap_bind_password=ldap_bind_password,
            ldap_search_base=ldap_search_base,
            ldap_search_filter=ldap_search_filter,
            ldap_mail_attr=ldap_mail_attr,
            ldap_timeout=ldap_timeout,
            pam_service=pam_service,
            system_domain=system_domain,
            api_timeout=_float(e, "POSTERN_API_TIMEOUT", 15.0),
            imap_window=imap_window,
            imap_poll_seconds=imap_poll_seconds,
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


def _bool(e: Mapping[str, str], name: str, default: bool) -> bool:
    raw = e.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")

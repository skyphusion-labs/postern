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
native/ldap/system it holds a per-function service token (see imap/README.md).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping, Optional

from . import proxyproto

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

    # --- ldap mode (mirrors relay/auth_ldap.go env knobs, byte-symmetric #182) ---
    # Direct-bind + self-read is the model of record (docs/AUTH-CONTRACT.md 5b):
    # the door binds AS the templated user DN (auth success == bind success) and,
    # when a group gate is configured, self-reads that user's OWN entry for the
    # authz check. The search+bind path (privileged service account) is RETIRED on
    # both doors; its env vars (LDAP_BIND_DN / LDAP_BIND_PASSWORD / LDAP_SEARCH_*)
    # are a loud startup error, never silently ignored. LDAP_MAIL_ATTR is relay-only
    # (the IMAP door reads the store with its service token, not the directory mail).
    ldap_url: Optional[str] = None  # ldaps://host:636 (preferred) or ldap://host:389
    ldap_starttls: bool = False  # upgrade an ldap:// connection before binding
    ldap_bind_dn_template: Optional[str] = None  # direct-bind DN template, e.g. cn=%s,ou=users,dc=ex,dc=com
    # LDAP_REQUIRE_GROUP: a group DN the bound user must carry in LDAP_GROUP_ATTR on
    # a base-scope self-read of their own entry (the mail-users authz gate). Empty =
    # no gate (today's behavior). When set the gate is FAIL-CLOSED: a failed or
    # empty self-read, or an entry without the group, DENIES the login.
    ldap_require_group: Optional[str] = None
    ldap_group_attr: str = "memberOf"  # LDAP_GROUP_ATTR, the attribute listing the user's groups
    # --- TLS-to-directory trust (#153; same knobs + semantics as the Go relay) ---
    # LDAP_TLS_CA: PEM CA bundle path; when set it is the ONLY trust anchor (full
    # verification against a pinned root, never added to the system roots).
    # LDAP_TLS_PIN_SHA256: exact-leaf SHA-256 pin (hex, colons optional, any case),
    # SAN-independent -- THE mechanism for Authentik's default outpost cert.
    # Mutually exclusive with LDAP_TLS_CA. Neither set = the channel is encrypted
    # but UNAUTHENTICATED (CERT_NONE, today's behavior) and the proxy logs a loud
    # startup warning.
    ldap_tls_ca: Optional[str] = None
    ldap_tls_server_name: Optional[str] = None  # LDAP_TLS_SERVER_NAME, extra accepted cert name (CA mode)
    ldap_tls_pin_sha256: Optional[str] = None
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

    # POSTERN_IMAP_UIDVALIDITY: the mailbox UIDVALIDITY (RFC 3501), a positive 32-bit
    # value. Constant across reconnects so a client's cached UID->message map stays
    # valid; the OPERATOR bumps it when the server-side PROJECTION of existing messages
    # changes (their BODY[]/RFC822.SIZE flips under the same UID), which invalidates
    # client body caches per the RFC's message-immutability rule. Defaults to 1 (the
    # historical constant), so nothing changes until an operator raises it. (#210: the
    # HTML/8bit projection change is the first event that requires a bump on deploy.)
    imap_uidvalidity: int = 1

    # --- Stage-1 read-path measurement (#102 / GO-LIVE 0.6) ---
    # POSTERN_IMAP_MEASURE: when true, the proxy emits additive, structured
    # `@measure <event> {json}` lines (Twisted log -> journald) for cold-sync cost +
    # window saturation, per-request API latency, the live-refresh poll's reactor-
    # thread blocking time, and lazy-body hydration. OFF by default and behaviour-
    # neutral: disabled, every hook is a no-op, so the read path is byte-for-byte the
    # un-instrumented path. No message content or token is ever emitted -- only counts,
    # sizes, and timings. See measure.py + imap/MEASUREMENT.md for the event catalogue.
    measure: bool = False

    # --- auth brute-force throttle (#105) ---
    # RATIFIED cross-door contract: identical AUTH_THROTTLE_* knobs on the SMTP
    # relay (587) and this IMAP door (993), integer seconds. Account-keyed +
    # a global spread-spray backstop. See throttle.py / docs/AUTH-CONTRACT.md.
    throttle_enabled: bool = True
    throttle_max_failures: int = 5  # per-account consecutive failures before lockout
    throttle_lockout_seconds: int = 60  # base lockout; doubles per failure past threshold
    throttle_max_lockout_seconds: int = 900  # backoff cap
    throttle_global_max_failures: int = 100  # aggregate failures/window before global cooldown (0 = off)
    throttle_global_window_seconds: int = 60  # aggregate window + cooldown

    # --- PROXY protocol on the listener edge (#155) ---
    # The mail edge moved to a single L4 load balancer targeting the directory host
    # directly (no bastion). An L4 LB rewrites the source address, so the door
    # recovers the REAL client IP from a PROXY header the LB prepends, HONORED ONLY
    # from a trusted source (anti-spoof). Config names (PROXY_PROTOCOL /
    # PROXY_PROTOCOL_TRUSTED / PROXY_PROTOCOL_TIMEOUT_SECONDS) are shared 1:1 with the
    # Go 587 door per docs/PROXY-PROTOCOL.md. Default off = the listener is not
    # wrapped at all (byte-for-byte the prior behavior). See proxyproto.py / proxywrap.py.
    proxy_protocol: proxyproto.ProxyProtocolConfig = field(
        default_factory=proxyproto.ProxyProtocolConfig
    )

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
        ldap_require_group = (e.get("LDAP_REQUIRE_GROUP") or "").strip() or None
        ldap_group_attr = (e.get("LDAP_GROUP_ATTR") or "memberOf").strip() or "memberOf"
        ldap_tls_ca = (e.get("LDAP_TLS_CA") or "").strip() or None
        ldap_tls_server_name = (e.get("LDAP_TLS_SERVER_NAME") or "").strip() or None
        ldap_tls_pin_sha256 = (e.get("LDAP_TLS_PIN_SHA256") or "").strip() or None
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
            # Direct-bind is the only bind mode (parity with the Go relay, #182).
            # The retired search+bind vars fail LOUD so an operator carrying an old
            # EnvironmentFile learns at startup, not from silently-changed auth.
            retired = [
                k
                for k in (
                    "LDAP_BIND_DN",
                    "LDAP_BIND_PASSWORD",
                    "LDAP_SEARCH_BASE",
                    "LDAP_SEARCH_FILTER",
                )
                if (e.get(k) or "").strip()
            ]
            if retired:
                raise ConfigError(
                    "the LDAP search+bind path is retired (#182, docs/AUTH-CONTRACT.md 5b): unset "
                    + ", ".join(retired)
                    + " and use LDAP_BIND_DN_TEMPLATE (direct-bind + self-read)"
                )
            if not ldap_bind_dn_template:
                raise ConfigError(
                    "ldap auth needs LDAP_BIND_DN_TEMPLATE for direct-bind "
                    "(e.g. cn=%s,ou=users,dc=ldap,dc=goauthentik,dc=io)"
                )
            if ldap_tls_ca and ldap_tls_pin_sha256:
                raise ConfigError(
                    "ldap tls: set LDAP_TLS_CA or LDAP_TLS_PIN_SHA256, not both "
                    "(they are different trust models)"
                )
            if ldap_tls_pin_sha256:
                # Validate the pin shape at startup (never start with a malformed
                # pin that would reject every cert); the value itself is non-secret.
                normalize_pin_sha256(ldap_tls_pin_sha256)

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
        imap_uidvalidity = _int(e, "POSTERN_IMAP_UIDVALIDITY", 1)
        if imap_uidvalidity < 1 or imap_uidvalidity > 0xFFFFFFFF:
            raise ConfigError(
                "POSTERN_IMAP_UIDVALIDITY must be a positive 32-bit integer (1..4294967295)"
            )
        measure = _bool(e, "POSTERN_IMAP_MEASURE", False)

        # Auth throttle (#105). Door-agnostic AUTH_THROTTLE_* names, integer seconds,
        # shared verbatim with the relay so one vocabulary configures both doors.
        throttle_enabled = _bool(e, "AUTH_THROTTLE_ENABLED", True)
        throttle_max_failures = _int(e, "AUTH_THROTTLE_MAX_FAILURES", 5)
        throttle_lockout_seconds = _int(e, "AUTH_THROTTLE_LOCKOUT_SECONDS", 60)
        throttle_max_lockout_seconds = _int(e, "AUTH_THROTTLE_MAX_LOCKOUT_SECONDS", 900)
        throttle_global_max_failures = _int(e, "AUTH_THROTTLE_GLOBAL_MAX_FAILURES", 100)
        throttle_global_window_seconds = _int(e, "AUTH_THROTTLE_GLOBAL_WINDOW_SECONDS", 60)
        for _name, _val in (
            ("AUTH_THROTTLE_MAX_FAILURES", throttle_max_failures),
            ("AUTH_THROTTLE_LOCKOUT_SECONDS", throttle_lockout_seconds),
            ("AUTH_THROTTLE_MAX_LOCKOUT_SECONDS", throttle_max_lockout_seconds),
            ("AUTH_THROTTLE_GLOBAL_MAX_FAILURES", throttle_global_max_failures),
            ("AUTH_THROTTLE_GLOBAL_WINDOW_SECONDS", throttle_global_window_seconds),
        ):
            if _val < 0:
                raise ConfigError(f"{_name} must be >= 0")

        # PROXY protocol (#155). Parse + validate eagerly so a misconfigured edge
        # fails at startup, not on the first connection. Identical names + rules to
        # the Go door (relay/config.go): an enabled mode REQUIRES a trusted set (an
        # enabled door with no trusted source could honor no header at all), and the
        # header-read timeout is floored at 1s.
        proxy_mode = (e.get("PROXY_PROTOCOL") or proxyproto.OFF).strip().lower()
        if proxy_mode not in proxyproto.MODES:
            raise ConfigError(
                "PROXY_PROTOCOL must be one of: " + ", ".join(proxyproto.MODES)
            )
        try:
            proxy_trusted = proxyproto.parse_trusted(e.get("PROXY_PROTOCOL_TRUSTED") or "")
        except ValueError as exc:
            raise ConfigError(str(exc)) from exc
        if proxy_mode in (proxyproto.OPTIONAL, proxyproto.REQUIRE) and not proxy_trusted:
            raise ConfigError(
                f"PROXY_PROTOCOL={proxy_mode} requires PROXY_PROTOCOL_TRUSTED "
                "(>=1 CIDR of the trusted proxy source)"
            )
        proxy_timeout_secs = _int(e, "PROXY_PROTOCOL_TIMEOUT_SECONDS", 5)
        if proxy_timeout_secs < 1:
            proxy_timeout_secs = 1  # floored at 1s, matching the Go door
        proxy_protocol = proxyproto.ProxyProtocolConfig(
            mode=proxy_mode, trusted=proxy_trusted, timeout=float(proxy_timeout_secs)
        )

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
            ldap_require_group=ldap_require_group,
            ldap_group_attr=ldap_group_attr,
            ldap_tls_ca=ldap_tls_ca,
            ldap_tls_server_name=ldap_tls_server_name,
            ldap_tls_pin_sha256=ldap_tls_pin_sha256,
            ldap_timeout=ldap_timeout,
            pam_service=pam_service,
            system_domain=system_domain,
            api_timeout=_float(e, "POSTERN_API_TIMEOUT", 15.0),
            imap_window=imap_window,
            imap_poll_seconds=imap_poll_seconds,
            imap_uidvalidity=imap_uidvalidity,
            measure=measure,
            throttle_enabled=throttle_enabled,
            throttle_max_failures=throttle_max_failures,
            throttle_lockout_seconds=throttle_lockout_seconds,
            throttle_max_lockout_seconds=throttle_max_lockout_seconds,
            throttle_global_max_failures=throttle_global_max_failures,
            throttle_global_window_seconds=throttle_global_window_seconds,
            proxy_protocol=proxy_protocol,
        )


def normalize_pin_sha256(s: str) -> bytes:
    """Parse an LDAP_TLS_PIN_SHA256 value into its 32 raw bytes (#153).

    Accepts the common fingerprint spellings -- colon-separated or bare hex, any
    case, surrounding whitespace -- so an operator can paste `openssl x509
    -fingerprint -sha256` output directly. A SHA-256 is 32 bytes / 64 hex chars;
    anything else is a loud ConfigError (we never start with a malformed pin that
    would reject every cert). Mirrors relay/auth_ldap.go normalizePinSHA256.
    """
    clean = "".join(c for c in s if c not in ": \t\r\n").lower()
    try:
        raw = bytes.fromhex(clean)
    except ValueError as exc:
        raise ConfigError("LDAP_TLS_PIN_SHA256 is not valid hex") from exc
    if len(raw) != 32:
        raise ConfigError(
            f"LDAP_TLS_PIN_SHA256 must be a 32-byte SHA-256 (64 hex chars), got {len(raw)} bytes"
        )
    return raw


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

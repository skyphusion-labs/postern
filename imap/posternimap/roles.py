"""Role-address membership, read from the Worker (#438).

SINGLE SOURCE. Membership used to be configured TWICE: POSTERN_VIEWER_ROLES on the
Worker (the webmail half, #425) and POSTERN_IMAP_VIEWER_ROLES here (#404), the same
syntax with the same refusal set, kept equal by an operator. Two configurations of one
fact drift, and the drift IS the divergence #425 exists to close: whichever side is
broader shows a queue to someone the other side does not. The Worker map is now the only
source, and this module reads it.

WHY A FETCH IS SAFE HERE, WHICH IS NOT WHAT #425 CONCLUDED. #425 refused a fetch because
it would put a network dependency in front of a FAIL-CLOSED STARTUP: one flake at boot
would read as "nobody is on any queue". That reasoning was about STARTUP, and nothing
here runs there. The door is a PROXY, not a store: LIST, SELECT, FETCH and /api/folders
are all Worker calls, so a Worker this door cannot reach is already a mailbox with no
mail in it. Reading membership over the same connection adds no failure mode the session
does not already have. The fetch happens per session on the first LIST or SELECT, both of
which Twisted runs through the thread pool (threaded.ThreadedAccount), so it never blocks
the reactor -- the synchronous account accessors read a map that is already in memory.

FAIL-CLOSED, UNCHANGED. A fetch that fails -- unreachable, timed out, 401/403 from a
mis-provisioned token, 404 from a Worker older than #438 -- yields NO roles for that
session, loudly, and is retried on the next login. There is deliberately NO on-disk
last-known-good: the door ships as a stateless container, and a cache that outlived the
process would keep a REVOKED member reading a queue after the operator removed them.
Staleness is bounded by the TTL, and only in the permissive direction.

WHERE THE REFUSAL SET LIVES NOW. The Worker parses POSTERN_VIEWER_ROLES and drops the
WHOLE map on any malformed or ambiguous entry (inbound/src/roles.ts): an unusable config
projects as an EMPTY map, so this door inherits that refusal by construction rather than
re-implementing it and drifting from it, which is the whole point of #438. What is
validated HERE is only what the Worker cannot own: the STRUCTURE of the response, because
a door that built folders out of arbitrary JSON would be trusting a parser it does not
have; and the one DOOR invariant, that two roles must not share a local part, because
both would then publish as one folder name. Either kind of violation drops the WHOLE map,
for the Worker reason exactly: half a membership map is indistinguishable from having
been taken off the queue.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, Mapping, Optional, Tuple

from .client import PosternClient, PosternError
from .config import Config, role_folder_name

_log = logging.getLogger(__name__)

# Process-wide cache: (expiry on the monotonic clock, map). Shared by every session
# because the map is ESTATE config and not a per-login fact, so the door pays one fetch
# per TTL rather than one per login. Only a SUCCESSFUL parse is ever stored: a failed
# fetch or a refused payload caches nothing, so the next login retries instead of
# inheriting a failure.
_LOCK = threading.Lock()
_CACHE: Optional[Tuple[float, Mapping[str, tuple]]] = None


class RolePayloadError(ValueError):
    """The Worker answered with something this door will not build folders from."""


def parse_role_payload(payload: Any) -> Dict[str, tuple]:
    """Validate the GET /api/imap/roles body into {role: (member, ...)}, or raise.

    STRUCTURE plus one door invariant, and nothing else: the semantic refusals (a role
    that lists itself, an address used as both a queue and a person, a role with no
    members declared twice, ...) are the WORKER parser refusals, and a config that trips
    them never reaches this door as a map at all -- it arrives as the empty projection.
    Re-deriving them here would recreate the second parser #438 exists to delete.
    """
    if not isinstance(payload, dict):
        raise RolePayloadError("the response is not a JSON object")
    roles = payload.get("roles")
    if not isinstance(roles, list):
        raise RolePayloadError("the response carries no roles list")
    out: Dict[str, tuple] = {}
    localparts: Dict[str, str] = {}
    for entry in roles:
        if not isinstance(entry, dict):
            raise RolePayloadError("a roles entry is not an object")
        address = entry.get("address")
        if not isinstance(address, str):
            raise RolePayloadError("a roles entry carries no address string")
        role = address.strip().lower()
        if not role or "@" not in role:
            raise RolePayloadError(
                "role address %r is not a full mail address" % address
            )
        if role in out:
            raise RolePayloadError("the role %r is listed twice" % role)
        local = role.split("@", 1)[0]
        if local in localparts:
            raise RolePayloadError(
                "roles %r and %r share the local part %r, so both would publish as the "
                "folder %s; give them distinct local parts"
                % (localparts[local], role, local, role_folder_name(role))
            )
        raw_members = entry.get("members")
        if not isinstance(raw_members, list):
            raise RolePayloadError("the role %r carries no members list" % role)
        members: list = []
        for raw in raw_members:
            if not isinstance(raw, str):
                raise RolePayloadError("the role %r has a non-string member" % role)
            member = raw.strip().lower()
            if not member or "@" not in member:
                raise RolePayloadError(
                    "the role %r has the member %r, which is not a full mail address"
                    % (role, raw)
                )
            if member not in members:
                members.append(member)
        if not members:
            raise RolePayloadError("the role %r has no members" % role)
        localparts[local] = role
        out[role] = tuple(members)
    return out


def viewer_roles(cfg: Config, client: Optional[PosternClient]) -> Mapping[str, tuple]:
    """The role map this door should act on: fetched, cached, or EMPTY.

    Empty is the fail-closed answer everywhere it appears, and every path that produces
    it says so out loud, because a queue that quietly stops being visible is the #404
    failure mode this feature exists to end.
    """
    if cfg.viewer_mode != "per_account":
        # Estate mode has no viewer address to check membership against, so a role folder
        # is unreachable by construction (role_folders_for refuses a viewer of None) and
        # there is nothing to fetch a map FOR. This is not the silent no-op the old
        # startup error guarded against: the map still applies on the Worker, which is
        # where it is configured and where webmail reads it.
        return {}
    if client is None:
        _log.warning(
            "postern-imap: POSTERN_IMAP_VIEWER_MODE=per_account without "
            "POSTERN_API_TOKEN_IMAP. Role membership is read from the Worker over the "
            "imap-scoped seam since #438, so NO role queue can be served until that "
            "per-function token is provisioned."
        )
        return {}

    global _CACHE
    with _LOCK:
        cached = _CACHE
        if cached is not None:
            if cached[0] > time.monotonic():
                return cached[1]
            # EXPIRED, so drop it before the refetch: a refetch that fails must not fall
            # back onto a stale membership, or a member the operator removed keeps the
            # queue. The TTL is the revocation bound and this is what enforces it.
            _CACHE = None

    try:
        parsed = parse_role_payload(client.get_roles())
    except PosternError as exc:
        _log.warning(
            "postern-imap: cannot read role membership from the Worker (%s); serving NO "
            "role queue this session, retrying on the next login. A 404 means the Worker "
            "predates #438 (deploy the Worker first); a 403 means the imap-scoped token "
            "is not the one the Worker gates on.",
            exc,
        )
        return {}
    except RolePayloadError as exc:
        _log.warning(
            "postern-imap: refusing the ENTIRE role map the Worker returned (%s). Half a "
            "membership map reads exactly like being taken off the queue, so no role "
            "queue is served at all.",
            exc,
        )
        return {}

    with _LOCK:
        _CACHE = (time.monotonic() + cfg.roles_ttl, parsed)
    return parsed


def reset_cache() -> None:
    """Drop the cached map.

    Test seam, and the honest kind: a suite drives many Worker answers through one
    module instance, and a process-wide cache would otherwise leak the first one into
    every case after it (the same reason inbound/src/roles.ts exports resetRoleCache).
    """
    global _CACHE
    with _LOCK:
        _CACHE = None

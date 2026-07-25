// Role-address membership for BOUND WEBMAIL SESSIONS (#425, the webmail half of the
// #404 ruling of 2026-07-25).
//
// A role address (abuse@, security@, support@) belongs to a FUNCTION, so under a
// per-viewer door it is nobody address and its mail is delivered, stored, searchable
// and visible to NO human. The IMAP door closed that with POSTERN_IMAP_VIEWER_ROLES
// (PR #423): a viewer resolves to a SET -- its own address V plus every role V is a
// member of -- and each role publishes as its OWN folder, never merged into INBOX.
// Webmail scopes to the single bound session identity, so without this module the two
// human doors disagree about what one person may see.
//
// FORMAT (identical to the door, deliberately): role=member+member,role2=member --
// commas separate roles, + separates members, and BOTH sides are full mail addresses.
// Everything is lower-cased and whitespace around any token is tolerated.
//
// WHY A SECOND VAR, AND WHAT IT COSTS. The door parses its own env at startup and
// must keep doing so: making it fetch membership from the worker would put a network
// dependency in front of a fail-closed startup, so one flake would read as "nobody is
// on any queue". The repo precedent is the other direction and it works -- the
// AUTH_THROTTLE_* knobs are ONE vocabulary configured verbatim on two doors. The cost
// is operator DRIFT: POSTERN_VIEWER_ROLES here and POSTERN_IMAP_VIEWER_ROLES on the
// door can disagree, which is the very divergence #425 exists to close. Three things
// bound it: the refusal set below is a port of the door _parse_viewer_roles, so a
// config the door refuses to START on is refused here too (one config is legal or
// illegal identically on both doors); the mirroring rule and deploy ordering are
// documented (docs/CONTRACT.md, webmail/README.md, imap/README.md); and GET /api/roles
// exposes the parsed map to an operator token so the two can be DIFFED instead of
// assumed. Single-source promotion is tracked as a follow-up, not done here.
//
// FAIL-CLOSED, AND WHY IT DIFFERS FROM FILE_ALSO_UNDER. ANY malformed or ambiguous
// entry drops the WHOLE map (not just that entry): a silently dropped member reads
// exactly like "that person is not on the queue", which is the #404 failure mode
// again. FILE_ALSO_UNDER skips-and-logs per entry because it sits on the DELIVERY
// path, where refusing costs MAIL; this sits on the READ path, where refusing costs
// ACCESS only. Losing access to a queue is loud and reversible by fixing the config;
// half a membership map is silent and is not.

/** A parse refusal. Never surfaced to a caller: it drops the map and is logged. */
class RoleConfigError extends Error {}

// Parse cache. A Worker has no startup phase to fail at, so the map is parsed on
// demand and memoized on the RAW STRING: a config change (new deploy, new isolate)
// re-parses, and a hot isolate never re-parses the same text.
let cachedRaw: string | null = null;
let cachedMap: ReadonlyMap<string, readonly string[]> = new Map();

const EMPTY: ReadonlyMap<string, readonly string[]> = new Map();

/** Parse POSTERN_VIEWER_ROLES into {role: [member, ...]}, or THROW (#425).
 *
 *  Exported for the suite: the caller-facing entry point (roleMap) turns every throw
 *  into an empty map, so the refusal set is only assertable directly. The refusals are
 *  a port of imap/posternimap/config.py _parse_viewer_roles, entry for entry:
 *  no "=", an empty side, a missing "@" on either side, a role listed twice, a role
 *  that lists itself, an address used as BOTH a role and a member, a role with no
 *  members, and two roles whose local parts collide (which is a DOOR folder-naming
 *  constraint, kept here purely so both doors accept exactly the same configs). */
export function parseViewerRoles(raw: string | undefined | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!raw || !raw.trim()) return out;
  const localParts = new Map<string, string>();
  for (const chunk of raw.split(",")) {
    const entry = chunk.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) {
      throw new RoleConfigError(`entries must be role=member+member (got ${entry})`);
    }
    const role = entry.slice(0, eq).trim().toLowerCase();
    if (!role || !role.includes("@")) {
      throw new RoleConfigError(
        `entry ${entry} needs a full role address on the left (e.g. abuse@example.org=ada@example.org)`,
      );
    }
    if (out.has(role)) {
      throw new RoleConfigError(
        `lists the role ${role} twice; put every member of a role in ONE entry (role=a@x+b@x)`,
      );
    }
    const local = role.slice(0, role.indexOf("@"));
    const clash = localParts.get(local);
    if (clash) {
      throw new RoleConfigError(
        `roles ${clash} and ${role} share the local part ${local}, so both would publish as one ` +
          "folder; give them distinct local parts",
      );
    }
    const members: string[] = [];
    for (const rawMember of entry.slice(eq + 1).split("+")) {
      const member = rawMember.trim().toLowerCase();
      if (!member || !member.includes("@")) {
        throw new RoleConfigError(
          `entry ${entry} needs full member addresses on the right, separated by + ` +
            "(e.g. abuse@x.org=ada@x.org+ben@x.org)",
        );
      }
      if (member === role) {
        throw new RoleConfigError(`role ${role} lists itself as a member`);
      }
      if (!members.includes(member)) members.push(member);
    }
    if (members.length === 0) {
      throw new RoleConfigError(
        `role ${role} has no members; remove the role or give it at least one member address`,
      );
    }
    localParts.set(local, role);
    out.set(role, members);
  }
  const everyMember = new Set<string>();
  for (const members of out.values()) for (const m of members) everyMember.add(m);
  const both = [...out.keys()].filter((role) => everyMember.has(role)).sort();
  if (both.length) {
    throw new RoleConfigError(
      `uses ${both.join(", ")} as BOTH a role address and a member address; an address is ` +
        "either a queue or a person, never both",
    );
  }
  return out;
}

/** The parsed role map, or an EMPTY map if the config is unusable (#425).
 *
 *  Unset, empty, or unparseable all resolve to no roles at all: no role folder is
 *  enumerated, no role read is possible, and every surface behaves exactly as it did
 *  before this feature. The log names the offending ENTRY (operator config text, an
 *  address at worst, never a credential) rather than dumping the whole raw var, so the
 *  line stays greppable. */
export function roleMap(env: Env): ReadonlyMap<string, readonly string[]> {
  const raw = env.POSTERN_VIEWER_ROLES ?? "";
  if (raw === cachedRaw) return cachedMap;
  let parsed: ReadonlyMap<string, readonly string[]>;
  try {
    parsed = parseViewerRoles(raw);
  } catch (err) {
    // Fail CLOSED on the whole map (see the header note): a partially applied
    // membership map is indistinguishable from "that person is not on the queue".
    console.error(
      "POSTERN_VIEWER_ROLES: refusing the ENTIRE map, no role queue is served:",
      err instanceof Error ? err.message : String(err),
    );
    parsed = EMPTY;
  }
  cachedRaw = raw;
  cachedMap = parsed;
  return parsed;
}

/** The role addresses this viewer may read, in config order (#425).
 *
 *  A viewer of undefined/empty yields NOTHING: membership is unanswerable without V,
 *  and the fail-closed answer is no roles, never a guess. Mirrors the door
 *  role_folders_for, which makes the same call for the same reason. */
export function rolesForViewer(env: Env, viewer: string | undefined | null): string[] {
  const v = viewer?.trim().toLowerCase();
  if (!v) return [];
  const out: string[] = [];
  for (const [role, members] of roleMap(env)) {
    if (members.includes(v)) out.push(role);
  }
  return out;
}

/** Reset the parse cache. Test-only seam: suites drive many env shapes through one
 *  module instance, and a raw-string cache would otherwise leak the first one. */
export function resetRoleCache(): void {
  cachedRaw = null;
  cachedMap = EMPTY;
}

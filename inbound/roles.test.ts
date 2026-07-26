// #425: the worker-side role-membership map (POSTERN_VIEWER_ROLES), which is what lets
// a bound webmail session read a role queue at all.
//
// The load-bearing property is a REFUSAL, so the refusals are what this suite is for:
// every malformed or ambiguous config must drop the WHOLE map, because a partially
// applied membership map is indistinguishable from "that person is not on the queue",
// which is the #404 failure mode this feature exists to end. The refusal set is a port
// of the IMAP door _parse_viewer_roles (imap/posternimap/config.py), entry for entry,
// so a config the door refuses to START on cannot be silently honored here: those two
// vars are mirrors, and a mirror that accepts more than its twin is drift with a
// friendly face.
//
// Every refusal case is paired with a POSITIVE CONTROL (the valid map right above it
// parses and yields members), because a suite of negatives over a dead code path all
// pass for the wrong reason.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseViewerRoles, roleMap, rolesForViewer, resetRoleCache } from "./src/roles";

const ROLE = "abuse@skyphusion.org";
const ADA = "ada@skyphusion.org";
const BEN = "ben@skyphusion.org";
const VALID = `${ROLE}=${ADA}+${BEN}`;

function envWith(raw: string | undefined): Env {
  return { POSTERN_VIEWER_ROLES: raw } as unknown as Env;
}

beforeEach(() => {
  resetRoleCache();
});

describe("parseViewerRoles: the shape the door accepts, and nothing else", () => {
  it("parses the canonical shape, tolerating case and whitespace (POSITIVE CONTROL)", () => {
    const map = parseViewerRoles(" Abuse@Skyphusion.ORG = Ada@skyphusion.org + ben@skyphusion.org ,");
    expect([...map.keys()]).toEqual([ROLE]);
    expect(map.get(ROLE)).toEqual([ADA, BEN]);
  });

  it("dedupes a member listed twice rather than refusing", () => {
    const map = parseViewerRoles(`${ROLE}=${ADA}+${ADA}`);
    expect(map.get(ROLE)).toEqual([ADA]);
  });

  it("returns an empty map for unset and empty input", () => {
    expect(parseViewerRoles(undefined).size).toBe(0);
    expect(parseViewerRoles("").size).toBe(0);
    expect(parseViewerRoles("   ").size).toBe(0);
  });

  const refused: Array<[string, string]> = [
    ["an entry with no =", `${ROLE}`],
    ["an empty role side", `=${ADA}`],
    ["a role with no @", `abuse=${ADA}`],
    ["a member with no @", `${ROLE}=ada`],
    ["an empty member side", `${ROLE}=`],
    ["a role listed twice", `${ROLE}=${ADA},${ROLE}=${BEN}`],
    ["a role that lists itself", `${ROLE}=${ROLE}`],
    ["an address used as BOTH a role and a member", `${ROLE}=${ADA},${ADA}=${BEN}`],
    ["two roles sharing a local part", `${ROLE}=${ADA},abuse@other.example=${BEN}`],
  ];
  for (const [name, raw] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => parseViewerRoles(raw)).toThrow();
    });
  }
});

describe("roleMap: an unusable config serves NO queue at all (fail-closed)", () => {
  it("drops the WHOLE map on one bad entry, valid entries included", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The first entry is perfectly good; the second is not. Keeping the first is the
    // tempting behavior and the wrong one: half a membership map reads to a member
    // exactly like being taken off the queue.
    const map = roleMap(envWith(`${VALID},broken-entry-without-eq`));
    expect(map.size).toBe(0);
    expect(rolesForViewer(envWith(`${VALID},broken-entry-without-eq`), ADA)).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("POSITIVE CONTROL: the same map without the bad entry does serve the queue", () => {
    expect(roleMap(envWith(VALID)).size).toBe(1);
    expect(rolesForViewer(envWith(VALID), ADA)).toEqual([ROLE]);
  });

  it("caches on the RAW string, so a config change re-parses", () => {
    expect(rolesForViewer(envWith(VALID), ADA)).toEqual([ROLE]);
    expect(rolesForViewer(envWith(""), ADA)).toEqual([]);
    expect(rolesForViewer(envWith(VALID), ADA)).toEqual([ROLE]);
  });
});

describe("rolesForViewer: membership is answered for a viewer, or not at all", () => {
  it("gives a member its queues, in config order", () => {
    const raw = `${ROLE}=${ADA}+${BEN},security@skyphusion.org=${ADA}`;
    expect(rolesForViewer(envWith(raw), ADA)).toEqual([ROLE, "security@skyphusion.org"]);
    expect(rolesForViewer(envWith(raw), BEN)).toEqual([ROLE]);
  });

  it("gives a NON-member nothing", () => {
    expect(rolesForViewer(envWith(VALID), "carol@skyphusion.org")).toEqual([]);
  });

  it("gives an unresolvable viewer nothing (membership is unanswerable without V)", () => {
    expect(rolesForViewer(envWith(VALID), undefined)).toEqual([]);
    expect(rolesForViewer(envWith(VALID), "")).toEqual([]);
    expect(rolesForViewer(envWith(VALID), "   ")).toEqual([]);
  });

  it("matches a member case-insensitively, as the map is lower-cased", () => {
    expect(rolesForViewer(envWith(VALID), "Ada@Skyphusion.ORG")).toEqual([ROLE]);
  });
});

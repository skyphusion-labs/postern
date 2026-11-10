import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { sha256Hex } from "./src/sendidentity";
import { realEnv, putInbound } from "./realdb";

// The write scope of the organize routes (seen, flags, move) follows the BOUND identity,
// whatever its other caps. Real sqlite engine built from schema.sql, through the real
// handleApi, for BOTH ways a Bearer resolves to an identity: a runtime identity minted
// through /api/admin/identities, and an entry in the POSTERN_SEND_IDENTITIES registry.

const ADMIN = "test-token"; // realdb's static both token
const OWN = "agent@skyphusion.org";
const OTHER = "conrad@skyphusion.org";
const OWN_MSG = "<own-1@example.com>";
const OTHER_MSG = "<other-1@example.com>";
const REGISTRY_TOKENS: Record<string, string> = {
  organize: "registry-organize-only-token-0123456789",
  "read+organize": "registry-read-organize-token-0123456789",
};

type Json = Record<string, unknown>;
type Resolver = "runtime identity" | "env registry";

async function setup(resolver: Resolver) {
  const registry: Record<string, { from: string; scopes: string[] }> = {};
  for (const [caps, token] of Object.entries(REGISTRY_TOKENS)) {
    registry[await sha256Hex(token)] = { from: OWN, scopes: caps.split("+") };
  }
  const r = realEnv(resolver === "env registry" ? { POSTERN_SEND_IDENTITIES: JSON.stringify(registry) } : {});
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await handleApi(
      new Request("https://postern.example" + path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Json };
  };
  await putInbound(r.env, r.ctx, { id: OWN_MSG, from: "x@example.com", to: OWN });
  await putInbound(r.env, r.ctx, { id: OTHER_MSG, from: "x@example.com", to: OTHER });
  const token = async (caps: "organize" | "read+organize") => {
    if (resolver === "env registry") return REGISTRY_TOKENS[caps];
    const res = await call("POST", "/api/admin/identities", ADMIN, { from: OWN, scopes: caps.split("+") });
    expect(res.status, res.text).toBe(201);
    return res.body.token as string;
  };
  const state = (id: string) =>
    r.raw.prepare("SELECT seen, flagged, mailbox FROM messages WHERE message_id = ?").get(id) as Json;
  const seenBy = (id: string) =>
    r.raw.prepare("SELECT recipient, seen FROM message_seen_by WHERE message_id = ? ORDER BY recipient").all(id) as Json[];
  return { ...r, call, token, state, seenBy };
}

// One request per organize row. The coverage test below fails if a new organize route is
// added without a request here, so a route cannot escape this suite by being new.
const REQUESTS: Record<string, (id: string) => { path: string; body: Json }> = {
  "messages-seen": (id) => ({ path: "/api/messages/seen", body: { ids: [id], seen: true } }),
  "messages-flags": (id) => ({ path: "/api/messages/flags", body: { ids: [id], set: { flagged: true } } }),
  "messages-move": (id) => ({ path: "/api/messages/move", body: { ids: [id], mailbox: "trash" } }),
};

describe("every organize route is covered (derived from the route table)", () => {
  it("the organize rows are exactly the requests below (the loops are not vacuous)", () => {
    const rows = ROUTE_TABLE.filter((r) => r.scope === "organize").map((r) => r.id).sort();
    expect(rows).toEqual(Object.keys(REQUESTS).sort());
  });
});

for (const resolver of ["runtime identity", "env registry"] as const) {
  describe(`write scope follows the bound identity (${resolver})`, () => {
    for (const [id, build] of Object.entries(REQUESTS)) {
      it(`${id}: an organize-only token writes its own mail and nothing outside it`, async () => {
        const s = await setup(resolver);
        const t = await s.token("organize");
        const before = s.state(OTHER_MSG);
        const other = build(OTHER_MSG);
        const res = await s.call("POST", other.path, t, other.body);
        expect(res.status, res.text).toBe(200);
        expect(res.body.updated, "outside its own address").toBe(0);
        expect(s.state(OTHER_MSG), "the stored row is unchanged").toEqual(before);
        expect(s.seenBy(OTHER_MSG), "no read-state override was written").toEqual([]);
        // OWNER CONTROL: the same token, the same route, on its own mail, does write.
        const own = build(OWN_MSG);
        expect((await s.call("POST", own.path, t, own.body)).body.updated).toBe(1);
      });

      it(`${id}: CONTROL, a read+organize token on the same message is held to its own address`, async () => {
        const s = await setup(resolver);
        const t = await s.token("read+organize");
        const other = build(OTHER_MSG);
        expect((await s.call("POST", other.path, t, other.body)).body.updated).toBe(0);
        // OPERATOR CONTROL: the message exists and the route can write it.
        expect((await s.call("POST", other.path, ADMIN, other.body)).body.updated).toBe(1);
      });
    }

    it("seen: an organize-only token may not name another recipient in `for`", async () => {
      const s = await setup(resolver);
      const t = await s.token("organize");
      const res = await s.call("POST", "/api/messages/seen", t, { ids: [OTHER_MSG], seen: true, for: OTHER });
      expect(res.status, res.text).toBe(403);
      expect(s.seenBy(OTHER_MSG)).toEqual([]);
    });

    it("seen: an organize-only token's mark is its OWN read state, never the row-level flag", async () => {
      const s = await setup(resolver);
      const t = await s.token("organize");
      expect((await s.call("POST", "/api/messages/seen", t, { ids: [OWN_MSG], seen: true })).body.updated).toBe(1);
      expect(s.state(OWN_MSG).seen, "row-level flag untouched").toBe(0);
      expect(s.seenBy(OWN_MSG)).toEqual([{ recipient: OWN, seen: 1 }]);
    });
  });
}

// The `organize` scope (#685): changing read state, flags or placement is its OWN grant.
//
// `messages-seen`, `messages-flags` and `messages-move` change stored state. They used to
// be declared `scope: "read"`, so one grant covered both reading mail and filing it. This
// suite pins the split, and it is written so each half can fail on its own:
//
//   REFUSE  -- a `read` token is 403 on all three, and the refusal NAMES organize.
//   PERMIT  -- `organize`, `imap` and `both` all reach all three.
//   CONTROL -- a `read` token still reaches the read doors, so a green REFUSE arm cannot
//              be bought by breaking the token wholesale.
//
// The CONTROL block is the discriminator this suite would otherwise lack: refusing
// everything would satisfy every REFUSE arm, so the refusals only mean something
// alongside a reader that still works.
//
// #692 added POSTERN_API_TOKEN_ORGANIZE, the slot that issues this scope on its own,
// and three more arms. Two of them are the ones that can bite:
//
//   ONE-WAY     -- an `organize` token is refused on read, send, delete, imap and admin.
//                  A new slot is a new way to WIDEN the gate, so each door is asserted
//                  separately rather than as a loop that one passing door could carry.
//   UNSET SLOT  -- with POSTERN_API_TOKEN_ORGANIZE unset, nothing changes: an `imap`
//                  token still organizes and a `read` token is still refused. This is
//                  the risk in adding a slot, because every deployment that exists today
//                  has it unset.

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { scopeSatisfies } from "./src/routes";
import { NATIVE_SESSION_CAPS } from "./src/session";
import { makeFakeEnv } from "./fakes";

function scopedEnv() {
  return makeFakeEnv({
    POSTERN_API_TOKEN: "both-token",
    POSTERN_API_TOKEN_READ: "read-token",
    POSTERN_API_TOKEN_SEND: "send-token",
    POSTERN_API_TOKEN_DELETE: "delete-token",
    POSTERN_API_TOKEN_IMAP: "imap-token",
    POSTERN_API_TOKEN_ORGANIZE: "organize-token",
  });
}

// The posture of every deployment that predates #692: the four older slots are set and
// POSTERN_API_TOKEN_ORGANIZE is not. Written as its own literal list rather than as
// scopedEnv() minus a key, so a later edit to scopedEnv cannot silently set the slot
// here and make the UNSET arms assert nothing.
function noOrganizeSlotEnv() {
  return makeFakeEnv({
    POSTERN_API_TOKEN: "both-token",
    POSTERN_API_TOKEN_READ: "read-token",
    POSTERN_API_TOKEN_SEND: "send-token",
    POSTERN_API_TOKEN_DELETE: "delete-token",
    POSTERN_API_TOKEN_IMAP: "imap-token",
  });
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://postern.example${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// Every body carries an EMPTY id list on purpose: the question here is only whether the
// gate admits the caller, so no arm depends on stored rows existing. A gate reject is 403
// and an admitted call is 200 with `updated: 0`, which are cleanly distinguishable.
const ORGANIZE_CALLS: Array<[string, string, unknown]> = [
  ["seen", "/api/messages/seen", { ids: [], seen: true }],
  ["flags", "/api/messages/flags", { ids: [], set: { flagged: true } }],
  ["move", "/api/messages/move", { ids: [], mailbox: "trash" }],
];

describe("organize scope (#685)", () => {
  describe("REFUSE: a read token cannot change read state, flags or placement", () => {
    for (const [name, path, body] of ORGANIZE_CALLS) {
      it(`${name} is 403 for a read token, and the refusal names organize`, async () => {
        const { env, ctx } = scopedEnv();
        const res = await handleApi(req("POST", path, { token: "read-token", body }), env, ctx);
        expect(res.status).toBe(403);
        const payload = (await res.json()) as { ok: boolean; error: string; message?: string };
        expect(payload.ok).toBe(false);
        // Naming the scope is what tells an operator WHICH grant is missing. A bare 403
        // would pass a status-only assert while leaving them to guess.
        expect(payload.message).toContain("organize");
      });
    }

    it("a send token and a delete token are also refused, so the fix widened nothing", async () => {
      const { env, ctx } = scopedEnv();
      for (const [, path, body] of ORGANIZE_CALLS) {
        for (const token of ["send-token", "delete-token"]) {
          expect((await handleApi(req("POST", path, { token, body }), env, ctx)).status).toBe(403);
        }
      }
    });
  });

  describe("PERMIT: the machine door and the operator token still organize", () => {
    for (const [name, path, body] of ORGANIZE_CALLS) {
      it(`${name} is reachable with an imap token`, async () => {
        const { env, ctx } = scopedEnv();
        const res = await handleApi(req("POST", path, { token: "imap-token", body }), env, ctx);
        expect(res.status).toBe(200);
        expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
      });

      it(`${name} is reachable with a both token`, async () => {
        const { env, ctx } = scopedEnv();
        expect((await handleApi(req("POST", path, { token: "both-token", body }), env, ctx)).status).toBe(200);
      });

      // The slot the scope was missing (#692). An operator who wants to grant filing and
      // nothing else now has a key for it.
      it(`${name} is reachable with an organize token`, async () => {
        const { env, ctx } = scopedEnv();
        const res = await handleApi(req("POST", path, { token: "organize-token", body }), env, ctx);
        expect(res.status).toBe(200);
        expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
      });
    }
  });

  // A new token slot is a new way to WIDEN the gate, so the question here is not "does
  // organize work" but "what ELSE did it just reach". Each door gets its own `it` with
  // its own expected scope NAME in the refusal: a single loop over paths would let one
  // door carry the others, and the scope name is what proves the request died at the
  // gate rather than inside a handler.
  describe("ONE-WAY: an organize token satisfies organize and nothing else (#692)", () => {
    async function refused(method: string, path: string, scope: string, body?: unknown) {
      const { env, ctx } = scopedEnv();
      const res = await handleApi(req(method, path, { token: "organize-token", body }), env, ctx);
      expect(res.status, `organize token on ${method} ${path}`).toBe(403);
      const payload = (await res.json()) as { ok: boolean; error: string; message?: string };
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe("forbidden");
      expect(payload.message).toContain(scope);
    }

    it("the read door refuses it: list, search and one message", async () => {
      await refused("GET", "/api/messages", "read");
      await refused("GET", "/api/search?q=hello", "read");
      await refused("GET", "/api/messages/some-id", "read");
    });

    // Called out on its own because it is the judgment call in #692, not a leftover.
    // Listing folders reads the mailbox, so `GET /api/folders` stays `read` and an
    // organize-only token cannot see it. Filing mail does not require seeing the
    // cabinet, and a token that could list folders would be reading.
    it("the folder list refuses it, because listing folders is a read", async () => {
      await refused("GET", "/api/folders", "read");
    });

    it("the send door refuses it: send and reply", async () => {
      await refused("POST", "/api/send", "send", {});
      await refused("POST", "/api/reply", "send", {});
    });

    it("the hard-delete door refuses it", async () => {
      await refused("DELETE", "/api/messages/some-id", "delete");
    });

    // organize and imap are NOT interchangeable, even though an imap token carries
    // organize. The grant runs one way only: the door can file mail, a filing key
    // cannot write drafts or import into the store.
    it("the imap service seam refuses it: import and the role map", async () => {
      await refused("POST", "/api/imap/import", "imap", {});
      await refused("GET", "/api/imap/roles", "imap");
    });

    it("the admin door refuses it: credential provisioning and the role list", async () => {
      await refused("POST", "/api/admin/smtp-credentials", "admin", {});
      await refused("GET", "/api/roles", "admin");
    });
  });

  // Every deployment that exists today has this slot UNSET, so "unset changes nothing"
  // is the arm that protects them. Adding a candidate row to the resolution table is a
  // change to how EVERY bearer resolves, not only to how a new one does.
  describe("UNSET SLOT: with POSTERN_API_TOKEN_ORGANIZE unset, nothing changes (#692)", () => {
    for (const [name, path, body] of ORGANIZE_CALLS) {
      it(`${name} is still reachable with an imap token`, async () => {
        const { env, ctx } = noOrganizeSlotEnv();
        const res = await handleApi(req("POST", path, { token: "imap-token", body }), env, ctx);
        expect(res.status).toBe(200);
        expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
      });

      it(`${name} still refuses a read token, and still names organize`, async () => {
        const { env, ctx } = noOrganizeSlotEnv();
        const res = await handleApi(req("POST", path, { token: "read-token", body }), env, ctx);
        expect(res.status).toBe(403);
        const payload = (await res.json()) as { message?: string };
        expect(payload.message).toContain("organize");
      });
    }

    // The discriminator the two arms above lack. They say what a KNOWN token still does.
    // They cannot say what happens to the value the slot would have held. An empty slot
    // must yield an empty token set, so that value is simply an unknown token.
    //
    // The assertion is 401, not "not 200", and the difference is the whole point. 401
    // means the bearer matched nothing and died at authentication. 403 would mean it
    // resolved to some scope and then died at the gate, which is a resolution bug in a
    // slot that is not even configured. Only one of those two readings is correct, and
    // "not 200" accepts both.
    it("the value the slot would have held is an UNKNOWN token, so it is 401 not 403", async () => {
      const { env, ctx } = noOrganizeSlotEnv();
      for (const [, path, body] of ORGANIZE_CALLS) {
        const res = await handleApi(req("POST", path, { token: "organize-token", body }), env, ctx);
        expect(res.status, `unset slot: ${path}`).toBe(401);
      }
    });
  });

  // Without this block every REFUSE arm above would also pass if the read token stopped
  // working altogether, which is the cheap way to make a refusal suite green.
  describe("CONTROL: the read token still reads, so the doors are not merely broken", () => {
    it("reaches the message list, the folder list and search", async () => {
      const { env, ctx } = scopedEnv();
      expect((await handleApi(req("GET", "/api/messages", { token: "read-token" }), env, ctx)).status).toBe(200);
      expect((await handleApi(req("GET", "/api/folders", { token: "read-token" }), env, ctx)).status).toBe(200);
      expect((await handleApi(req("GET", "/api/search?q=hello", { token: "read-token" }), env, ctx)).status).toBe(200);
    });
  });

  describe("the grant matrix", () => {
    it("organize is satisfied by both, organize and imap, and by nothing else", () => {
      expect(scopeSatisfies("both", "organize")).toBe(true);
      expect(scopeSatisfies("organize", "organize")).toBe(true);
      expect(scopeSatisfies("imap", "organize")).toBe(true);
      expect(scopeSatisfies("read", "organize")).toBe(false);
      expect(scopeSatisfies("send", "organize")).toBe(false);
      expect(scopeSatisfies("delete", "organize")).toBe(false);
    });

    // The policy half of the ONE-WAY block above, stated with literals. The block drives
    // the real gate; this pins the function, so a change to either one alone fails.
    it("an organize token satisfies organize and no other need", () => {
      expect(scopeSatisfies("organize", "read")).toBe(false);
      expect(scopeSatisfies("organize", "send")).toBe(false);
      expect(scopeSatisfies("organize", "delete")).toBe(false);
      expect(scopeSatisfies("organize", "imap")).toBe(false);
      expect(scopeSatisfies("organize", "admin")).toBe(false);
      expect(scopeSatisfies("organize", "organize")).toBe(true);
    });

    it("read is still satisfied only by read and both, so organize did not leak into it", () => {
      expect(scopeSatisfies("read", "read")).toBe(true);
      expect(scopeSatisfies("both", "read")).toBe(true);
      expect(scopeSatisfies("imap", "read")).toBe(false);
    });
  });

  describe("the human door", () => {
    // Capabilities are snapshotted into the session row at mint, so this list is what a
    // newly minted session will carry. A session minted BEFORE this change lacks organize
    // and is refused until the user logs in again; that is stated in CHANGELOG.md.
    it("a newly minted webmail session carries organize", () => {
      expect(NATIVE_SESSION_CAPS).toContain("organize");
    });
  });
});

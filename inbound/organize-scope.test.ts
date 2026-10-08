// The `organize` scope (#685): changing read state, flags or placement is its OWN grant.
//
// `messages-seen`, `messages-flags` and `messages-move` change stored state. They used to
// be declared `scope: "read"`, so one grant covered both reading mail and filing it. This
// suite pins the split, and it is written so each half can fail on its own:
//
//   REFUSE  -- a `read` token is 403 on all three, and the refusal NAMES organize.
//   PERMIT  -- `imap` and `both` still reach all three.
//   CONTROL -- a `read` token still reaches the read doors, so a green REFUSE arm cannot
//              be bought by breaking the token wholesale.
//
// The CONTROL block is the discriminator this suite would otherwise lack: refusing
// everything would satisfy every REFUSE arm, so the refusals only mean something
// alongside a reader that still works.

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
    }
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
    it("organize is satisfied by both and imap, and by nothing else", () => {
      expect(scopeSatisfies("both", "organize")).toBe(true);
      expect(scopeSatisfies("imap", "organize")).toBe(true);
      expect(scopeSatisfies("read", "organize")).toBe(false);
      expect(scopeSatisfies("send", "organize")).toBe(false);
      expect(scopeSatisfies("delete", "organize")).toBe(false);
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

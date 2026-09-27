// `messages.message_id` is UNIQUE and it arrives WITH the message rather than being
// derived here, so a collision on it identifies a row, not a message. The store resolves
// a collision by MERGING: it appends the incoming envelope recipient to `delivered_to`,
// which is the column every access check reads.
//
// The invariant this suite pins: a merge widens `delivered_to` ONLY between deliveries of
// the same message, judged on content two deliveries of one message necessarily share.
// When they are not the same message the delivery keeps its own row -- never merged, and
// never dropped, because dropping it is lost mail.
//
// Refs GHSA-pjv6-4xmx-29cw.
//
// WHY realEnv: the subject is an ON CONFLICT ... DO UPDATE ... WHERE clause. Only a real
// engine evaluates it; a fake that pattern-matches SQL answers a missing WHERE exactly as
// cheerfully as a correct one.
import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { realEnv, putInbound, AUTH } from "./realdb";

const VICTIM = "victim@skyphusion.org";
const ATTACKER = "attacker@skyphusion.org";
const SENDER = "someone@example.net";
const SHARED_ID = "collide@example.net";
const SECRET = "the body a reused identifier must never hand over";

/** One delivery, every field explicit, so a suite can vary exactly one of them. */
function delivery(o: {
  id: string;
  from: string;
  to: string;
  deliveredTo?: string[];
  subject?: string;
  date?: string;
  body?: string;
}): store.StoreInput {
  return {
    messageId: o.id,
    direction: "inbound",
    from: o.from,
    to: o.to,
    subject: o.subject ?? "shared subject",
    date: o.date ?? "2026-03-01T00:00:00.000Z",
    bodyText: o.body ?? "shared body",
    auth: AUTH,
    trusted: false,
    deliveredTo: o.deliveredTo ?? [o.to.toLowerCase()],
  };
}

describe("a reused Message-ID does not widen the access list", () => {
  describe("CONTROL: the instrument can see both sides of the boundary", () => {
    it("the recipient reads its own message and a stranger does not", async () => {
      const { env, ctx } = realEnv();
      await putInbound(env, ctx, { id: SHARED_ID, from: SENDER, to: VICTIM, body: SECRET });
      expect(await store.get(env, SHARED_ID, VICTIM)).not.toBeNull();
      expect(await store.get(env, SHARED_ID, ATTACKER)).toBeNull();
    });
  });

  describe("a colliding delivery of a DIFFERENT message", () => {
    it("does not put the new recipient on the stored row's access list", async () => {
      const { env, ctx } = realEnv();
      await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM, body: SECRET }), ctx);

      // A second delivery reusing the identifier: different sender, subject and body,
      // addressed to somebody else entirely.
      await store.put(
        env,
        delivery({
          id: SHARED_ID,
          from: ATTACKER,
          to: ATTACKER,
          subject: "unrelated",
          body: "unrelated body",
        }),
        ctx,
      );

      const row = await store.getUnscoped(env, SHARED_ID);
      expect(row?.bodyText, "the stored row must still be the first message").toContain(SECRET);
      expect(
        row?.deliveredTo ?? [],
        "the second delivery's recipient must not appear on the first row",
      ).not.toContain(ATTACKER);
      expect(
        await store.get(env, SHARED_ID, ATTACKER),
        "and so it cannot be read under that identifier",
      ).toBeNull();
      expect(
        await store.messageAccessible(env, SHARED_ID, ATTACKER),
        "on the shared predicate too",
      ).toBe(false);
      expect(
        await store.get(env, SHARED_ID, VICTIM),
        "inverse control: the real recipient is unaffected",
      ).not.toBeNull();
    });

    it("is still STORED, under its own identity, so no mail is lost", async () => {
      const { env, ctx } = realEnv();
      await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM, body: SECRET }), ctx);

      const second = await store.put(
        env,
        delivery({
          id: SHARED_ID,
          from: ATTACKER,
          to: ATTACKER,
          subject: "unrelated",
          body: "unrelated body",
        }),
        ctx,
      );

      expect(second.stored, "a different message must get a row, not be dropped").toBe(true);
      expect(second.merged).toBe(false);
      expect(second.messageId, "and it must report the identity it was stored under").not.toBe(SHARED_ID);

      const own = await store.get(env, second.messageId, ATTACKER);
      expect(own, "its own recipient can read its own message").not.toBeNull();
      expect(own?.bodyText).toContain("unrelated body");
      expect(
        await store.get(env, second.messageId, VICTIM),
        "and the first message's recipient cannot read THAT one either",
      ).toBeNull();
    });

    it("derives that identity DETERMINISTICALLY, so a retry does not multiply rows", async () => {
      const { env, ctx } = realEnv();
      await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM, body: SECRET }), ctx);
      const forged = delivery({
        id: SHARED_ID,
        from: ATTACKER,
        to: ATTACKER,
        subject: "unrelated",
        body: "unrelated body",
      });
      const first = await store.put(env, forged, ctx);
      const retry = await store.put(env, forged, ctx);

      expect(retry.messageId, "the same delivery resolves to the same row").toBe(first.messageId);
      expect(retry.stored, "and the retry is a no-op, not a third row").toBe(false);
      expect(await store.countMessages(env), "exactly two messages exist").toBe(2);
    });

    it("cannot widen the access list through the extra-recipient write either", async () => {
      const { env, ctx } = realEnv();
      await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM, body: SECRET }), ctx);

      // The role-filing path appends EVERY address after the first in its own statement,
      // keyed on message_id alone. A colliding delivery must not reach the stored row
      // through it.
      await store.put(
        env,
        delivery({
          id: SHARED_ID,
          from: ATTACKER,
          to: ATTACKER,
          deliveredTo: [ATTACKER, "accomplice@skyphusion.org"],
          subject: "unrelated",
          body: "unrelated body",
        }),
        ctx,
      );

      const row = await store.getUnscoped(env, SHARED_ID);
      expect(row?.deliveredTo ?? []).not.toContain(ATTACKER);
      expect(row?.deliveredTo ?? []).not.toContain("accomplice@skyphusion.org");
      expect(await store.get(env, SHARED_ID, "accomplice@skyphusion.org")).toBeNull();
    });
  });

  // The other direction. The merge exists to serve real deliveries (#178: concurrent
  // per-recipient invocations of ONE message, and role filing), so a fix that stops
  // merging is not a fix, it is a second defect wearing the first one's clothes.
  describe("a genuine second delivery of the SAME message still merges (#178)", () => {
    it("merges when every content field agrees, and the second recipient gains the read", async () => {
      const { env, ctx } = realEnv();
      const other = "other@skyphusion.org";
      const first = await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM }), ctx);
      expect(first.stored).toBe(true);

      // Same message, second envelope recipient: from, subject, date and body identical,
      // which is what two per-recipient invocations of one delivery necessarily share.
      const second = await store.put(
        env,
        delivery({ id: SHARED_ID, from: SENDER, to: VICTIM, deliveredTo: [other] }),
        ctx,
      );

      expect(second.merged, "the same message must merge, not fork").toBe(true);
      expect(second.messageId, "and keep the one identity").toBe(SHARED_ID);
      expect(await store.messageAccessible(env, SHARED_ID, VICTIM)).toBe(true);
      expect(await store.messageAccessible(env, SHARED_ID, other)).toBe(true);
      expect(await store.countMessages(env), "one message, one row").toBe(1);
    });

    it("merges when the message carries NO subject (a NULL column is not a mismatch)", async () => {
      const { env, ctx } = realEnv();
      const other = "other@skyphusion.org";
      await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM, subject: "" }), ctx);
      const second = await store.put(
        env,
        delivery({ id: SHARED_ID, from: SENDER, to: VICTIM, subject: "", deliveredTo: [other] }),
        ctx,
      );
      expect(second.merged, "an empty/absent field must compare NULL-safely").toBe(true);
      expect(await store.messageAccessible(env, SHARED_ID, other)).toBe(true);
    });

    it("a true duplicate of an already-recorded recipient stays a no-op", async () => {
      const { env, ctx } = realEnv();
      await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM }), ctx);
      const again = await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM }), ctx);
      expect(again.stored).toBe(false);
      expect(again.merged).toBe(false);
      expect(again.messageId).toBe(SHARED_ID);
      expect(await store.countMessages(env)).toBe(1);
    });

    it("role filing still files one delivery under the role owners", async () => {
      const { env, ctx } = realEnv();
      const role = "support@skyphusion.org";
      const owner = "owner@skyphusion.org";
      await store.put(
        env,
        delivery({ id: SHARED_ID, from: SENDER, to: role, deliveredTo: [role, owner] }),
        ctx,
      );
      expect(await store.messageAccessible(env, SHARED_ID, role)).toBe(true);
      expect(await store.messageAccessible(env, SHARED_ID, owner), "the role owner too").toBe(true);
    });

    it("role filing survives the MERGE path, where the other recipient landed first", async () => {
      const { env, ctx } = realEnv();
      const role = "support@skyphusion.org";
      const owner = "owner@skyphusion.org";
      const direct = "direct@skyphusion.org";
      await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: role, deliveredTo: [direct] }), ctx);
      const second = await store.put(
        env,
        delivery({ id: SHARED_ID, from: SENDER, to: role, deliveredTo: [role, owner] }),
        ctx,
      );
      expect(second.merged).toBe(true);
      expect(await store.messageAccessible(env, SHARED_ID, direct)).toBe(true);
      expect(await store.messageAccessible(env, SHARED_ID, role)).toBe(true);
      expect(
        await store.messageAccessible(env, SHARED_ID, owner),
        "the owners must not be dropped on the merge path",
      ).toBe(true);
    });
  });
});

// The store is the single owner of the data model, so that is the right place for the
// fix. But the DOOR is where the value arrives, and the import door is the sharpest
// version of the problem: the caller supplies the whole RFC822 message, which means it
// supplies the Message-ID, and it names the recipient too. A store-level assertion does
// not prove the door cannot reach past it. Refs GHSA-pjv6-4xmx-29cw.
describe("the import door cannot reach a stored message by reusing its identifier", () => {
  const DOOR_TOKEN = "imap-door-token";

  function mime(o: { id: string; from: string; to: string; subject: string; body: string }): string {
    const raw = [
      `Message-ID: <${o.id}>`,
      `From: ${o.from}`,
      `To: ${o.to}`,
      `Subject: ${o.subject}`,
      "Date: Mon, 02 Mar 2026 00:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      o.body,
    ].join("\r\n");
    return Buffer.from(raw, "utf8").toString("base64");
  }

  function importReq(identity: string, rawMime: string): Request {
    return new Request("https://postern.example/api/imap/import", {
      method: "POST",
      headers: { authorization: `Bearer ${DOOR_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ identity, folder: "archive", rawMime }),
    });
  }

  async function doorEnv() {
    return realEnv({ POSTERN_API_TOKEN: DOOR_TOKEN, ALLOWED_FROM_DOMAIN: "skyphusion.org" });
  }

  it("CONTROL: the door imports a message and the importer can read it", async () => {
    const { env, ctx } = await doorEnv();
    const res = await handleApi(
      importReq(ATTACKER, mime({ id: "own@x", from: SENDER, to: ATTACKER, subject: "mine", body: "mine" })),
      env,
      ctx,
    );
    expect(res.status, "an ordinary import must succeed").toBeLessThan(300);
    const body = (await res.json()) as { messageId: string };
    expect(await store.get(env, body.messageId, ATTACKER)).not.toBeNull();
  });

  it("an import reusing a stored message's identifier does not grant a read of it", async () => {
    const { env, ctx } = await doorEnv();
    await store.put(env, delivery({ id: SHARED_ID, from: SENDER, to: VICTIM, body: SECRET }), ctx);

    const res = await handleApi(
      importReq(
        ATTACKER,
        mime({ id: SHARED_ID, from: SENDER, to: ATTACKER, subject: "anything", body: "anything" }),
      ),
      env,
      ctx,
    );
    expect(res.status, "the import itself is not refused; it simply gets its own row").toBeLessThan(300);

    expect(
      await store.get(env, SHARED_ID, ATTACKER),
      "the stored message must not become readable by the importer",
    ).toBeNull();
    const victimCopy = await store.get(env, SHARED_ID, VICTIM);
    expect(victimCopy?.bodyText, "and the real recipient still reads the real body").toContain(SECRET);
  });
});

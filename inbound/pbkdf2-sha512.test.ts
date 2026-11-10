import { describe, it, expect, vi } from "vitest";
import { handleApi } from "./src/api";
import {
  hashIterations,
  hashPrf,
  hashSecret,
  needsRehash,
  PBKDF2_ITERATIONS,
  PBKDF2_TARGET_HASH,
  PBKDF2_TARGET_TAG,
  verifySecret,
} from "./src/smtpcreds";
import { realEnv } from "./realdb";

// #828: the native hash target moves from PBKDF2-HMAC-SHA256 to PBKDF2-HMAC-SHA512 at the
// SAME count, the Workers cap. The suite still runs under the edge cap shim
// (test-setup/workers-pbkdf2-cap.ts), so nothing here can pass by deriving above 100,000.
// The cap is a LITERAL here for the reason pbkdf2-cap.test.ts gives.
const CAP = 100_000;
const ORIGIN = "https://postern.example";
const USER = "alice@skyphusion.org";
const PASSWORD = "correct-horse-battery";
const ADMIN = "test-token"; // realdb's static both token
const TRANSPORT = "transport-token-0123456789";

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(secret: string, salt: Uint8Array, iterations: number, hash: "SHA-256" | "SHA-512", bits: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash, salt, iterations }, key, bits));
}

/** A legacy row exactly as pre-#828 code wrote it: pbkdf2$ + SHA-256, 32-byte output. */
async function legacyRow(secret: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return ["pbkdf2", String(iterations), b64(salt), b64(await derive(secret, salt, iterations, "SHA-256", 256))].join("$");
}

function setup() {
  const r = realEnv({ WEBMAIL_AUTH_BACKEND: "native", POSTERN_TRANSPORT_TOKEN: TRANSPORT });
  const seed = (hash: string, username = USER) =>
    r.raw.prepare(
      "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    ).run(username, username, hash, "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z");
  const stored = (username = USER) =>
    (r.raw.prepare("SELECT secret_hash FROM smtp_credentials WHERE username = ?").get(username) as { secret_hash: string }).secret_hash;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handleApi(
      new Request(ORIGIN + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      r.env,
      r.ctx,
    );
  const signIn = (password = PASSWORD, username = USER) => post("/api/session", { username, password });
  return { ...r, seed, stored, post, signIn };
}

describe("#828 the target is PBKDF2-HMAC-SHA512 at the cap", () => {
  it("names a SHA-512 target at a count no greater than the cap", () => {
    expect(PBKDF2_TARGET_TAG).toBe("pbkdf2-sha512");
    expect(PBKDF2_TARGET_HASH).toBe("SHA-512");
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(CAP);
  });

  it("hashSecret writes pbkdf2-sha512$100000$, a 16-byte salt and a 64-byte output", async () => {
    const [tag, iters, salt, out] = (await hashSecret(PASSWORD)).split("$");
    expect([tag, iters]).toEqual(["pbkdf2-sha512", "100000"]);
    expect(unb64(salt).length).toBe(16);
    expect(unb64(out).length).toBe(64);
  });

  it("the stored bytes ARE SHA-512 (independent derivation), and NOT SHA-256 (control)", async () => {
    const [, , saltB64, outB64] = (await hashSecret(PASSWORD)).split("$");
    const salt = unb64(saltB64);
    expect(b64(await derive(PASSWORD, salt, CAP, "SHA-512", 512))).toBe(outB64);
    // The same instrument on the other PRF must disagree, so the match above discriminates.
    const sha256 = await derive(PASSWORD, salt, CAP, "SHA-256", 512);
    expect(b64(sha256)).not.toBe(outB64);
  });
});

describe("#828 legacy SHA-256 rows keep verifying and are upgraded on sign-in", () => {
  it("a legacy row verifies at its own KDF", async () => {
    const legacy = await legacyRow(PASSWORD, CAP);
    expect(hashPrf(legacy)).toBe("SHA-256");
    expect(await verifySecret(PASSWORD, legacy)).toBe(true);
    expect(await verifySecret("not-the-password", legacy)).toBe(false);
  });

  it("a legacy row AT the target count is re-hashed to SHA-512 on a successful sign-in", async () => {
    // The pre-#828 rule upgraded only a LOWER count, so this row would have stayed SHA-256.
    const s = setup();
    s.seed(await legacyRow(PASSWORD, CAP));
    expect((await s.signIn()).status).toBe(200);
    const after = s.stored();
    expect(after.startsWith("pbkdf2-sha512$100000$")).toBe(true);
    expect(hashPrf(after)).toBe("SHA-512");
    expect((await s.signIn()).status).toBe(200); // same password, new hash
  });

  it("a legacy row at a lower count is re-hashed to SHA-512 at the target, never above", async () => {
    const s = setup();
    s.seed(await legacyRow(PASSWORD, 1000));
    expect((await s.signIn()).status).toBe(200);
    expect(hashIterations(s.stored())).toBe(CAP);
    expect(hashPrf(s.stored())).toBe("SHA-512");
  });

  it("a failed sign-in never rewrites a legacy row", async () => {
    const s = setup();
    const legacy = await legacyRow(PASSWORD, CAP);
    s.seed(legacy);
    expect((await s.signIn("wrong-password-xyz")).status).toBe(401);
    expect(s.stored()).toBe(legacy);
  });

  it("a row already at the target is not re-written", async () => {
    const s = setup();
    const h = await hashSecret(PASSWORD);
    s.seed(h);
    expect((await s.signIn()).status).toBe(200);
    expect(s.stored()).toBe(h);
  });

  it("the upgrade is compare-and-set: a reset that lands mid-sign-in wins", async () => {
    const s = setup();
    const legacy = await legacyRow(PASSWORD, CAP);
    s.seed(legacy);
    const reset = await hashSecret("an-operator-reset-pw");
    // Land the reset right after the sign-in has READ the row, before the upgrade writes.
    const db = s.env.DB as unknown as { prepare(sql: string): { first(): Promise<unknown> } };
    const real = db.prepare.bind(db);
    let fired = false;
    db.prepare = (sql: string) => {
      const stmt = real(sql) as Record<string, unknown> & { first(): Promise<unknown> };
      if (!fired && /FROM smtp_credentials WHERE username/.test(sql)) {
        const first = stmt.first.bind(stmt);
        stmt.first = async () => {
          const row = await first();
          fired = true;
          s.raw.prepare("UPDATE smtp_credentials SET secret_hash = ? WHERE username = ?").run(reset, USER);
          return row;
        };
      }
      return stmt as never;
    };
    expect((await s.signIn()).status).toBe(200); // it verified against the row it read
    expect(fired).toBe(true);
    expect(s.stored()).toBe(reset); // the reset, not the upgrade
  });

  it("needsRehash: any KDF other than the target, or a lower count; never a malformed row", async () => {
    expect(needsRehash(await legacyRow(PASSWORD, CAP))).toBe(true);
    expect(needsRehash(await legacyRow(PASSWORD, 1000))).toBe(true);
    expect(needsRehash(await hashSecret(PASSWORD))).toBe(false);
    const [, , salt, out] = (await hashSecret(PASSWORD)).split("$");
    expect(needsRehash(["pbkdf2-sha512", "1000", salt, out].join("$"))).toBe(true);
    for (const bad of ["", "pbkdf2", "pbkdf2-sha1$100000$AA==$AA==", "pbkdf2-sha512$x$AA==$AA=="]) {
      expect(needsRehash(bad), bad).toBe(false);
    }
  });
});

describe("#828 malformed rows fail closed and never throw", () => {
  it("an unknown tag, or an output the wrong length for its tag, never verifies", async () => {
    const [, , salt, out64] = (await hashSecret(PASSWORD)).split("$");
    const legacy = (await legacyRow(PASSWORD, CAP)).split("$");
    // A 64-byte SHA-512 output re-tagged as legacy, and a 32-byte SHA-256 output re-tagged
    // as SHA-512: both carry real bytes for the right password, so only the tag rule refuses.
    expect(await verifySecret(PASSWORD, ["pbkdf2", "100000", salt, out64].join("$"))).toBe(false);
    expect(await verifySecret(PASSWORD, ["pbkdf2-sha512", legacy[1], legacy[2], legacy[3]].join("$"))).toBe(false);
    expect(await verifySecret(PASSWORD, ["pbkdf2-sha1", "100000", salt, out64].join("$"))).toBe(false);
    expect(await verifySecret(PASSWORD, "garbage")).toBe(false);
  });

  it("a SHA-512 row above the cap fails closed as a wrong password, with a config error", async () => {
    const [, , salt, out] = (await hashSecret(PASSWORD)).split("$");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await verifySecret(PASSWORD, ["pbkdf2-sha512", "210000", salt, out].join("$"), USER)).toBe(false);
      expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("config error");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("#828 timing: the dummy hash is at the new target", () => {
  it("an unknown user costs the same derive (SHA-512 at the cap) as a wrong password on a current row", async () => {
    const s = setup();
    s.seed(await hashSecret(PASSWORD));
    const proto = Object.getPrototypeOf(crypto.subtle) as { deriveBits: (...a: unknown[]) => Promise<ArrayBuffer> };
    const spy = vi.spyOn(proto, "deriveBits");
    const work = () => spy.mock.calls.map((c) => {
      const a = c[0] as { hash?: unknown; iterations?: number };
      return [typeof a.hash === "string" ? a.hash : (a.hash as { name?: string })?.name, a.iterations, c[2]];
    });
    try {
      expect((await s.signIn(PASSWORD, "ghost@skyphusion.org")).status).toBe(401);
      const unknown = work();
      spy.mockClear();
      expect((await s.signIn("wrong-password-xyz")).status).toBe(401);
      const wrong = work();
      expect(wrong).toEqual([["SHA-512", CAP, 512]]);
      expect(unknown).toEqual(wrong);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("#828 every door still verifies", () => {
  it("an admin-created user signs in, and the relay seam (/api/smtp-auth) accepts it", async () => {
    const s = setup();
    const made = await s.post("/api/admin/users", { username: USER, password: PASSWORD }, { authorization: "Bearer " + ADMIN });
    expect(made.status).toBe(201);
    expect(s.stored().startsWith("pbkdf2-sha512$")).toBe(true);
    expect((await s.signIn()).status).toBe(200);
    const relay = await s.post("/api/smtp-auth", { username: USER, secret: PASSWORD }, { authorization: "Bearer " + TRANSPORT });
    expect(await relay.json()).toMatchObject({ ok: true });
  });
});

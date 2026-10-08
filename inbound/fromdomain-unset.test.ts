// #615: ALLOWED_FROM_DOMAIN has no product default. Before this, five call sites fell
// back to a hardcoded "skyphusion.org", so a self-hoster who left it unset silently
// inherited OUR domain as theirs. Each site now handles "unset" per its seam:
//   - send (resolveFrom):        refuse 500, nothing reaches the transport
//   - SMTP credential upsert:    refuse 500, nothing written
//   - registry token resolve:    deny (401), and NOT fail-open on any domain
//   - mobileconfig:              refuse 500, no profile naming someone else's hosts
//   - same-domain seen seed:     skip (no throw), the stored copy is untouched
//
// #619 adds the SIXTH site, which #615/#617 left out because it borrows no domain:
//   - imap identity (requireImapIdentity): refuse 500, nothing written
// It had the opposite defect. It read the variable directly and AND-ed the domain
// comparison behind a truthiness test, so unset meant "no domain policy" and any
// well-formed address was accepted as the identity: fail OPEN, on the one seam whose
// whole job is to decide which account a door may act as.

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { allowedFromDomain } from "./src/fromdomain";
import { sha256Hex } from "./src/sendidentity";
import { makeFakeEnv } from "./fakes";
import { realEnv, putOutbound } from "./realdb";

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

const UNSET = { ALLOWED_FROM_DOMAIN: undefined, DEFAULT_FROM: undefined };

describe("allowedFromDomain (#615)", () => {
  it("returns null for unset or blank, the trimmed lower-cased domain otherwise", () => {
    expect(allowedFromDomain({} as Env)).toBeNull();
    expect(allowedFromDomain({ ALLOWED_FROM_DOMAIN: "" } as Env)).toBeNull();
    expect(allowedFromDomain({ ALLOWED_FROM_DOMAIN: "   " } as Env)).toBeNull();
    expect(allowedFromDomain({ ALLOWED_FROM_DOMAIN: " Example.COM " } as Env)).toBe("example.com");
  });
});

describe("ALLOWED_FROM_DOMAIN unset: no borrowed default (#615)", () => {
  it("send refuses with 500 and nothing reaches the transport", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv(UNSET);
    const body = { to: "d@example.com", subject: "hi", text: "yo" };
    const res = await handleApi(req("POST", "/api/send", { token: "test-token", body }), env, ctx);
    await settle();
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it("send refuses even when the caller names a skyphusion.org From", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv(UNSET);
    const body = { to: "d@example.com", subject: "hi", text: "yo", from: "noreply@skyphusion.org" };
    const res = await handleApi(req("POST", "/api/send", { token: "test-token", body }), env, ctx);
    await settle();
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it("SMTP credential upsert refuses with 500", async () => {
    const { env, ctx } = makeFakeEnv(UNSET);
    const res = await handleApi(
      req("POST", "/api/admin/smtp-credentials", { token: "test-token", body: { username: "carol@skyphusion.org" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("E_INTERNAL_SERVER_ERROR");
  });

  it("registry tokens are denied (401), on our domain and on any other", async () => {
    // parseRegistry skips the domain check when given no domain, so an empty-string
    // fallback here would have accepted ANY From. Both entries must be refused.
    const ours = await sha256Hex("ours-secret");
    const theirs = await sha256Hex("theirs-secret");
    const { env, ctx, settle, sent } = makeFakeEnv({
      ...UNSET,
      POSTERN_SEND_IDENTITIES: JSON.stringify({
        [ours]: { from: "rollins@skyphusion.org" },
        [theirs]: { from: "anyone@example.net" },
      }),
    });
    const body = { to: "d@example.com", subject: "hi", text: "yo" };
    for (const token of ["ours-secret", "theirs-secret"]) {
      const res = await handleApi(req("POST", "/api/send", { token, body }), env, ctx);
      expect(res.status).toBe(401);
    }
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("mobileconfig refuses with 500 instead of emitting imap./smtp. hosts on a borrowed domain", async () => {
    const { env, ctx } = makeFakeEnv(UNSET);
    const res = await handleApi(req("GET", "/api/mobileconfig?user=alice@skyphusion.org", { token: "test-token" }), env, ctx);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("skyphusion.org");
  });

  it("same-domain seen seed is skipped, and the outbound copy still stores", async () => {
    const { env, ctx, raw } = realEnv({ ALLOWED_FROM_DOMAIN: undefined });
    await putOutbound(env, ctx, { id: "ab@skyphusion.org", from: "alice@skyphusion.org", to: ["bob@skyphusion.org"] });
    expect((raw.prepare("SELECT COUNT(*) n FROM message_seen_by").get() as { n: number }).n).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n).toBe(1);
  });
});

// --- the sixth site: the imap identity seam (#619) ---
//
// requireImapIdentity is the ONLY thing standing between a door token and the account
// it claims to be acting as, and it is reached by five routes: four in
// handleImapDrafts (GET / POST / PUT / DELETE) and one in handleImapImport (the APPEND
// path, which STORES a message filed under the supplied identity). One function, so one
// fix, but all five are driven here: a seam this cheap to re-break deserves the
// enumeration rather than a single representative call.
//
// The refusal is 500 E_INTERNAL_SERVER_ERROR, matching the other fail-closed seams
// above, NOT the 403 E_IDENTITY_NOT_ALLOWED this function answers for a genuinely
// disallowed identity. The distinction is load-bearing for whoever reads the log: an
// unset variable is the OPERATOR's missing config, and a 403 would blame the door for
// a request it had no way to get right.
const IMAP_IDENTITY = "conrad@skyphusion.org";

// A small, genuinely parseable message, so the import path under test is one that
// WOULD store if the guard failed to fire (cf. imap-import-cap.test.ts).
const IMPORT_MIME = [
  "From: Conrad <conrad@skyphusion.org>",
  "To: Friend <friend@example.com>",
  "Subject: appended",
  "Message-ID: <append-619@skyphusion.org>",
  "Date: Sat, 18 Jul 2026 00:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "body",
].join("\r\n");

const DRAFT_BODY = { identity: IMAP_IDENTITY, subject: "hi", bodyText: "yo" };

// Every route that reaches requireImapIdentity, as [label, method, path, body].
const IMAP_CALLS: Array<[string, string, string, unknown?]> = [
  ["drafts GET", "GET", `/api/imap/drafts?identity=${encodeURIComponent(IMAP_IDENTITY)}`, undefined],
  ["drafts POST", "POST", "/api/imap/drafts", DRAFT_BODY],
  ["drafts PUT", "PUT", "/api/imap/drafts/d619", { ...DRAFT_BODY }],
  ["drafts DELETE", "DELETE", `/api/imap/drafts/d619?identity=${encodeURIComponent(IMAP_IDENTITY)}`, undefined],
  ["import POST", "POST", "/api/imap/import", { identity: IMAP_IDENTITY, folder: "sent", rawMime: btoa(IMPORT_MIME) }],
];

function count(raw: { prepare(sql: string): { get(): unknown } }, table: string): number {
  return (raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}

describe("ALLOWED_FROM_DOMAIN unset: the imap identity seam fails CLOSED (#619)", () => {
  it.each(IMAP_CALLS)("%s refuses with 500, naming the config and not the caller", async (label, method, path, body) => {
    // A fresh env per call: a refusal must stand on its own, never on state a
    // previous call in this table happened to leave behind.
    const { env, ctx } = makeFakeEnv(UNSET);
    const res = await handleApi(req(method, path, { token: "test-token", body }), env, ctx);
    expect(res.status, label).toBe(500);
    const payload = (await res.json()) as { ok: boolean; error: string; message: string };
    expect(payload.ok, label).toBe(false);
    expect(payload.error, label).toBe("E_INTERNAL_SERVER_ERROR");
    expect(payload.message, label).toBe("ALLOWED_FROM_DOMAIN is not configured");
  });

  it("the drafts write stores NOTHING, measured on the real engine", async () => {
    const { env, ctx, raw } = realEnv({ ALLOWED_FROM_DOMAIN: undefined });
    const res = await handleApi(req("POST", "/api/imap/drafts", { token: "test-token", body: DRAFT_BODY }), env, ctx);
    // The STATE first, deliberately. A status assertion placed ahead of this one
    // short-circuits the run and the row count is never read at all, so the
    // assertion that actually covers "wrote nothing" would never be shown capable
    // of going red. Pre-fix this line reads: expected 1 to be +0.
    expect(count(raw, "drafts")).toBe(0);
    expect(res.status).toBe(500);
  });

  it("the import APPEND stores NOTHING, measured on the real engine", async () => {
    const { env, ctx, raw } = realEnv({ ALLOWED_FROM_DOMAIN: undefined });
    const body = { identity: IMAP_IDENTITY, folder: "sent", rawMime: btoa(IMPORT_MIME) };
    const res = await handleApi(req("POST", "/api/imap/import", { token: "test-token", body }), env, ctx);
    // State first, same reason as above. Pre-fix this line reads: expected 1 to
    // be +0, and that one row is a message filed under an identity nothing
    // validated, which is the whole of what #619 reports.
    expect(count(raw, "messages")).toBe(0);
    expect(res.status).toBe(500);
  });

  // POSITIVE CONTROL. The two counts above are zeroes, and a zero is exactly what an
  // inert harness also prints: a route that 404s, a token that 401s, a table the store
  // never writes. So the SAME calls run here with the variable SET, and the same
  // counters must come back non-zero. Without this pair, "refused and wrote nothing"
  // is unfalsifiable. These two pass before AND after the #619 fix, by design: their
  // job is to prove the instrument can produce the opposite reading, not to detect it.
  it("positive control: with the domain SET, the same drafts write DOES store", async () => {
    const { env, ctx, raw } = realEnv();
    const res = await handleApi(req("POST", "/api/imap/drafts", { token: "test-token", body: DRAFT_BODY }), env, ctx);
    expect(res.status).toBe(201);
    expect(count(raw, "drafts")).toBe(1);
  });

  it("positive control: with the domain SET, the same import APPEND DOES store", async () => {
    const { env, ctx, raw } = realEnv();
    const body = { identity: IMAP_IDENTITY, folder: "sent", rawMime: btoa(IMPORT_MIME) };
    const res = await handleApi(req("POST", "/api/imap/import", { token: "test-token", body }), env, ctx);
    expect(res.status).toBe(201);
    expect(count(raw, "messages")).toBe(1);
  });

  // The 403 is NOT collateral of the above: a configured deploy must still refuse an
  // off-domain identity, and must still say it is the identity that was wrong.
  it("with the domain SET, an off-domain identity is still a 403 E_IDENTITY_NOT_ALLOWED", async () => {
    const { env, ctx, raw } = realEnv();
    const body = { identity: "conrad@elsewhere.example", subject: "hi", bodyText: "yo" };
    const res = await handleApi(req("POST", "/api/imap/drafts", { token: "test-token", body }), env, ctx);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("E_IDENTITY_NOT_ALLOWED");
    expect(count(raw, "drafts")).toBe(0);
  });
});

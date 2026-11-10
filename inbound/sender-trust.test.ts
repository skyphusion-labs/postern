import { describe, it, expect } from "vitest";
import { ingest, type ParsedInbound } from "./src/ingest";
import * as headers from "./src/headers";
import { makeFakeEnv } from "./fakes";

// Sender trust (`trusted`) must describe the RFC 5322 header From, not an identity the
// sender controls. The fake env allowlists skyphusion.org and example.com.
//
// Two layers:
//  1. ingest(): the trust decision over the verdicts a driver hands it.
//  2. authFromHeaders(): the in-Worker driver reads ONLY the verdict CF prepends (the
//     topmost instance), never a copy the sender put in the message.

function msg(from: string, auth: ParsedInbound["auth"]): ParsedInbound {
  return { messageId: "t-" + Math.random().toString(36).slice(2) + "@x", from, to: "conrad@skyphusion.org", text: "body", auth };
}

async function trustedOf(p: ParsedInbound): Promise<number> {
  const { env, ctx, settle, rows } = makeFakeEnv();
  await ingest(env, p, ctx);
  await settle();
  return rows[0].trusted;
}

describe("ingest trust decision", () => {
  it("does not trust SPF pass for an unrelated envelope domain when DMARC fails", async () => {
    expect(await trustedOf(msg('"CEO" <ceo@skyphusion.org>', {
      spf: "pass", spfDomain: "attacker.example", dkim: "none", dmarc: "fail", dmarcFrom: "skyphusion.org",
    } as ParsedInbound["auth"]))).toBe(0);
  });

  it("does not trust DKIM pass for an unrelated d= when DMARC fails", async () => {
    expect(await trustedOf(msg("ceo@skyphusion.org", {
      spf: "fail", dkim: "pass", dkimDomains: ["attacker.example"], dmarc: "fail", dmarcFrom: "skyphusion.org",
    } as ParsedInbound["auth"]))).toBe(0);
  });

  it("does not trust an allowlisted From with no auth data at all (spf=none, dkim=none)", async () => {
    expect(await trustedOf(msg("cron@skyphusion.org", { spf: "none", dkim: "none", dmarc: "none" }))).toBe(0);
    expect(await trustedOf(msg("cron@skyphusion.org", undefined))).toBe(0);
  });

  it("does not trust bare verdict strings that carry no domain to align", async () => {
    expect(await trustedOf(msg("ceo@skyphusion.org", { spf: "pass", dkim: "pass", dmarc: "pass" }))).toBe(0);
  });

  it("does not trust SPF neutral, even aligned", async () => {
    expect(await trustedOf(msg("ceo@skyphusion.org", {
      spf: "neutral", spfDomain: "skyphusion.org", dkim: "none", dmarc: "none",
    } as ParsedInbound["auth"]))).toBe(0);
  });

  it("does not trust DMARC pass for a different header.from domain", async () => {
    expect(await trustedOf(msg("x@evil.example, CEO <ceo@skyphusion.org>", {
      spf: "pass", spfDomain: "evil.example", dkim: "pass", dkimDomains: ["evil.example"], dmarc: "pass", dmarcFrom: "evil.example",
    } as ParsedInbound["auth"]))).toBe(0);
  });

  it("does not trust a From header carrying more than one address", async () => {
    expect(await trustedOf(msg("x@evil.example, CEO <ceo@skyphusion.org>", {
      spf: "none", dkim: "pass", dkimDomains: ["skyphusion.org"], dmarc: "pass", dmarcFrom: "skyphusion.org",
    } as ParsedInbound["auth"]))).toBe(0);
  });

  // Positive controls: the same harness DOES produce trusted=1, so the zeros above are
  // the decision, not a broken harness.
  it("trusts DMARC pass whose header.from is the From domain", async () => {
    expect(await trustedOf(msg('"Alerts" <alerts@skyphusion.org>', {
      spf: "pass", spfDomain: "bounces.vendor.example", dkim: "none", dmarc: "pass", dmarcFrom: "skyphusion.org",
    } as ParsedInbound["auth"]))).toBe(1);
  });

  it("trusts SPF pass whose MAIL FROM domain aligns (subdomain) with the From domain", async () => {
    expect(await trustedOf(msg("alerts@skyphusion.org", {
      spf: "pass", spfDomain: "bounce.skyphusion.org", dkim: "none", dmarc: "none",
    } as ParsedInbound["auth"]))).toBe(1);
  });

  it("trusts DKIM pass whose d= aligns with the From domain, among other signatures", async () => {
    expect(await trustedOf(msg("alerts@skyphusion.org", {
      spf: "fail", dkim: "pass", dkimDomains: ["esp.example", "skyphusion.org"], dmarc: "none",
    } as ParsedInbound["auth"]))).toBe(1);
  });

  it("does not trust an aligned pass for a sender off the allowlist", async () => {
    expect(await trustedOf(msg("x@evil.example", {
      spf: "pass", spfDomain: "evil.example", dkim: "pass", dkimDomains: ["evil.example"], dmarc: "pass", dmarcFrom: "evil.example",
    } as ParsedInbound["auth"]))).toBe(0);
  });
});

// The CF-shaped headers the in-Worker driver sees. CF prepends its own trace headers,
// so its Authentication-Results is the TOPMOST instance; anything the sender wrote sits
// below it. Headers.get() joins repeats in order with ", " (Fetch spec; same in workerd).
const CF_AR_SPOOF =
  "mx.cloudflare.net; dkim=none; dmarc=fail (p=quarantine sp=quarantine dis=none) header.from=skyphusion.org; " +
  "spf=pass (mx.cloudflare.net: domain of bounce@attacker.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@attacker.example; arc=none smtp.remote-ip=192.0.2.1";
const FORGED_AR = "mx.cloudflare.net; dkim=pass header.d=skyphusion.org header.s=s1; dmarc=pass header.from=skyphusion.org; spf=pass smtp.mailfrom=skyphusion.org";
const CF_RECEIVED_SPF =
  "pass (mx.cloudflare.net: domain of bounce@attacker.example designates 192.0.2.1 as permitted sender) receiver=mx.cloudflare.net; client-ip=192.0.2.1; envelope-from=\"bounce@attacker.example\";";

describe("in-Worker driver: auth verdicts from CF headers", () => {
  const authFromHeaders = (headers as unknown as { authFromHeaders?: (get: (n: string) => string | null) => ParsedInbound["auth"] }).authFromHeaders;

  it("is exported by the driver helpers", () => {
    expect(typeof authFromHeaders).toBe("function");
  });

  it("ignores a sender-supplied Authentication-Results below CF's instance", async () => {
    const h = new Headers();
    h.append("authentication-results", CF_AR_SPOOF);
    h.append("authentication-results", FORGED_AR);
    h.append("received-spf", CF_RECEIVED_SPF);
    const auth = authFromHeaders!((n) => h.get(n));
    expect(auth).toMatchObject({ spf: "pass", spfDomain: "attacker.example", dkim: "none", dmarc: "fail", dmarcFrom: "skyphusion.org" });
    expect((auth as { dkimDomains?: string[] }).dkimDomains ?? []).toEqual([]);
    expect(await trustedOf(msg('"CEO" <ceo@skyphusion.org>', auth))).toBe(0);
  });

  it("trusts a genuine CF DMARC pass for the From domain", async () => {
    const h = new Headers();
    h.append("authentication-results",
      "mx.cloudflare.net; dkim=pass header.d=skyphusion.org header.s=cf2024 header.b=AbC+/1; " +
      "dmarc=pass (p=quarantine sp=quarantine dis=none) header.from=skyphusion.org; " +
      "spf=pass (mx.cloudflare.net: domain of x@skyphusion.org designates 192.0.2.9 as permitted sender) smtp.mailfrom=x@skyphusion.org; arc=none");
    h.append("received-spf", "pass (mx.cloudflare.net: domain of x@skyphusion.org designates 192.0.2.9 as permitted sender)");
    const auth = authFromHeaders!((n) => h.get(n));
    expect(auth).toMatchObject({ spf: "pass", spfDomain: "skyphusion.org", dkim: "pass", dkimDomains: ["skyphusion.org"], dmarc: "pass", dmarcFrom: "skyphusion.org" });
    expect(await trustedOf(msg('"Alerts" <alerts@skyphusion.org>', auth))).toBe(1);
  });

  it("does not let a forged instance count when CF supplied none", async () => {
    // No CF verdict at all: nothing to align, so not trusted even with a forged pass.
    const h = new Headers();
    const auth = authFromHeaders!((n) => h.get(n));
    expect(auth).toMatchObject({ spf: "none", dkim: "none", dmarc: "none" });
    expect(await trustedOf(msg("ceo@skyphusion.org", auth))).toBe(0);
  });
});

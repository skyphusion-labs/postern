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

// --- Review round 2: injection through attacker-chosen values in CF's own instance ---
//
// smtp.mailfrom (and the comment that echoes it) and smtp.helo are chosen by the SENDER,
// yet sit inside the CF-written instance. They must never yield a method=result entry.

const AUTH_DKIM_ATTACKER = "mx.cloudflare.net; dkim=pass header.d=attacker.example header.s=s1 header.b=AAAA; dmarc=fail header.from=skyphusion.org policy.dmarc=reject; ";

function trustOfAr(ar: string, from = "CEO <ceo@skyphusion.org>", receivedSpf = "pass") {
  const get = (n: string): string | null => (n === "authentication-results" ? ar : n === "received-spf" ? receivedSpf : null);
  return headers.authFromHeaders(get);
}

describe("in-Worker driver: values the sender controls cannot inject a verdict", () => {
  const cases: Record<string, string> = {
    "quoted MAIL FROM local part with ;": AUTH_DKIM_ATTACKER +
      'spf=pass (mx.cloudflare.net: domain of "x;dkim=pass header.d=skyphusion.org y"@attacker.example designates 192.0.2.1 as permitted sender) ' +
      'smtp.mailfrom="x;dkim=pass header.d=skyphusion.org y"@attacker.example; arc=none smtp.remote-ip=192.0.2.1',
    "quoted local part with ( inside": AUTH_DKIM_ATTACKER +
      'spf=pass (mx.cloudflare.net: domain of "x(;dkim=pass header.d=skyphusion.org y"@attacker.example designates 192.0.2.1 as permitted sender) ' +
      'smtp.mailfrom="x(;dkim=pass header.d=skyphusion.org y"@attacker.example; arc=none',
    "quoted local part with ) inside": AUTH_DKIM_ATTACKER +
      'spf=pass (mx.cloudflare.net: domain of "x);dkim=pass header.d=skyphusion.org y"@attacker.example designates 192.0.2.1 as permitted sender) ' +
      'smtp.mailfrom="x);dkim=pass header.d=skyphusion.org y"@attacker.example; arc=none',
    "quoted local part with a comma (cut leaves an open quote)": AUTH_DKIM_ATTACKER +
      'spf=pass (mx.cloudflare.net: domain of "x;dkim=pass header.d=skyphusion.org,y"@attacker.example designates 192.0.2.1 as permitted sender) ' +
      'smtp.mailfrom="x;dkim=pass header.d=skyphusion.org,y"@attacker.example; arc=none',
    "unquoted HELO carrying ;": AUTH_DKIM_ATTACKER +
      "spf=none smtp.helo=x;dkim=pass header.d=skyphusion.org; spf=pass smtp.mailfrom=b@attacker.example; arc=none",
    "HELO injecting a dmarc pass": "mx.cloudflare.net; dkim=pass header.d=attacker.example; " +
      "spf=none smtp.helo=x;dmarc=pass header.from=skyphusion.org; spf=pass smtp.mailfrom=b@attacker.example",
    "HELO injecting an aligned SPF entry": "mx.cloudflare.net; dkim=none; dmarc=fail header.from=skyphusion.org; " +
      "spf=none smtp.helo=x;spf=pass smtp.mailfrom=ceo@skyphusion.org; spf=pass smtp.mailfrom=b@attacker.example",
  };
  for (const [name, ar] of Object.entries(cases)) {
    it(`stays untrusted: ${name}`, async () => {
      const auth = trustOfAr(ar);
      expect(auth.dkimDomains ?? []).not.toContain("skyphusion.org");
      expect(auth.spfDomain === "skyphusion.org").toBe(false);
      expect(auth.dmarc === "pass" && auth.dmarcFrom === "skyphusion.org").toBe(false);
      expect(await trustedOf(msg("CEO <ceo@skyphusion.org>", auth))).toBe(0);
    });
  }
});

// The live CF shape the lead observed on an npm notice: CRLF+TAB folded, two dkim=pass,
// dmarc=pass, then TWO spf= entries, the HELO one (spf=none) FIRST.
const LIVE_NPM_AR_FOLDED = [
  "mx.cloudflare.net;",
  "dkim=pass header.d=npmjs.com header.s=i3w6c3fu7s7tgmqto35f7tqsbdtjmclz header.b=DuWYwQhY;",
  "dkim=pass header.d=amazonses.com header.s=hsbnp7p3ensaochzwyq5wwmceodymuwv header.b=LzQcNswt;",
  "dmarc=pass header.from=npmjs.com policy.dmarc=quarantine;",
  "spf=none (mx.cloudflare.net: no SPF records found for postmaster@a84-221.smtp-out.us-west-2.amazonses.com) smtp.helo=a84-221.smtp-out.us-west-2.amazonses.com;",
  "spf=pass (mx.cloudflare.net: domain of 010101a1c2127365-x@us-west-2-amazonses.npmjs.com designates 54.240.84.221 as permitted sender) smtp.mailfrom=010101a1c2127365-x@us-west-2-amazonses.npmjs.com;",
  "arc=none smtp.remote-ip=54.240.84.221",
].join("\r\n\t");

describe("in-Worker driver: the live Cloudflare header shape", () => {
  const npmEnv = () => makeFakeEnv({ TRUSTED_SENDER_DOMAINS: "npmjs.com" });
  async function npmTrusted(auth: ParsedInbound["auth"]) {
    const { env, ctx, settle, rows } = npmEnv();
    await ingest(env, { messageId: "npm-" + Math.random().toString(36).slice(2) + "@x", from: "npm <support@npmjs.com>", to: "conrad@skyphusion.org", text: "b", auth }, ctx);
    await settle();
    return rows[0].trusted;
  }
  for (const [label, ar] of [["folded", LIVE_NPM_AR_FOLDED], ["unfolded", LIVE_NPM_AR_FOLDED.replace(/\r\n\t/g, " ")]] as const) {
    it(`parses every leg (${label}) and trusts npm`, async () => {
      const auth = trustOfAr(ar + ", evil; dkim=pass header.d=skyphusion.org", "npm <support@npmjs.com>");
      expect(auth).toEqual({
        spf: "pass", spfDomain: "us-west-2-amazonses.npmjs.com",
        dkim: "pass", dkimDomains: ["npmjs.com", "amazonses.com"],
        dmarc: "pass", dmarcFrom: "npmjs.com",
      });
      expect(await npmTrusted(auth)).toBe(1);
      // Each leg alone carries trust: SPF (the leg that was dead), DKIM, DMARC.
      expect(await npmTrusted({ spf: "pass", spfDomain: auth!.spfDomain, dkim: "none", dmarc: "none" })).toBe(1);
      expect(await npmTrusted({ spf: "none", dkim: "pass", dkimDomains: auth!.dkimDomains, dmarc: "none" })).toBe(1);
      expect(await npmTrusted({ spf: "none", dkim: "none", dmarc: "pass", dmarcFrom: "npmjs.com" })).toBe(1);
    });
  }
});

describe("in-Worker driver: a legitimate quoted MAIL FROM local part", () => {
  it("keeps the SPF leg: the quoted local part is opaque, its domain is read", async () => {
    const auth = trustOfAr("mx.cloudflare.net; dkim=none; dmarc=none; " +
      'spf=pass (mx.cloudflare.net: domain of "a;b c"@bounce.skyphusion.org designates 192.0.2.7 as permitted sender) ' +
      'smtp.mailfrom="a;b c"@bounce.skyphusion.org; arc=none', "alerts@skyphusion.org");
    expect(auth).toMatchObject({ spf: "pass", spfDomain: "bounce.skyphusion.org" });
    expect(await trustedOf(msg("alerts@skyphusion.org", auth))).toBe(1);
  });
});

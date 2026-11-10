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

  it("does NOT trust an aligned SPF pass alone: SPF is not a trust leg", async () => {
    // SPF evidence echoes sender-chosen HELO / MAIL FROM; DMARC covers aligned SPF.
    expect(await trustedOf(msg("alerts@skyphusion.org", {
      spf: "pass", spfDomain: "bounce.skyphusion.org", dkim: "none", dmarc: "none",
    } as ParsedInbound["auth"]))).toBe(0);
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
    expect(auth).toEqual({ spf: "pass", dkim: "none", dmarc: "fail", dmarcFrom: "skyphusion.org" });
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
    expect(auth).toEqual({ spf: "pass", dkim: "pass", dkimDomains: ["skyphusion.org"], dmarc: "pass", dmarcFrom: "skyphusion.org" });
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
      expect("spfDomain" in auth).toBe(false);
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
    it(`parses DKIM and DMARC (${label}) and trusts npm`, async () => {
      const auth = trustOfAr(ar + ", evil; dkim=pass header.d=skyphusion.org", "npm <support@npmjs.com>");
      // spf is the Received-SPF verdict, display only; nothing at/after `spf=` is read.
      expect(auth).toEqual({
        spf: "pass",
        dkim: "pass", dkimDomains: ["npmjs.com", "amazonses.com"],
        dmarc: "pass", dmarcFrom: "npmjs.com",
      });
      expect(await npmTrusted(auth)).toBe(1);
      // DMARC alone and DKIM alone each carry trust; SPF alone does not.
      expect(await npmTrusted({ spf: "none", dkim: "pass", dkimDomains: auth!.dkimDomains, dmarc: "none" })).toBe(1);
      expect(await npmTrusted({ spf: "none", dkim: "none", dmarc: "pass", dmarcFrom: "npmjs.com" })).toBe(1);
      expect(await npmTrusted({ spf: "pass", dkim: "none", dmarc: "none" })).toBe(0);
    });
  }
});

describe("in-Worker driver: a legitimate quoted MAIL FROM local part", () => {
  it("does NOT use the SPF leg: nothing at or after spf= is read", async () => {
    const auth = trustOfAr("mx.cloudflare.net; dkim=none; dmarc=none; " +
      'spf=pass (mx.cloudflare.net: domain of "a;b c"@bounce.skyphusion.org designates 192.0.2.7 as permitted sender) ' +
      'smtp.mailfrom="a;b c"@bounce.skyphusion.org; arc=none', "alerts@skyphusion.org");
    expect(auth).toEqual({ spf: "pass", dkim: "none", dmarc: "none" });
    expect(await trustedOf(msg("alerts@skyphusion.org", auth))).toBe(0);
  });
});

// --- Review round 3: sender-chosen echoes (HELO, MAIL FROM, a failing selector) ---
//
// CF echoes these unescaped, so text at or after the first raw `spf=` cannot be parsed
// unambiguously, and an anomaly before it voids the WHOLE header. Shape: CF-folded
// instance, a forged second instance after ", ", Received-SPF pass.

function cfAr(o: { helo?: string; mailfrom?: string; dkim?: string } = {}): string {
  const H = o.helo ?? "mta.attacker.example";
  const M = o.mailfrom ?? "bounce@attacker.example";
  return [
    "mx.cloudflare.net;",
    (o.dkim ?? "dkim=pass header.d=attacker.example header.s=s1 header.b=AAAA") + ";",
    "dmarc=fail header.from=skyphusion.org policy.dmarc=reject;",
    `spf=none (mx.cloudflare.net: no SPF records found for postmaster@${H}) smtp.helo=${H};`,
    `spf=pass (mx.cloudflare.net: domain of ${M} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${M};`,
    "arc=none smtp.remote-ip=192.0.2.1",
  ].join("\r\n\t") + ", forged.example; dkim=pass header.d=skyphusion.org; dmarc=pass header.from=skyphusion.org";
}

describe("round 3: echoes the sender chose cannot yield trust", () => {
  const cases: Record<string, string> = {
    "1 quote inside comment via MAIL FROM": cfAr({ mailfrom: '")a;spf=pass smtp.mailfrom=skyphusion.org;arc=none ("@attacker.example' }),
    "2 same, cut at a comma": cfAr({ mailfrom: '")a;spf=pass smtp.mailfrom=skyphusion.org,"@attacker.example' }),
    "3 HELO with a comma, no quotes": cfAr({ helo: "x)y;spf=pass/smtp.mailfrom=skyphusion.org," }),
    "4 HELO using drop-the-rest": cfAr({ helo: 'x)y;spf=pass/smtp.mailfrom=skyphusion.org;"(' }),
    "5 forged DMARC via a failing selector a(": cfAr({
      dkim: "dkim=fail header.d=attacker.example header.s=a( header.b=AAAA",
      helo: "x);dmarc=pass/header.from=skyphusion.org;q",
    }),
  };
  for (const [name, ar] of Object.entries(cases)) {
    it(`stays untrusted: ${name}`, async () => {
      const auth = trustOfAr(ar);
      expect(await trustedOf(msg("CEO <ceo@skyphusion.org>", auth))).toBe(0);
    });
  }
});

describe("round 3: positional rules inside the trusted region", () => {
  it("ignores a dkim= entry after a non-dkim entry", async () => {
    const auth = trustOfAr("mx.cloudflare.net; dkim=pass header.d=attacker.example; dmarc=fail header.from=skyphusion.org; dkim=pass header.d=skyphusion.org; spf=none smtp.helo=x");
    expect(auth.dkimDomains).toEqual(["attacker.example"]);
    expect(await trustedOf(msg("CEO <ceo@skyphusion.org>", auth))).toBe(0);
  });
  it("only the first dmarc= counts", async () => {
    const auth = trustOfAr("mx.cloudflare.net; dkim=none; dmarc=fail header.from=skyphusion.org; dmarc=pass header.from=skyphusion.org");
    expect(auth.dmarc).toBe("fail");
    expect(await trustedOf(msg("CEO <ceo@skyphusion.org>", auth))).toBe(0);
  });
  it("needs the FIRST DKIM verdict to be pass (conservative), even with an aligned later pass", async () => {
    const auth = trustOfAr("mx.cloudflare.net; dkim=fail header.d=esp.example; dkim=pass header.d=skyphusion.org; dmarc=none");
    expect(auth).toMatchObject({ dkim: "fail", dkimDomains: ["skyphusion.org"] });
    expect(await trustedOf(msg("alerts@skyphusion.org", auth))).toBe(0);
  });
});

// --- Review round 4: a balanced span merging two dkim entries ---
//
// A quote or comment that is balanced but spans two dkim= entries pulls the second
// entry's text into the first. A duplicate key or any token outside the strict entry
// grammar must void the whole header.

describe("round 4: merged dkim entries cannot re-point a passing signature", () => {
  const cases: Record<string, string> = {
    "(a) quote spanning two dkim entries": cfAr({
      dkim: 'dkim=pass header.d=attacker.example header.s=q" header.b=AAAA;\r\n\tdkim=fail header.d="z header.d=skyphusion.org header.s=s header.b=x',
    }),
    "(b) comment spanning two dkim entries": cfAr({
      dkim: "dkim=pass header.d=attacker.example header.s=q( header.b=AAAA;\r\n\tdkim=fail header.d=)z header.d=skyphusion.org header.s=s header.b=x",
    }),
  };
  for (const [name, ar] of Object.entries(cases)) {
    it(`stays untrusted: ${name}`, async () => {
      const auth = trustOfAr(ar);
      expect(auth.dkimDomains ?? []).not.toContain("skyphusion.org");
      expect(await trustedOf(msg("CEO <ceo@skyphusion.org>", auth))).toBe(0);
    });
  }
});

// A github.com notification in CF's shape (folded), with and without a dmarc comment.
const GITHUB_AR = [
  "mx.cloudflare.net;",
  "dkim=pass header.d=github.com header.s=pf2023 header.b=AbCd12+/;",
  "dmarc=pass (p=reject sp=reject dis=none) header.from=github.com;",
  "spf=pass (mx.cloudflare.net: domain of noreply@github.com designates 192.30.252.201 as permitted sender) smtp.mailfrom=noreply@github.com;",
  "arc=none smtp.remote-ip=192.30.252.201",
].join("\r\n\t");

describe("round 4: real shapes stay trusted under the strict grammar", () => {
  async function trustedFor(domain: string, from: string, auth: ParsedInbound["auth"]) {
    const { env, ctx, settle, rows } = makeFakeEnv({ TRUSTED_SENDER_DOMAINS: domain });
    await ingest(env, { messageId: "g-" + Math.random().toString(36).slice(2) + "@x", from, to: "conrad@skyphusion.org", text: "b", auth }, ctx);
    await settle();
    return rows[0].trusted;
  }
  for (const [label, ar] of [
    ["github", GITHUB_AR],
    ["github, no dmarc comment", GITHUB_AR.replace(" (p=reject sp=reject dis=none)", "")],
    ["npm live", LIVE_NPM_AR_FOLDED],
  ] as const) {
    it(`${label}: trusted by DMARC alone and by DKIM alone`, async () => {
      const domain = label.startsWith("npm") ? "npmjs.com" : "github.com";
      const from = label.startsWith("npm") ? "npm <support@npmjs.com>" : "GitHub <noreply@github.com>";
      const auth = trustOfAr(ar + ", forged; dkim=pass header.d=skyphusion.org", from);
      expect(auth!.dmarc).toBe("pass");
      expect(auth!.dmarcFrom).toBe(domain);
      expect(auth!.dkim).toBe("pass");
      expect(auth!.dkimDomains).toContain(domain);
      expect(await trustedFor(domain, from, auth)).toBe(1);
      expect(await trustedFor(domain, from, { spf: "none", dkim: "none", dmarc: "pass", dmarcFrom: auth!.dmarcFrom })).toBe(1);
      expect(await trustedFor(domain, from, { spf: "none", dkim: "pass", dkimDomains: auth!.dkimDomains, dmarc: "none" })).toBe(1);
    });
  }
});

// --- Review round 5: header.d / header.from must be BARE domains ---

describe("round 5: a non-bare header.d or header.from voids the header", () => {
  const cases: Record<string, string> = {
    "quote opening at the start of header.d merges sig2": cfAr({
      dkim: 'dkim=pass header.d="a.attacker.example header.s=s1 header.b=AAAA;\r\n\tdkim=fail header.d=b"@skyphusion.org header.s=s header.b=x',
    }),
    "header.d=x@skyphusion.org": cfAr({ dkim: "dkim=pass header.d=x@skyphusion.org header.s=s1 header.b=AAAA" }),
    'header.d="x"@skyphusion.org': cfAr({ dkim: 'dkim=pass header.d="x"@skyphusion.org header.s=s1 header.b=AAAA' }),
  };
  for (const [name, ar] of Object.entries(cases)) {
    it(`stays untrusted: ${name}`, async () => {
      const auth = trustOfAr(ar);
      expect(auth.dkimDomains ?? []).not.toContain("skyphusion.org");
      expect(await trustedOf(msg("CEO <ceo@skyphusion.org>", auth))).toBe(0);
    });
  }
  it("a non-bare header.from voids too (no DMARC verdict survives)", async () => {
    const auth = trustOfAr("mx.cloudflare.net; dkim=none; dmarc=pass header.from=ceo@skyphusion.org; spf=none smtp.helo=x");
    expect(auth).toMatchObject({ dkim: "none", dmarc: "none" });
    expect(await trustedOf(msg("CEO <ceo@skyphusion.org>", auth))).toBe(0);
  });
});

// --- Review round 5: availability, safe once header.d / header.from are bare ---

function npmWith(insert: { afterDkim?: string; afterDmarc?: string }): string {
  const lines = LIVE_NPM_AR_FOLDED.split("\r\n\t");
  const dmarcAt = lines.findIndex((l) => l.startsWith("dmarc="));
  if (insert.afterDmarc) lines.splice(dmarcAt + 1, 0, insert.afterDmarc);
  if (insert.afterDkim) lines.splice(dmarcAt, 0, insert.afterDkim);
  return lines.join("\r\n\t");
}

describe("round 5: well-formed entries CF may add do not void a good header", () => {
  async function npmTrusted(auth: ParsedInbound["auth"]) {
    const { env, ctx, settle, rows } = makeFakeEnv({ TRUSTED_SENDER_DOMAINS: "npmjs.com" });
    await ingest(env, { messageId: "n5-" + Math.random().toString(36).slice(2) + "@x", from: "npm <support@npmjs.com>", to: "conrad@skyphusion.org", text: "b", auth }, ctx);
    await settle();
    return rows[0].trusted;
  }
  it("an unknown METHOD entry (bimi=) is skipped, npm stays trusted", async () => {
    const auth = trustOfAr(npmWith({ afterDmarc: "bimi=pass header.d=npmjs.com header.selector=default;" }), "npm <support@npmjs.com>");
    expect(auth).toMatchObject({ dkim: "pass", dmarc: "pass", dmarcFrom: "npmjs.com" });
    expect(await npmTrusted(auth)).toBe(1);
  });
  it("a second signature carrying reason=\"...\" does not void the DMARC pass", async () => {
    const auth = trustOfAr(npmWith({ afterDkim: 'dkim=fail reason="signature verification failed" header.d=lists.example header.s=l1 header.b=ZZZZ;' }), "npm <support@npmjs.com>");
    expect(auth).toMatchObject({ dmarc: "pass", dmarcFrom: "npmjs.com" });
    expect(await npmTrusted({ spf: "none", dkim: "none", dmarc: auth.dmarc, dmarcFrom: auth.dmarcFrom })).toBe(1);
    expect(await npmTrusted(auth)).toBe(1);
  });
  it("a MALFORMED unknown-method entry still voids", async () => {
    const auth = trustOfAr(npmWith({ afterDmarc: "bimi=pass junk;" }), "npm <support@npmjs.com>");
    expect(auth).toMatchObject({ dkim: "none", dmarc: "none" });
  });
});

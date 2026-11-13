import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import PostalMime from "postal-mime";
import worker from "./src/index";
import { cfTraceBlock, isCloudflareReceived, driverAuth, MAX_RECEIVED_LENGTH, type RawHeader } from "./src/headers";
import * as store from "./src/store";
import { realEnv } from "./realdb";

// Inbound trust also requires Cloudflare's own Received header: the raw message, as CF
// hands it to the Worker, must start with CF's trace block, and the first
// Authentication-Results must sit inside it. Fixtures are the live CF shape (lead
// capture 2026-11-13, header NAMES in wire order) with every address, IP and id
// replaced: example.* domains, RFC 5737 IPs.

const CF_RECEIVED =
  "from mta-1.example.com (192.0.2.10)\r\n\tby cloudflare-email.com (cloudflare) id AbC123xyz\r\n\tfor <alice@example.org>; Fri, 13 Nov 2026 06:25:00 +0000";
const CF_ARC_SEAL = "i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.com; cv=none; b=AAAA";
const CF_ARC_MS = "i=1; a=rsa-sha256; c=relaxed/relaxed; d=cloudflare-email.com; s=cf2024-1; h=from:to; bh=BBBB; b=CCCC";
const CF_ARC_AR = "i=1; mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1 header.b=DDDD; dmarc=pass header.from=example.com policy.dmarc=reject; spf=pass smtp.mailfrom=bounce@example.com; arc=none smtp.remote-ip=192.0.2.10";
const CF_RECEIVED_SPF = "pass (mx.cloudflare.net: domain of bounce@example.com designates 192.0.2.10 as permitted sender) receiver=mx.cloudflare.net; client-ip=192.0.2.10; envelope-from=\"bounce@example.com\"; helo=mta-1.example.com;";
const CF_AR = [
  "mx.cloudflare.net;",
  "dkim=pass header.d=example.com header.s=s1 header.b=DDDD;",
  "dmarc=pass header.from=example.com policy.dmarc=reject;",
  "spf=pass (mx.cloudflare.net: domain of bounce@example.com designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@example.com;",
  "arc=none smtp.remote-ip=192.0.2.10",
].join("\r\n\t");
const FORGED_AR = "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1 header.b=EEEE; dmarc=pass header.from=example.com policy.dmarc=reject; spf=pass smtp.mailfrom=ceo@example.com";

type H = [string, string];
const CF_BLOCK: H[] = [
  ["Received", CF_RECEIVED],
  ["ARC-Seal", CF_ARC_SEAL],
  ["ARC-Message-Signature", CF_ARC_MS],
  ["ARC-Authentication-Results", CF_ARC_AR],
  ["Received-SPF", CF_RECEIVED_SPF],
  ["Authentication-Results", CF_AR],
  ["X-CF-SpamH-Score", "1"],
];
const SENDER: H[] = [
  ["Return-Path", "<bounce@example.com>"],
  ["DKIM-Signature", "v=1; a=rsa-sha256; d=example.com; s=s1; h=from:to; bh=BBBB; b=DDDD"],
  ["Received", "by mta-1.example.com with SMTP id q1; Fri, 13 Nov 2026 06:24:59 +0000"],
  ["Date", "Fri, 13 Nov 2026 06:24:58 +0000"],
  ["From", "Support <support@example.com>"],
  ["To", "alice@example.org"],
  ["Subject", "case update"],
];

const rawOf = (hs: H[], id: string) =>
  hs.map(([k, v]) => `${k}: ${v}`).join("\r\n") + `\r\nMessage-ID: <${id}>\r\nContent-Type: text/plain\r\n\r\nhello\r\n`;
const listOf = (hs: H[]): RawHeader[] => hs.map(([k, v]) => ({ key: k.toLowerCase(), value: v.replace(/\r\n/g, "") }));
const headersOf = (hs: H[]) => {
  const h = new Headers();
  for (const [k, v] of hs) h.append(k, v.replace(/\r\n/g, " "));
  return h;
};

const enc = new TextEncoder();
function emailEvent(hs: H[], id: string) {
  const raw = rawOf(hs, id);
  const bytes = enc.encode(raw);
  return {
    from: "bounce@example.com",
    to: "alice@example.org",
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
    rawSize: raw.length,
    headers: headersOf(hs),
    forward: async () => {},
    setReject: () => {},
    reply: async () => {},
  } as unknown as ForwardableEmailMessage;
}

async function trustedViaWorker(hs: H[]): Promise<boolean | undefined> {
  const id = "tb-" + Math.random().toString(36).slice(2) + "@example.com";
  const { env, ctx } = realEnv({ TRUSTED_SENDER_DOMAINS: "example.com" });
  await worker.email(emailEvent(hs, id), env, ctx);
  return (await store.getUnscoped(env, id))?.trusted;
}

describe("isCloudflareReceived: the strict CF Received shape", () => {
  it("accepts the live shape, folded or not", () => {
    expect(isCloudflareReceived(CF_RECEIVED)).toBe(true);
    expect(isCloudflareReceived(CF_RECEIVED.replace(/\r\n\t/g, " "))).toBe(true);
    expect(isCloudflareReceived(CF_RECEIVED.replace("192.0.2.10", "2001:db8::a"))).toBe(true);
  });

  const refused: Record<string, string> = {
    "another MTA's by-clause": CF_RECEIVED.replace("by cloudflare-email.com", "by mx.example.net"),
    "a lookalike domain": CF_RECEIVED.replace("cloudflare-email.com", "cloudflare-email.com.example.net"),
    "a different comment": CF_RECEIVED.replace("(cloudflare)", "(unknown)"),
    "the by-clause carried inside the HELO": "from x(by cloudflare-email.com (cloudflare) id 1 for <a@example.org>; d) (192.0.2.1) by mx.example.net (x) id 2 for <a@example.org>; d",
    "a HELO with a space": "from a b (192.0.2.1) by cloudflare-email.com (cloudflare) id 1 for <a@example.org>; d",
    "no IP comment": "from mta-1.example.com by cloudflare-email.com (cloudflare) id 1 for <a@example.org>; d",
    "a trailing second clause": CF_RECEIVED + "; extra",
    "empty": "",
  };
  for (const [name, v] of Object.entries(refused)) {
    it(`refuses ${name}`, () => expect(isCloudflareReceived(v)).toBe(false));
  }

  it("refuses a value over the length cap", () => {
    const long = CF_RECEIVED.replace("AbC123xyz", "a".repeat(MAX_RECEIVED_LENGTH));
    expect(isCloudflareReceived(long)).toBe(false);
  });
});

describe("cfTraceBlock: the order rule", () => {
  it("accepts the live CF block followed by the sender's headers", () => {
    expect(cfTraceBlock(listOf([...CF_BLOCK, ...SENDER]))).toEqual({ ok: true });
  });

  it("accepts the block without the ARC set (each CF header is optional except AR)", () => {
    const hs = CF_BLOCK.filter(([k]) => !k.startsWith("ARC-"));
    expect(cfTraceBlock(listOf([...hs, ...SENDER]))).toEqual({ ok: true });
  });

  const cases: Record<string, [H[], string]> = {
    "no headers at all": [[], "no_headers"],
    "a sender Authentication-Results first, no CF Received": [[["Authentication-Results", FORGED_AR], ...SENDER], "first_not_received"],
    "the sender's Received first": [[SENDER[2], ["Authentication-Results", FORGED_AR], ["X-CF-SpamH-Score", "1"], ...SENDER], "received_not_cloudflare"],
    "no end-of-block marker": [[CF_BLOCK[0], ["Authentication-Results", CF_AR], ...SENDER], "no_block_end"],
    "CF block without its AR, a sender AR below the block": [[...CF_BLOCK.filter(([k]) => k !== "Authentication-Results"), ["Authentication-Results", FORGED_AR], ...SENDER], "no_auth_results_in_block"],
    "a non-CF header inside the block": [[CF_BLOCK[0], ["Return-Path", "<x@example.com>"], ...CF_BLOCK.slice(1), ...SENDER], "foreign_header_in_block"],
    "a second Received inside the block": [[CF_BLOCK[0], ["Received", CF_RECEIVED], ...CF_BLOCK.slice(1), ...SENDER], "foreign_header_in_block"],
    "two Authentication-Results inside the block": [[...CF_BLOCK.slice(0, 6), ["Authentication-Results", FORGED_AR], ...CF_BLOCK.slice(6), ...SENDER], "duplicate_in_block"],
  };
  for (const [name, [hs, reason]] of Object.entries(cases)) {
    it(`refuses ${name} (${reason})`, () => {
      expect(cfTraceBlock(listOf(hs))).toEqual({ ok: false, reason });
    });
  }

  it("matches header names case-insensitively", () => {
    const upper = listOf([...CF_BLOCK, ...SENDER]).map((h) => ({ ...h, key: h.key.toUpperCase() }));
    expect(cfTraceBlock(upper)).toEqual({ ok: true });
  });
});

describe("driverAuth: no verdict unless the CF block is proven", () => {
  it("returns the CF verdict on the live shape", () => {
    const hs = [...CF_BLOCK, ...SENDER];
    const h = headersOf(hs);
    const { auth, trace } = driverAuth((n) => h.get(n), listOf(hs));
    expect(trace).toEqual({ ok: true });
    expect(auth).toMatchObject({ dkim: "pass", dmarc: "pass", dmarcFrom: "example.com", dkimDomains: ["example.com"] });
  });

  it("returns no verdict at all when the block is not proven", () => {
    const hs: H[] = [["Authentication-Results", FORGED_AR], ...SENDER];
    const h = headersOf(hs);
    // Control: the old reader alone WOULD read the forged instance as a pass.
    expect(h.get("authentication-results")).toContain("dmarc=pass");
    const { auth, trace } = driverAuth((n) => h.get(n), listOf(hs));
    expect(trace.ok).toBe(false);
    expect(auth).toEqual({ spf: "none", dkim: "none", dmarc: "none" });
  });
});

describe("postal-mime keeps the CF block on top, in wire order", () => {
  it("parses the raw message into the header list the guard reads", async () => {
    const parsed = await new PostalMime().parse(rawOf([...CF_BLOCK, ...SENDER], "pm@example.com"));
    expect(parsed.headers.slice(0, 8).map((h) => h.key)).toEqual([
      "received", "arc-seal", "arc-message-signature", "arc-authentication-results",
      "received-spf", "authentication-results", "x-cf-spamh-score", "return-path",
    ]);
    expect(cfTraceBlock(parsed.headers)).toEqual({ ok: true });
  });
});

describe("email(): end to end through the Worker driver", () => {
  afterEach(() => vi.restoreAllMocks());

  it("control: a normal CF-delivered message from an allowlisted, DMARC-aligned sender is trusted", async () => {
    expect(await trustedViaWorker([...CF_BLOCK, ...SENDER])).toBe(true);
  });

  it("a forged Authentication-Results with no CF Received is not trusted", async () => {
    expect(await trustedViaWorker([["Authentication-Results", FORGED_AR], ["X-CF-SpamH-Score", "1"], ...SENDER])).toBe(false);
  });

  it("a forged Authentication-Results below a CF block that has none is not trusted", async () => {
    const noAr = CF_BLOCK.filter(([k]) => k !== "Authentication-Results");
    expect(await trustedViaWorker([...noAr, ["Authentication-Results", FORGED_AR], ...SENDER])).toBe(false);
  });

  it("logs one line per message: outcome and reason, never an address", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await trustedViaWorker([["Authentication-Results", FORGED_AR], ...SENDER]);
    await trustedViaWorker([...CF_BLOCK, ...SENDER]);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("inbound_trust_guard "));
    expect(lines).toEqual([
      'inbound_trust_guard {"ok":false,"reason":"first_not_received"}',
      'inbound_trust_guard {"ok":true}',
    ]);
    expect(lines.join("\n")).not.toMatch(/@/);
  });
});

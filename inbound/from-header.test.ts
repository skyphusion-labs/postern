import { describe, it, expect } from "vitest";
import { chooseFrom } from "./src/headers";
import { ingest } from "./src/ingest";
import * as store from "./src/store";
import { makeFakeEnv } from "./fakes";

// #from-fidelity: the stored/displayed sender must be the RFC 5322 `From:` HEADER, not
// the SMTP envelope sender (MAIL FROM). ESPs that use VERP/bounce addressing
// (SparkPost/SendGrid/SES/Mailgun/Cloudflare notify) set the envelope sender to a
// dynamic bounce address; storing THAT made every such message show
// `msprvs1=...=bounces-...@notify.cloudflare.com` instead of `"Cloudflare"
// <noreply@notify.cloudflare.com>`. The CF email() driver now normalizes `from` via
// chooseFrom(getHeader("from"), message.from); this suite covers chooseFrom and the
// ingest -> store -> trust pipeline it feeds. (The email() handler itself imports the
// worker entrypoint / cloudflare:workers, so it is exercised end-to-end against
// wrangler dev, not in this node suite -- same split as the other transport helpers.)

describe("chooseFrom (header vs envelope sender)", () => {
  it("prefers the From header (display name preserved) over the envelope sender", () => {
    expect(
      chooseFrom('"Cloudflare" <noreply@notify.cloudflare.com>', "msprvs1=abc=bounces-1@notify.cloudflare.com"),
    ).toBe('"Cloudflare" <noreply@notify.cloudflare.com>');
  });

  it("falls back to the envelope sender when there is no From header", () => {
    expect(chooseFrom(null, "bounce@lists.example.com")).toBe("bounce@lists.example.com");
    expect(chooseFrom("", "bounce@lists.example.com")).toBe("bounce@lists.example.com");
    expect(chooseFrom("   ", "bounce@lists.example.com")).toBe("bounce@lists.example.com");
  });
});

describe("ingest stores the header From end-to-end", () => {
  it("keeps the display-name From on the stored + listed message", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    const headerFrom = '"Cloudflare" <noreply@notify.cloudflare.com>';
    await ingest(
      env,
      {
        messageId: "cf-access-1@notify.cloudflare.com",
        from: headerFrom, // the CF driver now passes the header, not the bounce sender
        to: "conrad@skyphusion.org",
        subject: "Cloudflare Access login code for play.skyphusion.org",
        text: "Your login code is 627120.",
      },
      ctx,
    );
    await settle();

    const msg = await store.get(env, "cf-access-1@notify.cloudflare.com");
    expect(msg!.from).toBe(headerFrom);
    expect(msg!.from).not.toContain("bounces");

    // Summaries carry the same value, so the IMAP/webmail list shows "Cloudflare".
    const page = await store.list(env, {});
    expect(page.items[0].from).toBe(headerFrom);
    // The from= filter still substring-matches the address inside the header.
    const byAddr = await store.list(env, { from: "noreply@notify.cloudflare.com" });
    expect(byAddr.items.map((m) => m.messageId)).toContain("cf-access-1@notify.cloudflare.com");
  });

  it("computes trust on the header-From domain, not the envelope bounce domain", async () => {
    // TRUSTED_SENDER_DOMAINS in the fake env is "skyphusion.org,example.com". A message
    // whose header From is an allowlisted domain is trusted even though the real message
    // arrived via a different (bounce) envelope sender.
    const { env, ctx, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "trust-1@skyphusion.org",
        from: '"Alerts" <alerts@skyphusion.org>',
        to: "conrad@skyphusion.org",
        text: "system alert",
        auth: { spf: "pass", dkim: "none", dmarc: "pass" },
      },
      ctx,
    );
    await settle();
    expect((await store.get(env, "trust-1@skyphusion.org"))!.trusted).toBe(true);
  });
});

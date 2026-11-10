import { describe, it, expect, vi, afterEach } from "vitest";
import { handleApi } from "./src/api";
import { sha256Hex } from "./src/sendidentity";
import { RelayTransport } from "./src/transport/relay";
import type { OutboundMessage } from "./src/transport/index";
import { makeFakeEnv } from "./fakes";

// Caller-supplied header NAMES on a send. A name must be an RFC 5322 field-name
// (printable ASCII 33-126, no colon), and a caller may not set a header the system owns
// (identity, addressing, trace, MIME). Enforced before ANY transport, and again at the
// relay transport seam.

afterEach(() => { vi.unstubAllGlobals(); });

async function sendWith(headers: Record<string, string>, transport: "relay" | "cf" = "relay") {
  const hash = await sha256Hex("agent-secret");
  const made = makeFakeEnv({
    POSTERN_SEND_IDENTITIES: JSON.stringify({ [hash]: { from: "agent@skyphusion.org" } }),
    OUTBOUND_TRANSPORT: transport,
    RELAY_DISPATCH_URL: "https://relay.example/dispatch",
    POSTERN_TRANSPORT_TOKEN: "transport-secret",
  });
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
  const res = await handleApi(new Request("https://postern.example/api/send", {
    method: "POST",
    headers: { authorization: "Bearer agent-secret", "content-type": "application/json" },
    body: JSON.stringify({ to: "d@example.com", subject: "hi", text: "yo", headers }),
  }), made.env, made.ctx);
  await made.settle();
  const text = await res.text();
  return { status: res.status, body: text, relayCalls: calls, cfSent: made.sent };
}

describe("send: caller header names", () => {
  it("rejects a name carrying a colon (would emit a second From on the relay wire)", async () => {
    const r = await sendWith({ "From: Boss <boss@skyphusion.org> (": ")" });
    expect(r.status).toBe(400);
    expect(r.body).toContain("E_VALIDATION_ERROR");
    expect(r.relayCalls).toHaveLength(0);
  });

  const reserved = [
    "From", "Sender", "To", "Cc", "Bcc", "Reply-To", "Return-Path", "Message-ID", "Date",
    "MIME-Version", "Content-Type", "Content-Transfer-Encoding", "Content-Disposition", "Received",
    // case and spacing variants
    "sender", "message-id", "CONTENT-TYPE", "return-PATH", "Resent-From", "Subject",
  ];
  for (const name of reserved) {
    it(`rejects the reserved name ${JSON.stringify(name)}`, async () => {
      const r = await sendWith({ [name]: "boss@skyphusion.org" });
      expect(r.status).toBe(400);
      expect(r.body).toContain("E_VALIDATION_ERROR");
      expect(r.relayCalls).toHaveLength(0);
    });
  }

  const malformed = ["", "X Bad", "X-Tab\there", "X-\u0001", "X-\u007f", "X-café", " X-Lead", "X-Trail "];
  for (const name of malformed) {
    it(`rejects the malformed name ${JSON.stringify(name)}`, async () => {
      const r = await sendWith({ [name]: "v" });
      expect(r.status).toBe(400);
      expect(r.relayCalls).toHaveLength(0);
    });
  }

  it("rejects a bad name on the CF transport too", async () => {
    const r = await sendWith({ "X-A:b": "v" }, "cf");
    expect(r.status).toBe(400);
    expect(r.cfSent).toHaveLength(0);
  });

  // Positive control: the same harness DOES send, so the 400s above are the rule.
  it("still relays legitimate caller headers", async () => {
    const r = await sendWith({ "X-Custom": "1", "In-Reply-To": "<a@b>", References: "<a@b>", "List-Unsubscribe": "<mailto:u@x>" });
    expect(r.status).toBe(200);
    expect(r.relayCalls).toHaveLength(1);
    const wire = JSON.parse(r.relayCalls[0]);
    expect(wire.from.email).toBe("agent@skyphusion.org");
    expect(Object.keys(wire.headers).sort()).toEqual(["In-Reply-To", "List-Unsubscribe", "Message-ID", "References", "X-Custom"]);
  });
});

describe("RelayTransport: header names at the transport seam", () => {
  function out(headers: Record<string, string>): OutboundMessage {
    return { messageId: "m1@skyphusion.org", to: ["d@example.com"], from: { email: "agent@skyphusion.org" }, subject: "s", text: "t", headers };
  }
  const env = { RELAY_DISPATCH_URL: "https://relay.example/dispatch", POSTERN_TRANSPORT_TOKEN: "tt" } as unknown as Env;

  it("refuses a reserved or malformed name before any network call", async () => {
    const cases: Record<string, string>[] = [{ Sender: "boss@x" }, { "From: x (": ")" }, { "message-id": "<other@x>" }];
    for (const h of cases) {
      const f = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", f);
      await expect(new RelayTransport(env).dispatch(out({ "Message-ID": "<m1@skyphusion.org>", ...h }))).rejects.toThrow();
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("refuses a Message-ID that is not the core-generated id", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await expect(new RelayTransport(env).dispatch(out({ "Message-ID": "<spoof@x>" }))).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it("passes the core-stamped Message-ID and caller X- headers", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await new RelayTransport(env).dispatch(out({ "Message-ID": "<m1@skyphusion.org>", "X-Ok": "1" }));
    expect(f).toHaveBeenCalledTimes(1);
  });
});

// --- Parity with the Go relay: ONE table (relay/testdata/header_names.json) ---
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { headerNameProblem, MAX_HEADER_NAME_LENGTH } from "./src/headernames";

const PARITY = JSON.parse(readFileSync(new URL("../relay/testdata/header_names.json", import.meta.url), "utf8")) as {
  maxNameLength: number;
  cases: { name: string; ok: boolean }[];
};

describe("header-name rule: parity table shared with relay/header_names_test.go", () => {
  it("the table cap equals the code constant (same check as the Go test)", () => {
    expect(MAX_HEADER_NAME_LENGTH).toBe(PARITY.maxNameLength);
  });
  it("the table covers the length boundary on both sides", () => {
    const lens = PARITY.cases.filter((c) => /^X-a+$/.test(c.name)).map((c) => [c.name.length, c.ok]);
    expect(lens).toContainEqual([PARITY.maxNameLength, true]);
    expect(lens).toContainEqual([PARITY.maxNameLength + 1, false]);
  });
  for (const c of PARITY.cases) {
    it(`${c.ok ? "accepts" : "refuses"} ${JSON.stringify(c.name)} (rule + send door)`, async () => {
      expect(headerNameProblem(c.name) === null).toBe(c.ok);
      const r = await sendWith({ [c.name]: "v" });
      expect(r.status).toBe(c.ok ? 200 : 400);
      expect(r.relayCalls).toHaveLength(c.ok ? 1 : 0);
    });
  }
});

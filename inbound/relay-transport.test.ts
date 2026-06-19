import { describe, it, expect, vi, afterEach } from "vitest";
import { RelayTransport } from "./src/transport/relay";
import { selectTransport, type OutboundMessage } from "./src/transport/index";
import { send } from "./src/mailbox";
import * as store from "./src/store";
import { makeFakeEnv } from "./fakes";

function relayEnv(over: Partial<Record<string, unknown>> = {}): Env {
  return {
    OUTBOUND_TRANSPORT: "relay",
    RELAY_DISPATCH_URL: "https://relay.example/dispatch",
    POSTERN_TRANSPORT_TOKEN: "transport-secret",
    POSTERN_API_TOKEN: "api-secret",
    ...over,
  } as unknown as Env;
}

function msg(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    messageId: "m1@skyphusion.org",
    to: ["dev@example.com"],
    from: { email: "noreply@skyphusion.org", name: "Skyphusion" },
    subject: "hi",
    text: "hello",
    headers: { "Message-ID": "<m1@skyphusion.org>" },
    ...over,
  };
}

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selectTransport", () => {
  it("returns a RelayTransport for OUTBOUND_TRANSPORT=relay", () => {
    vi.stubGlobal("fetch", mockFetch(200, { ok: true }));
    expect(selectTransport(relayEnv())).toBeInstanceOf(RelayTransport);
  });

  it("throws on an unknown transport", () => {
    expect(() => selectTransport(relayEnv({ OUTBOUND_TRANSPORT: "smoke-signals" }))).toThrow();
  });

  it("fails to construct a relay transport without URL or token", () => {
    expect(() => new RelayTransport(relayEnv({ RELAY_DISPATCH_URL: "" }))).toThrow();
    expect(() => new RelayTransport(relayEnv({ POSTERN_TRANSPORT_TOKEN: "" }))).toThrow();
  });
});

describe("RelayTransport.dispatch", () => {
  it("POSTs the OutboundMessage to /dispatch with the TRANSPORT token and returns providerMessageId", async () => {
    const fetchMock = mockFetch(200, { ok: true, messageId: "m1@skyphusion.org", providerMessageId: "smtp-999" });
    vi.stubGlobal("fetch", fetchMock);

    const res = await new RelayTransport(relayEnv()).dispatch(msg({ bcc: ["secret@example.com"] }));
    expect(res.providerMessageId).toBe("smtp-999");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example/dispatch");
    expect(init.method).toBe("POST");
    // Uses the TRANSPORT token, never the API token.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer transport-secret");
    expect((init.headers as Record<string, string>).authorization).not.toContain("api-secret");

    const sentBody = JSON.parse(init.body as string) as OutboundMessage;
    expect(sentBody.messageId).toBe("m1@skyphusion.org");
    // bcc rides in the bcc field, NEVER in headers.
    expect(sentBody.bcc).toEqual(["secret@example.com"]);
    expect(JSON.stringify(sentBody.headers)).not.toContain("secret@example.com");
  });

  it("tolerates a 200 with no providerMessageId (best-effort)", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { ok: true, messageId: "m1@skyphusion.org" }));
    const res = await new RelayTransport(relayEnv()).dispatch(msg());
    expect(res.providerMessageId).toBeUndefined();
  });

  it("maps a 401 (bad transport token) to a non-retryable internal error", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { ok: false, error: "unauthorized" }));
    await expect(new RelayTransport(relayEnv()).dispatch(msg())).rejects.toMatchObject({
      code: "E_INTERNAL_SERVER_ERROR",
    });
  });

  it("maps a 400 (bad message) to a validation error", async () => {
    vi.stubGlobal("fetch", mockFetch(400, { ok: false, error: "no recipients" }));
    await expect(new RelayTransport(relayEnv()).dispatch(msg())).rejects.toMatchObject({
      code: "E_VALIDATION_ERROR",
    });
  });

  it("maps a 413 to payload-too-large", async () => {
    vi.stubGlobal("fetch", mockFetch(413, { ok: false, error: "too large" }));
    await expect(new RelayTransport(relayEnv()).dispatch(msg())).rejects.toMatchObject({
      code: "E_PAYLOAD_TOO_LARGE",
    });
  });

  it("maps a 502 (upstream SMTP failed) to a retryable delivery error", async () => {
    vi.stubGlobal("fetch", mockFetch(502, { ok: false, error: "dispatch failed: dial tcp" }));
    await expect(new RelayTransport(relayEnv()).dispatch(msg())).rejects.toMatchObject({
      code: "E_DELIVERY_FAILED",
    });
  });

  it("maps a network failure to a retryable delivery error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(new RelayTransport(relayEnv()).dispatch(msg())).rejects.toMatchObject({
      code: "E_DELIVERY_FAILED",
    });
  });
});


describe("mailbox.send over the relay transport (end to end)", () => {
  it("dispatches via the relay AND stores the outbound copy", async () => {
    const fetchMock = mockFetch(200, { ok: true, messageId: "x", providerMessageId: "smtp-1" });
    vi.stubGlobal("fetch", fetchMock);

    const { env, ctx, settle } = makeFakeEnv({
      OUTBOUND_TRANSPORT: "relay",
      RELAY_DISPATCH_URL: "https://relay.example/dispatch",
      POSTERN_TRANSPORT_TOKEN: "transport-secret",
    });

    const res = await send(env, { to: "dev@example.com", subject: "hi", text: "hello" }, ctx);
    await settle();

    // Sent through the relay, not env.EMAIL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The sent copy is still in the store, threaded.
    const stored = await store.get(env, res.messageId);
    expect(stored?.direction).toBe("outbound");
    expect(res.providerMessageId).toBe("smtp-1");
  });
});

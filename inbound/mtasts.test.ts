// MTA-STS policy endpoint (#197, RFC 8461). Proves the pure policy builder emits a
// well-formed policy, and that GET /.well-known/mta-sts.txt is ANONYMOUS (no token),
// dark by default (404 unset), env-driven, and refuses to serve a malformed policy.

import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { buildMtaStsPolicy, type MtaStsParams } from "./src/mtasts";
import { makeFakeEnv } from "./fakes";

const WELL_KNOWN = "/.well-known/mta-sts.txt";

// A request with NO Authorization header -- the MTA-STS door must answer these
// (senders fetch anonymously); if it ever 401s, the token gate leaked onto it.
function anon(method: string): Request {
  return new Request(`https://mta-sts.skyphusion.org${WELL_KNOWN}`, { method });
}

function testingEnv(extra: Record<string, unknown> = {}) {
  return makeFakeEnv({
    MTA_STS_MODE: "testing",
    MTA_STS_MX: "*.mx.cloudflare.net",
    MTA_STS_MAX_AGE: "86400",
    ...extra,
  });
}

describe("buildMtaStsPolicy (pure)", () => {
  it("emits version, mode, one mx line per pattern, max_age, trailing newline", () => {
    const params: MtaStsParams = { mode: "enforce", mx: ["*.mx.cloudflare.net"], maxAge: 604800 };
    const out = buildMtaStsPolicy(params);
    expect(out).toBe(
      "version: STSv1\nmode: enforce\nmx: *.mx.cloudflare.net\nmax_age: 604800\n",
    );
  });

  it("emits one mx line per pattern in order", () => {
    const out = buildMtaStsPolicy({ mode: "testing", mx: ["a.example", "b.example"], maxAge: 86400 });
    expect(out).toContain("mx: a.example\nmx: b.example\n");
  });
});

describe("GET /.well-known/mta-sts.txt", () => {
  it("is anonymous + serves the testing policy (no token required)", async () => {
    const { env, ctx } = testingEnv();
    const res = await handleApi(anon("GET"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("version: STSv1");
    expect(body).toContain("mode: testing");
    expect(body).toContain("mx: *.mx.cloudflare.net");
    expect(body).toContain("max_age: 86400");
  });

  it("is dark by default: 404 when MTA_STS_MODE is unset (still no 401)", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(anon("GET"), env, ctx);
    expect(res.status).toBe(404);
  });

  it("serves an enforce policy when configured", async () => {
    const { env, ctx } = testingEnv({ MTA_STS_MODE: "enforce", MTA_STS_MAX_AGE: "604800" });
    const res = await handleApi(anon("GET"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mode: enforce");
  });

  it("allows mode: none with no mx (retirement)", async () => {
    const { env, ctx } = makeFakeEnv({ MTA_STS_MODE: "none", MTA_STS_MAX_AGE: "86400" });
    const res = await handleApi(anon("GET"), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("mode: none");
    expect(body).not.toContain("mx:");
  });

  it("500s a configured-but-invalid policy (testing/enforce with no mx)", async () => {
    const { env, ctx } = makeFakeEnv({ MTA_STS_MODE: "testing", MTA_STS_MAX_AGE: "86400" });
    const res = await handleApi(anon("GET"), env, ctx);
    expect(res.status).toBe(500);
  });

  it("500s an invalid mode", async () => {
    const { env, ctx } = testingEnv({ MTA_STS_MODE: "bogus" });
    const res = await handleApi(anon("GET"), env, ctx);
    expect(res.status).toBe(500);
  });

  it("does not serve on non-GET", async () => {
    const { env, ctx } = testingEnv();
    const res = await handleApi(anon("POST"), env, ctx);
    expect(res.status).toBe(404);
  });
});

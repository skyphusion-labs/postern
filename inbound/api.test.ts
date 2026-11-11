import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

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

describe("handleApi", () => {
  it("serves health without a token", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "postern" });
  });

  it("serves an HTML landing at / (not the health JSON)", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("GET", "/"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Postern");
    expect(body).toContain("/webmail");
  });

  it("answers HEAD on / and /health with 200 (no body)", async () => {
    const { env, ctx } = makeFakeEnv();
    const root = await handleApi(req("HEAD", "/"), env, ctx);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toMatch(/text\/html/);
    expect(await root.text()).toBe("");

    const health = await handleApi(req("HEAD", "/health"), env, ctx);
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toContain("application/json");
    expect(await health.text()).toBe("");
  });

  it("serves robots.txt and sitemap.xml on the posternonline.com demo zone", async () => {
    const { env, ctx } = makeFakeEnv();
    const robots = await handleApi(
      new Request("https://demo.posternonline.com/robots.txt", { method: "GET" }),
      env,
      ctx,
    );
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toMatch(/text\/plain/);
    const robotsBody = await robots.text();
    expect(robotsBody).toContain("Sitemap: https://demo.posternonline.com/sitemap.xml");

    const sitemap = await handleApi(
      new Request("https://demo.posternonline.com/sitemap.xml", { method: "GET" }),
      env,
      ctx,
    );
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toMatch(/xml/);
    const mapBody = await sitemap.text();
    expect(mapBody).toContain("https://demo.posternonline.com/");
    expect(mapBody).toContain("https://demo.posternonline.com/webmail");
  });

  // #579: both routes hardcode the demo's own canonical URLs, so serving them
  // on a self-hoster's own mail domain would advertise OUR demo's robots/
  // sitemap on THEIR host. Host-gated on the posternonline.com zone; every
  // other host must fall through to the ordinary not_found path, restoring
  // exactly what production served before the SEO routes existed (verified
  // live: postern.skyphusion.org/robots.txt was 404 on v1.4.3).
  it("404s robots.txt and sitemap.xml off the posternonline.com zone (self-hoster host)", async () => {
    const { env, ctx } = makeFakeEnv();
    const robots = await handleApi(req("GET", "/robots.txt"), env, ctx);
    expect(robots.status).toBe(404);

    const sitemap = await handleApi(req("GET", "/sitemap.xml"), env, ctx);
    expect(sitemap.status).toBe(404);

    const otherDomain = await handleApi(
      new Request("https://mail.example.com/robots.txt", { method: "GET" }),
      env,
      ctx,
    );
    expect(otherDomain.status).toBe(404);
  });

  it("301s posternonline.com apex to demo.posternonline.com", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(
      new Request("https://posternonline.com/webmail?x=1", { method: "GET" }),
      env,
      ctx,
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://demo.posternonline.com/webmail?x=1");

    const www = await handleApi(
      new Request("https://www.posternonline.com/", { method: "GET" }),
      env,
      ctx,
    );
    expect(www.status).toBe(301);
    expect(www.headers.get("location")).toBe("https://demo.posternonline.com/");
  });

  it("keeps the apex redirect on the demo host for a path that starts with //", async () => {
    const { env, ctx } = makeFakeEnv();
    for (const [input, want] of [
      ["https://posternonline.com//evil.example/login", "https://demo.posternonline.com//evil.example/login"],
      ["https://www.posternonline.com//evil.example/x?q=1", "https://demo.posternonline.com//evil.example/x?q=1"],
      ["https://posternonline.com///evil.example", "https://demo.posternonline.com///evil.example"],
    ] as const) {
      const res = await handleApi(new Request(input, { method: "GET" }), env, ctx);
      expect(res.status).toBe(301);
      const location = res.headers.get("location") ?? "";
      expect(new URL(location).host).toBe("demo.posternonline.com");
      expect(location).toBe(want);
    }
  });

  it("401s an API call with no/with a wrong token", async () => {
    const { env, ctx } = makeFakeEnv();
    expect((await handleApi(req("POST", "/api/send", { body: {} }), env, ctx)).status).toBe(401);
    expect((await handleApi(req("POST", "/api/send", { token: "wrong", body: {} }), env, ctx)).status).toBe(401);
  });

  it("sends via POST /api/send with the API token", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    const res = await handleApi(
      req("POST", "/api/send", { token: "test-token", body: { to: "d@example.com", subject: "hi", text: "yo" } }),
      env,
      ctx,
    );
    await settle();
    const payload = (await res.json()) as { ok: boolean; messageId: string };
    expect(res.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("keeps /send as a back-compat alias of /api/send", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    const res = await handleApi(
      req("POST", "/send", { token: "test-token", body: { to: "d@example.com", subject: "hi", text: "yo" } }),
      env,
      ctx,
    );
    await settle();
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("reads a stored message and its thread over the API", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    const sendRes = await handleApi(
      req("POST", "/api/send", { token: "test-token", body: { to: "d@example.com", subject: "hi", text: "yo" } }),
      env,
      ctx,
    );
    await settle();
    const { messageId, threadId } = (await sendRes.json()) as { messageId: string; threadId: string };

    const getRes = await handleApi(req("GET", `/api/messages/${encodeURIComponent(messageId)}`, { token: "test-token" }), env, ctx);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()) as { message: { messageId: string } }).toMatchObject({ message: { messageId } });

    const threadRes = await handleApi(req("GET", `/api/threads/${encodeURIComponent(threadId)}`, { token: "test-token" }), env, ctx);
    const tp = (await threadRes.json()) as { messages: unknown[] };
    expect(threadRes.status).toBe(200);
    expect(tp.messages).toHaveLength(1);
  });

  it("404s an unknown message id", async () => {
    const { env, ctx } = makeFakeEnv();
    const res = await handleApi(req("GET", "/api/messages/nope@example.com", { token: "test-token" }), env, ctx);
    expect(res.status).toBe(404);
  });
});

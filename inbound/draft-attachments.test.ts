import { describe, expect, it } from "vitest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

async function registry(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({ [hash]: { from: "conrad@skyphusion.org" } });
}

function jsonRequest(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`https://postern.example${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function uploadRequest(path: string, token: string, name: string, bytes: Uint8Array): Request {
  return new Request(`https://postern.example${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
      "x-postern-filename": encodeURIComponent(name),
    },
    body: bytes,
  });
}

describe("identity-owned draft attachment staging (#353)", () => {
  it("uploads, lists, deletes, and enforces the draft owner", async () => {
    const token = "owner-token";
    const other = "other-token";
    const { env, ctx, r2 } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: JSON.stringify({
        ...JSON.parse(await registry(token)),
        ...JSON.parse((await registry(other)).replace("conrad@skyphusion.org", "other@skyphusion.org")),
      }),
    });
    expect((await handleApi(jsonRequest("PUT", "/api/drafts/d1", token, {
      to: "friend@example.com", subject: "draft", bodyText: "body",
    }), env, ctx)).status).toBe(200);

    const upload = await handleApi(
      uploadRequest("/api/drafts/d1/attachments", token, "notes.txt", new TextEncoder().encode("hello")),
      env,
      ctx,
    );
    expect(upload.status).toBe(201);
    const created = (await upload.json()) as { attachment: { id: string; filename: string; size: number } };
    expect(created.attachment).toMatchObject({ filename: "notes.txt", size: 5 });
    expect(r2).toHaveLength(1);

    const listed = await handleApi(jsonRequest("GET", "/api/drafts/d1/attachments", token), env, ctx);
    expect((await listed.json()) as { attachments: unknown[] }).toMatchObject({
      attachments: [{ id: created.attachment.id, filename: "notes.txt", size: 5 }],
    });
    expect((await handleApi(jsonRequest("GET", "/api/drafts/d1/attachments", other), env, ctx)).status).toBe(404);

    expect((await handleApi(jsonRequest(
      "DELETE",
      `/api/drafts/d1/attachments/${created.attachment.id}`,
      token,
    ), env, ctx)).status).toBe(200);
    expect(r2).toHaveLength(0);
  });

  it("sends staged bytes through the one core and removes the draft only on success", async () => {
    const token = "owner-token";
    const { env, ctx, sent, r2 } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: await registry(token),
    });
    await handleApi(jsonRequest("PUT", "/api/drafts/d2", token, {
      to: "friend@example.com", subject: "draft", bodyText: "body",
    }), env, ctx);
    await handleApi(
      uploadRequest("/api/drafts/d2/attachments", token, "notes.txt", new TextEncoder().encode("hello")),
      env,
      ctx,
    );

    const response = await handleApi(jsonRequest("POST", "/api/drafts/d2/send", token, {}), env, ctx);
    expect(response.status).toBe(200);
    expect(sent[0].attachments?.[0]).toMatchObject({ filename: "notes.txt", type: "text/plain" });
    expect(new TextDecoder().decode(sent[0].attachments?.[0].content as ArrayBuffer)).toBe("hello");
    expect(r2).toHaveLength(0);
    expect((await handleApi(jsonRequest("GET", "/api/drafts/d2", token), env, ctx)).status).toBe(404);
  });

  it("preserves the draft and staged bytes when delivery fails", async () => {
    const token = "owner-token";
    const { env, ctx, r2 } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: await registry(token),
      EMAIL: { async send() { throw Object.assign(new Error("provider down"), { code: "E_DELIVERY_FAILED" }); } },
    });
    await handleApi(jsonRequest("PUT", "/api/drafts/d3", token, {
      to: "friend@example.com", subject: "draft", bodyText: "body",
    }), env, ctx);
    await handleApi(
      uploadRequest("/api/drafts/d3/attachments", token, "notes.txt", new TextEncoder().encode("hello")),
      env,
      ctx,
    );
    expect((await handleApi(jsonRequest("POST", "/api/drafts/d3/send", token, {}), env, ctx)).status).toBe(502);
    expect((await handleApi(jsonRequest("GET", "/api/drafts/d3", token), env, ctx)).status).toBe(200);
    expect((await handleApi(jsonRequest("GET", "/api/drafts/d3/attachments", token), env, ctx)).status).toBe(200);
    expect(r2).toHaveLength(1);
  });

  it("rejects an attachment above the 25 MiB cap", async () => {
    const token = "owner-token";
    const { env, ctx } = makeFakeEnv({
      POSTERN_API_TOKEN: undefined,
      POSTERN_SEND_IDENTITIES: await registry(token),
    });
    await handleApi(jsonRequest("PUT", "/api/drafts/d4", token, {
      to: "friend@example.com", subject: "draft", bodyText: "body",
    }), env, ctx);
    const request = uploadRequest(
      "/api/drafts/d4/attachments",
      token,
      "too-big.bin",
      new Uint8Array(25 * 1024 * 1024 + 1),
    );
    expect((await handleApi(request, env, ctx)).status).toBe(413);
  });
});

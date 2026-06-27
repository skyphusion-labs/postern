// Read-only HTTP client over the Postern mailbox API. Zero runtime deps beyond
// Node's global fetch (Node >= 18). Every request carries a custom User-Agent:
// the API sits behind Cloudflare, which 403s default bot UAs ("error 1010"), so
// a real UA is mandatory and must never regress.

import type { Direction, Message, MessageSummary, Page, SearchHit, SearchMode } from "./types.js";

export const USER_AGENT = "postern-mcp (+https://github.com/skyphusion-labs/postern)";

export class PosternError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "PosternError";
    this.status = status;
  }
}

export interface ClientOptions {
  userAgent?: string;
  timeoutMs?: number;
}

export class PosternClient {
  private readonly base: string;
  private readonly token: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token: string, opts: ClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async search(args: {
    q: string;
    mode?: SearchMode;
    limit?: number;
    cursor?: string;
    direction?: Direction;
  }): Promise<Page<SearchHit>> {
    const params: Record<string, string> = { q: args.q };
    if (args.mode) params.mode = args.mode;
    if (args.limit !== undefined) params.limit = String(args.limit);
    if (args.cursor) params.cursor = args.cursor;
    // Forwarded for direction-scoped search (#116 ws2). The store supports it; if
    // the API has not yet wired it on /api/search the param is simply ignored,
    // so this is forward-compatible, never an error.
    if (args.direction) params.direction = args.direction;
    const body = await this.request("/api/search", params);
    return { items: (body.items as SearchHit[]) ?? [], cursor: body.cursor ?? null };
  }

  async list(args: {
    to?: string;
    from?: string;
    thread?: string;
    direction?: Direction;
    q?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<MessageSummary>> {
    const params: Record<string, string> = {};
    if (args.to) params.to = args.to;
    if (args.from) params.from = args.from;
    if (args.thread) params.thread = args.thread;
    if (args.direction) params.direction = args.direction;
    if (args.q) params.q = args.q;
    if (args.limit !== undefined) params.limit = String(args.limit);
    if (args.cursor) params.cursor = args.cursor;
    const body = await this.request("/api/messages", params);
    return { items: (body.items as MessageSummary[]) ?? [], cursor: body.cursor ?? null };
  }

  async get(messageId: string): Promise<Message | null> {
    try {
      const body = await this.request(`/api/messages/${encodeURIComponent(messageId)}`, {});
      return (body.message as Message) ?? null;
    } catch (err) {
      if (err instanceof PosternError && err.status === 404) return null;
      throw err;
    }
  }

  async thread(threadId: string): Promise<Message[]> {
    const body = await this.request(`/api/threads/${encodeURIComponent(threadId)}`, {});
    return (body.messages as Message[]) ?? [];
  }

  // --- internals ---

  private async request(path: string, params: Record<string, string>): Promise<Record<string, any>> {
    const qs = new URLSearchParams(params).toString();
    const url = this.base + path + (qs ? `?${qs}` : "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
        signal: ctrl.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PosternError(`request to ${path} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 401) {
      throw new PosternError("Postern API rejected the token (check POSTERN_API_TOKEN; a read scope is required)", 401);
    }
    if (resp.status === 403) {
      throw new PosternError("Postern API returned 403 (Cloudflare WAF or scope); ensure the custom User-Agent is sent and the token has read scope", 403);
    }
    if (!resp.ok) {
      throw new PosternError(`Postern API error (HTTP ${resp.status}) on ${path}`, resp.status);
    }
    const text = await resp.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      throw new PosternError(`invalid JSON from Postern API on ${path}`);
    }
  }
}

// HTTP client over the Postern mailbox API. Zero runtime deps beyond Node's global
// fetch (Node >= 18). Every request carries a custom User-Agent: the API sits behind
// Cloudflare, which 403s default bot UAs ("error 1010"), so a real UA is mandatory
// and must never regress. Read methods (search/list/get/thread) GET the read door;
// write methods (send/reply) POST the write door and require a send-scoped token.

import type {
  Direction,
  MailboxFilter,
  Message,
  MessageSummary,
  Page,
  ReplyInput,
  SearchField,
  SearchHit,
  SearchMode,
  SendInput,
  SendResult,
  ViewLens,
} from "./types.js";

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
    field?: SearchField;
    limit?: number;
    cursor?: string;
    direction?: Direction;
    to?: string;
    from?: string;
    lens?: ViewLens;
    mailbox?: MailboxFilter;
    after?: string;
    before?: string;
    hasAttachment?: boolean;
    seen?: boolean;
    seenFor?: string;
  }): Promise<Page<SearchHit>> {
    const params: Record<string, string> = { q: args.q };
    if (args.mode) params.mode = args.mode;
    // field selects which column(s) the "substr" mode matches (worker api.ts:206);
    // the worker validates it strictly and ignores it for the non-substr modes.
    if (args.field) params.field = args.field;
    if (args.limit !== undefined) params.limit = String(args.limit);
    if (args.cursor) params.cursor = args.cursor;
    // direction is wired on /api/search (worker #128, api.ts:197): the worker
    // validates it strictly (inbound|outbound) and 400s a typo, so we forward it
    // as-is and let the worker be the authority.
    if (args.direction) params.direction = args.direction;
    // Viewer scope + named lens (worker #350/#403): to= is the viewer, lens= names
    // the view. The worker refuses lens+direction and a viewerless lens, so a bad
    // combination is a clean 400 here, never a quietly different answer.
    if (args.to) params.to = args.to;
    if (args.lens) params.lens = args.lens;
    // Sender filter (worker #366, api.ts): same lower(from_addr) LIKE semantics as
    // list's from=.
    if (args.from) params.from = args.from;
    // Durable-folder scope (worker #352/#354, api.ts): "all" = every placement,
    // archive|trash|junk = that placement only.
    if (args.mailbox) params.mailbox = args.mailbox;
    // Inclusive ISO date bounds on messages.date (worker #354).
    if (args.after) params.after = args.after;
    if (args.before) params.before = args.before;
    // Booleans forward as "true"/"false"; the worker accepts 0|1|true|false
    // (worker #354, api.ts) and 400s anything else.
    if (args.hasAttachment !== undefined) params.hasAttachment = String(args.hasAttachment);
    if (args.seen !== undefined) params.seen = String(args.seen);
    // Read-state projection key (worker #404): whose message_seen_by row the
    // effective-seen COALESCE reads, separate from which rows come back. An MCP
    // token is a static, estate-scoped credential (docs/CONTRACT.md 10.9), the
    // caller class the worker allows to name any address here, same as python
    // and the imap door.
    if (args.seenFor) params.seenFor = args.seenFor;
    const body = await this.requestGet("/api/search", params);
    return { items: (body.items as SearchHit[]) ?? [], cursor: body.cursor ?? null };
  }

  async list(args: {
    to?: string;
    from?: string;
    thread?: string;
    direction?: Direction;
    lens?: ViewLens;
    mailbox?: MailboxFilter;
    q?: string;
    limit?: number;
    cursor?: string;
    seenFor?: string;
  }): Promise<Page<MessageSummary>> {
    const params: Record<string, string> = {};
    if (args.to) params.to = args.to;
    if (args.from) params.from = args.from;
    if (args.thread) params.thread = args.thread;
    if (args.direction) params.direction = args.direction;
    if (args.lens) params.lens = args.lens;
    // Durable-folder scope (worker #352/#354, api.ts parseListQuery): "all" =
    // every placement, archive|trash|junk = that placement only, omitted =
    // mailbox IS NULL (today's default, unchanged).
    if (args.mailbox) params.mailbox = args.mailbox;
    if (args.q) params.q = args.q;
    if (args.limit !== undefined) params.limit = String(args.limit);
    if (args.cursor) params.cursor = args.cursor;
    // Read-state projection key (worker #404); see the matching comment in
    // search() above.
    if (args.seenFor) params.seenFor = args.seenFor;
    const body = await this.requestGet("/api/messages", params);
    return { items: (body.items as MessageSummary[]) ?? [], cursor: body.cursor ?? null };
  }

  async get(messageId: string): Promise<Message | null> {
    try {
      const body = await this.requestGet(`/api/messages/${encodeURIComponent(messageId)}`, {});
      return (body.message as Message) ?? null;
    } catch (err) {
      if (err instanceof PosternError && err.status === 404) return null;
      throw err;
    }
  }

  // Fetch one attachment's raw bytes as base64. GET /api/messages/{id}/attachments/{i}
  // returns the bytes (not JSON), so this bypasses the JSON request() path. Returns
  // null on 404 (no such message/index). maxBytes caps the transfer: if the response
  // declares a Content-Length over the cap we refuse BEFORE reading the body (no huge
  // download just to reject it), and re-check the decoded length as defense in depth.
  async getAttachmentBytes(
    messageId: string,
    index: number,
    maxBytes: number,
  ): Promise<{ base64: string; contentType: string; size: number } | null> {
    const path = `/api/messages/${encodeURIComponent(messageId)}/attachments/${index}`;
    const url = this.base + path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "*/*",
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
    if (resp.status === 404) return null;
    if (resp.status === 401) {
      throw new PosternError("Postern API rejected the token (check the token; the required scope must be granted)", 401);
    }
    if (resp.status === 403) {
      const detail = await safeErrorMessage(resp);
      throw new PosternError(
        `Postern API returned 403${detail ? `: ${detail}` : " (Cloudflare WAF or token scope; ensure the custom User-Agent is sent and the token carries the required scope)"}`,
        403,
      );
    }
    if (!resp.ok) {
      throw new PosternError(`Postern API error (HTTP ${resp.status}) on ${path}`, resp.status);
    }
    const declared = Number(resp.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new PosternError(
        `attachment is ${declared} bytes, over the ${maxBytes}-byte limit; raise POSTERN_MCP_MAX_ATTACHMENT_BYTES to fetch it`,
        413,
      );
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new PosternError(
        `attachment is ${buf.byteLength} bytes, over the ${maxBytes}-byte limit; raise POSTERN_MCP_MAX_ATTACHMENT_BYTES to fetch it`,
        413,
      );
    }
    return {
      base64: Buffer.from(buf).toString("base64"),
      contentType: resp.headers.get("content-type") || "application/octet-stream",
      size: buf.byteLength,
    };
  }

  async thread(threadId: string): Promise<Message[]> {
    const body = await this.requestGet(`/api/threads/${encodeURIComponent(threadId)}`, {});
    return (body.messages as Message[]) ?? [];
  }

  // --- write (send scope) ---

  // POST /api/send. The worker owns From-enforcement, DKIM signing, threading, and
  // storing the sent copy; we forward the composed message and unwrap the result.
  async send(input: SendInput): Promise<SendResult> {
    const body = await this.requestPost("/api/send", input);
    return this.asSendResult(body);
  }

  // POST /api/reply. The worker pulls the referenced stored message and fills
  // to / subject / In-Reply-To / References / thread; we forward the new body.
  async reply(input: ReplyInput): Promise<SendResult> {
    const body = await this.requestPost("/api/reply", input);
    return this.asSendResult(body);
  }

  private asSendResult(body: Record<string, any>): SendResult {
    return {
      messageId: String(body.messageId ?? ""),
      threadId: String(body.threadId ?? ""),
      providerMessageId: body.providerMessageId ? String(body.providerMessageId) : undefined,
    };
  }

  // --- internals ---

  private requestGet(path: string, params: Record<string, string>): Promise<Record<string, any>> {
    const qs = new URLSearchParams(params).toString();
    return this.request("GET", path + (qs ? `?${qs}` : ""), undefined);
  }

  private requestPost(path: string, payload: unknown): Promise<Record<string, any>> {
    return this.request("POST", path, payload);
  }

  private async request(method: "GET" | "POST", pathAndQuery: string, payload: unknown): Promise<Record<string, any>> {
    const url = this.base + pathAndQuery;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PosternError(`request to ${pathAndQuery} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 401) {
      throw new PosternError("Postern API rejected the token (check the token; the required scope must be granted)", 401);
    }
    if (resp.status === 403) {
      // Either the CF WAF (missing/non-custom User-Agent) or a scope mismatch (#85):
      // a read-scoped token on a write route, or vice versa. Surface the body's
      // message when present so "requires send scope" reaches the agent verbatim.
      const detail = await safeErrorMessage(resp);
      throw new PosternError(
        `Postern API returned 403${detail ? `: ${detail}` : " (Cloudflare WAF or token scope; ensure the custom User-Agent is sent and the token carries the required scope)"}`,
        403,
      );
    }
    if (resp.status === 400 || resp.status === 413) {
      // Caller-fixable validation/size errors from the mailbox core (e.g. invalid
      // recipient, body too large). Surface the worker's message so the agent can fix it.
      const detail = await safeErrorMessage(resp);
      throw new PosternError(`Postern API rejected the request (HTTP ${resp.status})${detail ? `: ${detail}` : ""}`, resp.status);
    }
    if (!resp.ok) {
      throw new PosternError(`Postern API error (HTTP ${resp.status}) on ${pathAndQuery}`, resp.status);
    }
    const text = await resp.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      throw new PosternError(`invalid JSON from Postern API on ${pathAndQuery}`);
    }
  }
}

// Best-effort extraction of the worker's `{ ok:false, error, message }` body so a
// caller sees the real reason. Never throws: a missing/non-JSON body yields "".
async function safeErrorMessage(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    if (!text) return "";
    const body = JSON.parse(text) as { error?: string; message?: string };
    return body.message || body.error || "";
  } catch {
    return "";
  }
}

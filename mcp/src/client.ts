// HTTP client over the Postern mailbox API. Zero runtime deps beyond Node's global
// fetch (Node >= 18). Every request carries a custom User-Agent: the API sits behind
// Cloudflare, which 403s default bot UAs ("error 1010"), so a real UA is mandatory
// and must never regress. Read methods (search/list/get/thread/folders) GET the read door;
// write methods (send/reply plus the draft surface) use the write door and require a
// send-scoped token. The draft routes additionally require a token BOUND to an identity:
// a static operator token has no trustworthy owner to attribute a draft to, so the worker
// answers E_IDENTITY_REQUIRED (403), which this client surfaces verbatim rather than
// flattening into an empty result.

import type {
  Direction,
  Draft,
  DraftInput,
  FlagSet,
  FolderSummary,
  MailboxPlacement,
  MailboxFilter,
  Message,
  MessageSummary,
  ProjectedSearchHit,
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

/**
 * Project a worker read response into a Page WITHOUT flattening its completeness signals.
 *
 * The old form was `cursor: body.cursor ?? null`, and that one `??` was the whole problem: the
 * worker omits `cursor` precisely when it CANNOT claim exhaustion, and `?? null` translated
 * that into "there are no more" before an agent ever saw it. So an absent cursor stays absent
 * here, and `complete` / `retrievalCap` / `degraded` / `identityScope` are passed through
 * untouched, because a door that normalises away the caveat is worse than no caveat: it makes
 * the lie look like the worker told it.
 */
function page<T>(body: Record<string, unknown>, items: T[]): Page<T> {
  const out: Page<T> = { items };
  if ("cursor" in body) out.cursor = (body.cursor as string | null) ?? null;
  if (typeof body.complete === "boolean") out.complete = body.complete;
  if (typeof body.retrievalCap === "number") out.retrievalCap = body.retrievalCap;
  if (typeof body.degraded === "string") out.degraded = body.degraded;
  if (body.identityScope) out.identityScope = body.identityScope as Page<T>["identityScope"];
  return out;
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
    fields?: string[];
  }): Promise<Page<ProjectedSearchHit>> {
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
    // Inclusive ISO date bounds on messages.date (worker #354, semantics fixed in #647: both
    // ends inclusive, a bare date covering its whole named day, a bogus value refused).
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
    // Response PROJECTION (worker #646): which summary keys hit.message carries, NOT
    // which hits come back. Note the neighbour three fields up: `field` (singular) picks
    // the substr COLUMN matched; this picks the keys RETURNED. Forwarded as-is so the
    // worker stays the authority on the allowed names -- it 400s an unknown one with the
    // full allowed list, which is strictly better than a second copy of that list here
    // that could drift from the worker's own summary type.
    // `!== undefined`, not a truthiness test: an explicitly EMPTY projection is a caller
    // error and must earn the worker's 400, not be read as "no projection asked for".
    // Silently ignoring it is the same accepted-and-dropped defect this parameter exists
    // to avoid, just on the client side of the wire.
    if (args.fields !== undefined) params.fields = args.fields.join(",");
    const body = await this.requestGet("/api/search", params);
    return page<ProjectedSearchHit>(body, (body.items as ProjectedSearchHit[]) ?? []);
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
    fields?: string[];
    after?: string;
    before?: string;
  }): Promise<Page<Partial<MessageSummary>>> {
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
    // Response projection (worker #646); see the comment in search() above. The return
    // type is Partial because that is TRUE of both cases: a full row satisfies it, and a
    // projected row is all this client can promise once a projection was requested.
    // See search() above: an explicit empty list is forwarded so the worker refuses it.
    if (args.fields !== undefined) params.fields = args.fields.join(",");
    // Inclusive ISO date bounds (worker #647). Forwarded verbatim: the worker validates the
    // shape AND the calendar, canonicalizes a bare date to its whole named day, and 400s
    // anything else, so a second opinion here could only disagree with it.
    if (args.after) params.after = args.after;
    if (args.before) params.before = args.before;
    const body = await this.requestGet("/api/messages", params);
    return page<Partial<MessageSummary>>(body, (body.items as Partial<MessageSummary>[]) ?? []);
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

  // GET /api/folders. Server-authoritative counts computed with the SAME placement and
  // access predicates the list and read paths use, so the rail cannot disagree with what
  // a read would return. `to` scopes the unread counts; under a bound identity the worker
  // overrides it server-side, which is why this client sends it and never assumes it won.
  async folders(args: { to?: string } = {}): Promise<FolderSummary[]> {
    const params: Record<string, string> = {};
    if (args.to) params.to = args.to;
    const body = await this.requestGet("/api/folders", params);
    return (body.folders as FolderSummary[]) ?? [];
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

  // --- server-side drafts (send scope AND a bound identity) ---
  //
  // Identity-owned by construction: every route below derives the owner from the token,
  // never from an argument, so there is no caller-supplied owner to get wrong and no way
  // to name someone else's draft id. A static operator token gets E_IDENTITY_REQUIRED.

  async listDrafts(): Promise<Draft[]> {
    const body = await this.requestGet("/api/drafts", {});
    return (body.drafts as Draft[]) ?? [];
  }

  // Null on 404, matching get(): an id that is not there and an id that is not YOURS are
  // deliberately the same answer, so a probe learns nothing about another identity.
  async getDraft(id: string): Promise<Draft | null> {
    try {
      const body = await this.requestGet(`/api/drafts/${encodeURIComponent(id)}`, {});
      return (body.draft as Draft) ?? null;
    } catch (err) {
      if (err instanceof PosternError && err.status === 404) return null;
      throw err;
    }
  }

  // The worker reads an ABSENT key as a CLEARED field, so what is NOT in this payload is
  // as load-bearing as what is. A spread is enough and a filter would be theatre:
  // JSON.stringify omits an undefined value, so an unset optional never reaches the wire
  // in the first place. What WOULD blank a field is defaulting one here (`?? null`), which
  // serializes, so this deliberately defaults nothing.
  async createDraft(input: DraftInput): Promise<Draft | null> {
    const body = await this.requestPost("/api/drafts", { ...input });
    return (body.draft as Draft) ?? null;
  }

  // PUT is a READ-MODIFY-WRITE and `updatedAt` is the value read. The worker refuses a
  // stale or absent one with 409 E_CONFLICT rather than overwriting a concurrent edit, so
  // omitting it is not a shortcut, it is a guaranteed conflict on an existing draft.
  async updateDraft(id: string, input: DraftInput, updatedAt?: string): Promise<Draft | null> {
    const payload: Record<string, unknown> = { ...input };
    if (updatedAt !== undefined) payload.updatedAt = updatedAt;
    const body = await this.request("PUT", `/api/drafts/${encodeURIComponent(id)}`, payload);
    return (body.draft as Draft) ?? null;
  }

  // True when a row was removed, false on 404. A delete of something already gone is not
  // an error to an agent, and saying so beats making it parse one.
  async deleteDraft(id: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/api/drafts/${encodeURIComponent(id)}`, undefined);
      return true;
    } catch (err) {
      if (err instanceof PosternError && err.status === 404) return false;
      throw err;
    }
  }

  // POST /api/drafts/{id}/send. The worker dispatches, stores the sent copy, and deletes
  // the draft ONLY after both succeed, so any failure leaves the draft retryable. This
  // client therefore reports a failure as a failure and never as a partial success.
  async sendDraft(id: string): Promise<SendResult> {
    const body = await this.requestPost(`/api/drafts/${encodeURIComponent(id)}/send`, {});
    return this.asSendResult(body);
  }

  // --- read state + placement (organize scope) ---
  //
  // Three routes that CHANGE stored state: read state, flags, and which folder a
  // message sits in. They moved to the `organize` scope in #685, which an `organize`
  // token carries and a `read` token deliberately does not, so these need a credential
  // the read client does not hold.
  //
  // Every one answers `{ updated }`: a COUNT of the message rows the worker matched,
  // never a per-id result. The count is rows that EXIST and that the token may reach
  // (store.ts setSeen/setFlags/moveMessages share one access predicate), so re-marking
  // a message that already had the value still counts it. A short count therefore means
  // some ids are unknown to the store or outside the token's reach, and nothing in the
  // answer says WHICH. This client passes the count through verbatim rather than
  // inventing a per-id answer the worker did not give.

  // POST /api/messages/seen. `forRecipient` writes a per-recipient override
  // (message_seen_by) instead of the row-level flag. Under a bound identity the worker
  // REFUSES a `for` that disagrees with the token's identity (403), and that refusal
  // surfaces as itself through request() rather than as a zero count.
  async setSeen(ids: string[], seen: boolean, forRecipient?: string): Promise<number> {
    const payload: Record<string, unknown> = { ids, seen };
    // Only when supplied: the worker reads an absent `for` as the estate/row-level
    // write, which is a DIFFERENT operation, so defaulting it here would silently
    // change which one runs.
    if (forRecipient !== undefined) payload.for = forRecipient;
    const body = await this.requestPost("/api/messages/seen", payload);
    return this.asUpdated(body, "/api/messages/seen");
  }

  // POST /api/messages/flags. `set` carries flagged and/or answered; the worker refuses
  // a set with neither rather than treating it as a no-op.
  async setFlags(ids: string[], set: FlagSet): Promise<number> {
    const body = await this.requestPost("/api/messages/flags", { ids, set });
    return this.asUpdated(body, "/api/messages/flags");
  }

  // POST /api/messages/move. `null` is not "no placement given", it is the request to
  // RESTORE the default unfoldered view, so it is sent as a literal null.
  async move(ids: string[], mailbox: MailboxPlacement): Promise<number> {
    const body = await this.requestPost("/api/messages/move", { ids, mailbox });
    return this.asUpdated(body, "/api/messages/move");
  }

  /** The `updated` count, or a thrown error when the worker did not send one.
   *
   *  Deliberately NOT `Number(body.updated ?? 0)`. Zero is a real, meaningful answer
   *  here ("nothing you named was reachable"), so coercing a MISSING count into zero
   *  would manufacture that answer out of a malformed response. This is the same defect
   *  the `cursor ?? null` flattening was: a door that normalises an absent fact into a
   *  definite one makes the lie look like the worker told it. */
  private asUpdated(body: Record<string, any>, path: string): number {
    if (typeof body.updated !== "number" || !Number.isFinite(body.updated)) {
      throw new PosternError(`Postern API did not return an updated count on ${path}`);
    }
    return body.updated;
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

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathAndQuery: string,
    payload: unknown,
  ): Promise<Record<string, any>> {
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
    if (resp.status === 400 || resp.status === 409 || resp.status === 413) {
      // Caller-fixable validation/size/concurrency errors from the mailbox core (e.g.
      // invalid recipient, body too large, a stale draft `updatedAt`). Surface the
      // worker's message so the agent can fix it. 409 is here because without it a draft
      // conflict arrived as a bare "HTTP 409", and E_CONFLICT is the one thing the caller
      // needs in order to know the answer is re-read and retry rather than give up.
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

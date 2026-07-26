#!/usr/bin/env node
// Postern v1.0 clean-deploy smoke (issue #25 / CONTRACT section 7).
//
// Drives a DEPLOYED Postern instance through the v1.0 acceptance path and
// asserts on the STRUCTURED store/API state (not on prose). Zero operator-
// specific assumptions: everything comes from env vars or flags, no domains,
// accounts, or resource names are baked in.
//
// What it checks (CONTRACT section 7):
//   1. The instance is live (GET /health) and the API token works.
//   2. POST /api/send accepts a message and the sent copy lands in the store
//      (GET /api/messages?direction=outbound finds it; GET /api/messages/{id}
//      returns it). This is the outbound + store half and needs no inbound MX.
//   3. POST /api/reply to a stored message threads (shared thread_id) and its
//      sent copy is in the store too.
//   4. (full mode, --expect-inbound) An inbound message delivered to the
//      operator's domain appears in GET /api/messages and is findable via
//      GET /api/search?q=. This leg requires a real domain on Cloudflare Email
//      Routing pointed at the deployed worker, so it is opt-in: the operator
//      sends a real email to a watched address, the script polls the store.
//   5. The deployed worker REFUSES malformed filters (direction, field,
//      hasAttachment, seen, lens+direction). Read-only, no side effects: it is the
//      negative half that makes every 200 above mean something.
//   6. Read state + placement on the message this run created: /api/messages/seen,
//      /api/messages/flags, /api/messages/move (archive and back), each verified by
//      reading the state back, and each restored afterwards.
//   7. /api/folders answers with server-authoritative counts, and the count moves
//      when this run files its own message.
//   8. Attachments: a send WITH an attachment, then the bytes read back byte-for-byte
//      from /api/messages/{id}/attachments/0.
//   9. Drafts are identity-owned: a static operator token must be REFUSED
//      (E_IDENTITY_REQUIRED). With POSTERN_IDENTITY_TOKEN set, the full draft
//      lifecycle runs and cleans up after itself.
//  10. With POSTERN_DELETE_TOKEN set, this run hard-deletes the messages it created,
//      so a repeated smoke does not accumulate mail in the operator's store.
//
// Deliberately NOT covered here, because both need operator-specific configuration
// this script refuses to assume: the webmail SESSION path (needs
// WEBMAIL_AUTH_BACKEND=native plus a real credential) and FILE_ALSO_UNDER routing
// (needs the operator's own address map). Named so their absence is a decision on the
// record rather than an oversight.
//
// Usage:
//   POSTERN_BASE_URL=https://postern.<acct>.workers.dev \
//   POSTERN_API_TOKEN=<read-scoped or both-scoped bearer> \
//   POSTERN_SEND_TOKEN=<send-scoped bearer, optional; defaults to POSTERN_API_TOKEN> \
//   POSTERN_FROM=noreply@<your-domain> \
//   POSTERN_TO=<a-mailbox-you-can-read>@<your-domain> \
//   POSTERN_IDENTITY_TOKEN=<per-identity send token, optional; unlocks the drafts leg> \
//   POSTERN_DELETE_TOKEN=<delete-scoped bearer, optional; unlocks cleanup> \
//   node smoke.mjs [--expect-inbound] [--inbound-subject "..."] [--timeout-ms 120000]
//
// Exit 0 = all asserted checks passed. Non-zero = first failure (printed).

const cfg = {
  baseUrl: required("POSTERN_BASE_URL").replace(/\/+$/, ""),
  readToken: required("POSTERN_API_TOKEN"),
  sendToken: process.env.POSTERN_SEND_TOKEN || required("POSTERN_API_TOKEN"),
  from: required("POSTERN_FROM"),
  to: process.env.POSTERN_TO || "",
  identityToken: process.env.POSTERN_IDENTITY_TOKEN || "",
  deleteToken: process.env.POSTERN_DELETE_TOKEN || "",
  expectInbound: process.argv.includes("--expect-inbound"),
  inboundSubject: flag("--inbound-subject"),
  timeoutMs: Number(flag("--timeout-ms") || 120000),
};

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} is required (no default; supply your own value)`);
    process.exit(2);
  }
  return v;
}
function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : "";
}

let passed = 0;
function ok(msg) { passed++; console.log(`  ok  ${msg}`); }
function fail(msg, detail) {
  console.error(`FAIL  ${msg}`);
  if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}
function assert(cond, msg, detail) { cond ? ok(msg) : fail(msg, detail); }

function emailsEqual(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

async function api(method, path, { body, auth = true, scope = "read", token } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) {
    const bearer = token || (scope === "send" ? cfg.sendToken : cfg.readToken);
    headers.authorization = `Bearer ${bearer}`;
  }
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

/** Raw bytes (attachments): the response is a file, not JSON. */
async function apiBytes(path, { token } = {}) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token || cfg.readToken}` },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf, contentType: res.headers.get("content-type") || "" };
}

/** A filter the worker must REFUSE. The negative half of every positive above. */
async function refuses(path, what) {
  const res = await api("GET", path);
  assert(
    res.status === 400 && res.json?.error === "E_VALIDATION_ERROR",
    `${what} is refused with 400 E_VALIDATION_ERROR`,
    { path, status: res.status, body: res.json },
  );
}

/** One message summary by id, or null. */
async function summary(id) {
  const res = await api("GET", `/api/messages/${encodeURIComponent(id)}`);
  return res.json?.message ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = `postern-smoke ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 10)}`;

async function main() {
  console.log(`Postern smoke against ${cfg.baseUrl}`);
  console.log(`marker subject: "${tag}"\n`);

  // --- 1. liveness + auth ---
  console.log("1. liveness + auth");
  {
    const health = await api("GET", "/health", { auth: false });
    assert(health.status === 200 && health.json?.ok === true, "GET /health is 200 ok:true", health);

    // A bad token must be rejected: proves auth is actually enforced (not open).
    const bad = await fetch(`${cfg.baseUrl}/api/messages`, { headers: { authorization: "Bearer definitely-not-the-token" } });
    assert(bad.status === 401, "GET /api/messages with a wrong token is 401", { status: bad.status });

    const list = await api("GET", "/api/messages?limit=1");
    assert(list.status === 200 && list.json?.ok === true && Array.isArray(list.json.items),
      "GET /api/messages with the real token is 200 and returns items[]", list);
  }

  // --- 2. send + sent copy in the store ---
  console.log("\n2. POST /api/send -> sent copy in the store");
  assert(cfg.to, "POSTERN_TO is required (distinct from POSTERN_FROM for the reply leg)", { from: cfg.from, to: cfg.to });
  let sentId;
  let threadId;
  {
    const subject = `${tag} send`;
    const send = await api("POST", "/api/send", {
      scope: "send",
      body: {
        to: cfg.to,
        from: cfg.from,
        subject,
        text: "Postern clean-deploy smoke: outbound + store leg.",
        html: "<p>Postern clean-deploy smoke: outbound + store leg.</p>",
      },
    });
    assert(send.status === 200 && send.json?.ok === true, "POST /api/send returns 200 ok:true", send);
    sentId = send.json?.messageId;
    assert(typeof sentId === "string" && sentId.length > 0, "send response carries a core messageId", send.json);

    // The sent copy must be stored as direction=outbound (CONTRACT section 3/6).
    const got = await api("GET", `/api/messages/${encodeURIComponent(sentId)}`);
    assert(got.status === 200 && got.json?.message?.messageId === sentId,
      "GET /api/messages/{id} returns the stored sent copy", got);
    assert(got.json?.message?.direction === "outbound", "stored sent copy has direction=outbound", got.json?.message);
    threadId = got.json?.message?.threadId;
    assert(typeof threadId === "string" && threadId.length > 0, "stored sent copy has a thread_id", got.json?.message);

    // It must also be visible in the outbound-filtered list.
    const list = await api("GET", `/api/messages?direction=outbound&limit=50`);
    const found = (list.json?.items || []).some((m) => m.messageId === sentId);
    assert(found, "sent copy appears in GET /api/messages?direction=outbound", list.json);
  }

  // --- 3. reply threads + sent copy stored ---
  console.log("\n3. POST /api/reply -> shared thread, reply copy stored");
  if (emailsEqual(cfg.to, cfg.from)) {
    ok("SKIP POST /api/reply: POSTERN_TO must differ from POSTERN_FROM (outbound self-address has no reply recipient)");
  } else {
    const reply = await api("POST", "/api/reply", {
      scope: "send",
      body: { messageId: sentId, text: "Reply leg of the smoke.", html: "<p>Reply leg of the smoke.</p>" },
    });
    assert(reply.status === 200 && reply.json?.ok === true, "POST /api/reply returns 200 ok:true", reply);
    const replyId = reply.json?.messageId;
    assert(typeof replyId === "string" && replyId !== sentId, "reply has its own distinct messageId", reply.json);

    const got = await api("GET", `/api/messages/${encodeURIComponent(replyId)}`);
    assert(got.json?.message?.threadId === threadId, "reply shares the original thread_id", {
      replyThread: got.json?.message?.threadId, originalThread: threadId,
    });

    const thread = await api("GET", `/api/threads/${encodeURIComponent(threadId)}`);
    const ids = (thread.json?.messages || []).map((m) => m.messageId);
    assert(ids.includes(sentId) && ids.includes(replyId),
      "GET /api/threads/{id} contains both the original and the reply", ids);
  }

  // --- 4. inbound (opt-in: needs a real domain on CF Email Routing) ---
  if (cfg.expectInbound) {
    console.log("\n4. inbound delivery -> store + search (real MX leg)");
    const subject = cfg.inboundSubject || `${tag} inbound`;
    const words = subject.split(/\s+/).filter(Boolean);
    const searchWord = words[words.length - 1]; // a distinctive token from the subject
    console.log(`   waiting up to ${cfg.timeoutMs}ms for an inbound message with subject containing "${searchWord}".`);
    console.log(`   send a real email now to an address on your domain, subject: "${subject}"`);

    const deadline = Date.now() + cfg.timeoutMs;
    let inbound = null;
    while (Date.now() < deadline) {
      const list = await api("GET", `/api/messages?direction=inbound&q=${encodeURIComponent(searchWord)}&limit=20`);
      inbound = (list.json?.items || []).find((m) => (m.subject || "").includes(searchWord));
      if (inbound) break;
      await sleep(5000);
    }
    assert(inbound, "inbound message appeared in GET /api/messages?direction=inbound", { searchedFor: searchWord });

    const search = await api("GET", `/api/search?q=${encodeURIComponent(searchWord)}`);
    const hit = (search.json?.items || []).some((h) => (h.message?.messageId) === inbound.messageId);
    assert(search.status === 200 && hit, "inbound message is findable via GET /api/search?q=", search.json);
  } else {
    console.log("\n4. inbound leg SKIPPED (pass --expect-inbound with a real CF Email Routing domain to run it)");
  }

  // --- 5. the worker REFUSES malformed filters (read-only, no side effects) ---
  // Every 200 above is only meaningful if a bad request is actually rejected. These
  // are the same refusals inbound/route-table.test.ts proves against the handler,
  // asserted here against the DEPLOYED artifact, which is the only place a stale
  // deploy shows up (#417: verify the artifact, never the pipeline).
  console.log("\n5. malformed filters are refused by the deployed worker");
  {
    await refuses("/api/messages?direction=sideways", "direction=sideways");
    await refuses("/api/messages?lens=nope", "lens=nope");
    await refuses("/api/messages?lens=inbox&direction=inbound&to=" + encodeURIComponent(cfg.to),
      "lens together with direction");
    await refuses("/api/messages?seenFor=not-an-address", "a malformed seenFor");
    await refuses("/api/search?q=x&mode=substr&field=nope", "field=nope");
    await refuses("/api/search?q=x&hasAttachment=maybe", "hasAttachment=maybe");
    await refuses("/api/search?q=x&seen=maybe", "seen=maybe");
  }

  // --- 6. read state + placement, on THIS run's own message ---
  console.log("\n6. seen / flags / move on the message this run created");
  {
    const seen = await api("POST", "/api/messages/seen", { body: { ids: [sentId], seen: false } });
    assert(seen.status === 200 && seen.json?.updated === 1, "POST /api/messages/seen marks it unread", seen);
    const unread = await summary(sentId);
    assert(unread?.seen === false, "the message reads back UNSEEN", { seen: unread?.seen });

    const reread = await api("POST", "/api/messages/seen", { body: { ids: [sentId], seen: true } });
    assert(reread.json?.updated === 1 && (await summary(sentId))?.seen === true,
      "marking it read again is honored (state restored)", reread);

    const flags = await api("POST", "/api/messages/flags", {
      body: { ids: [sentId], set: { flagged: true, answered: true } },
    });
    assert(flags.status === 200 && flags.json?.updated === 1, "POST /api/messages/flags returns updated:1", flags);
    const flagged = await summary(sentId);
    assert(flagged?.flagged === true && flagged?.answered === true,
      "flagged + answered read back as set", { flagged: flagged?.flagged, answered: flagged?.answered });
    await api("POST", "/api/messages/flags", { body: { ids: [sentId], set: { flagged: false, answered: false } } });
    const cleared = await summary(sentId);
    assert(cleared?.flagged === false && cleared?.answered === false, "flags cleared again (state restored)",
      { flagged: cleared?.flagged, answered: cleared?.answered });

    const move = await api("POST", "/api/messages/move", { body: { ids: [sentId], mailbox: "archive" } });
    assert(move.status === 200 && move.json?.updated === 1, "POST /api/messages/move files it to archive", move);
    const inArchive = await api("GET", "/api/messages?mailbox=archive&limit=50");
    assert((inArchive.json?.items || []).some((m) => m.messageId === sentId),
      "the archived message is in GET /api/messages?mailbox=archive", inArchive.json);
    const defaultView = await api("GET", "/api/messages?direction=outbound&limit=50");
    assert(!(defaultView.json?.items || []).some((m) => m.messageId === sentId),
      "and is NO LONGER in the direction-default view", defaultView.json);
    const restore = await api("POST", "/api/messages/move", { body: { ids: [sentId], mailbox: null } });
    assert(restore.json?.updated === 1, "moving it back to the default view is honored (state restored)", restore);
  }

  // --- 7. folders ---
  console.log("\n7. GET /api/folders");
  {
    const before = await api("GET", "/api/folders");
    assert(before.status === 200 && Array.isArray(before.json?.folders) && before.json.folders.length > 0,
      "GET /api/folders returns folders[]", before);
    const archiveOf = (body) => (body?.folders || []).find((f) => f.id === "archive");
    assert(archiveOf(before.json), "the archive folder is present", before.json?.folders);
    const baseline = archiveOf(before.json).count;

    await api("POST", "/api/messages/move", { body: { ids: [sentId], mailbox: "archive" } });
    const after = await api("GET", "/api/folders");
    assert(archiveOf(after.json).count === baseline + 1,
      "the archive count MOVES when this run files a message (counts are live, not cached)",
      { baseline, after: archiveOf(after.json).count });
    await api("POST", "/api/messages/move", { body: { ids: [sentId], mailbox: null } });
  }

  // --- 8. attachments, end to end ---
  console.log("\n8. send WITH an attachment -> read the bytes back");
  let attachmentId;
  {
    const payload = Buffer.from(`postern smoke attachment ${tag}\n`, "utf8");
    const send = await api("POST", "/api/send", {
      scope: "send",
      body: {
        to: cfg.to,
        from: cfg.from,
        subject: `${tag} attachment`,
        text: "Postern smoke: attachment leg.",
        attachments: [
          { content: payload.toString("base64"), filename: "smoke.txt", mimeType: "text/plain" },
        ],
      },
    });
    assert(send.status === 200 && send.json?.ok === true, "POST /api/send with an attachment is 200 ok:true", send);
    attachmentId = send.json?.messageId;

    const got = await summary(attachmentId);
    assert((got?.attachmentCount ?? 0) >= 1, "the stored sent copy reports an attachment", got);

    const bytes = await apiBytes(`/api/messages/${encodeURIComponent(attachmentId)}/attachments/0`);
    assert(bytes.status === 200 && bytes.bytes.equals(payload),
      "GET /api/messages/{id}/attachments/0 returns the EXACT bytes sent",
      { status: bytes.status, sent: payload.length, got: bytes.bytes.length });
    assert(bytes.contentType.startsWith("text/plain"), "the attachment keeps its declared content type",
      { contentType: bytes.contentType });
  }

  // --- 9. drafts are identity-owned ---
  console.log("\n9. drafts (identity-owned)");
  {
    const refused = await api("GET", "/api/drafts");
    assert(refused.status === 403 && refused.json?.error === "E_IDENTITY_REQUIRED",
      "a static operator token is REFUSED on /api/drafts (E_IDENTITY_REQUIRED)", refused);

    if (!cfg.identityToken) {
      ok("SKIP the drafts lifecycle: set POSTERN_IDENTITY_TOKEN (a per-identity send token) to run it");
    } else {
      const opts = { token: cfg.identityToken };
      const created = await api("POST", "/api/drafts", { ...opts, body: { to: cfg.to, subject: `${tag} draft`, bodyText: "draft" } });
      assert(created.status === 201 && created.json?.id, "POST /api/drafts creates a draft", created);
      const id = created.json.id;

      const fetched = await api("GET", `/api/drafts/${encodeURIComponent(id)}`, opts);
      assert(fetched.json?.draft?.subject === `${tag} draft`, "GET /api/drafts/{id} round-trips it", fetched.json);

      const stale = await api("PUT", `/api/drafts/${encodeURIComponent(id)}`, {
        ...opts, body: { subject: "stale write", updatedAt: "2000-01-01T00:00:00Z" },
      });
      assert(stale.status === 409 && stale.json?.error === "E_CONFLICT",
        "a stale updatedAt is refused with 409 E_CONFLICT", stale);

      const updated = await api("PUT", `/api/drafts/${encodeURIComponent(id)}`, {
        ...opts, body: { to: cfg.to, subject: `${tag} draft v2`, bodyText: "draft v2", updatedAt: fetched.json.draft.updatedAt },
      });
      assert(updated.json?.draft?.subject === `${tag} draft v2`, "PUT with the CURRENT updatedAt is applied", updated.json);

      const removed = await api("DELETE", `/api/drafts/${encodeURIComponent(id)}`, opts);
      assert(removed.status === 200, "DELETE /api/drafts/{id} removes it (no debris left behind)", removed);
    }
  }

  // --- 10. cleanup: this run deletes what it created, if it can ---
  console.log("\n10. cleanup");
  if (!cfg.deleteToken) {
    ok("SKIP hard delete: set POSTERN_DELETE_TOKEN (a delete-scoped bearer) so a repeated smoke leaves no debris");
  } else {
    // No "the read token cannot delete" assertion here on purpose: this script cannot
    // know the SCOPE of the token it was handed, and the documented single-key default
    // (POSTERN_API_TOKEN = `both`) legitimately CAN delete. Asserting 403 would fail
    // the default deployment. The scope matrix is proved in inbound/scopes.test.ts.
    for (const id of [sentId, attachmentId].filter(Boolean)) {
      const del = await api("DELETE", `/api/messages/${encodeURIComponent(id)}`, { token: cfg.deleteToken });
      assert(del.status === 200 && del.json?.ok === true, `DELETE /api/messages/{id} removed ${id}`, del);
      const gone = await api("GET", `/api/messages/${encodeURIComponent(id)}`);
      assert(gone.status === 404, "and it is GONE afterwards", { status: gone.status });
    }
  }

  console.log(`\nPASS: ${passed} checks green.`);
}

main().catch((e) => fail("unexpected error", e?.stack || String(e)));

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
//
// Usage:
//   POSTERN_BASE_URL=https://postern.<acct>.workers.dev \
//   POSTERN_API_TOKEN=<read-scoped or both-scoped bearer> \
//   POSTERN_SEND_TOKEN=<send-scoped bearer, optional; defaults to POSTERN_API_TOKEN> \
//   POSTERN_FROM=noreply@<your-domain> \
//   POSTERN_TO=<a-mailbox-you-can-read>@<your-domain> \
//   node smoke.mjs [--expect-inbound] [--inbound-subject "..."] [--timeout-ms 120000]
//
// Exit 0 = all asserted checks passed. Non-zero = first failure (printed).

const cfg = {
  baseUrl: required("POSTERN_BASE_URL").replace(/\/+$/, ""),
  readToken: required("POSTERN_API_TOKEN"),
  sendToken: process.env.POSTERN_SEND_TOKEN || required("POSTERN_API_TOKEN"),
  from: required("POSTERN_FROM"),
  to: process.env.POSTERN_TO || "",
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

async function api(method, path, { body, auth = true, scope = "read" } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) {
    const token = scope === "send" ? cfg.sendToken : cfg.readToken;
    headers.authorization = `Bearer ${token}`;
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
  let sentId;
  let threadId;
  {
    const subject = `${tag} send`;
    const send = await api("POST", "/api/send", {
      scope: "send",
      body: {
        to: cfg.to || cfg.from, // self-send if no separate mailbox given; still proves the store path
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
  {
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

  console.log(`\nPASS: ${passed} checks green.`);
}

main().catch((e) => fail("unexpected error", e?.stack || String(e)));

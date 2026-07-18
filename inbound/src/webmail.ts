// Self-contained read-only Postern webmail (the human browser door, complementing
// the IMAP proxy). A single vanilla HTML/CSS/JS page, no framework and no build
// step. It is a CLIENT of the read API (#24): the operator supplies the API
// origin + their Postern API token in the browser; the token lives in
// sessionStorage only and rides as a Bearer header, never a cookie or URL.
//
// Served same-origin by the inbound worker (so the page and the API it calls
// share an origin, avoiding CORS and keeping the token in one security context).
// The canonical, editable source is webmail/index.html at the repo root; this
// embedded copy is generated from it by scripts/sync-webmail.mjs and checked by
// webmail.test.ts (the worker runtime cannot read a file at request time).
//
// After editing webmail/index.html: cd inbound && npm run sync-webmail
//
// Security: all message-derived content is inserted via text nodes / setAttribute
// in the page script, never innerHTML, so stored message bytes cannot inject
// markup or script. See webmail/index.html.

export const WEBMAIL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Postern webmail</title>
<style>
  :root {
    --bg: #14161a; --panel: #1c1f26; --panel-2: #232733; --line: #2e3340;
    --fg: #e7e9ee; --muted: #99a0ad; --accent: #6ea8fe; --accent-dim: #2b3550;
    --bad: #e06c75; --ok: #98c379;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  header .grow { flex: 1; }
  header .who { color: var(--muted); font-size: 13px; }
  button {
    background: var(--accent-dim); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit;
  }
  button:hover { border-color: var(--accent); }
  button.link { background: none; border: none; color: var(--accent); padding: 0; }
  input, select {
    background: var(--panel-2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 8px 10px; font: inherit;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }

  /* Gate */
  #gate { margin: auto; max-width: 460px; padding: 28px; }
  #gate .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 22px;
  }
  #gate h2 { margin: 0 0 4px; }
  #gate p { color: var(--muted); margin: 6px 0 16px; font-size: 13px; }
  #gate label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
  #gate input { width: 100%; }
  #gate .row { display: flex; gap: 8px; margin-top: 18px; }
  #gate .row button { flex: 1; }
  .err { color: var(--bad); font-size: 13px; min-height: 1.2em; margin-top: 10px; }

  /* App layout */
  #app { flex: 1; display: none; min-height: 0; }
  #app.on { display: flex; }
  .sidebar { width: 360px; border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .toolbar { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .toolbar input { flex: 1; min-width: 120px; }
  .toolbar select { width: auto; }
  .toolbar .mode { min-width: 6.5rem; }
  .list { overflow-y: auto; flex: 1; }
  .row-item {
    padding: 10px 12px; border-bottom: 1px solid var(--line); cursor: pointer;
  }
  .row-item:hover { background: var(--panel); }
  .row-item.sel { background: var(--accent-dim); }
  .row-item .top { display: flex; justify-content: space-between; gap: 8px; }
  .row-item .from { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-item .date { color: var(--muted); font-size: 12px; flex-shrink: 0; }
  .row-item .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-item .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .tag { display: inline-block; font-size: 11px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--line); margin-right: 4px; }
  .tag.trusted { color: var(--ok); }
  .tag.untrusted { color: var(--bad); }
  .tag.out { color: var(--accent); }
  .more { padding: 12px; text-align: center; }

  .reading { flex: 1; overflow-y: auto; padding: 22px 28px; min-width: 0; }
  .reading .empty { color: var(--muted); margin-top: 40px; text-align: center; }
  .msg-head h2 { margin: 0 0 8px; font-size: 20px; }
  .msg-head .kv { color: var(--muted); font-size: 13px; }
  .msg-head .kv b { color: var(--fg); font-weight: 600; }
  .msg-body-frame {
    margin-top: 18px; padding-top: 18px; border: none; border-top: 1px solid var(--line);
    width: 100%; min-height: 220px; background: var(--panel-2);
  }
  /* #60/#343: remote content is always blocked (tracking-pixel privacy); this
     banner is a non-actionable notice, not an opt-in (see renderBody). */
  .remote-banner {
    margin-top: 18px; padding: 8px 12px; display: flex; align-items: center; gap: 10px;
    flex-wrap: wrap; background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 6px; font-size: 13px; color: var(--muted);
  }
  .remote-banner + .msg-body-frame { margin-top: 0; }
  .attachments { margin-top: 18px; }
  .attachments h3 { font-size: 13px; color: var(--muted); margin: 0 0 6px; }
  .attachments li { font-size: 13px; margin-bottom: 4px; }
  .attachments .dl { font-size: 12px; padding: 2px 8px; margin-left: 6px; }
  .thread { margin-top: 24px; }
  .thread h3 { font-size: 13px; color: var(--muted); }
  .thread .t-item { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 6px; cursor: pointer; }
  .thread .t-item:hover { border-color: var(--accent); }
  .loading { color: var(--muted); padding: 12px; }
  .compose label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
  .compose input, .compose textarea { width: 100%; }
  .compose textarea { min-height: 180px; resize: vertical; }
  .compose-editor {
    width: 100%; min-height: 220px; padding: 10px; overflow-y: auto;
    background: var(--panel-2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px;
  }
  .compose-editor.plain { white-space: pre-wrap; font-family: inherit; }
  .formatbar { display: flex; gap: 4px; margin: 6px 0; flex-wrap: wrap; }
  .formatbar button { min-width: 34px; padding: 4px 8px; }
  .compose-status { color: var(--muted); font-size: 12px; margin-left: auto; align-self: center; }
  .draft-files { list-style: none; padding: 0; margin: 8px 0; }
  .draft-files li { display: flex; gap: 8px; align-items: center; margin: 5px 0; }
  .draft-files .progress { color: var(--muted); font-size: 12px; }
  .quote-preview {
    margin-top: 14px; padding: 10px; border-left: 3px solid var(--line);
    color: var(--muted); white-space: pre-wrap; max-height: 180px; overflow: auto;
  }
  .compose-actions { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  .compose-note { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
  .sendnote { color: var(--muted); font-size: 12px; }
  header .identity { color: var(--fg); font-size: 13px; font-weight: 600; }


  /* Folder rail (#352) */
  .folders {
    width: 168px; border-right: 1px solid var(--line); background: var(--panel);
    display: flex; flex-direction: column; padding: 8px 0; overflow-y: auto; flex-shrink: 0;
  }
  .folders button {
    display: flex; justify-content: space-between; gap: 8px; width: 100%;
    text-align: left; background: none; border: none; border-radius: 0;
    padding: 8px 12px; color: var(--fg); font: inherit; cursor: pointer;
  }
  .folders button:hover { background: var(--panel-2); }
  .folders button.active { background: var(--accent-dim); color: var(--accent); }
  .folders .fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folders .fcount { color: var(--muted); font-size: 12px; flex-shrink: 0; }
  .folders .fcount.unread { color: var(--accent); font-weight: 600; }
  .row-item.unread .from, .row-item.unread .subject { font-weight: 700; }
  .row-item .star { color: var(--muted); margin-right: 4px; }
  .row-item .star.on { color: #e5c07b; }
  .msg-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }

  /* Keyboard focus visibility (a11y foundation): a clear ring for keyboard users
     on every interactive control, without a persistent outline on mouse click. */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .row-item:focus-visible { outline-offset: -2px; }

  /* Sign-in card shares the gate look. */
  #signin { margin: auto; max-width: 460px; padding: 28px; }
  #signin .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 22px;
  }
  #signin h2 { margin: 0 0 4px; }
  #signin p { color: var(--muted); margin: 6px 0 16px; font-size: 13px; }
  #signin label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
  #signin input { width: 100%; }
  #signin .row { display: flex; gap: 8px; margin-top: 18px; }
  #signin .row button { flex: 1; }
  .switch { margin: 14px 0 0; font-size: 13px; }
  .switch button { font: inherit; }
</style>
</head>
<body>

<header role="banner">
  <h1>Postern webmail</h1>
  <span class="grow"></span>
  <span class="identity" id="identity"></span>
  <span class="who" id="who"></span>
  <span class="sendnote" id="sendNote" style="display:none"></span>
  <button id="composeBtn" style="display:none">Compose</button>
  <button id="logout" class="link" style="display:none">Sign out</button>
</header>

<!-- BYO-token gate (operator / self-host path, contract 1.7) -->
<div id="gate">
  <div class="card">
    <h2>Connect to your mailbox</h2>
    <p>Paste a read-scoped API token to browse mail. Optionally add a send-scoped token
       (or per-identity send token) to compose and reply. Tokens stay in this browser
       tab only (sessionStorage), never sent anywhere but the API you name below.</p>
    <label for="origin">API origin</label>
    <input id="origin" type="url" placeholder="https://postern.example" autocomplete="off" spellcheck="false">
    <label for="token">Postern read token</label>
    <input id="token" type="password" placeholder="read-scoped API token" autocomplete="off" spellcheck="false">
    <label for="sendToken">Send token (optional)</label>
    <input id="sendToken" type="password" placeholder="send-scoped token for compose" autocomplete="off" spellcheck="false">
    <div class="row">
      <button id="connect">Connect</button>
    </div>
    <div class="err" id="gateErr" role="alert" aria-live="assertive"></div>
    <p class="switch" id="toSigninWrap" style="display:none"><button type="button" class="link" id="toSignin">Back to sign in</button></p>
  </div>
</div>

<!-- Native sign-in (session cookie mode, #351) -->
<div id="signin" style="display:none">
  <div class="card">
    <h2>Sign in to your mailbox</h2>
    <p>Enter your Postern mailbox username and password.</p>
    <form id="signinForm">
      <label for="siUser">Username</label>
      <input id="siUser" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false">
      <label for="siPass">Password</label>
      <input id="siPass" name="password" type="password" autocomplete="current-password">
      <div class="row">
        <button type="submit" id="siSubmit">Sign in</button>
      </div>
    </form>
    <div class="err" id="signinErr" role="alert" aria-live="assertive"></div>
    <p class="switch"><button type="button" class="link" id="toTokenGate">Use an API token instead</button></p>
  </div>
</div>

<!-- App -->
<div id="app">
  <nav class="folders" id="folders" role="navigation" aria-label="Folders"></nav>
  <div class="sidebar" aria-label="Mailbox">
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search (press Enter)" aria-label="Search mail">
      <select id="searchMode" class="mode" title="Search mode (applies when searching)" aria-label="Search mode">
        <option value="hybrid">Hybrid</option>
        <option value="fts">Keyword</option>
        <option value="semantic">Semantic</option>
      </select>
    </div>
    <div class="list" id="list" aria-label="Messages"></div>
  </div>
  <div class="reading" id="reading" role="main" aria-label="Message">
    <div class="empty">Select a message to read.</div>
  </div>
</div>

<script>
"use strict";
(function () {
  // --- tiny safe DOM helpers (no innerHTML of untrusted content) -------------
  // Everything message-derived goes through text nodes / setAttribute, never
  // innerHTML, so stored content cannot inject markup or script.
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.appendChild(document.createTextNode(attrs[k]));
      else n.setAttribute(k, attrs[k]);
    }
    if (children) for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function $(id) { return document.getElementById(id); }

  // --- session state ---------------------------------------------------------
  var SS = window.sessionStorage;
  var SEARCH_MODES = ["fts", "semantic", "hybrid"];
  function normalizeSearchMode(v) {
    return SEARCH_MODES.indexOf(v) >= 0 ? v : "hybrid";
  }
  var state = {
    origin: SS.getItem("postern_origin") || "",
    token: SS.getItem("postern_token") || "",
    sendToken: SS.getItem("postern_send_token") || "",
    searchMode: normalizeSearchMode(SS.getItem("postern_search_mode") || "hybrid"),
    folder: "inbox", q: "", cursor: null, items: [], selected: null,
    folders: [],
    // Auth mode: "token" = BYO Bearer token (operator/self-host path, sessionStorage);
    // "session" = the native cookie session (#351), same-origin HttpOnly cookie + CSRF.
    authMode: "token",
    authBackend: "off",       // reported by GET /api/session: "native" or "off"
    identity: null,           // { from, displayName } when session-authed (Sending as ...)
    caps: [],                 // capability set granted to the session, e.g. ["read","send"]
    csrfToken: "",            // session synchronizer token (also read from the companion cookie)
    // Send capability is a PROBED fact, not "a send token was pasted": null until
    // probed, true when POST /api/send cleared the scope gate, false when refused (#277).
    sendCapable: null,
    // Why compose is disabled, so the note stays truthful: readonly (403), invalid
    // (401), unreachable (network). Empty when capable or no send token.
    sendReason: ""
  };

  // Same-origin base for session mode (relative URLs, so the HttpOnly cookie rides);
  // the pasted origin for BYO-token mode.
  function baseUrl() {
    return state.authMode === "session" ? "" : state.origin.replace(/\\/+$/, "");
  }
  // Read the readable CSRF companion cookie (__Host-postern_csrf, not HttpOnly): the
  // durable source echoed in X-Postern-CSRF on every write (double-submit). Reading it
  // fresh at write time means a reload never strands writes.
  function csrfFromCookie() {
    var m = (document.cookie || "").match(/(?:^|;\\s*)__Host-postern_csrf=([^;]+)/);
    return m ? m[1] : "";
  }

  // --- API client. Session mode: same-origin cookie (credentials:include), no token
  // in JS. Token mode: Bearer header, credentials:omit (token never logged/in a URL). ---
  function api(path, params) {
    var url = baseUrl() + path;
    if (params) {
      var qs = Object.keys(params)
        .filter(function (k) { return params[k] != null && params[k] !== ""; })
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
        .join("&");
      if (qs) url += "?" + qs;
    }
    var opts = state.authMode === "session"
      ? { headers: { "accept": "application/json" }, credentials: "include", referrerPolicy: "no-referrer" }
      : { headers: { "authorization": "Bearer " + state.token, "accept": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer" };
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "bad_json", status: r.status }; })
        .then(function (body) {
          if (r.status === 401) { var e = new Error("unauthorized"); e.code = 401; throw e; }
          if (!r.ok || body.ok === false) {
            var msg = (body && (body.message || body.error)) || ("HTTP " + r.status);
            throw new Error(msg);
          }
          return body;
        });
    });
  }

  function apiWrite(path, body) {
    return apiSendRequest("POST", path, body);
  }

  function apiSendRequest(method, path, body) {
    var url = baseUrl() + path;
    var opts;
    var headers = { "accept": "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (state.authMode === "session") {
      // Cookie session: the HttpOnly session cookie rides automatically; a write must
      // additionally carry the CSRF token in X-Postern-CSRF (double-submit, contract 1.6).
      opts = {
        method: method,
        headers: headers,
        credentials: "include",
        referrerPolicy: "no-referrer"
      };
      headers["x-postern-csrf"] = csrfFromCookie();
    } else {
      if (!state.sendToken) throw new Error("send token not configured");
      headers["authorization"] = "Bearer " + state.sendToken;
      opts = { method: method, headers: headers, credentials: "omit", referrerPolicy: "no-referrer" };
    }
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "bad_json", status: r.status }; })
        .then(function (j) {
          if (r.status === 401) { var e = new Error("unauthorized"); e.code = 401; throw e; }
          if (r.status === 403) {
            // The token cannot send: degrade honestly (never keep offering compose as
            // if a retry might work), then surface it to the caller (#277).
            state.sendCapable = false; state.sendReason = "readonly"; updateComposeUI();
            var e403 = new Error((j && (j.message || j.error)) || "requires send scope");
            e403.code = 403; throw e403;
          }
          if (!r.ok || j.ok === false) {
            var msg = (j && (j.message || j.error)) || ("HTTP " + r.status);
            var requestError = new Error(msg);
            requestError.code = r.status;
            throw requestError;
          }
          return j;
        });
    });
  }


  // Read-scoped organize writes (#352): seen/flags/move use the READ credential
  // (session cookie + CSRF, or the BYO read Bearer). Not the send token.
  function apiOrganize(path, body) {
    var url = baseUrl() + path;
    var opts;
    if (state.authMode === "session") {
      opts = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "x-postern-csrf": csrfFromCookie()
        },
        body: JSON.stringify(body),
        credentials: "include",
        referrerPolicy: "no-referrer"
      };
    } else {
      if (!state.token) throw new Error("read token not configured");
      opts = {
        method: "POST",
        headers: {
          "authorization": "Bearer " + state.token,
          "content-type": "application/json",
          "accept": "application/json"
        },
        body: JSON.stringify(body),
        credentials: "omit",
        referrerPolicy: "no-referrer"
      };
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "bad_json", status: r.status }; })
        .then(function (j) {
          if (r.status === 401) { var e = new Error("unauthorized"); e.code = 401; throw e; }
          if (!r.ok || j.ok === false) {
            var msg = (j && (j.message || j.error)) || ("HTTP " + r.status);
            throw new Error(msg);
          }
          return j;
        });
    });
  }


  // GET with the send credential (#352 drafts): drafts are send-scoped and
  // identity-bound. Session mode still uses the cookie; BYO token mode must use
  // the send token (usually a per-identity registry token), not the read Bearer.
  function apiSendGet(path, params) {
    var url = baseUrl() + path;
    if (params) {
      var qs = Object.keys(params)
        .filter(function (k) { return params[k] != null && params[k] !== ""; })
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
        .join("&");
      if (qs) url += "?" + qs;
    }
    var opts;
    if (state.authMode === "session") {
      opts = { headers: { "accept": "application/json" }, credentials: "include", referrerPolicy: "no-referrer" };
    } else {
      if (!state.sendToken) throw new Error("send token not configured");
      opts = {
        headers: { "authorization": "Bearer " + state.sendToken, "accept": "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer"
      };
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "bad_json", status: r.status }; })
        .then(function (body) {
          if (r.status === 401) { var e = new Error("unauthorized"); e.code = 401; throw e; }
          if (!r.ok || body.ok === false) {
            var msg = (body && (body.message || body.error)) || ("HTTP " + r.status);
            var err = new Error(msg); err.code = r.status; throw err;
          }
          return body;
        });
    });
  }

  function updateComposeUI() {
    var capable = state.sendCapable === true;
    $("composeBtn").style.display = capable ? "" : "none";
    var note = $("sendNote");
    var reasons = {
      readonly: "Send token is read-only; compose disabled.",
      invalid: "Send token was rejected; compose disabled.",
      unreachable: "Could not verify the send token; compose disabled."
    };
    if (state.sendToken && state.sendCapable === false && reasons[state.sendReason]) {
      note.textContent = reasons[state.sendReason]; note.style.display = "";
    } else {
      note.textContent = ""; note.style.display = "none";
    }
    // Reflect current capability in an open reading pane (the Reply button).
    if (state.selected) renderReading(state.selected);
  }

  // Honest send-capability probe (#277): a read-only token must NEVER be offered a
  // compose/reply UI, and we must learn that WITHOUT sending mail. The worker checks
  // token SCOPE before it validates the body, and POST /api/send with an empty body is
  // rejected by validation (400) before any message is dispatched. So an empty-body
  // POST reveals the token's send scope with zero mail sent: 403 = not send-capable,
  // 401 = bad token, anything else (400 validation) = the token cleared the scope gate.
  function probeSendCapability() {
    // Session mode: capability is KNOWN from the granted caps (no probe, no mail). A
    // native session has read+send, so compose is offered; a session without send is not.
    if (state.authMode === "session") {
      state.sendCapable = state.caps.indexOf("send") >= 0;
      state.sendReason = state.sendCapable ? "" : "readonly";
      updateComposeUI();
      return;
    }
    if (!state.sendToken) { state.sendCapable = false; updateComposeUI(); return; }
    state.sendCapable = null; updateComposeUI();
    var url = state.origin.replace(/\\/+$/, "") + "/api/send";
    fetch(url, {
      method: "POST",
      headers: {
        "authorization": "Bearer " + state.sendToken,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: "{}",
      credentials: "omit", referrerPolicy: "no-referrer"
    }).then(function (r) {
      if (r.status === 403) { state.sendCapable = false; state.sendReason = "readonly"; }
      else if (r.status === 401) { state.sendCapable = false; state.sendReason = "invalid"; }
      else { state.sendCapable = true; state.sendReason = ""; }
    }).catch(function () {
      // Network/other error: do not claim capability. Reactive 403-degrade still guards.
      state.sendCapable = false; state.sendReason = "unreachable";
    }).then(function () { updateComposeUI(); });
  }

  // --- attachment download (Bearer fetch -> Blob -> object URL) --------------
  // The API is token-gated and the token rides in the Authorization header, so a
  // plain <a href> cannot carry it (and we never put the token in a URL). Fetch
  // the bytes with the header, then trigger a download from an object URL.
  function downloadAttachment(messageId, index, filename, btn) {
    var url = baseUrl() +
      "/api/messages/" + encodeURIComponent(messageId) + "/attachments/" + index;
    var label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Downloading..."; }
    var opts = state.authMode === "session"
      ? { credentials: "include", referrerPolicy: "no-referrer" }
      : { headers: { "authorization": "Bearer " + state.token }, credentials: "omit", referrerPolicy: "no-referrer" };
    fetch(url, opts).then(function (r) {
      if (r.status === 401) { logout(); throw new Error("unauthorized"); }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.blob();
    }).then(function (blob) {
      var obj = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = obj; a.download = filename || ("attachment-" + index);
      document.body.appendChild(a); a.click(); a.remove();
      // Revoke on the next tick so the download has started.
      setTimeout(function () { URL.revokeObjectURL(obj); }, 0);
    }).catch(function (e) {
      if (e.message !== "unauthorized") alert("Download failed: " + e.message);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    });
  }

  // Render a (plain-text) message body inside a sandboxed iframe: sandbox="" is
  // maximally restrictive (no scripts, no same-origin, no forms), so even if the
  // stored body contained markup it cannot execute or reach the API/token. We
  // escape the text and linkify bare URLs; the result is the iframe's srcdoc.
  function escapeHtml(t) {
    return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function linkify(escaped) {
    // Operates on ALREADY-escaped text, so we only ever match plain URL chars and
    // emit an anchor whose href is itself escaped. No raw input reaches the DOM.
    return escaped.replace(/(https?:\\/\\/[^\\s<>"']+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer nofollow">' + u + '</a>';
    });
  }
  // --- remote-content blocking (#60/#343): privacy always ----------------------
  // HTML bodies can reference remote subresources (img src, srcset, CSS url(),
  // <link rel=stylesheet>, legacy background=""). Even in the sandbox="" iframe
  // (which blocks scripts) those still FETCH on open: that is the tracking-pixel
  // leak (the sender learns the open, the reader's IP, time, and client). So we
  // ALWAYS neutralize remote-loading references; there is no per-message opt-in.
  // Why no opt-in: the served /webmail CSP is img-src 'self' data:, and the
  // reading pane is an about:srcdoc iframe that INHERITS that policy (a nested
  // meta CSP can only tighten it, never relax it), so a remote image cannot load
  // even if we emitted its URL. A real opt-in would mean relaxing the top-frame
  // CSP for the whole page, defeating this very protection (#343).
  // Parsing uses DOMParser (text/html is INERT: no scripts run, no resources load)
  // and we only mutate attributes / text nodes, never assign innerHTML.
  function isRemoteUrl(u) {
    if (u == null) return false;
    return /^(?:https?:)?\\/\\//i.test(String(u).trim());
  }
  function hasRemoteInSrcset(ss) {
    return !!ss && /(?:^|,)\\s*(?:https?:)?\\/\\//i.test(String(ss));
  }
  // A neutral inline placeholder so a blocked image degrades to a tidy box (not a
  // broken-image icon) and fires NO network request (data: is allowed by the CSP).
  var BLOCKED_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='90'%3E%3Crect width='100%25' height='100%25' fill='%23f3f3f3' stroke='%23cccccc'/%3E%3Ctext x='60' y='48' font-size='10' fill='%23999999' text-anchor='middle' font-family='sans-serif'%3Eimage blocked%3C/text%3E%3C/svg%3E";
  function stripRemoteCssUrls(css) {
    var n = 0;
    var out = String(css).replace(/url\\(\\s*(['"]?)\\s*(?:https?:)?\\/\\/[^)'"]*\\1\\s*\\)/ig, function () {
      n++; return "url('')";
    });
    return { css: out, count: n };
  }
  function neutralizeRemoteHtml(html) {
    var blocked = 0, doc = null;
    try { doc = new DOMParser().parseFromString(String(html), "text/html"); } catch (e) { doc = null; }
    if (!doc || !doc.body) {
      // Parser unavailable: FAIL SAFE -- show escaped text so nothing auto-loads.
      return { html: linkify(escapeHtml(String(html))), blocked: 0 };
    }
    var i, list, hit;
    // Hoist any <style> from <head> into <body> so our body-only embed keeps them.
    if (doc.head) {
      var hs = doc.head.querySelectorAll("style");
      for (i = hs.length - 1; i >= 0; i--) doc.body.insertBefore(hs[i], doc.body.firstChild);
    }
    function blockAttr(node, attr, stash) {
      var v = node.getAttribute(attr);
      if (isRemoteUrl(v)) { node.setAttribute(stash, v); node.removeAttribute(attr); return true; }
      return false;
    }
    // <img>: remote src -> placeholder; remote srcset -> stripped.
    list = doc.querySelectorAll("img");
    for (i = 0; i < list.length; i++) {
      hit = false;
      var src = list[i].getAttribute("src");
      if (isRemoteUrl(src)) {
        list[i].setAttribute("data-blocked-src", src);
        list[i].setAttribute("src", BLOCKED_IMG);
        list[i].setAttribute("data-blocked", "1");
        hit = true;
      }
      var ss = list[i].getAttribute("srcset");
      if (hasRemoteInSrcset(ss)) { list[i].setAttribute("data-blocked-srcset", ss); list[i].removeAttribute("srcset"); hit = true; }
      if (hit) blocked++;
    }
    // Other remote-loading elements.
    list = doc.querySelectorAll("source, video, audio, track, iframe, embed, object, input[type=image]");
    for (i = 0; i < list.length; i++) {
      hit = false;
      if (blockAttr(list[i], "src", "data-blocked-src")) hit = true;
      if (blockAttr(list[i], "poster", "data-blocked-poster")) hit = true;
      if (blockAttr(list[i], "data", "data-blocked-data")) hit = true;
      var ss2 = list[i].getAttribute("srcset");
      if (hasRemoteInSrcset(ss2)) { list[i].setAttribute("data-blocked-srcset", ss2); list[i].removeAttribute("srcset"); hit = true; }
      if (hit) blocked++;
    }
    // Legacy background="" attribute (old HTML email tables).
    list = doc.querySelectorAll("[background]");
    for (i = 0; i < list.length; i++) { if (blockAttr(list[i], "background", "data-blocked-background")) blocked++; }
    // Remote <link> (e.g. rel=stylesheet): drop it; it would fetch on open.
    list = doc.querySelectorAll("link[href]");
    for (i = 0; i < list.length; i++) {
      if (isRemoteUrl(list[i].getAttribute("href")) && list[i].parentNode) { list[i].parentNode.removeChild(list[i]); blocked++; }
    }
    // Inline style="" carrying remote url().
    list = doc.querySelectorAll("[style]");
    for (i = 0; i < list.length; i++) {
      var r1 = stripRemoteCssUrls(list[i].getAttribute("style"));
      if (r1.count) { list[i].setAttribute("style", r1.css); blocked += r1.count; }
    }
    // <style> blocks carrying remote url().
    list = doc.querySelectorAll("style");
    for (i = 0; i < list.length; i++) {
      var r2 = stripRemoteCssUrls(list[i].textContent);
      if (r2.count) { list[i].textContent = r2.css; blocked += r2.count; }
    }
    return { html: doc.body.innerHTML, blocked: blocked };
  }

  // Build the sandboxed body iframe + (when content was blocked) the opt-in banner.
  // Returns a container node; the iframe stays sandbox="" in every path.
  function renderBody(m) {
    var wrap = el("div", { class: "body-wrap" });
    var hasHtml = !!(m && m.bodyHtml);
    // HTML email authors its own colors for a LIGHT background (every mail client
    // renders HTML mail on white), so use white + dark text for the HTML case to
    // avoid dark-on-dark unreadable bodies. Plain text keeps the app's dark theme.
    function baseStyle(light) {
      return "<style>html,body{margin:0}body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
        "word-wrap:break-word;padding:10px" +
        (light ? ";color:#1a1a1a;background:#ffffff" : ";color:#e7e9ee;background:#1c1f26;white-space:pre-wrap") +
        "}a{color:#6ea8fe}img{max-width:100%;height:auto}</style>";
    }
    function frameFor(inner, light) {
      var doc = '<!doctype html><html><head><meta charset="utf-8">' + baseStyle(light) +
        '</head><body>' + inner + '</body></html>';
      var f = document.createElement("iframe");
      f.className = "msg-body-frame";
      f.setAttribute("sandbox", "");        // no scripts, no same-origin, no forms
      f.setAttribute("referrerpolicy", "no-referrer");
      f.setAttribute("srcdoc", doc);
      return f;
    }
    function mount() {
      clear(wrap);
      if (!hasHtml) { wrap.appendChild(frameFor(linkify(escapeHtml((m && m.bodyText) || "")), false)); return; }
      // Remote content is ALWAYS neutralized: the served page CSP (img-src 'self'
      // data:) is inherited by this srcdoc iframe, so remote loads are blocked at
      // the platform layer regardless. There is no opt-in to load them (#343).
      var res = neutralizeRemoteHtml(m.bodyHtml);
      var inner = res.html, blocked = res.blocked;
      if (blocked > 0) {
        wrap.appendChild(el("div", { class: "remote-banner" }, [
          el("span", { text: "Remote content blocked to protect your privacy (" + blocked + " item" + (blocked === 1 ? "" : "s") + "). Images are not loaded in webmail." })
        ]));
      }
      wrap.appendChild(frameFor(inner, true));
    }
    mount();
    return wrap;
  }

  // --- formatting (pure, returns strings; rendered via text nodes) -----------
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  }

  // --- gate / sign-in ---------------------------------------------------------
  function focusFirst(id) {
    var elm = $(id);
    if (elm && typeof elm.focus === "function") { try { elm.focus(); } catch (_) {} }
  }

  function showGate(msg) {
    state.authMode = "token";
    $("app").className = "";
    $("signin").style.display = "none";
    $("gate").style.display = "";
    $("logout").style.display = "none";
    $("identity").textContent = "";
    $("who").textContent = "";
    $("origin").value = state.origin;
    // Offer a way back to native sign-in only when the server supports it.
    $("toSigninWrap").style.display = state.authBackend === "native" ? "" : "none";
    $("gateErr").textContent = msg || "";
    focusFirst("origin");
  }

  function showSignin(msg) {
    state.authMode = "session";
    $("app").className = "";
    $("gate").style.display = "none";
    $("signin").style.display = "";
    $("logout").style.display = "none";
    $("identity").textContent = "";
    $("who").textContent = "";
    $("signinErr").textContent = msg || "";
    $("siPass").value = "";
    focusFirst("siUser");
  }

  function showApp() {
    $("gate").style.display = "none";
    $("signin").style.display = "none";
    $("app").className = "on";
    $("logout").style.display = "";
    if (state.authMode === "session" && state.identity) {
      // Identity display (contract 1.5.1): show who the browser sends as. A send
      // token could never surface this; a session GET echoes the bound identity.
      $("identity").textContent = "Sending as " + state.identity.from;
      $("who").textContent = state.identity.displayName || "";
    } else {
      $("identity").textContent = "";
      $("who").textContent = state.origin;
    }
    $("searchMode").value = state.searchMode;
    updateComposeUI();
    probeSendCapability();
  }

  // BYO-token connect (operator / self-host path, contract 1.7). Unchanged behavior.
  function connect() {
    state.authMode = "token";
    var origin = $("origin").value.trim();
    var token = $("token").value;
    var sendTok = $("sendToken").value.trim();
    $("gateErr").textContent = "";
    if (!/^https?:\\/\\//.test(origin)) { $("gateErr").textContent = "Enter the API origin (https://...)."; return; }
    if (!token) { $("gateErr").textContent = "Enter your Postern read token."; return; }
    state.origin = origin; state.token = token; state.sendToken = sendTok;
    // Validate by hitting an authed endpoint before persisting the token.
    api("/api/messages", { limit: 1 }).then(function () {
      SS.setItem("postern_origin", origin);
      SS.setItem("postern_token", token);
      if (sendTok) SS.setItem("postern_send_token", sendTok);
      else SS.removeItem("postern_send_token");
      $("token").value = "";
      $("sendToken").value = "";
      showApp();
      resetAndLoad();
    }).catch(function (e) {
      state.token = ""; state.sendToken = "";
      $("gateErr").textContent = e.code === 401 ? "Token rejected by the API." : ("Could not connect: " + e.message);
    });
  }

  // Native sign-in (session cookie mode, #351): POST /api/session mints an HttpOnly
  // session; the browser never holds the credential in JS.
  function signIn() {
    state.authMode = "session";
    var username = $("siUser").value.trim();
    var password = $("siPass").value;
    $("signinErr").textContent = "";
    if (!username || !password) { $("signinErr").textContent = "Enter your username and password."; return; }
    $("siSubmit").disabled = true;
    fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
      credentials: "include", referrerPolicy: "no-referrer"
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (b) { return { status: r.status, body: b }; });
    }).then(function (res) {
      $("siSubmit").disabled = false;
      if (res.status === 200 && res.body && res.body.ok) { $("siPass").value = ""; onSession(res.body); return; }
      if (res.status === 429) { $("signinErr").textContent = "Too many attempts. Please wait and try again."; return; }
      $("signinErr").textContent = "Sign in failed. Check your username and password.";
    }).catch(function () {
      $("siSubmit").disabled = false;
      $("signinErr").textContent = "Could not reach the server. Try again.";
    });
  }

  // Adopt a session payload ({ identity, capabilities, csrfToken } from POST or GET
  // /api/session) into state, then show the app.
  function onSession(body) {
    state.authMode = "session";
    state.origin = "";
    state.identity = body.identity || null;
    state.caps = body.capabilities || [];
    state.csrfToken = body.csrfToken || csrfFromCookie();
    showApp();
    resetAndLoad();
  }

  function sessionReset() {
    state.identity = null; state.caps = []; state.csrfToken = "";
    state.sendCapable = null; state.sendReason = "";
    state.items = []; state.selected = null; state.cursor = null;
    clear($("list")); renderReading(null);
  }

  // Sign out. Session mode: DELETE /api/session revokes the row server-side and clears
  // the cookies; token mode: drop the tokens from sessionStorage.
  function logout() {
    if (state.authMode === "session") {
      var csrf = csrfFromCookie();
      fetch("/api/session", {
        method: "DELETE",
        headers: { "accept": "application/json", "x-postern-csrf": csrf },
        credentials: "include", referrerPolicy: "no-referrer"
      }).catch(function () {}).then(function () {
        sessionReset();
        showSignin("Signed out.");
      });
      return;
    }
    SS.removeItem("postern_token");
    SS.removeItem("postern_send_token");
    SS.removeItem("postern_origin");
    state.token = ""; state.sendToken = ""; state.sendCapable = null; state.sendReason = ""; state.items = []; state.selected = null; state.cursor = null;
    clear($("list")); renderReading(null);
    showGate("Signed out. Your tokens were cleared from this browser.");
  }

  // --- folders + list (#352) -------------------------------------------------
  function listParams() {
    var p = { limit: 50, cursor: state.cursor };
    if (state.folder === "inbox") p.direction = "inbound";
    else if (state.folder === "sent") p.direction = "outbound";
    else if (state.folder === "all") p.mailbox = "all";
    else if (state.folder === "trash" || state.folder === "junk" || state.folder === "archive") {
      p.mailbox = state.folder;
    }
    return p;
  }

  function renderFolderRail() {
    var nav = $("folders");
    if (!nav) return;
    clear(nav);
    var rows = state.folders.length ? state.folders : [
      { id: "inbox", label: "Inbox", count: 0, unread: 0 },
      { id: "sent", label: "Sent", count: 0, unread: 0 },
      { id: "all", label: "All", count: 0, unread: 0 },
      { id: "drafts", label: "Drafts", count: 0, unread: 0 },
      { id: "trash", label: "Trash", count: 0, unread: 0 },
      { id: "junk", label: "Junk", count: 0, unread: 0 },
      { id: "archive", label: "Archive", count: 0, unread: 0 }
    ];
    rows.forEach(function (f) {
      var countLabel = f.unread > 0 ? String(f.unread) : (f.count > 0 ? String(f.count) : "");
      var btn = el("button", {
        type: "button",
        class: f.id === state.folder ? "active" : "",
        "data-folder": f.id,
        "aria-current": f.id === state.folder ? "page" : "false"
      }, [
        el("span", { class: "fname", text: f.label || f.id }),
        el("span", { class: "fcount" + (f.unread > 0 ? " unread" : ""), text: countLabel })
      ]);
      btn.addEventListener("click", function () {
        if (state.folder === f.id) return;
        state.folder = f.id;
        state.q = "";
        $("search").value = "";
        renderFolderRail();
        resetAndLoad();
      });
      nav.appendChild(btn);
    });
  }

  function refreshFolders() {
    return api("/api/folders").then(function (body) {
      state.folders = body.folders || [];
      renderFolderRail();
    }).catch(function () {
      // Folder counts are best-effort; the rail still works from defaults.
      renderFolderRail();
    });
  }

  function resetAndLoad() {
    state.cursor = null; state.items = [];
    clear($("list"));
    renderFolderRail();
    loadMore();
    refreshFolders();
  }

  function loadMore(fallbackFts) {
    var loading = el("div", { class: "loading", text: "Loading..." });
    $("list").appendChild(loading);
    var mode = fallbackFts ? "fts" : state.searchMode;
    var req;
    if (state.folder === "drafts" && !state.q) {
      if (state.authMode !== "session" && !state.sendToken) {
        $("list").removeChild(loading);
        $("list").appendChild(el("div", {
          class: "loading",
          text: "Drafts need an identity send token (BYO read token cannot list drafts)."
        }));
        return;
      }
      req = apiSendGet("/api/drafts").then(function (body) {
        return { items: (body.drafts || []).map(function (d) {
          return {
            messageId: d.id,
            isDraft: true,
            direction: "outbound",
            from: d.identity || "",
            to: d.to || "",
            subject: d.subject || "(no subject)",
            date: d.updatedAt || d.createdAt || "",
            bodyText: d.bodyText || "",
            bodyHtml: d.bodyHtml || null,
            cc: d.cc || "",
            bcc: d.bcc || "",
            composeMode: d.composeMode || "new",
            sourceMessageId: d.sourceMessageId || null,
            updatedAt: d.updatedAt || null,
            seen: true,
            flagged: false,
            trusted: true,
            attachmentCount: 0,
            mailbox: null
          };
        }), cursor: null };
      });
    } else {
      req = state.q
        ? api("/api/search", { q: state.q, mode: mode, limit: 50, cursor: state.cursor })
        : api("/api/messages", listParams());
    }
    req.then(function (body) {
      $("list").removeChild(loading);
      // search returns SearchHit { message, ... }; list returns summaries.
      var rows = (body.items || []).map(function (it) { return it.message ? it.message : it; });
      state.items = state.items.concat(rows);
      state.cursor = body.cursor || null;
      rows.forEach(appendRow);
      if (fallbackFts) {
        $("list").appendChild(el("div", { class: "loading", text: "Semantic search unavailable; showing keyword results." }));
      }
      if (state.cursor) {
        var more = el("div", { class: "more" }, [el("button", { class: "link", text: "Load more" })]);
        more.firstChild.addEventListener("click", function () { $("list").removeChild(more); loadMore(); });
        $("list").appendChild(more);
      } else if (state.items.length === 0) {
        $("list").appendChild(el("div", { class: "loading", text: "No messages." }));
      }
    }).catch(function (e) {
      try { $("list").removeChild(loading); } catch (_) {}
      if (e.code === 401) { logout(); return; }
      if (state.q && !fallbackFts && state.searchMode !== "fts") {
        var msg = String(e.message || "");
        if (/semantic|hybrid|vector|embed|ai/i.test(msg)) {
          state.searchMode = "fts";
          SS.setItem("postern_search_mode", "fts");
          $("searchMode").value = "fts";
          state.cursor = null; state.items = [];
          clear($("list"));
          loadMore(true);
          return;
        }
      }
      $("list").appendChild(el("div", { class: "err", text: "Error: " + e.message }));
    });
  }

  function appendRow(m) {
    var tags = [];
    if (m.flagged) tags.push(el("span", { class: "star on", text: "★", title: "Flagged" }));
    if (m.isDraft) {
      tags.push(el("span", { class: "tag out", text: "Draft" }));
    } else {
      if (m.direction === "outbound") tags.push(el("span", { class: "tag out", text: "Sent" }));
      tags.push(el("span", { class: "tag " + (m.trusted ? "trusted" : "untrusted"), text: m.trusted ? "trusted" : "untrusted" }));
    }
    var who = m.direction === "outbound" ? ("To: " + (m.to || "")) : (m.from || "");
    var item = el("div", {
      class: "row-item" + (m.seen === false ? " unread" : ""),
      "data-id": m.messageId,
      role: "button",
      tabindex: "0",
      "aria-label": (m.subject || "(no subject)") + " from " + who
    }, [
      el("div", { class: "top" }, [
        el("div", { class: "from", text: who }),
        el("div", { class: "date", text: fmtDate(m.date || m.receivedAt) })
      ]),
      el("div", { class: "subject", text: m.subject || "(no subject)" }),
      el("div", { class: "meta" }, tags.concat(
        m.attachmentCount ? [el("span", { text: m.attachmentCount + " attachment(s)" })] : []
      ))
    ]);
    item.addEventListener("click", function () { selectMessage(m.messageId, item); });
    item.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectMessage(m.messageId, item); }
    });
    $("list").appendChild(item);
  }

  // --- reading ---------------------------------------------------------------
  function selectMessage(id, item) {
    var prev = $("list").querySelector(".row-item.sel");
    if (prev) prev.classList.remove("sel");
    if (item) item.classList.add("sel");
    // Drafts have no /api/messages/:id body; keep the list summary in the pane.
    var draft = state.items.find(function (x) { return x.messageId === id && x.isDraft; });
    if (draft) {
      renderLoadingReading();
      Promise.all([
        apiSendGet("/api/drafts/" + encodeURIComponent(id)),
        apiSendGet("/api/drafts/" + encodeURIComponent(id) + "/attachments")
      ]).then(function (parts) {
        var d = parts[0].draft;
        d.attachments = parts[1].attachments || [];
        renderComposeForm({ draft: d });
      }).catch(function (e) { renderError(e.message); });
      return;
    }
    renderLoadingReading();
    api("/api/messages/" + encodeURIComponent(id)).then(function (body) {
      var m = body.message;
      renderReading(m);
      if (m && m.seen === false) {
        apiOrganize("/api/messages/seen", { ids: [m.messageId], seen: true }).then(function () {
          m.seen = true;
          if (item) item.classList.remove("unread");
          state.items.forEach(function (it) {
            if (it.messageId === m.messageId) it.seen = true;
          });
          refreshFolders();
        }).catch(function () { /* non-fatal */ });
      }
    }).catch(function (e) {
      if (e.code === 401) { logout(); return; }
      renderError(e.message);
    });
  }

  function renderLoadingReading() {
    var r = $("reading"); clear(r); r.appendChild(el("div", { class: "loading", text: "Loading message..." }));
  }
  function renderError(msg) {
    var r = $("reading"); clear(r); r.appendChild(el("div", { class: "err", text: "Error: " + msg }));
  }

  function renderComposeForm(opts) {
    opts = opts || {};
    var draft = opts.draft || {};
    var mode = draft.composeMode || opts.composeMode || "new";
    var sourceMessageId = draft.sourceMessageId || opts.sourceMessageId || null;
    var draftId = draft.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    var updatedAt = draft.updatedAt || null;
    var attachments = draft.attachments || [];
    var rich = draft.bodyHtml != null ? true : !!opts.rich;
    var saveTimer = null;
    var saveChain = Promise.resolve();
    var closed = false;
    var r = $("reading"); clear(r);
    var err = el("div", { class: "err", text: "" });
    var status = el("span", { class: "compose-status", text: updatedAt ? "Saved" : "Not saved yet" });
    var toInput = el("input", { id: "cmpTo", type: "text", value: draft.to || opts.to || "", placeholder: "one@example.com, two@example.com" });
    var ccInput = el("input", { id: "cmpCc", type: "text", value: draft.cc || opts.cc || "" });
    var bccInput = el("input", { id: "cmpBcc", type: "text", value: draft.bcc || opts.bcc || "" });
    var subInput = el("input", { id: "cmpSub", type: "text", value: draft.subject || opts.subject || "" });
    var editor = el("div", {
      id: "cmpBody", class: "compose-editor" + (rich ? "" : " plain"),
      contenteditable: "true", role: "textbox", "aria-multiline": "true"
    });
    var initialText = draft.bodyText || opts.text || "";
    if (rich && draft.bodyHtml) editor.appendChild(safeComposeFragment(draft.bodyHtml));
    else editor.textContent = initialText;
    var formatbar = el("div", { class: "formatbar", role: "toolbar", "aria-label": "Formatting" });
    [["bold", "B"], ["italic", "I"], ["underline", "U"], ["insertUnorderedList", "Bullets"],
      ["insertOrderedList", "Numbers"]].forEach(function (item) {
      var btn = el("button", { type: "button", text: item[1], "data-command": item[0] });
      btn.addEventListener("click", function () {
        editor.focus(); document.execCommand(item[0], false, null); scheduleSave();
      });
      formatbar.appendChild(btn);
    });
    formatbar.style.display = rich ? "" : "none";
    var modeBtn = el("button", { type: "button", text: rich ? "Use plain text" : "Use rich text" });
    modeBtn.addEventListener("click", function () {
      if (rich) {
        editor.textContent = editor.innerText;
        editor.classList.add("plain");
        rich = false;
      } else {
        editor.classList.remove("plain");
        rich = true;
      }
      formatbar.style.display = rich ? "" : "none";
      modeBtn.textContent = rich ? "Use plain text" : "Use rich text";
      scheduleSave();
    });
    var fileInput = el("input", { id: "cmpFiles", type: "file", multiple: "multiple" });
    var fileList = el("ul", { class: "draft-files", id: "cmpFileList" });
    var quoteBox = el("div", { class: "quote-preview" });
    quoteBox.style.display = "none";
    var form = el("div", { class: "compose" }, [
      el("h2", { text: mode === "replyAll" ? "Reply all" : mode === "reply" ? "Reply" : mode === "forward" ? "Forward" : "Compose" }),
      el("p", { class: "compose-note", text: "Autosaves server-side; Send uses the same mailbox core as API clients." }),
      err,
      el("label", { for: "cmpTo", text: "To" }), toInput,
      el("label", { for: "cmpCc", text: "Cc" }), ccInput,
      el("label", { for: "cmpBcc", text: "Bcc" }), bccInput,
      el("label", { for: "cmpSub", text: "Subject" }), subInput,
      el("label", { for: "cmpBody", text: "Message" }),
      el("div", { class: "formatbar" }, [modeBtn]),
      formatbar, editor, quoteBox,
      el("label", { for: "cmpFiles", text: "Attachments (20 files, 25 MiB total)" }), fileInput, fileList,
      el("div", { class: "compose-actions" }, [
        el("button", { id: "cmpSend", text: "Send" }),
        el("button", { id: "cmpCancel", text: "Close" }),
        el("button", { id: "cmpDiscard", text: "Discard" }),
        status
      ])
    ]);
    r.appendChild(form);
    if (mode === "reply" || mode === "replyAll") {
      toInput.disabled = true;
      ccInput.disabled = true;
      subInput.disabled = true;
    }
    showQuote(opts.original || null);
    if (!opts.original && sourceMessageId) {
      api("/api/messages/" + encodeURIComponent(sourceMessageId)).then(function (body) {
        showQuote(body.message);
      }).catch(function () {});
    }
    renderFiles();

    function safeComposeFragment(html) {
      var frag = document.createDocumentFragment();
      var doc;
      try { doc = new DOMParser().parseFromString(String(html), "text/html"); } catch (_) { return frag; }
      var allowed = ["A","B","BLOCKQUOTE","BR","CODE","DIV","EM","H1","H2","H3","I","LI","OL","P","PRE","S","SPAN","STRONG","U","UL"];
      function copy(node, parent) {
        if (node.nodeType === 3) { parent.appendChild(document.createTextNode(node.nodeValue || "")); return; }
        if (node.nodeType !== 1) return;
        var tag = node.tagName;
        if (allowed.indexOf(tag) < 0) {
          Array.prototype.slice.call(node.childNodes).forEach(function (child) { copy(child, parent); });
          return;
        }
        var clean = document.createElement(tag.toLowerCase());
        if (tag === "A") {
          var href = node.getAttribute("href") || "";
          if (/^(https?:|mailto:)/i.test(href)) clean.setAttribute("href", href);
          clean.setAttribute("rel", "noopener noreferrer nofollow");
        }
        Array.prototype.slice.call(node.childNodes).forEach(function (child) { copy(child, clean); });
        parent.appendChild(clean);
      }
      Array.prototype.slice.call(doc.body.childNodes).forEach(function (node) { copy(node, frag); });
      return frag;
    }

    function showQuote(original) {
      if (!original || mode === "new") return;
      var source = (original.bodyText || htmlToPlain(original.bodyHtml || "")).trim();
      var label = mode === "forward" ? "Forwarded message" : "Quoted message";
      quoteBox.textContent = label + "\\nFrom: " + (original.from || "") + "\\n" + source;
      quoteBox.style.display = "";
    }

    function htmlToPlain(html) {
      try {
        var doc = new DOMParser().parseFromString(String(html), "text/html");
        return (doc.body && doc.body.textContent) || "";
      } catch (_) { return ""; }
    }

    function recipientList(value) {
      return String(value || "").split(/[,\\n;]/).map(function (x) { return x.trim(); }).filter(Boolean);
    }

    function validateRecipients() {
      var re = /^[^@\\s]+@[^@\\s.]+(?:\\.[^@\\s.]+)+$/;
      var fields = mode === "reply" || mode === "replyAll"
        ? [["Bcc", bccInput.value]]
        : [["To", toInput.value], ["Cc", ccInput.value], ["Bcc", bccInput.value]];
      for (var i = 0; i < fields.length; i++) {
        var values = recipientList(fields[i][1]);
        for (var j = 0; j < values.length; j++) {
          if (!re.test(values[j])) return "Invalid " + fields[i][0] + " address: " + values[j];
        }
      }
      if (mode !== "reply" && mode !== "replyAll" && recipientList(toInput.value).length === 0) return "Enter a To recipient.";
      return "";
    }

    function payload() {
      var text = (editor.innerText || editor.textContent || "").trim();
      return {
        to: toInput.value.trim() || null,
        cc: ccInput.value.trim() || null,
        bcc: bccInput.value.trim() || null,
        subject: subInput.value.trim() || "(no subject)",
        bodyText: rich ? text : text,
        bodyHtml: rich ? editor.innerHTML : null,
        inReplyTo: sourceMessageId,
        threadId: opts.threadId || draft.threadId || null,
        composeMode: mode,
        sourceMessageId: sourceMessageId,
        updatedAt: updatedAt
      };
    }

    function saveDraft() {
      clearTimeout(saveTimer);
      if (closed) return saveChain;
      status.textContent = "Saving...";
      saveChain = saveChain.catch(function () {}).then(function () {
        return apiSendRequest("PUT", "/api/drafts/" + encodeURIComponent(draftId), payload());
      }).then(function (body) {
          updatedAt = body.draft.updatedAt;
          status.textContent = "Saved";
          return body.draft;
        }).catch(function (e) {
          status.textContent = "Not saved";
          err.textContent = "Autosave failed: " + e.message;
          throw e;
      });
      return saveChain;
    }

    function scheduleSave() {
      if (closed) return;
      clearTimeout(saveTimer);
      status.textContent = "Unsaved changes";
      saveTimer = setTimeout(function () { saveDraft().catch(function () {}); }, 800);
    }

    [toInput, ccInput, bccInput, subInput, editor].forEach(function (node) {
      node.addEventListener("input", scheduleSave);
    });

    function renderFiles() {
      clear(fileList);
      attachments.forEach(function (a) {
        var remove = el("button", { type: "button", text: "Remove" });
        remove.addEventListener("click", function () {
          remove.disabled = true;
          apiSendRequest("DELETE", "/api/drafts/" + encodeURIComponent(draftId) +
            "/attachments/" + encodeURIComponent(a.id)).then(function () {
            attachments = attachments.filter(function (x) { return x.id !== a.id; });
            renderFiles();
          }).catch(function (e) { err.textContent = e.message; remove.disabled = false; });
        });
        fileList.appendChild(el("li", {}, [
          el("span", { text: (a.filename || "attachment") + " (" + a.size + " bytes)" }), remove
        ]));
      });
    }

    function uploadFile(file) {
      var progress = el("span", { class: "progress", text: file.name + " 0%" });
      fileList.appendChild(el("li", {}, [progress]));
      return saveDraft().then(function () {
        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open("POST", baseUrl() + "/api/drafts/" + encodeURIComponent(draftId) + "/attachments");
          xhr.withCredentials = state.authMode === "session";
          xhr.setRequestHeader("Accept", "application/json");
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.setRequestHeader("X-Postern-Filename", encodeURIComponent(file.name));
          if (state.authMode === "session") xhr.setRequestHeader("X-Postern-CSRF", csrfFromCookie());
          else xhr.setRequestHeader("Authorization", "Bearer " + state.sendToken);
          xhr.upload.onprogress = function (event) {
            if (event.lengthComputable) progress.textContent = file.name + " " + Math.round(event.loaded * 100 / event.total) + "%";
          };
          xhr.onload = function () {
            var body = {};
            try { body = JSON.parse(xhr.responseText); } catch (_) {}
            if (xhr.status >= 200 && xhr.status < 300 && body.attachment) resolve(body.attachment);
            else reject(new Error(body.message || body.error || ("HTTP " + xhr.status)));
          };
          xhr.onerror = function () { reject(new Error("attachment upload failed")); };
          xhr.send(file);
        });
      }).then(function (attachment) {
        attachments.push(attachment);
        renderFiles();
      }).catch(function (e) {
        err.textContent = e.message;
        renderFiles();
      });
    }

    fileInput.addEventListener("change", function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      if (attachments.length + files.length > 20) { err.textContent = "At most 20 attachments are allowed."; return; }
      var total = attachments.reduce(function (sum, a) { return sum + (a.size || 0); }, 0);
      files.forEach(function (file) { total += file.size; });
      if (total > 25 * 1024 * 1024) { err.textContent = "Attachments exceed 25 MiB."; return; }
      files.reduce(function (chain, file) {
        return chain.then(function () { return uploadFile(file); });
      }, Promise.resolve());
      fileInput.value = "";
    });

    $("cmpCancel").addEventListener("click", function () {
      saveDraft().catch(function () {}).then(function () {
        closed = true;
        state.folder = "drafts"; resetAndLoad(); renderReading(null);
      });
    });
    $("cmpDiscard").addEventListener("click", function () {
      clearTimeout(saveTimer);
      closed = true;
      saveChain.catch(function () {}).then(function () {
        return apiSendRequest("DELETE", "/api/drafts/" + encodeURIComponent(draftId));
      }).then(function () {
        state.folder = "drafts"; resetAndLoad(); renderReading(null);
      }).catch(function (e) {
        if (e.code === 404) {
          state.folder = "drafts"; resetAndLoad(); renderReading(null);
          return;
        }
        err.textContent = e.message;
      });
    });
    $("cmpSend").addEventListener("click", function () {
      err.textContent = "";
      var recipientError = validateRecipients();
      if (recipientError) { err.textContent = recipientError; return; }
      var text = (editor.innerText || editor.textContent || "").trim();
      if (!text) { err.textContent = "Enter a message."; return; }
      $("cmpSend").disabled = true;
      saveDraft().then(function () {
        return apiWrite("/api/drafts/" + encodeURIComponent(draftId) + "/send", {});
      }).then(function (res) {
        state.folder = "sent"; state.q = ""; $("search").value = "";
        resetAndLoad();
        if (res.messageId) selectMessage(res.messageId, null);
        else renderReading(null);
      }).catch(function (e) {
        if (e.code === 401) { logout(); return; }
        if (e.code === 403) {
          // Not send-capable: apiWrite already hid the compose entry points; keep Send
          // disabled and say so plainly rather than inviting a doomed retry (#277).
          err.textContent = "This token is read-only; sending is disabled. Provide a send-scoped token to compose.";
          return;
        }
        $("cmpSend").disabled = false;
        err.textContent = e.message + " Draft preserved for retry.";
      });
    });
  }

  function kv(label, value) {
    return el("div", { class: "kv" }, [el("b", { text: label + ": " }), document.createTextNode(value || "")]);
  }

  function renderReading(m) {
    var r = $("reading"); clear(r);
    if (!m) { r.appendChild(el("div", { class: "empty", text: "Select a message to read." })); return; }
    state.selected = m;

    var head = el("div", { class: "msg-head" }, [
      el("h2", { text: m.subject || "(no subject)" }),
      kv("From", m.from),
      kv("To", m.to),
      m.cc ? kv("Cc", m.cc) : null,
      m.bcc ? kv("Bcc", m.bcc) : null,
      kv("Date", m.date ? new Date(m.date).toLocaleString() : ""),
      el("div", { class: "kv" }, [
        el("b", { text: "Trust: " }),
        el("span", { class: "tag " + (m.trusted ? "trusted" : "untrusted"), text: m.trusted ? "trusted" : "untrusted" }),
        document.createTextNode(
          m.auth ? ("  spf=" + (m.auth.spf || "none") + " dkim=" + (m.auth.dkim || "none") + " dmarc=" + (m.auth.dmarc || "none")) : ""
        )
      ])
    ]);
    var actions = [];
    if (!m.isDraft) {
      var starBtn = el("button", { text: m.flagged ? "Unstar" : "Star" });
      starBtn.addEventListener("click", function () {
        var next = !m.flagged;
        starBtn.disabled = true;
        apiOrganize("/api/messages/flags", { ids: [m.messageId], set: { flagged: next } }).then(function () {
          m.flagged = next;
          state.items.forEach(function (it) { if (it.messageId === m.messageId) it.flagged = next; });
          renderReading(m);
          refreshFolders();
          clear($("list"));
          state.items.forEach(appendRow);
          var sel = $("list").querySelector('.row-item[data-id="' + m.messageId + '"]');
          if (sel) sel.classList.add("sel");
        }).catch(function (e) {
          if (e.code === 401) { logout(); return; }
          alert("Flag update failed: " + e.message);
          starBtn.disabled = false;
        });
      });
      actions.push(starBtn);

      function moveTo(mailbox, label) {
        var btn = el("button", { text: label });
        btn.addEventListener("click", function () {
          btn.disabled = true;
          apiOrganize("/api/messages/move", { ids: [m.messageId], mailbox: mailbox }).then(function () {
            state.selected = null;
            resetAndLoad();
            renderReading(null);
          }).catch(function (e) {
            if (e.code === 401) { logout(); return; }
            alert("Move failed: " + e.message);
            btn.disabled = false;
          });
        });
        return btn;
      }
      if (m.mailbox === "trash" || m.mailbox === "junk" || m.mailbox === "archive") {
        actions.push(moveTo(null, "Restore"));
      } else {
        actions.push(moveTo("archive", "Archive"));
        actions.push(moveTo("trash", "Trash"));
        actions.push(moveTo("junk", "Junk"));
      }
    }
    if (state.sendCapable === true && !m.isDraft) {
      function composeFromMessage(label, composeMode) {
        var button = el("button", { text: label });
        button.addEventListener("click", function () {
          var isForward = composeMode === "forward";
          var prefix = isForward ? "Fwd: " : "Re: ";
          var subject = (m.subject || "").match(isForward ? /^(Fwd?|Fw):/i : /^Re:/i)
            ? (m.subject || "") : (prefix + (m.subject || ""));
          renderComposeForm({
            composeMode: composeMode,
            sourceMessageId: m.messageId,
            threadId: isForward ? null : m.threadId,
            original: m,
            to: isForward ? "" : (m.replyTo || m.from || ""),
            cc: composeMode === "replyAll" ? [m.to || "", m.cc || ""].filter(Boolean).join(", ") : "",
            subject: subject
          });
        });
        return button;
      }
      actions.push(composeFromMessage("Reply", "reply"));
      actions.push(composeFromMessage("Reply all", "replyAll"));
      actions.push(composeFromMessage("Forward", "forward"));
    }
    if (actions.length) {
      head.appendChild(el("div", { class: "msg-actions compose-actions" }, actions));
    }
    r.appendChild(head);

    // Body: rendered inside a sandboxed iframe (sandbox="" = no scripts, no
    // same-origin), so stored content cannot execute or reach the token/API.
    r.appendChild(renderBody(m));

    if (m.attachments && m.attachments.length) {
      var ul = el("ul");
      m.attachments.forEach(function (a, i) {
        var name = a.filename || "(unnamed)";
        var btn = el("button", { class: "dl", text: "Download" });
        btn.addEventListener("click", function () { downloadAttachment(m.messageId, i, name, btn); });
        ul.appendChild(el("li", {}, [
          document.createTextNode(name + " (" + (a.mime || "?") + ", " + (a.size || 0) + " bytes) "),
          btn
        ]));
      });
      r.appendChild(el("div", { class: "attachments" }, [
        el("h3", { text: "Attachments" }), ul
      ]));
    }

    // Thread: show siblings if this message is part of a multi-message thread.
    if (m.threadId) {
      var box = el("div", { class: "thread" }, [el("h3", { text: "Loading thread..." })]);
      r.appendChild(box);
      api("/api/threads/" + encodeURIComponent(m.threadId)).then(function (body) {
        clear(box);
        var msgs = body.messages || [];
        if (msgs.length <= 1) { return; }
        box.appendChild(el("h3", { text: "Thread (" + msgs.length + ")" }));
        msgs.forEach(function (tm) {
          var t = el("div", { class: "t-item" }, [
            el("div", { text: (tm.from || "") + "  -  " + fmtDate(tm.date) }),
            el("div", { class: "subject", text: tm.subject || "(no subject)" })
          ]);
          t.addEventListener("click", function () { selectMessage(tm.messageId, null); });
          box.appendChild(t);
        });
      }).catch(function () { clear(box); });
    }
  }

  // --- wire up ---------------------------------------------------------------
  $("connect").addEventListener("click", connect);
  $("token").addEventListener("keydown", function (e) { if (e.key === "Enter") connect(); });
  $("origin").addEventListener("keydown", function (e) { if (e.key === "Enter") $("token").focus(); });
  $("logout").addEventListener("click", logout);
  $("composeBtn").addEventListener("click", function () { renderComposeForm({}); });
  $("signinForm").addEventListener("submit", function (e) { e.preventDefault(); signIn(); });
  $("toTokenGate").addEventListener("click", function () { showGate(""); });
  $("toSignin").addEventListener("click", function () { showSignin(""); });
  $("search").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { state.q = e.target.value.trim(); resetAndLoad(); }
  });
  $("searchMode").addEventListener("change", function (e) {
    state.searchMode = normalizeSearchMode(e.target.value);
    SS.setItem("postern_search_mode", state.searchMode);
    if (state.q) resetAndLoad();
  });
  // --- boot: prefer a live native session, else BYO-token, else the right gate -----
  // GET /api/session (same-origin, cookie) tells us: a live session (restore it), or
  // the configured backend so we show the sign-in form (native) or token gate (off).
  function boot() {
    fetch("/api/session", {
      headers: { "accept": "application/json" },
      credentials: "include", referrerPolicy: "no-referrer"
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    }).then(function (res) {
      if (res.status === 200 && res.body && res.body.ok) { onSession(res.body); return; }
      state.authBackend = (res.body && res.body.authBackend) || "off";
      afterNoSession();
    }).catch(function () {
      state.authBackend = "off";
      afterNoSession();
    });
  }
  // No live session: honor an existing BYO-token in this tab, else show sign-in
  // (native backend) or the token gate (sessions off / unreachable).
  function afterNoSession() {
    if (state.origin && state.token) { state.authMode = "token"; showApp(); resetAndLoad(); return; }
    if (state.authBackend === "native") { showSignin(""); return; }
    showGate("");
  }
  boot();
})();
</script>
</body>
</html>
`;

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  // Lock the page down: it loads no third-party anything and only talks to the
  // same origin (its own API). connect-src 'self' means a hijacked page cannot
  // exfiltrate the pasted token to another host.
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    // frame-src 'self' permits the sandboxed srcdoc iframe the reading pane uses
    // to render message bodies in an isolated context (sandbox="" = no scripts,
    // no same-origin), so stored body content can never execute or reach the API.
    "connect-src 'self'; img-src 'self' data:; frame-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Serve the webmail page. Public (no token gate): the page itself carries no
// secret; the token is entered client-side and only used for API calls.
export function serveWebmail(): Response {
  return new Response(WEBMAIL_HTML, { status: 200, headers: SECURITY_HEADERS });
}

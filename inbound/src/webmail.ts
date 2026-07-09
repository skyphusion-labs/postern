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
  .toolbar { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line); }
  .toolbar input { flex: 1; }
  .toolbar select { width: auto; }
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
  /* #60: remote-content blocked-by-default banner (tracking-pixel privacy) */
  .remote-banner {
    margin-top: 18px; padding: 8px 12px; display: flex; align-items: center; gap: 10px;
    flex-wrap: wrap; background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 6px; font-size: 13px; color: var(--muted);
  }
  .remote-banner + .msg-body-frame { margin-top: 0; }
  .remote-banner .load-remote {
    font-size: 12px; padding: 3px 10px; cursor: pointer; background: transparent;
    color: var(--accent); border: 1px solid var(--accent); border-radius: 6px;
  }
  .remote-banner .load-remote:hover { background: var(--accent); color: #0b0d10; }
  .attachments { margin-top: 18px; }
  .attachments h3 { font-size: 13px; color: var(--muted); margin: 0 0 6px; }
  .attachments li { font-size: 13px; margin-bottom: 4px; }
  .attachments .dl { font-size: 12px; padding: 2px 8px; margin-left: 6px; }
  .thread { margin-top: 24px; }
  .thread h3 { font-size: 13px; color: var(--muted); }
  .thread .t-item { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 6px; cursor: pointer; }
  .thread .t-item:hover { border-color: var(--accent); }
  .loading { color: var(--muted); padding: 12px; }
  a { color: var(--accent); }
</style>
</head>
<body>

<header>
  <h1>Postern webmail</h1>
  <span class="grow"></span>
  <span class="who" id="who"></span>
  <button id="logout" class="link" style="display:none">Sign out</button>
</header>

<!-- Token gate -->
<div id="gate">
  <div class="card">
    <h2>Connect to your mailbox</h2>
    <p>This is a read-only view of one Postern mailbox. Your API token is kept in
       this browser tab only (sessionStorage), never sent anywhere but the API you
       name below, and cleared when you sign out or close the tab.</p>
    <label for="origin">API origin</label>
    <input id="origin" type="url" placeholder="https://postern.example" autocomplete="off" spellcheck="false">
    <label for="token">Postern API token</label>
    <input id="token" type="password" placeholder="paste your token" autocomplete="off" spellcheck="false">
    <div class="row">
      <button id="connect">Connect</button>
    </div>
    <div class="err" id="gateErr"></div>
  </div>
</div>

<!-- App -->
<div id="app">
  <div class="sidebar">
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search (press Enter)">
      <select id="folder" title="Folder">
        <option value="">All</option>
        <option value="inbound">Inbox</option>
        <option value="outbound">Sent</option>
      </select>
    </div>
    <div class="list" id="list"></div>
  </div>
  <div class="reading" id="reading">
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
  var state = {
    origin: SS.getItem("postern_origin") || "",
    token: SS.getItem("postern_token") || "",
    folder: "", q: "", cursor: null, items: [], selected: null
  };

  // --- API client (Bearer token; token never logged, never in a URL) ---------
  function api(path, params) {
    var url = state.origin.replace(/\\/+$/, "") + path;
    if (params) {
      var qs = Object.keys(params)
        .filter(function (k) { return params[k] != null && params[k] !== ""; })
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
        .join("&");
      if (qs) url += "?" + qs;
    }
    return fetch(url, {
      headers: { "authorization": "Bearer " + state.token, "accept": "application/json" },
      // The token rides in the header, not as a cookie; do not attach ambient creds.
      credentials: "omit", referrerPolicy: "no-referrer"
    }).then(function (r) {
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

  // --- attachment download (Bearer fetch -> Blob -> object URL) --------------
  // The API is token-gated and the token rides in the Authorization header, so a
  // plain <a href> cannot carry it (and we never put the token in a URL). Fetch
  // the bytes with the header, then trigger a download from an object URL.
  function downloadAttachment(messageId, index, filename, btn) {
    var url = state.origin.replace(/\\/+$/, "") +
      "/api/messages/" + encodeURIComponent(messageId) + "/attachments/" + index;
    var label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Downloading..."; }
    fetch(url, {
      headers: { "authorization": "Bearer " + state.token },
      credentials: "omit", referrerPolicy: "no-referrer"
    }).then(function (r) {
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
  // --- remote-content blocking (#60): privacy by default -----------------------
  // HTML bodies can reference remote subresources (img src, srcset, CSS url(),
  // <link rel=stylesheet>, legacy background=""). Even in the sandbox="" iframe
  // (which blocks scripts) those still FETCH on open: that is the tracking-pixel
  // leak (the sender learns the open, the reader's IP, time, and client). So by
  // default we neutralize remote-loading references and offer a per-message
  // opt-in ("Load remote images"), exactly like Gmail / Apple Mail / Thunderbird.
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
    function mount(loadRemote) {
      clear(wrap);
      if (!hasHtml) { wrap.appendChild(frameFor(linkify(escapeHtml((m && m.bodyText) || "")), false)); return; }
      var inner, blocked = 0;
      if (loadRemote) {
        inner = String(m.bodyHtml);               // per-message opt-in: load everything
      } else {
        var res = neutralizeRemoteHtml(m.bodyHtml);
        inner = res.html; blocked = res.blocked;
      }
      if (blocked > 0 && !loadRemote) {
        var btn = el("button", { class: "load-remote", text: "Load remote images" });
        btn.addEventListener("click", function () { mount(true); });
        wrap.appendChild(el("div", { class: "remote-banner" }, [
          el("span", { text: "Remote content blocked to protect your privacy (" + blocked + " item" + (blocked === 1 ? "" : "s") + "). " }),
          btn
        ]));
      }
      wrap.appendChild(frameFor(inner, true));
    }
    mount(false);
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

  // --- gate ------------------------------------------------------------------
  function showGate(msg) {
    $("app").className = "";
    $("gate").style.display = "";
    $("logout").style.display = "none";
    $("who").textContent = "";
    $("origin").value = state.origin;
    $("gateErr").textContent = msg || "";
  }
  function showApp() {
    $("gate").style.display = "none";
    $("app").className = "on";
    $("logout").style.display = "";
    $("who").textContent = state.origin;
  }

  function connect() {
    var origin = $("origin").value.trim();
    var token = $("token").value;
    $("gateErr").textContent = "";
    if (!/^https?:\\/\\//.test(origin)) { $("gateErr").textContent = "Enter the API origin (https://...)."; return; }
    if (!token) { $("gateErr").textContent = "Enter your Postern API token."; return; }
    state.origin = origin; state.token = token;
    // Validate by hitting an authed endpoint before persisting the token.
    api("/api/messages", { limit: 1 }).then(function () {
      SS.setItem("postern_origin", origin);
      SS.setItem("postern_token", token);
      $("token").value = "";
      showApp();
      resetAndLoad();
    }).catch(function (e) {
      state.token = "";
      $("gateErr").textContent = e.code === 401 ? "Token rejected by the API." : ("Could not connect: " + e.message);
    });
  }

  function logout() {
    SS.removeItem("postern_token");
    SS.removeItem("postern_origin");
    state.token = ""; state.items = []; state.selected = null; state.cursor = null;
    clear($("list")); renderReading(null);
    showGate("Signed out. Your token was cleared from this browser.");
  }

  // --- list ------------------------------------------------------------------
  function resetAndLoad() {
    state.cursor = null; state.items = [];
    clear($("list"));
    loadMore();
  }

  function loadMore() {
    var loading = el("div", { class: "loading", text: "Loading..." });
    $("list").appendChild(loading);
    var req = state.q
      ? api("/api/search", { q: state.q, limit: 50, cursor: state.cursor })
      : api("/api/messages", { direction: state.folder, limit: 50, cursor: state.cursor });
    req.then(function (body) {
      $("list").removeChild(loading);
      // search returns SearchHit { message, ... }; list returns summaries.
      var rows = (body.items || []).map(function (it) { return it.message ? it.message : it; });
      state.items = state.items.concat(rows);
      state.cursor = body.cursor || null;
      rows.forEach(appendRow);
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
      $("list").appendChild(el("div", { class: "err", text: "Error: " + e.message }));
    });
  }

  function appendRow(m) {
    var tags = [];
    if (m.direction === "outbound") tags.push(el("span", { class: "tag out", text: "Sent" }));
    tags.push(el("span", { class: "tag " + (m.trusted ? "trusted" : "untrusted"), text: m.trusted ? "trusted" : "untrusted" }));
    var who = m.direction === "outbound" ? ("To: " + (m.to || "")) : (m.from || "");
    var item = el("div", { class: "row-item", "data-id": m.messageId }, [
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
    $("list").appendChild(item);
  }

  // --- reading ---------------------------------------------------------------
  function selectMessage(id, item) {
    var prev = $("list").querySelector(".row-item.sel");
    if (prev) prev.classList.remove("sel");
    if (item) item.classList.add("sel");
    renderLoadingReading();
    api("/api/messages/" + encodeURIComponent(id)).then(function (body) {
      renderReading(body.message);
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
      kv("Date", m.date ? new Date(m.date).toLocaleString() : ""),
      el("div", { class: "kv" }, [
        el("b", { text: "Trust: " }),
        el("span", { class: "tag " + (m.trusted ? "trusted" : "untrusted"), text: m.trusted ? "trusted" : "untrusted" }),
        document.createTextNode(
          m.auth ? ("  spf=" + (m.auth.spf || "none") + " dkim=" + (m.auth.dkim || "none") + " dmarc=" + (m.auth.dmarc || "none")) : ""
        )
      ])
    ]);
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
  $("search").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { state.q = e.target.value.trim(); resetAndLoad(); }
  });
  $("folder").addEventListener("change", function (e) {
    state.folder = e.target.value; state.q = ""; $("search").value = ""; resetAndLoad();
  });

  // Auto-connect if a token is already in this tab's sessionStorage.
  if (state.origin && state.token) {
    showApp();
    resetAndLoad();
  } else {
    showGate("");
  }
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

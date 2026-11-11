// Self-contained Postern webmail (the human browser door, complementing
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
  /* Design tokens (#794). Every color, size and space in this page reads from here.
     Light is the base palette; dark applies when the OS asks for it (theme "system",
     the default) or when the user picks Dark. The two dark blocks below MUST stay
     identical: webmail-tokens.test.ts asserts it and checks WCAG AA on both palettes. */
  :root {
    color-scheme: light;
    --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --fs-2xs: 11px; --fs-xs: 12px; --fs-sm: 13px; --fs-md: 15px; --fs-lg: 17px; --fs-xl: 20px; --fs-2xl: 24px;
    --lh-tight: 1.3; --lh: 1.5;
    --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;
    --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --r-pill: 999px;
    --dur: 120ms;
    /* tokens:light */
    --bg: #f6f7f9; --panel: #ffffff; --panel-2: #f0f2f5; --line: #dde1e8; --line-strong: #7c8596;
    --fg: #171a21; --muted: #545d6b; --accent: #2456d3; --accent-fg: #ffffff; --accent-dim: #e5ecfb;
    --bad: #b42318; --bad-dim: #fdecea; --ok: #067647; --ok-dim: #e7f5ee; --star: #9a6700;
    --focus: #2456d3; --shadow: 0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.10);
    --frame-bg: #ffffff; --frame-fg: #171a21; --frame-link: #2456d3;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      /* tokens:dark */
      --bg: #111318; --panel: #181b22; --panel-2: #20242d; --line: #2b303b; --line-strong: #6b7486;
    --fg: #e8eaef; --muted: #9aa3b2; --accent: #7fa8ff; --accent-fg: #0b1020; --accent-dim: #1f2a44;
    --bad: #f28b82; --bad-dim: #3a1f22; --ok: #7fd1a0; --ok-dim: #173326; --star: #e5c07b;
    --focus: #7fa8ff; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.45);
    --frame-bg: #181b22; --frame-fg: #e8eaef; --frame-link: #7fa8ff;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    /* tokens:dark */
    --bg: #111318; --panel: #181b22; --panel-2: #20242d; --line: #2b303b; --line-strong: #6b7486;
    --fg: #e8eaef; --muted: #9aa3b2; --accent: #7fa8ff; --accent-fg: #0b1020; --accent-dim: #1f2a44;
    --bad: #f28b82; --bad-dim: #3a1f22; --ok: #7fd1a0; --ok-dim: #173326; --star: #e5c07b;
    --focus: #7fa8ff; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.45);
    --frame-bg: #181b22; --frame-fg: #e8eaef; --frame-link: #7fa8ff;
  }
  @media (prefers-reduced-motion: reduce) { :root { --dur: 0ms; } }
  html[data-density="compact"] .row-item { padding: var(--sp-1) var(--sp-3); }
  html[data-density="compact"] body { font-size: var(--fs-sm); }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: var(--fs-md)/var(--lh) var(--font-sans);
    display: flex; flex-direction: column;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  h1, h2, h3 { line-height: var(--lh-tight); }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* --- Header (#795) --- */
  header {
    display: flex; align-items: center; gap: var(--sp-3); min-height: 56px;
    padding: var(--sp-2) var(--sp-4); background: var(--panel); border-bottom: 1px solid var(--line);
    flex-shrink: 0;
  }
  header h1 {
    display: flex; align-items: center; gap: var(--sp-2); margin: 0;
    font-size: var(--fs-lg); font-weight: 650; letter-spacing: -.01em; white-space: nowrap;
  }
  header h1 .mark { width: 26px; height: 26px; color: var(--accent); flex-shrink: 0; }
  header h1 .sub { color: var(--muted); font-weight: 500; }
  header .grow { flex: 1; min-width: 0; }
  header .who, header .identity {
    font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  header .who { color: var(--muted); }
  header .identity { color: var(--fg); font-weight: 600; }
  .sendnote { color: var(--muted); font-size: var(--fs-xs); }
  #railBtn { display: none; }

  /* --- Buttons (#795): secondary is the default; primary, quiet, danger, link --- */
  button {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
    min-height: 36px; padding: 0 var(--sp-3);
    background: var(--panel); color: var(--fg); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm); cursor: pointer; font: inherit; font-size: var(--fs-sm); font-weight: 550;
    transition: background var(--dur), border-color var(--dur), color var(--dur);
  }
  button:hover { background: var(--panel-2); }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button.btn-primary, button[type="submit"], #connect, #cmpSend, #composeBtn {
    background: var(--accent); border-color: var(--accent); color: var(--accent-fg);
  }
  button.btn-primary:hover, button[type="submit"]:hover, #connect:hover, #cmpSend:hover, #composeBtn:hover {
    background: var(--accent); filter: brightness(1.08);
  }
  button.btn-danger { color: var(--bad); }
  button.btn-danger:hover { background: var(--bad-dim); border-color: var(--bad); }
  button.btn-quiet { background: none; border-color: transparent; }
  button.btn-quiet:hover { background: var(--panel-2); }
  button.link {
    background: none; border: none; color: var(--accent); padding: 0 var(--sp-1);
    min-height: 0; font-weight: 500;
  }
  button.link:hover { text-decoration: underline; background: none; }
  header button.link { min-height: 36px; padding: 0 var(--sp-2); }
  header button.link:hover { background: var(--panel-2); text-decoration: none; border-radius: var(--r-sm); }

  input, select, textarea {
    background: var(--panel); color: var(--fg); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); font: inherit; font-size: var(--fs-md);
    min-height: 38px;
  }
  input::placeholder { color: var(--muted); opacity: 1; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--focus); box-shadow: 0 0 0 3px var(--accent-dim); }
  input:disabled { background: var(--panel-2); color: var(--muted); }

  /* --- Auth screens (#798): sign-in, token gate and first run share one card --- */
  .auth { margin: auto; width: 100%; max-width: 440px; padding: var(--sp-6) var(--sp-4); }
  .auth .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg);
    padding: var(--sp-6) var(--sp-5); box-shadow: var(--shadow);
  }
  .auth .eyebrow {
    margin: 0 0 var(--sp-2); color: var(--accent); font-size: var(--fs-xs); font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase;
  }
  .auth h2 { margin: 0 0 var(--sp-1); font-size: var(--fs-2xl); font-weight: 650; letter-spacing: -.01em; }
  .auth .lede { color: var(--muted); margin: var(--sp-2) 0 var(--sp-4); font-size: var(--fs-sm); }
  .auth label {
    display: block; font-size: var(--fs-sm); font-weight: 550; color: var(--fg); margin: var(--sp-4) 0 var(--sp-1);
  }
  .auth label .opt { color: var(--muted); font-weight: 400; }
  .auth input { width: 100%; }
  .auth .hint { color: var(--muted); font-size: var(--fs-xs); margin: var(--sp-1) 0 0; }
  .auth .row { display: flex; gap: var(--sp-2); margin-top: var(--sp-5); }
  .auth .row button { flex: 1; min-height: 44px; font-size: var(--fs-md); }
  .auth .note-ok { color: var(--ok); font-size: var(--fs-sm); margin: var(--sp-3) 0 0; }
  .auth .note-ok:empty { display: none; }
  .auth .err:empty { display: none; }
  .auth .err { margin-top: var(--sp-3); }
  .auth .switch { margin-top: var(--sp-5); padding-top: var(--sp-4); border-top: 1px solid var(--line); text-align: center; }
  .pw-wrap { position: relative; }
  .pw-wrap input { padding-right: 76px; }
  .pw-wrap .pw-toggle {
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    min-height: 30px; padding: 0 var(--sp-2); font-size: var(--fs-xs);
  }
  .auth code { font: var(--fs-xs) var(--font-mono); background: var(--panel-2); padding: 1px 4px; border-radius: 4px; color: var(--fg); }
  .auth details.help { margin-top: var(--sp-4); font-size: var(--fs-sm); color: var(--muted); }
  .auth details.help summary { cursor: pointer; color: var(--accent); }
  .auth details.help p { margin: var(--sp-2) 0 0; }
  .err { color: var(--bad); font-size: var(--fs-sm); min-height: 1.2em; margin-top: var(--sp-2); }
  .switch { margin: var(--sp-3) 0 0; font-size: var(--fs-sm); }
  @media (max-width: 760px) { .auth { padding: var(--sp-4) var(--sp-3); } .auth .card { padding: var(--sp-5) var(--sp-4); } }
  .switch button { font: inherit; }

  /* --- App shell (#795): rail | list | reading. Below 1100px the rail is a drawer;
     below 760px list and reading are stacked views switched by data-view. --- */
  #app { flex: 1; display: none; min-height: 0; position: relative; }
  #app.on { display: flex; }
  .folders {
    width: 208px; flex-shrink: 0; background: var(--panel); border-right: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3) var(--sp-2); overflow-y: auto;
  }
  .folders button {
    display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2);
    width: 100%; min-height: 36px; text-align: left; background: none; border: none;
    border-radius: var(--r-sm); padding: 0 var(--sp-3); color: var(--fg);
    font-size: var(--fs-md); font-weight: 500;
  }
  .folders button:hover { background: var(--panel-2); }
  .folders button.active { background: var(--accent-dim); color: var(--accent); font-weight: 650; }
  .folders .fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folders .fcount { color: var(--muted); font-size: var(--fs-xs); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .folders .fcount.unread { color: var(--accent); font-weight: 700; }
  .folders .fgroup {
    color: var(--muted); font-size: var(--fs-2xs); font-weight: 650; text-transform: uppercase;
    letter-spacing: .06em; padding: var(--sp-4) var(--sp-3) var(--sp-1);
  }
  .scrim { display: none; }

  .sidebar {
    width: 380px; flex-shrink: 0; border-right: 1px solid var(--line); background: var(--bg);
    display: flex; flex-direction: column; min-height: 0;
  }
  .toolbar { display: flex; gap: var(--sp-2); padding: var(--sp-3); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .toolbar input { flex: 1; min-width: 120px; }
  .toolbar select { width: auto; }
  .toolbar .mode { min-width: 6.5rem; }
  .filters {
    display: flex; flex-wrap: wrap; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--line); align-items: center;
  }
  .filters label { font-size: var(--fs-xs); color: var(--muted); display: flex; gap: var(--sp-1); align-items: center; }
  .filters input { min-height: 30px; padding: var(--sp-1) var(--sp-2); font-size: var(--fs-xs); }
  .filters .chip {
    min-height: 28px; font-size: var(--fs-xs); padding: 0 var(--sp-3); border-radius: var(--r-pill);
    border: 1px solid var(--line-strong); background: var(--panel); color: var(--fg);
  }
  .filters .chip.on { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
  .list { overflow-y: auto; flex: 1; }
  .row-item {
    padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--line); cursor: pointer;
    background: var(--bg); transition: background var(--dur);
  }
  .row-item:hover { background: var(--panel-2); }
  .row-item.sel { background: var(--accent-dim); box-shadow: inset 3px 0 0 var(--accent); }
  .row-item .top { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-2); }
  .row-item .from { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-item .date { color: var(--muted); font-size: var(--fs-xs); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .row-item .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); margin-top: 2px; }
  .row-item .meta { color: var(--muted); font-size: var(--fs-xs); margin-top: var(--sp-1); display: flex; gap: var(--sp-1); align-items: center; flex-wrap: wrap; }
  .row-item.unread .from, .row-item.unread .subject { font-weight: 700; }
  .row-item .star { color: var(--muted); }
  .row-item .star.on { color: var(--star); }
  .tag {
    display: inline-block; font-size: var(--fs-2xs); font-weight: 600; line-height: 18px; padding: 0 var(--sp-2);
    border-radius: var(--r-pill); border: 1px solid var(--line);
  }
  .tag.trusted { color: var(--ok); background: var(--ok-dim); border-color: transparent; }
  .tag.untrusted { color: var(--bad); background: var(--bad-dim); border-color: transparent; }
  .tag.out { color: var(--accent); background: var(--accent-dim); border-color: transparent; }
  .more { padding: var(--sp-3); text-align: center; }
  .loading { color: var(--muted); padding: var(--sp-4); font-size: var(--fs-sm); }
  .list > .err { padding: 0 var(--sp-4) var(--sp-4); }

  .reading-col { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
  .reading-bar { display: none; }
  .reading { flex: 1; overflow-y: auto; padding: var(--sp-5) var(--sp-6); min-width: 0; }
  .reading > * { max-width: 920px; }
  .reading .empty { color: var(--muted); margin: var(--sp-7) auto 0; text-align: center; }
  .reading > .err { padding: var(--sp-2) 0; }
  .msg-head h2 { margin: 0 0 var(--sp-3); font-size: var(--fs-2xl); font-weight: 650; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .msg-head .kv { color: var(--muted); font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .msg-head .kv b { color: var(--fg); font-weight: 600; }
  .msg-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-4); }
  .msg-body-frame {
    display: block; margin-top: var(--sp-4); border: 1px solid var(--line); border-radius: var(--r-md);
    width: 100%; min-height: 360px; background: var(--frame-bg);
  }
  /* #60/#343: remote content is always blocked (tracking-pixel privacy); this
     banner is a non-actionable notice, not an opt-in (see renderBody). */
  .remote-banner {
    margin-top: var(--sp-4); padding: var(--sp-2) var(--sp-3); display: flex; align-items: center; gap: var(--sp-2);
    flex-wrap: wrap; background: var(--panel-2); border: 1px solid var(--line);
    border-radius: var(--r-md) var(--r-md) 0 0; font-size: var(--fs-sm); color: var(--muted);
  }
  .remote-banner + .msg-body-frame { margin-top: 0; border-top: none; border-radius: 0 0 var(--r-md) var(--r-md); }
  .attachments { margin-top: var(--sp-4); }
  .attachments h3, .thread h3 {
    font-size: var(--fs-xs); font-weight: 650; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 0 0 var(--sp-2);
  }
  .attachments ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .attachments li {
    font-size: var(--fs-sm); display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3); border: 1px solid var(--line); border-radius: var(--r-md); overflow-wrap: anywhere;
  }
  .attachments .dl { min-height: 30px; flex-shrink: 0; }
  .att-name { unicode-bidi: isolate; }
  .thread { margin-top: var(--sp-5); }
  .thread .t-item {
    padding: var(--sp-3); border: 1px solid var(--line); border-radius: var(--r-md);
    margin-bottom: var(--sp-2); cursor: pointer; font-size: var(--fs-sm);
  }
  .thread .t-item:hover { border-color: var(--accent); background: var(--panel-2); }
  .queue-note { color: var(--muted); font-size: var(--fs-xs); margin-top: var(--sp-2); }

  /* --- Compose --- */
  .compose h2 { margin: 0 0 var(--sp-1); font-size: var(--fs-xl); }
  .compose label { display: block; font-size: var(--fs-sm); font-weight: 550; color: var(--fg); margin: var(--sp-3) 0 var(--sp-1); }
  .compose input, .compose textarea { width: 100%; }
  .compose input[type="file"] { padding: var(--sp-2); font-size: var(--fs-sm); }
  .compose textarea { min-height: 180px; resize: vertical; }
  .compose-editor {
    width: 100%; min-height: 240px; padding: var(--sp-3); overflow-y: auto;
    background: var(--panel); color: var(--fg); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm);
  }
  .compose-editor:focus { outline: none; border-color: var(--focus); box-shadow: 0 0 0 3px var(--accent-dim); }
  .compose-editor.plain { white-space: pre-wrap; font-family: inherit; }
  .formatbar { display: flex; gap: var(--sp-1); margin: var(--sp-2) 0; flex-wrap: wrap; }
  .formatbar button { min-width: 36px; min-height: 30px; padding: 0 var(--sp-2); }
  .compose-status { color: var(--muted); font-size: var(--fs-xs); margin-left: auto; align-self: center; }
  .draft-files { list-style: none; padding: 0; margin: var(--sp-2) 0; }
  .draft-files li { display: flex; gap: var(--sp-2); align-items: center; margin: var(--sp-1) 0; font-size: var(--fs-sm); }
  .draft-files .progress { color: var(--muted); font-size: var(--fs-xs); }
  .quote-preview {
    margin-top: var(--sp-3); padding: var(--sp-3); border-left: 3px solid var(--line-strong);
    color: var(--muted); white-space: pre-wrap; max-height: 180px; overflow: auto; font-size: var(--fs-sm);
  }
  .compose-actions { margin-top: var(--sp-4); display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
  .compose-note { color: var(--muted); font-size: var(--fs-sm); margin: 0 0 var(--sp-3); }

  /* --- Settings popover + autocomplete --- */
  .settings-panel {
    position: fixed; top: 60px; right: var(--sp-3); width: min(320px, calc(100vw - 24px)); z-index: 30;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg);
    padding: var(--sp-4); box-shadow: var(--shadow); display: none;
  }
  .settings-panel.on { display: block; }
  .settings-panel h2 { margin: 0 0 var(--sp-2); font-size: var(--fs-md); }
  .settings-panel label { display: block; font-size: var(--fs-sm); color: var(--muted); margin: var(--sp-3) 0 var(--sp-1); }
  .settings-panel select { width: 100%; }
  .settings-panel .note { color: var(--muted); font-size: var(--fs-xs); margin-top: var(--sp-3); }
  .settings-signout { display: none; width: 100%; margin-top: var(--sp-3); }
  .settings-panel { max-height: calc(100vh - 76px); overflow-y: auto; }
  .settings-panel h3 { margin: var(--sp-4) 0 0; padding-top: var(--sp-3); border-top: 1px solid var(--line); font-size: var(--fs-sm); }
  .settings-panel input { width: 100%; }
  .settings-panel .hint { color: var(--muted); font-size: var(--fs-xs); margin: var(--sp-1) 0 0; }
  .settings-panel form button[type="submit"] { width: 100%; margin-top: var(--sp-3); }
  .settings-panel .note-ok { color: var(--ok); font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
  .settings-panel .note-ok:empty, .settings-panel .err:empty { display: none; }
  .ac-wrap { position: relative; }
  .ac-list {
    position: absolute; left: 0; right: 0; top: 100%; z-index: 5;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-sm);
    box-shadow: var(--shadow); max-height: 160px; overflow-y: auto; display: none;
  }
  .ac-list.on { display: block; }
  .ac-list button {
    display: block; width: 100%; text-align: left; background: none; border: none;
    border-radius: 0; padding: var(--sp-2) var(--sp-3); color: var(--fg); min-height: 0;
  }
  .ac-list button:hover { background: var(--accent-dim); }

  /* --- Components (#796) --- */
  .avatar {
    width: 36px; height: 36px; border-radius: var(--r-pill); flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--accent-dim); color: var(--accent); font-weight: 700; font-size: var(--fs-md);
  }
  .row-item { display: flex; gap: var(--sp-3); align-items: flex-start; }
  .row-item .avatar { width: 32px; height: 32px; font-size: var(--fs-sm); margin-top: 2px; }
  .row-main { flex: 1; min-width: 0; }
  .row-item .dot { width: 8px; height: 8px; border-radius: var(--r-pill); background: var(--accent); flex-shrink: 0; display: none; align-self: center; }
  .row-item.unread .dot { display: inline-block; }
  .row-item .top .from { flex: 1; min-width: 0; }
  .row-item .top { justify-content: flex-start; }
  .row-item:not(.unread) .from { font-weight: 500; }
  .row-item .meta:empty { display: none; }
  .row-item .att { display: inline-flex; align-items: center; gap: 2px; }
  .ico { width: 14px; height: 14px; flex-shrink: 0; }
  .toolbar #filtersBtn { min-height: 38px; }
  .badge {
    display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px;
    padding: 0 5px; border-radius: var(--r-pill); background: var(--accent); color: var(--accent-fg);
    font-size: var(--fs-2xs); font-weight: 700;
  }
  .badge:empty { display: none; }
  .filters[hidden] { display: none; }
  .filters .fhint { width: 100%; color: var(--muted); font-size: var(--fs-xs); }

  .msg-head .sender { display: flex; gap: var(--sp-3); align-items: flex-start; margin-top: var(--sp-2); }
  .msg-head .sender-main { flex: 1; min-width: 0; }
  .msg-head .sender-line { overflow-wrap: anywhere; }
  .msg-head .sender-name { font-weight: 650; }
  .msg-head .sender-addr { color: var(--muted); font-size: var(--fs-sm); margin-left: var(--sp-1); }
  .msg-head .sender-date { color: var(--muted); font-size: var(--fs-sm); white-space: nowrap; flex-shrink: 0; }
  .msg-head .trust { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; margin-top: var(--sp-3); font-size: var(--fs-sm); }
  .msg-head details.auth-detail { color: var(--muted); }
  .msg-head details.auth-detail summary { cursor: pointer; color: var(--accent); }
  .msg-head details.auth-detail span { margin-left: var(--sp-2); }

  .empty-state { text-align: center; padding: var(--sp-7) var(--sp-4); color: var(--muted); }
  .empty-state .es-ico { width: 40px; height: 40px; color: var(--line-strong); }
  .empty-state .es-title { margin: var(--sp-3) 0 var(--sp-1); color: var(--fg); font-weight: 600; font-size: var(--fs-md); }
  .empty-state .es-hint { margin: 0; font-size: var(--fs-sm); }
  .reading > .empty-state { max-width: none; margin-top: 10vh; }

  .skel { display: block; border-radius: var(--r-sm); background: var(--panel-2); position: relative; overflow: hidden; }
  .skel::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, var(--line), transparent);
    animation: skel 1.2s ease-in-out infinite;
  }
  @keyframes skel { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  @media (prefers-reduced-motion: reduce) { .skel::after { animation: none; } }
  .skel-row { display: flex; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--line); }
  .skel-row .skel-av { width: 32px; height: 32px; border-radius: var(--r-pill); flex-shrink: 0; }
  .skel-row .skel-lines { flex: 1; display: flex; flex-direction: column; gap: var(--sp-2); padding-top: 2px; }
  .skel-line { height: 10px; }
  .loading.skel-list, .loading.skel-read { padding: 0; }
  .skel-read { display: flex; flex-direction: column; gap: var(--sp-3); }
  .skel-read .skel-title { height: 22px; width: 60%; }
  .skel-read .skel-body { height: 280px; margin-top: var(--sp-3); }

  .compose-head { display: flex; align-items: baseline; gap: var(--sp-3); }
  .compose-head .compose-status { margin-left: auto; }
  .compose .field-row { display: flex; align-items: flex-end; gap: var(--sp-2); }
  .compose .field-row > .grow { flex: 1; min-width: 0; }
  .compose .cc-toggle { min-height: 38px; white-space: nowrap; }
  .file-pick { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin-top: var(--sp-3); }
  .compose .file-pick label.file-btn {
    display: inline-flex; align-items: center; gap: var(--sp-2); margin: 0; min-height: 36px; padding: 0 var(--sp-3);
    border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--panel);
    cursor: pointer; font-weight: 550; font-size: var(--fs-sm);
  }
  .compose .file-pick label.file-btn:hover { background: var(--panel-2); }
  .file-pick input:focus-visible + label.file-btn { outline: 2px solid var(--focus); outline-offset: 2px; }
  .file-pick .fhint { color: var(--muted); font-size: var(--fs-xs); }
  .compose > .compose-actions {
    position: sticky; bottom: 0; z-index: 2; background: var(--panel);
    margin: var(--sp-4) calc(-1 * var(--sp-6)) 0; padding: var(--sp-3) var(--sp-6);
    border-top: 1px solid var(--line);
  }
  .compose > .err:empty { display: none; }
  @media (max-width: 1100px) { .compose > .compose-actions { margin: var(--sp-4) calc(-1 * var(--sp-5)) 0; padding: var(--sp-3) var(--sp-5); } }
  @media (max-width: 760px) {
    .compose > .compose-actions { margin: var(--sp-4) calc(-1 * var(--sp-4)) 0; padding: var(--sp-3) var(--sp-4); }
    .msg-head .sender { flex-wrap: wrap; }
    .msg-head .sender-date { width: 100%; padding-left: 48px; }
  }

  /* --- Accessibility (#797) --- */
  .skip {
    position: absolute; left: var(--sp-2); top: -60px; z-index: 50; text-decoration: none;
    background: var(--accent); color: var(--accent-fg); padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-sm); font-weight: 650; font-size: var(--fs-sm);
  }
  .skip:focus { top: var(--sp-2); }
  .list:focus { outline: none; }
  .msg-head h2:focus, .auth h2:focus { outline: none; }
  .toast {
    position: fixed; left: 50%; bottom: var(--sp-4); transform: translateX(-50%); z-index: 40;
    max-width: calc(100vw - 32px); padding: var(--sp-2) var(--sp-4); border-radius: var(--r-md);
    background: var(--fg); color: var(--bg); box-shadow: var(--shadow); font-size: var(--fs-sm); font-weight: 550;
  }
  .toast.bad { background: var(--bad-dim); color: var(--bad); border: 1px solid var(--bad); }
  .toast[hidden] { display: none; }
  .settings-panel kbd {
    font: var(--fs-2xs)/1 var(--font-mono); padding: 2px 5px; border: 1px solid var(--line-strong);
    border-radius: 4px; background: var(--panel-2); color: var(--fg);
  }

  /* Keyboard focus visibility (a11y foundation): a clear ring for keyboard users
     on every interactive control, without a persistent outline on mouse click. */
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .row-item:focus-visible { outline-offset: -2px; }

  /* --- Responsive (#795) --- */
  @media (max-width: 1100px) {
    #railBtn { display: inline-flex; }
    .folders {
      position: absolute; top: 0; bottom: 0; left: 0; z-index: 25; width: 260px;
      transform: translateX(-105%); transition: transform var(--dur) ease-out; box-shadow: var(--shadow);
      visibility: hidden;
    }
    #app[data-rail="open"] .folders { transform: none; visibility: visible; }
    #app[data-rail="open"] .scrim {
      display: block; position: absolute; inset: 0; z-index: 24; background: rgba(0,0,0,.35);
    }
    .reading { padding: var(--sp-5); }
  }
  @media (max-width: 760px) {
    header { gap: var(--sp-1); padding: var(--sp-2); }
    header h1 .sub, header .who, header .identity, .sendnote, #themeBtn, #logout { display: none !important; }
    .settings-signout { display: flex; }
    #composeBtn { padding: 0 var(--sp-3); }
    .sidebar { width: 100%; border-right: none; }
    .reading-col { display: none; }
    #app[data-view="reading"] .sidebar { display: none; }
    #app[data-view="reading"] .reading-col { display: flex; }
    .reading-bar {
      display: flex; align-items: center; padding: var(--sp-2); border-bottom: 1px solid var(--line);
      background: var(--panel); flex-shrink: 0;
    }
    .reading { padding: var(--sp-4); }
    .msg-head h2 { font-size: var(--fs-xl); }
    .msg-body-frame { min-height: 55vh; }
    .settings-panel { top: 56px; }
    input, select, textarea { font-size: 16px; } /* iOS: no zoom on focus */
  }
</style>
</head>
<body>
<a class="skip" href="#list" id="skipLink">Skip to messages</a>

<header role="banner">
  <button id="railBtn" style="display:none" type="button" class="btn-quiet" aria-label="Folders" aria-controls="folders" aria-expanded="false">
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
  </button>
  <h1><svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect x="1" y="1" width="30" height="30" rx="8" fill="currentColor"/><path d="M10 25V14a6 6 0 0 1 12 0v11" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M7 25h18" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>Postern <span class="sub">webmail</span></h1>
  <span class="grow"></span>
  <span class="identity" id="identity"></span>
  <span class="who" id="who"></span>
  <span class="sendnote" id="sendNote" style="display:none"></span>
  <button id="composeBtn" style="display:none">Compose</button>
  <button id="themeBtn" type="button" class="link" aria-label="Theme: match system" title="Theme: match system">Theme</button>
  <button id="settingsBtn" class="link" style="display:none" aria-controls="settingsPanel" aria-expanded="false">Settings</button>
  <button id="logout" class="link" style="display:none">Sign out</button>
</header>
<div id="settingsPanel" class="settings-panel" role="dialog" aria-label="Settings">
  <h2>Settings</h2>
  <label for="themeSelect">Theme</label>
  <select id="themeSelect" aria-label="Theme">
    <option value="system">Match system</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>
  <label for="densitySelect">Density</label>
  <select id="densitySelect" aria-label="Density">
    <option value="comfortable">Comfortable</option>
    <option value="compact">Compact</option>
  </select>
  <p class="note" id="settingsSession">Session: not signed in.</p>
  <!-- Change password (#819, contract 1.10.5): session mode only -->
  <div id="pwSection" style="display:none">
    <h3 id="pwTitle">Change password</h3>
    <form id="pwForm" novalidate aria-labelledby="pwTitle">
      <label for="pwCur">Current password</label>
      <input id="pwCur" type="password" autocomplete="current-password">
      <label for="pwNew">New password</label>
      <input id="pwNew" type="password" autocomplete="new-password" aria-describedby="pwNewHint">
      <p class="hint" id="pwNewHint">At least 12 characters. Your other devices will be signed out.</p>
      <label for="pwNew2">Confirm new password</label>
      <input id="pwNew2" type="password" autocomplete="new-password">
      <button type="submit" id="pwSubmit">Change password</button>
    </form>
    <div class="err" id="pwErr" role="alert" aria-live="assertive"></div>
    <p class="note-ok" id="pwNote" role="status"></p>
  </div>
  <button type="button" id="settingsSignout" class="settings-signout">Sign out</button>
  <p class="note">Keyboard: <kbd>j</kbd> / <kbd>k</kbd> next and previous message, <kbd>/</kbd> search,
    <kbd>c</kbd> compose, arrow keys move in the list, <kbd>Esc</kbd> closes a panel or goes back.</p>
  <p class="note">Remote images in message bodies are blocked by CSP (img-src 'self' data: only; no https:). There is no toggle that can enable them under the current policy.</p>
</div>

<!-- BYO-token gate (operator / self-host path, contract 1.7) -->
<div id="gate" class="auth" role="region" aria-labelledby="gateTitle">
  <div class="card">
    <p class="eyebrow">Operators and agents</p>
    <h2 id="gateTitle">Connect with an API token</h2>
    <p class="lede">Your token stays in this browser tab and is sent only to the server below.</p>
    <label for="origin">Server</label>
    <input id="origin" type="url" placeholder="https://postern.example" autocomplete="off" spellcheck="false">
    <label for="token">Read token</label>
    <input id="token" type="password" placeholder="read-scoped or dual-cap identity token" autocomplete="off" spellcheck="false">
    <label for="sendToken">Send token <span class="opt">(optional)</span></label>
    <input id="sendToken" type="password" placeholder="leave empty if the read token can also send" autocomplete="off" spellcheck="false">
    <details class="help">
      <summary>Which token do I need?</summary>
      <p>A read-scoped API token lets you browse mail. To compose and reply, add a send-scoped
         token, or paste one dual-cap identity token (read and send) in the read field; send
         falls back to it when the send field is empty. Tokens are kept in sessionStorage for
         this tab only and are never sent anywhere but the server you name.</p>
    </details>
    <div class="row">
      <button id="connect" type="button">Connect</button>
    </div>
    <div class="err" id="gateErr" role="alert" aria-live="assertive"></div>
    <p class="note-ok" id="gateNote" role="status"></p>
    <p class="switch" id="toSigninWrap" style="display:none"><button type="button" class="link" id="toSignin">Sign in with a username and password</button></p>
  </div>
</div>

<!-- Native sign-in (session cookie mode, #351) -->
<div id="signin" class="auth" style="display:none" role="region" aria-labelledby="signinTitle">
  <div class="card">
    <h2 id="signinTitle">Sign in</h2>
    <p class="lede">Use your Postern username and password: the same login your mail app uses.</p>
    <form id="signinForm" novalidate>
      <label for="siUser">Username</label>
      <input id="siUser" name="username" type="text" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false">
      <label for="siPass">Password</label>
      <div class="pw-wrap">
        <input id="siPass" name="password" type="password" autocomplete="current-password">
        <button type="button" class="btn-quiet pw-toggle" data-toggle-for="siPass" aria-pressed="false" aria-label="Show password">Show</button>
      </div>
      <div class="row">
        <button type="submit" id="siSubmit">Sign in</button>
      </div>
    </form>
    <div class="err" id="signinErr" role="alert" aria-live="assertive"></div>
    <p class="note-ok" id="signinNote" role="status"></p>
    <p class="switch"><button type="button" class="link" id="toTokenGate">Use an API token instead</button></p>
  </div>
</div>

<!-- Sign-in not enabled (#798): WEBMAIL_AUTH_BACKEND unset or "off". Unset means OFF;
     only an explicit "native" turns sign-in on (lead ruling, contract #793 amended). -->
<div id="disabled" class="auth" style="display:none" role="region" aria-labelledby="disabledTitle">
  <div class="card">
    <p class="eyebrow">Not enabled</p>
    <h2 id="disabledTitle" tabindex="-1">Webmail sign-in is not enabled on this server</h2>
    <p class="lede">This Postern server does not offer username and password sign-in. If you run it,
       set <code>WEBMAIL_AUTH_BACKEND</code> to <code>native</code> and create an account; see DEPLOY.md.</p>
    <p class="lede">Your mail is unaffected: mail apps (IMAP and SMTP) and the API work as before.</p>
    <p class="switch"><button type="button" class="link" id="toTokenFromOff">Operators and agents: connect with an API token</button></p>
  </div>
</div>

<!-- First run (#798, contract 1.10.7): no users yet and POSTERN_SETUP_TOKEN is set -->
<div id="setup" class="auth" style="display:none" role="region" aria-labelledby="setupTitle">
  <div class="card">
    <p class="eyebrow">First run</p>
    <h2 id="setupTitle">Create the first account</h2>
    <p class="lede">This mailbox has no users yet. Enter the setup token from your deploy, then choose the
       login for the first person. You can add more people later.</p>
    <form id="setupForm" novalidate>
      <label for="suToken">Setup token</label>
      <div class="pw-wrap">
        <input id="suToken" type="password" autocomplete="off" spellcheck="false" aria-describedby="suTokenHint">
        <button type="button" class="btn-quiet pw-toggle" data-toggle-for="suToken" aria-pressed="false" aria-label="Show setup token">Show</button>
      </div>
      <p class="hint" id="suTokenHint">The POSTERN_SETUP_TOKEN secret you set when you deployed.</p>
      <label for="suUser">Email address</label>
      <input id="suUser" type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="suUserHint">
      <p class="hint" id="suUserHint">Your login, and the address you send from.</p>
      <label for="suName">Display name <span class="opt">(optional)</span></label>
      <input id="suName" type="text" autocomplete="name" maxlength="128">
      <label for="suPass">Password</label>
      <div class="pw-wrap">
        <input id="suPass" type="password" autocomplete="new-password" aria-describedby="suPassHint">
        <button type="button" class="btn-quiet pw-toggle" data-toggle-for="suPass" aria-pressed="false" aria-label="Show password">Show</button>
      </div>
      <p class="hint" id="suPassHint">At least 12 characters. A long phrase is easier to remember than symbols.</p>
      <label for="suPass2">Confirm password</label>
      <input id="suPass2" type="password" autocomplete="new-password">
      <div class="row">
        <button type="submit" id="suSubmit">Create account and sign in</button>
      </div>
    </form>
    <div class="err" id="setupErr" role="alert" aria-live="assertive"></div>
  </div>
</div>

<!-- App -->
<div id="app">
  <nav class="folders" id="folders" role="navigation" aria-label="Folders"></nav>
  <section class="sidebar" aria-label="Message list">
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search mail" aria-label="Search mail">
      <select id="searchMode" class="mode" title="Search mode (applies when searching)" aria-label="Search mode">
        <option value="hybrid">Hybrid</option>
        <option value="fts">Keyword</option>
        <option value="semantic">Semantic</option>
      </select>
      <button type="button" id="filtersBtn" class="btn-quiet" aria-expanded="false" aria-controls="filters">Filters <span class="badge" id="filtersCount"></span></button>
    </div>
    <div class="filters" id="filters" aria-label="Search filters" hidden>
      <span class="fhint">Filters narrow a search. Type a query and press Enter.</span>
      <button type="button" class="chip" data-filter="unseen" id="chipUnseen">Unread</button>
      <button type="button" class="chip" data-filter="seen" id="chipSeen">Read</button>
      <button type="button" class="chip" data-filter="hasAtt" id="chipHasAtt">Has attachment</button>
      <label>From <input id="filterFrom" type="text" placeholder="from@" aria-label="Filter from" style="width:9rem"></label>
      <label>After <input id="filterAfter" type="date" aria-label="After date"></label>
      <label>Before <input id="filterBefore" type="date" aria-label="Before date"></label>
      <button type="button" class="link" id="clearFilters">Clear filters</button>
    </div>
    <div class="list" id="list" aria-label="Messages" tabindex="-1"></div>
  </section>
  <main class="reading-col" aria-label="Message">
    <div class="reading-bar"><button type="button" id="backBtn" class="btn-quiet">&larr; Back to list</button></div>
    <div class="reading" id="reading">
      <div class="empty">Select a message to read.</div>
    </div>
  </main>
  <div class="scrim" id="scrim"></div>
</div>

<div id="announce" class="vh" aria-live="polite" aria-atomic="true"></div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

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

  // Attachment filenames are written by the sender. Control and invisible format
  // characters (bidi overrides and isolates, zero-width characters, C0/C1 controls,
  // line and paragraph separators) can make a name read differently from what it is,
  // so the shown name marks each one as a visible [U+XXXX] and the name handed to the
  // download replaces each one with "_". Shown names also sit in an LTR isolate.
  var FILENAME_HIDDEN = /[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]/gu;
  function codePointLabel(ch) {
    var hex = ch.codePointAt(0).toString(16).toUpperCase();
    while (hex.length < 4) hex = "0" + hex;
    return "[U+" + hex + "]";
  }
  function shownFileName(name) { return String(name).replace(FILENAME_HIDDEN, codePointLabel); }
  function savedFileName(name) { return String(name).replace(FILENAME_HIDDEN, "_"); }
  function fileNameNode(name) {
    return el("span", { class: "att-name", dir: "ltr", text: shownFileName(name) });
  }
  function $(id) { return document.getElementById(id); }

  // --- session state ---------------------------------------------------------
  var SS = window.sessionStorage;
  var LS = (function () { try { return window.localStorage; } catch (_) { return null; } })();
  var SEARCH_MODES = ["fts", "semantic", "hybrid"];
  function normalizeSearchMode(v) {
    return SEARCH_MODES.indexOf(v) >= 0 ? v : "hybrid";
  }
  // Theme (#794): "system" (default, follows prefers-color-scheme), "light" or "dark".
  // localStorage can throw (private mode, blocked storage); a pref is a convenience, so
  // a failed read falls back to the default and a failed write is ignored.
  var THEMES = ["system", "light", "dark"];
  var THEME_LABEL = { system: "match system", light: "light", dark: "dark" };
  function prefGet(k) { try { return LS.getItem(k); } catch (_) { return null; } }
  function prefSet(k, v) { try { LS.setItem(k, v); } catch (_) {} }
  function themePref() {
    var t = prefGet("postern_theme");
    return THEMES.indexOf(t) >= 0 ? t : "system";
  }
  var DARK_MQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function applyChromePrefs() {
    var theme = themePref();
    var density = prefGet("postern_density") === "compact" ? "compact" : "comfortable";
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-density", density);
    if ($("themeSelect")) $("themeSelect").value = theme;
    if ($("densitySelect")) $("densitySelect").value = density;
    var tb = $("themeBtn");
    if (tb) {
      var label = "Theme: " + THEME_LABEL[theme];
      tb.setAttribute("aria-label", label);
      tb.setAttribute("title", label);
    }
    retintPlainFrames();
  }
  var state = {
    origin: SS.getItem("postern_origin") || "",
    token: SS.getItem("postern_token") || "",
    // Dual-cap: a lone read token that also carries send (v1.4.0 identity scopes)
    // is enough to compose when no separate send token was stored.
    sendToken: SS.getItem("postern_send_token") || SS.getItem("postern_token") || "",
    searchMode: normalizeSearchMode(SS.getItem("postern_search_mode") || "hybrid"),
    folder: "inbox", q: "", cursor: null, items: [], selected: null,
    folders: [],
    filters: { from: "", after: "", before: "", seen: null, hasAttachment: null },
    recentRecipients: [],
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
    sendReason: "",
    // First run (#798, contract 1.10.6): GET /api/session 401 says setupRequired.
    setupRequired: false
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
            // E_IDENTITY_REQUIRED (drafts need a bound identity) is not "cannot send".
            if ((j && j.error) !== "E_IDENTITY_REQUIRED") {
              state.sendCapable = false; state.sendReason = "readonly"; updateComposeUI();
            }
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
      a.href = obj; a.download = savedFileName(filename || ("attachment-" + index));
      document.body.appendChild(a); a.click(); a.remove();
      // Revoke on the next tick so the download has started.
      setTimeout(function () { URL.revokeObjectURL(obj); }, 0);
    }).catch(function (e) {
      if (e.message !== "unauthorized") toast("Download failed: " + e.message, true);
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
  // Frame palette (#794). Plain text follows the app theme; HTML mail is authored for a
  // light canvas, so it always gets the light palette. Values are read from the page own
  // tokens and constrained to a color grammar before they enter the srcdoc style, so no
  // value can close the style element or add a declaration.
  var FRAME_LIGHT = { bg: "#ffffff", fg: "#171a21", link: "#2456d3" };
  function cssColor(v, fallback) {
    v = String(v || "").trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
  }
  function framePalette(light) {
    if (light) return FRAME_LIGHT;
    var cs = window.getComputedStyle(document.documentElement);
    return {
      bg: cssColor(cs.getPropertyValue("--frame-bg"), "#ffffff"),
      fg: cssColor(cs.getPropertyValue("--frame-fg"), "#171a21"),
      link: cssColor(cs.getPropertyValue("--frame-link"), "#2456d3")
    };
  }
  function frameBaseStyle(light) {
    var p = framePalette(light);
    return "<style>html,body{margin:0}body{font:14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
      "word-wrap:break-word;padding:16px;color:" + p.fg + ";background:" + p.bg +
      (light ? "" : ";white-space:pre-wrap") +
      "}a{color:" + p.link + "}img{max-width:100%;height:auto}</style>";
  }
  function retintPlainFrames() {
    var frames = document.querySelectorAll("iframe.msg-body-frame[data-plain]");
    Array.prototype.forEach.call(frames, function (f) {
      if (typeof f._posternInner !== "string") return;
      var doc = f.getAttribute("srcdoc") || "";
      var start = doc.indexOf("<style>"), end = doc.indexOf("</style>");
      if (start < 0 || end < start) return;
      f.setAttribute("srcdoc", doc.slice(0, start) + frameBaseStyle(false) + doc.slice(end + 8));
    });
  }

  function renderBody(m) {
    var wrap = el("div", { class: "body-wrap" });
    var hasHtml = !!(m && m.bodyHtml);
    // HTML email authors its own colors for a LIGHT background (every mail client
    // renders HTML mail on white), so use white + dark text for the HTML case to
    // avoid dark-on-dark unreadable bodies. Plain text keeps the app's dark theme.
    function baseStyle(light) {
      return frameBaseStyle(light);
    }
    // Defense in depth for the message iframe (#409). sandbox="" (no scripts, no
    // same-origin, no forms) is the primary isolation and the served-page CSP is
    // inherited by this srcdoc document, but both are single points of failure that
    // live OUTSIDE the document; this meta policy travels WITH the srcdoc, so the
    // rendered mail body stays inert even if either one is ever loosened by mistake.
    // style-src 'unsafe-inline' is required: baseStyle injects a <style> block and
    // neutralizeRemoteHtml hoists the message own <style> elements into the body.
    // img-src data: is required for the blocked-image placeholder (remote images are
    // stripped before they reach here; nothing else may load).
    var FRAME_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:";
    function frameFor(inner, light) {
      var doc = '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">' + baseStyle(light) +
        '</head><body>' + inner + '</body></html>';
      var f = document.createElement("iframe");
      f.className = "msg-body-frame";
      // Plain-text frames follow the app theme (#794); keep the inner so a theme change
      // can rebuild the srcdoc with the new palette (retintPlainFrames).
      if (!light) { f.setAttribute("data-plain", "1"); f._posternInner = inner; }
      f.setAttribute("sandbox", "");        // no scripts, no same-origin, no forms
      f.setAttribute("title", "Message body");
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

  function showGate(msg, info) {
    state.authMode = "token";
    $("app").className = "";
    $("signin").style.display = "none";
    $("setup").style.display = "none";
    $("disabled").style.display = "none";
    $("gate").style.display = "";
    $("logout").style.display = "none";
    $("railBtn").style.display = "none";
    $("identity").textContent = "";
    $("who").textContent = "";
    // Served by the worker, the CSP is connect-src 'self', so the page's own origin is
    // the only API origin that can work: prefill it rather than make the user retype
    // the URL they are already on. Opened from file:// there is nothing to prefill.
    $("origin").value = state.origin || (/^https?:\\/\\//.test(location.origin) ? location.origin : "");
    // Offer a way back to native sign-in only when the server supports it.
    $("toSigninWrap").style.display = state.authBackend === "native" ? "" : "none";
    $("gateErr").textContent = msg || "";
    $("gateNote").textContent = info || "";
    focusFirst("origin");
  }

  function showSignin(msg, info) {
    state.authMode = "session";
    $("app").className = "";
    $("gate").style.display = "none";
    $("setup").style.display = "none";
    $("disabled").style.display = "none";
    $("signin").style.display = "";
    $("logout").style.display = "none";
    $("railBtn").style.display = "none";
    $("identity").textContent = "";
    $("who").textContent = "";
    $("signinErr").textContent = msg || "";
    $("signinNote").textContent = info || "";
    $("siPass").value = "";
    setPwVisible("siPass", false);
    focusFirst("siUser");
  }

  // First run (#798, contract 1.10.7). Shown only when GET /api/session says
  // setupRequired; the server decides, the page never guesses.
  function showSetup(msg) {
    state.authMode = "session";
    $("app").className = "";
    $("gate").style.display = "none";
    $("signin").style.display = "none";
    $("disabled").style.display = "none";
    $("setup").style.display = "";
    $("logout").style.display = "none";
    $("railBtn").style.display = "none";
    $("identity").textContent = "";
    $("who").textContent = "";
    $("setupErr").textContent = msg || "";
    focusFirst("suToken");
  }

  // Sign-in is off on this server (#798). A plain notice, not a form: a person who is
  // not an operator has nothing to type here. The token gate stays one click away for
  // operators and agents (contract 1.7, the off-mode path).
  function showDisabled() {
    state.authMode = "token";
    $("app").className = "";
    $("gate").style.display = "none";
    $("signin").style.display = "none";
    $("setup").style.display = "none";
    $("disabled").style.display = "";
    $("logout").style.display = "none";
    $("railBtn").style.display = "none";
    $("identity").textContent = "";
    $("who").textContent = "";
    focusFirst("disabledTitle");
  }

  // Show / hide a password field (#798). The value never leaves the input.
  function setPwVisible(id, on) {
    var input = $(id);
    if (input) input.type = on ? "text" : "password";
    var btn = document.querySelector('.pw-toggle[data-toggle-for="' + id + '"]');
    if (btn) {
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.textContent = on ? "Hide" : "Show";
    }
  }

  function showApp() {
    $("gate").style.display = "none";
    $("setup").style.display = "none";
    $("disabled").style.display = "none";
    $("signin").style.display = "none";
    $("app").className = "on";
    $("logout").style.display = "";
    $("railBtn").style.display = "";
    // The gate or sign-in card that held focus is now hidden; do not strand focus there (#797).
    var ae = document.activeElement;
    if (ae && ae.closest && ae.closest("#gate, #signin")) $("list").focus();
    $("settingsBtn").style.display = "";
    if (state.authMode === "session" && state.identity) {
      // Identity display (contract 1.5.1): show who the browser sends as. A send
      // token could never surface this; a session GET echoes the bound identity.
      $("identity").textContent = "Sending as " + state.identity.from;
      $("who").textContent = state.identity.displayName || "";
      $("settingsSession").textContent = "Session: " + state.identity.from +
        (state.identity.displayName ? " (" + state.identity.displayName + ")" : "");
      $("pwSection").style.display = "";
    } else {
      $("identity").textContent = "";
      $("who").textContent = state.origin;
      $("settingsSession").textContent = "Session: BYO token at " + (state.origin || "(same origin)");
      // A token is not a person and has no password to change (contract 1.10.5).
      $("pwSection").style.display = "none";
    }
    $("searchMode").value = state.searchMode;
    applyChromePrefs();
    updateComposeUI();
    probeSendCapability();
    loadRecentRecipients();
  }

  function loadRecentRecipients() {
    var params = {};
    if (state.authMode !== "session" && state.identity && state.identity.from) {
      params.viewer = state.identity.from;
    }
    api("/api/recipients/recent", params).then(function (body) {
      state.recentRecipients = body.recipients || [];
    }).catch(function () {
      state.recentRecipients = [];
    });
  }

  // Folder scope (#403). A bound session has a viewer, so Inbox/Sent are the NAMED
  // viewer lenses (lens=inbox / lens=sent) -- the same predicates /api/folders counts
  // with, so the rail and the list agree. Token mode has no viewer: the API refuses a
  // viewerless lens, and the honest token-mode view IS the estate arrival view, so it
  // keeps filtering on the stored direction.
  // Role queues (#425). A role folder id is "role:<address>"; the address is the QUEUE,
  // and membership was decided server-side (the rail only ever lists queues this session
  // is a member of, and every read is re-checked at the API). Read state stays keyed on
  // the signed-in person, which the server derives -- the page never sends seenFor.
  function roleAddress(folderId) {
    return folderId && folderId.indexOf("role:") === 0 ? folderId.slice(5) : "";
  }
  function currentRole() {
    return state.authMode === "session" ? roleAddress(state.folder) : "";
  }

  function applyFolderScope(p) {
    var session = state.authMode === "session";
    var role = currentRole();
    if (role) {
      // The queue arrival view, exactly as the IMAP door asks for it: to=R with the
      // NAMED inbox lens (never direction=inbound, which would drop same-domain sends
      // delivered TO the queue). No mailbox, no other lens: the server refuses those.
      p.to = role;
      p.lens = "inbox";
      return;
    }
    if (state.folder === "inbox") {
      if (session) p.lens = "inbox"; else p.direction = "inbound";
    } else if (state.folder === "sent") {
      if (session) p.lens = "sent"; else p.direction = "outbound";
    } else if (state.folder === "all") {
      p.mailbox = "all";
    } else if (state.folder === "trash" || state.folder === "junk" || state.folder === "archive") {
      p.mailbox = state.folder;
    }
  }

  function searchFilterParams() {
    var p = {};
    if (state.filters.from) p.from = state.filters.from;
    // The bare <input type="date"> value goes on the wire as-is (#647). This used to append
    // "T00:00:00.000Z" / "T23:59:59.999Z" here, which was CORRECT and was the only place in
    // the estate that got the inclusive upper bound right: the Worker compared a bare date
    // as a string and so silently dropped the whole named day, which means the webmail was
    // right and every other door was wrong about the same documented parameter. The Worker
    // now canonicalizes a bare date to its full named day for every caller, so keeping this
    // would be a second implementation of a rule the server owns, and a second one drifts.
    if (state.filters.after) p.after = state.filters.after;
    if (state.filters.before) p.before = state.filters.before;
    if (state.filters.seen === true) p.seen = "1";
    if (state.filters.seen === false) p.seen = "0";
    if (state.filters.hasAttachment === true) p.hasAttachment = "1";
    if (state.filters.hasAttachment === false) p.hasAttachment = "0";
    applyFolderScope(p);
    return p;
  }

  function syncFilterChips() {
    $("chipUnseen").className = "chip" + (state.filters.seen === false ? " on" : "");
    $("chipSeen").className = "chip" + (state.filters.seen === true ? " on" : "");
    $("chipHasAtt").className = "chip" + (state.filters.hasAttachment === true ? " on" : "");
    $("filterFrom").value = state.filters.from || "";
    $("filterAfter").value = state.filters.after || "";
    $("filterBefore").value = state.filters.before || "";
    ["chipUnseen", "chipSeen", "chipHasAtt"].forEach(function (id) {
      $(id).setAttribute("aria-pressed", / on$/.test($(id).className) ? "true" : "false");
    });
    updateFilterCount();
  }
  function updateFilterCount() {
    var f = state.filters, n = 0;
    if (f.seen !== null) n++;
    if (f.hasAttachment) n++;
    if (f.from) n++;
    if (f.after) n++;
    if (f.before) n++;
    $("filtersCount").textContent = n ? String(n) : "";
    $("filtersBtn").setAttribute("aria-label", n ? "Filters, " + n + " active" : "Filters");
  }

  // BYO-token connect (operator / self-host path, contract 1.7).
  // Dual-cap identity tokens (read+send on one secret, v1.4.0+): if the send field is
  // empty, reuse the read token as the send credential. probeSendCapability still gates
  // compose; a pure read token just keeps sendCapable=false.
  function connect() {
    state.authMode = "token";
    var origin = $("origin").value.trim();
    var token = $("token").value;
    var sendTok = $("sendToken").value.trim() || token;
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
    $("signinNote").textContent = "";
    if (!username || !password) { $("signinErr").textContent = "Enter your username and password."; return; }
    $("siSubmit").disabled = true;
    $("siSubmit").textContent = "Signing in\\u2026";
    fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
      credentials: "include", referrerPolicy: "no-referrer"
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (b) { return { status: r.status, body: b }; });
    }).then(function (res) {
      $("siSubmit").disabled = false;
      $("siSubmit").textContent = "Sign in";
      if (res.status === 200 && res.body && res.body.ok) { $("siPass").value = ""; setPwVisible("siPass", false); onSession(res.body); return; }
      // Locked out by the mint throttle (#409): the server sends Retry-After and a
      // retryAfter field, so tell the user how long instead of "wait a bit".
      if (res.status === 429) {
        var wait = res.body && res.body.retryAfter ? Number(res.body.retryAfter) : 0;
        $("signinErr").textContent = tooManyText(wait);
        return;
      }
      // The throttle store is unreachable, so the server refuses rather than run the
      // sign-in unthrottled (#409 fail-closed). Not a credential problem; say so.
      if (res.status === 503) { $("signinErr").textContent = "Sign-in is temporarily unavailable. Try again shortly."; return; }
      $("signinErr").textContent = "That username and password do not match. Check them and try again.";
    }).catch(function () {
      $("siSubmit").disabled = false;
      $("siSubmit").textContent = "Sign in";
      $("signinErr").textContent = "Could not reach the server. Try again.";
    });
  }

  function tooManyText(wait) {
    if (!(wait > 0)) return "Too many attempts. Please wait and try again.";
    var mins = Math.ceil(wait / 60);
    return "Too many attempts. Try again in " + mins + (mins === 1 ? " minute." : " minutes.");
  }

  // First-run create (#798): POST /api/setup (contract 1.10.7). The server is the
  // authority on every rule; the checks here only save a round trip on obvious slips.
  function setupSubmit() {
    var token = $("suToken").value;
    var username = $("suUser").value.trim().toLowerCase();
    var name = $("suName").value.trim();
    var pw = $("suPass").value, pw2 = $("suPass2").value;
    var err = $("setupErr");
    err.textContent = "";
    if (!token) { err.textContent = "Enter the setup token."; focusFirst("suToken"); return; }
    if (!username) { err.textContent = "Enter the email address for this account."; focusFirst("suUser"); return; }
    if (pw.length < 12) { err.textContent = "The password must be at least 12 characters."; focusFirst("suPass"); return; }
    if (pw.toLowerCase() === username) { err.textContent = "The password cannot be the same as the email address."; focusFirst("suPass"); return; }
    if (pw !== pw2) { err.textContent = "The two passwords do not match."; focusFirst("suPass2"); return; }
    var body = { setupToken: token, username: username, password: pw };
    if (name) body.displayName = name;
    $("suSubmit").disabled = true;
    $("suSubmit").textContent = "Creating account\\u2026";
    fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(body),
      credentials: "include", referrerPolicy: "no-referrer"
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (b) { return { status: r.status, body: b || {} }; });
    }).then(function (res) {
      $("suSubmit").disabled = false;
      $("suSubmit").textContent = "Create account and sign in";
      var b = res.body, code = b.error || "";
      if ((res.status === 201 || res.status === 200) && b.ok) {
        ["suToken", "suPass", "suPass2"].forEach(function (id) { $(id).value = ""; setPwVisible(id, false); });
        state.setupRequired = false;
        onSession(b);
        return;
      }
      if (res.status === 409) { state.setupRequired = false; showSignin("", "This mailbox is already set up. Sign in with your account."); return; }
      if (res.status === 404) { state.setupRequired = false; showSignin("", "First-run setup is not turned on for this mailbox. Sign in, or ask your operator for an account."); return; }
      if (res.status === 401) { err.textContent = "That setup token is not correct."; focusFirst("suToken"); return; }
      if (res.status === 429) { err.textContent = tooManyText(Number(b.retryAfter) || 0); return; }
      if (res.status === 503) { err.textContent = "Setup is temporarily unavailable. Try again shortly."; return; }
      if (code === "E_SENDER_NOT_ALLOWED") { err.textContent = b.message || "That address is not on this mailbox domain."; focusFirst("suUser"); return; }
      if (code === "E_PASSWORD_POLICY") { err.textContent = b.message || "That password does not meet the policy."; focusFirst("suPass"); return; }
      err.textContent = b.message || "Could not create the account. Check the fields and try again.";
    }).catch(function () {
      $("suSubmit").disabled = false;
      $("suSubmit").textContent = "Create account and sign in";
      err.textContent = "Could not reach the server. Try again.";
    });
  }

  // Change password (#819, contract 1.10.5): POST /api/session/password, cookie session
  // plus the CSRF header. On success the server ends every OTHER session of the account
  // and rotates this one (new cookies, new csrfToken; #827), so this tab stays signed in.
  function changePassword() {
    var cur = $("pwCur").value, nw = $("pwNew").value, nw2 = $("pwNew2").value;
    var err = $("pwErr"), note = $("pwNote");
    err.textContent = ""; note.textContent = "";
    if (!cur || !nw) { err.textContent = "Enter your current password and a new one."; return; }
    if (nw.length < 12) { err.textContent = "The new password must be at least 12 characters."; focusFirst("pwNew"); return; }
    if (nw === cur) { err.textContent = "The new password must be different from the current one."; focusFirst("pwNew"); return; }
    if (nw !== nw2) { err.textContent = "The two new passwords do not match."; focusFirst("pwNew2"); return; }
    $("pwSubmit").disabled = true;
    $("pwSubmit").textContent = "Changing\\u2026";
    function done() { $("pwSubmit").disabled = false; $("pwSubmit").textContent = "Change password"; }
    fetch("/api/session/password", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json", "x-postern-csrf": csrfFromCookie() },
      body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
      credentials: "include", referrerPolicy: "no-referrer"
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (b) { return { status: r.status, body: b || {} }; });
    }).then(function (res) {
      done();
      var b = res.body, code = b.error || "";
      if (res.status === 200 && b.ok) {
        ["pwCur", "pwNew", "pwNew2"].forEach(function (id) { $(id).value = ""; });
        state.csrfToken = b.csrfToken || csrfFromCookie();
        if (b.identity) state.identity = b.identity;
        note.textContent = "Password changed. Any other devices were signed out.";
        return;
      }
      if (code === "E_REAUTH_REQUIRED") {
        sessionReset(); setSettings(false);
        showSignin("", "Sign in again, then change your password.");
        return;
      }
      if (res.status === 401) {
        // E_AUTH_FAILED means a wrong current password OR a session that is gone.
        // Ask the server which, rather than guess.
        return fetch("/api/session", { headers: { "accept": "application/json" }, credentials: "include", referrerPolicy: "no-referrer" })
          .then(function (r) {
            if (r.status === 200) { err.textContent = "The current password is not correct."; focusFirst("pwCur"); return; }
            sessionReset(); setSettings(false);
            showSignin("", "Your session ended. Sign in again.");
          });
      }
      if (res.status === 429) { err.textContent = tooManyText(Number(b.retryAfter) || 0); return; }
      if (res.status === 503) { err.textContent = "Password change is temporarily unavailable. Try again shortly."; return; }
      if (res.status === 403) { err.textContent = "The request was refused for security reasons. Reload the page and try again."; return; }
      if (code === "E_PASSWORD_POLICY") { err.textContent = b.message || "That password does not meet the policy."; focusFirst("pwNew"); return; }
      err.textContent = b.message || "Could not change the password. Try again.";
    }).catch(function () {
      done();
      err.textContent = "Could not reach the server. Try again.";
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
        showSignin("", "You are signed out.");
      });
      return;
    }
    SS.removeItem("postern_token");
    SS.removeItem("postern_send_token");
    SS.removeItem("postern_origin");
    state.token = ""; state.sendToken = ""; state.sendCapable = null; state.sendReason = ""; state.items = []; state.selected = null; state.cursor = null;
    clear($("list")); renderReading(null);
    showGate("", "Signed out. Your tokens were cleared from this browser.");
  }

  // --- folders + list (#352) -------------------------------------------------
  function listParams() {
    var p = { limit: 50, cursor: state.cursor };
    applyFolderScope(p);
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
    function folderButton(f) {
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
      if (f.role) btn.setAttribute("title", f.role + " (shared queue)");
      btn.addEventListener("click", function () {
        setRail(false);
        setView("list");
        if (state.folder === f.id) return;
        state.folder = f.id;
        state.q = "";
        $("search").value = "";
        renderFolderRail();
        resetAndLoad();
      });
      return btn;
    }
    // Personal folders first, then the role queues under their own heading -- the same
    // shape the IMAP door publishes (a Roles parent with one folder per queue), so the
    // two human doors read the same way. A queue is never merged into Inbox.
    rows.filter(function (f) { return !f.role; }).forEach(function (f) {
      nav.appendChild(folderButton(f));
    });
    var queues = rows.filter(function (f) { return !!f.role; });
    if (queues.length) {
      nav.appendChild(el("div", {
        class: "fgroup",
        text: "Roles",
        title: "Shared queues you are a member of: read and mark-read only"
      }));
      queues.forEach(function (f) { nav.appendChild(folderButton(f)); });
    }
  }

  function refreshFolders() {
    return api("/api/folders").then(function (body) {
      state.folders = body.folders || [];
      // A queue can vanish (membership changed, or the operator map became unusable and
      // the server now serves NO queue). Land back on Inbox rather than keep asking for
      // a view the server will no longer scope: fail closed in the UI too.
      var role = currentRole();
      if (role && !state.folders.some(function (f) { return f.id === state.folder; })) {
        state.folder = "inbox";
        state.q = "";
        resetAndLoad();
        return;
      }
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

  // Score-ranked search with no AI or Vectorize is HTTP 200, ok:true, and
  // degraded "semantic search unavailable..." (not an error, and not an empty
  // mailbox). The keyword retry below is the page that can carry a cursor.
  function semanticUnavailable(body) {
    var d = body && body.degraded;
    return typeof d === "string" && /semantic search unavailable/i.test(d);
  }

  function loadMore(fallbackFts) {
    var loading = el("div", { class: "loading skel-list", role: "status" },
      [el("span", { class: "vh", text: "Loading messages" })].concat(skeletonRows(state.items.length ? 2 : 6)));
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
      if (state.q) {
        var sp = searchFilterParams();
        sp.q = state.q;
        sp.mode = mode;
        sp.limit = 50;
        sp.cursor = state.cursor;
        req = api("/api/search", sp);
      } else {
        req = api("/api/messages", listParams());
      }
    }
    req.then(function (body) {
      $("list").removeChild(loading);
      // The dropdown stays on semantic or hybrid. This retry is mode=fts, and
      // its cursor is only valid for that mode (#803).
      if (state.q && !fallbackFts && state.searchMode !== "fts" && semanticUnavailable(body)) {
        state.cursor = null; state.items = [];
        clear($("list"));
        loadMore(true);
        return;
      }
      // search returns SearchHit { message, ... }; list returns summaries.
      var rows = (body.items || []).map(function (it) { return it.message ? it.message : it; });
      state.items = state.items.concat(rows);
      state.cursor = body.cursor || null;
      rows.forEach(appendRow);
      if (!state.cursor || rows.length) {
        announce(state.items.length === 0 ? (state.q ? "No results." : "No messages.")
          : state.items.length + (state.items.length === 1 ? " message" : " messages") +
            (state.q ? " found." : " in " + folderLabel(state.folder) + "."));
      }
      if (fallbackFts) {
        $("list").appendChild(el("div", { class: "loading", text: "Semantic search unavailable; showing keyword results." }));
      }
      if (state.cursor) {
        var more = el("div", { class: "more" }, [el("button", { class: "link", text: "Load more" })]);
        // Page in the mode that produced this cursor. A fallback fts page must
        // keep mode=fts; the dropdown may still be semantic or hybrid, and
        // those modes refuse a cursor (#803).
        more.firstChild.addEventListener("click", function () { $("list").removeChild(more); loadMore(fallbackFts); });
        $("list").appendChild(more);
      } else if (state.items.length === 0) {
        $("list").appendChild(state.q
          ? emptyState("search", "No results for \\u201c" + state.q + "\\u201d", "Try Keyword mode, or clear the filters.")
          : emptyState("inbox", state.folder === "inbox" ? "Your inbox is empty" : "No messages in " + folderLabel(state.folder),
              state.folder === "inbox" ? "New mail shows up here." : ""));
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
      // Trusted is the normal case, so it stays quiet in the list; only untrusted is loud.
      // The reading pane always states the verdict.
      if (!m.trusted && m.direction !== "outbound") tags.push(el("span", { class: "tag untrusted", text: "untrusted" }));
    }
    if (m.attachmentCount) {
      tags.push(el("span", { class: "att", title: m.attachmentCount + " attachment" + (m.attachmentCount === 1 ? "" : "s") },
        [icon("clip"), document.createTextNode(String(m.attachmentCount))]));
    }
    var who = m.direction === "outbound" ? ("To: " + (m.to || "")) : (m.from || "");
    var item = el("div", {
      class: "row-item" + (m.seen === false ? " unread" : ""),
      "data-id": m.messageId,
      role: "button",
      tabindex: "0",
      "aria-label": (m.subject || "(no subject)") + " from " + who
    }, [
      avatar(who),
      el("div", { class: "row-main" }, [
        el("div", { class: "top" }, [
          el("span", { class: "dot", "aria-hidden": "true" }),
          el("div", { class: "from", text: (m.direction === "outbound" ? "To: " : "") + parseAddr(m.direction === "outbound" ? m.to : m.from).name, title: who }),
          el("div", { class: "date", text: fmtDate(m.date || m.receivedAt) })
        ]),
        el("div", { class: "subject", text: m.subject || "(no subject)" }),
        el("div", { class: "meta" }, tags)
      ])
    ]);
    item.addEventListener("click", function () { selectMessage(m.messageId, item); });
    item.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectMessage(m.messageId, item); return; }
      var rows = listRows(), i = rows.indexOf(item), to = null;
      if (e.key === "ArrowDown") to = rows[i + 1];
      else if (e.key === "ArrowUp") to = rows[i - 1];
      else if (e.key === "Home") to = rows[0];
      else if (e.key === "End") to = rows[rows.length - 1];
      else return;
      e.preventDefault();
      focusRow(to);
    });
    $("list").appendChild(item);
  }

  // --- small presentational helpers (#796). All text goes in via text nodes. -----
  var SVGNS = "http://www.w3.org/2000/svg";
  var ICONS = {
    clip: "M20 11.5l-7.8 7.8a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3 3 0 0 1 4.3 4.3l-7.6 7.6a1.5 1.5 0 0 1-2.1-2.1l7-7",
    inbox: "M3 13l2.5-7h13L21 13v6H3zM3 13h5l1.5 2.5h5L16 13h5",
    mail: "M3 6h18v12H3zM3 7l9 6 9-6",
    search: "M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM15.5 15.5L21 21"
  };
  function icon(name, cls, box) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", box || "0 0 24 24");
    svg.setAttribute("class", cls || "ico");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", ICONS[name]);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.7");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
    return svg;
  }
  // "Name <addr>" -> { name, addr }; a bare address is its own name.
  function parseAddr(s) {
    var t = String(s || "").trim();
    var m = t.match(/^"?([^"<]*?)"?\\s*<([^>]+)>$/);
    if (m && m[1].trim()) return { name: m[1].trim(), addr: m[2].trim() };
    return { name: t, addr: m ? m[2].trim() : t };
  }
  function initialOf(s) {
    var m = parseAddr(String(s || "").replace(/^To:\\s*/i, "")).name.match(/[\\p{L}\\p{N}]/u);
    return m ? m[0].toUpperCase() : "?";
  }
  function avatar(s) { return el("span", { class: "avatar", "aria-hidden": "true", text: initialOf(s) }); }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function emptyState(ico, title, hint) {
    return el("div", { class: "empty-state" }, [
      icon(ico, "es-ico"),
      el("p", { class: "es-title", text: title }),
      hint ? el("p", { class: "es-hint", text: hint }) : null
    ]);
  }
  function skeletonRows(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(el("div", { class: "skel-row", "aria-hidden": "true" }, [
        el("span", { class: "skel skel-av" }),
        el("span", { class: "skel-lines" }, [
          el("span", { class: "skel skel-line", style: "width:" + (45 + (i * 17) % 35) + "%" }),
          el("span", { class: "skel skel-line", style: "width:" + (70 + (i * 11) % 25) + "%" })
        ])
      ]));
    }
    return out;
  }
  function folderLabel(id) {
    var f = state.folders.filter(function (x) { return x.id === id; })[0];
    return (f && f.label) || (id.charAt(0).toUpperCase() + id.slice(1));
  }

  // --- announcements (#797) ---------------------------------------------------
  // announce(): polite screen-reader text. toast(): a short visible notice that also
  // reads out; errors use it in place of window.alert, which blocks the page.
  function announce(msg) {
    var a = $("announce");
    a.textContent = "";
    setTimeout(function () { a.textContent = msg; }, 30);
  }
  var toastTimer = null;
  function toast(msg, bad) {
    var t = $("toast");
    t.className = "toast" + (bad ? " bad" : "");
    t.setAttribute("role", bad ? "alert" : "status");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 6000 : 3500);
  }
  var NARROW_MQ = window.matchMedia ? window.matchMedia("(max-width: 760px)") : null;
  function listRows() { return Array.prototype.slice.call($("list").querySelectorAll(".row-item")); }
  function rowFor(id) {
    var rows = listRows();
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute("data-id") === id) return rows[i];
    return null;
  }
  function focusRow(row) { if (row) { row.focus(); row.scrollIntoView({ block: "nearest" }); } }

  // --- narrow-screen views (#795) -------------------------------------------------
  // Under 760px the list and the reading pane are one view at a time (CSS keys on
  // data-view); under 1100px the folder rail is a drawer (data-rail). Wide screens
  // ignore both attributes, so this is pure presentation state.
  function setView(v) { $("app").setAttribute("data-view", v === "reading" ? "reading" : "list"); }
  function setRail(open) {
    $("app").setAttribute("data-rail", open ? "open" : "closed");
    $("railBtn").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      var cur = $("folders").querySelector("button.active") || $("folders").querySelector("button");
      if (cur) cur.focus();
    }
  }

  // --- reading ---------------------------------------------------------------
  function selectMessage(id, item) {
    var prev = $("list").querySelector(".row-item.sel");
    if (prev) { prev.classList.remove("sel"); prev.removeAttribute("aria-current"); }
    item = item || rowFor(id);
    if (item) { item.classList.add("sel"); item.setAttribute("aria-current", "true"); }
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
        // #410: scope the mark-read to OUR viewer explicitly. With no "for" field
        // this takes the estate path, which sets the row-level flag AND realigns
        // every other recipient override -- so A opening a shared message would mark
        // it read in B mailbox, the exact recipient boundary #350 exists to draw. The
        // worker now binds the viewer server-side too (belt and braces), but sending
        // it here also keeps a new page correct against an older worker, and it
        // mirrors what the IMAP door already does (posternimap/client.py). BYO-token
        // mode carries no bound identity in the page, so it sends no "for" and keeps
        // the documented estate behavior for an operator holding an estate token.
        var seenBody = { ids: [m.messageId], seen: true };
        if (state.authMode === "session" && state.identity && state.identity.from) {
          seenBody.for = state.identity.from;
        }
        apiOrganize("/api/messages/seen", seenBody).then(function () {
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
    setView("reading");
    var r = $("reading"); clear(r);
    r.appendChild(el("div", { class: "loading skel-read", role: "status" }, [
      el("span", { class: "vh", text: "Loading message" }),
      el("span", { class: "skel skel-title", "aria-hidden": "true" }),
      el("span", { class: "skel skel-line", "aria-hidden": "true", style: "width:40%" }),
      el("span", { class: "skel skel-body", "aria-hidden": "true" })
    ]));
  }
  function renderError(msg) {
    setView("reading");
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
    setView("reading");
    var r = $("reading"); clear(r);
    var err = el("div", { class: "err", text: "" });
    var status = el("span", { class: "compose-status", text: updatedAt ? "Saved" : "Not saved yet" });
    var toInput = el("input", { id: "cmpTo", type: "text", value: draft.to || opts.to || "", placeholder: "one@example.com, two@example.com" });
    var ccInput = el("input", { id: "cmpCc", type: "text", value: draft.cc || opts.cc || "" });
    var bccInput = el("input", { id: "cmpBcc", type: "text", value: draft.bcc || opts.bcc || "" });
    var subInput = el("input", { id: "cmpSub", type: "text", value: draft.subject || opts.subject || "" });
    var editor = el("div", {
      id: "cmpBody", class: "compose-editor" + (rich ? "" : " plain"),
      contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Message body"
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
    var fileInput = el("input", { id: "cmpFiles", type: "file", multiple: "multiple", class: "vh" });
    var fileList = el("ul", { class: "draft-files", id: "cmpFileList" });
    var quoteBox = el("div", { class: "quote-preview" });
    quoteBox.style.display = "none";
    var ccFields = el("div", { class: "cc-fields", id: "cmpCcFields" }, [
      el("label", { for: "cmpCc", text: "Cc" }), wrapAutocomplete(ccInput),
      el("label", { for: "cmpBcc", text: "Bcc" }), wrapAutocomplete(bccInput)
    ]);
    var ccOpen = !!(ccInput.value || bccInput.value);
    ccFields.style.display = ccOpen ? "" : "none";
    var ccToggle = el("button", {
      type: "button", class: "btn-quiet cc-toggle", text: "Cc / Bcc",
      "aria-controls": "cmpCcFields", "aria-expanded": ccOpen ? "true" : "false"
    });
    ccToggle.addEventListener("click", function () {
      var open = ccFields.style.display === "none";
      ccFields.style.display = open ? "" : "none";
      ccToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && !ccInput.disabled) ccInput.focus();
    });
    var form = el("div", { class: "compose" }, [
      el("div", { class: "compose-head" }, [
        el("h2", { text: mode === "replyAll" ? "Reply all" : mode === "reply" ? "Reply" : mode === "forward" ? "Forward" : "New message" }),
        status
      ]),
      el("p", { class: "compose-note", text: "Drafts save automatically while you type." }),
      err,
      el("label", { for: "cmpTo", text: "To" }),
      el("div", { class: "field-row" }, [el("div", { class: "grow" }, [wrapAutocomplete(toInput)]), ccToggle]),
      ccFields,
      el("label", { for: "cmpSub", text: "Subject" }), subInput,
      el("label", { for: "cmpBody", text: "Message" }),
      el("div", { class: "formatbar" }, [modeBtn]),
      formatbar, editor, quoteBox,
      el("div", { class: "file-pick" }, [
        fileInput,
        el("label", { for: "cmpFiles", class: "file-btn" }, [icon("clip"), document.createTextNode("Attach files")]),
        el("span", { class: "fhint", text: "Up to 20 files, 25 MiB in total" })
      ]),
      fileList,
      el("div", { class: "compose-actions" }, [
        el("button", { id: "cmpSend", text: "Send" }),
        el("button", { id: "cmpCancel", text: "Save and close" }),
        el("button", { id: "cmpDiscard", text: "Discard", class: "btn-danger" })
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

    function wrapAutocomplete(input) {
      var list = el("div", { class: "ac-list" });
      var wrap = el("div", { class: "ac-wrap" }, [input, list]);
      function hide() { list.className = "ac-list"; clear(list); }
      function showMatches() {
        var raw = input.value || "";
        var parts = raw.split(/[,;\\n]/);
        var prefix = (parts[parts.length - 1] || "").trim().toLowerCase();
        clear(list);
        if (!prefix || !state.recentRecipients.length) { hide(); return; }
        var hits = state.recentRecipients.filter(function (r) {
          return (r.address || "").toLowerCase().indexOf(prefix) === 0;
        }).slice(0, 8);
        if (!hits.length) { hide(); return; }
        hits.forEach(function (r) {
          var btn = el("button", { type: "button", text: r.address });
          btn.addEventListener("mousedown", function (ev) {
            ev.preventDefault();
            parts[parts.length - 1] = r.address;
            input.value = parts.join(", ").replace(/(,\\s*)+$/, "");
            hide();
            scheduleSave();
          });
          list.appendChild(btn);
        });
        list.className = "ac-list on";
      }
      input.addEventListener("input", showMatches);
      input.addEventListener("focus", showMatches);
      input.addEventListener("blur", function () { setTimeout(hide, 120); });
      return wrap;
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

    // Serialize attachment uploads and make Send wait for them. Without this, a
    // quick Send after picking a file dispatches before POST /attachments lands,
    // so the mail goes out with zero staged parts and the late upload 404s.
    var uploadChain = Promise.resolve();
    var uploadsPending = 0;

    function setSendEnabled() {
      var btn = $("cmpSend");
      if (!btn || closed) return;
      btn.disabled = uploadsPending > 0;
      btn.textContent = uploadsPending > 0 ? "Uploading..." : "Send";
    }

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
          el("span", {}, [fileNameNode(a.filename || "attachment"), " (" + fmtSize(a.size) + ")"]), remove
        ]));
      });
    }

    function uploadFile(file) {
      uploadsPending++;
      setSendEnabled();
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
        err.textContent = "Attachment upload failed: " + e.message;
        renderFiles();
        throw e;
      }).then(function () {
        uploadsPending--;
        setSendEnabled();
      }, function (e) {
        uploadsPending--;
        setSendEnabled();
        throw e;
      });
    }

    fileInput.addEventListener("change", function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      if (attachments.length + files.length > 20) { err.textContent = "At most 20 attachments are allowed."; return; }
      var total = attachments.reduce(function (sum, a) { return sum + (a.size || 0); }, 0);
      files.forEach(function (file) { total += file.size; });
      if (total > 25 * 1024 * 1024) { err.textContent = "Attachments exceed 25 MiB."; return; }
      // Keep a single chain so Send can await every in-flight upload.
      uploadChain = files.reduce(function (chain, file) {
        return chain.then(function () { return uploadFile(file); });
      }, uploadChain.catch(function () {}));
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
      // Wait for staged uploads first; otherwise draft send loads zero attachments.
      uploadChain.catch(function () {}).then(function () {
        if (uploadsPending > 0) {
          throw new Error("Attachments are still uploading; wait for them to finish.");
        }
        return saveDraft();
      }).then(function () {
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
        setSendEnabled();
        err.textContent = e.message + " Draft preserved for retry.";
      });
    });
  }

  function kv(label, value) {
    return el("div", { class: "kv" }, [el("b", { text: label + ": " }), document.createTextNode(value || "")]);
  }

  function renderReading(m) {
    var r = $("reading"); clear(r);
    if (!m) {
      setView("list");
      r.appendChild(el("div", { class: "empty" }, [emptyState("mail", "Select a message to read.", "")]));
      return;
    }
    setView("reading");
    state.selected = m;

    var sender = parseAddr(m.from);
    var when = m.date ? new Date(m.date) : null;
    var trustKids = [
      el("span", { class: "tag " + (m.trusted ? "trusted" : "untrusted"), text: m.trusted ? "trusted sender" : "untrusted sender" })
    ];
    if (m.auth) {
      trustKids.push(el("details", { class: "auth-detail" }, [
        el("summary", { text: "Authentication" }),
        el("span", { text: "SPF " + (m.auth.spf || "none") + ", DKIM " + (m.auth.dkim || "none") + ", DMARC " + (m.auth.dmarc || "none") })
      ]));
    }
    var head = el("div", { class: "msg-head" }, [
      el("h2", { text: m.subject || "(no subject)" }),
      el("div", { class: "sender" }, [
        avatar(m.from),
        el("div", { class: "sender-main" }, [
          el("div", { class: "sender-line" }, [
            el("span", { class: "sender-name", text: sender.name || "(unknown sender)" }),
            sender.addr && sender.addr !== sender.name ? el("span", { class: "sender-addr", text: "<" + sender.addr + ">" }) : null
          ]),
          kv("To", m.to),
          m.cc ? kv("Cc", m.cc) : null,
          m.bcc ? kv("Bcc", m.bcc) : null
        ]),
        el("div", {
          class: "sender-date",
          text: when && !isNaN(when.getTime()) ? when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "",
          title: m.date || ""
        })
      ]),
      el("div", { class: "trust" }, trustKids)
    ]);
    var actions = [];
    // Role queue (#425): read plus mark-read ONLY. Starring, filing and deleting would
    // write shared state on behalf of every other member of the queue, so the API
    // refuses them and the page must not offer them either -- an affordance that always
    // errors is worse than no affordance. Reply/forward stay available: you answer the
    // queue as YOURSELF, from your own identity, which is the honest semantic.
    var inQueue = !!currentRole();
    if (!m.isDraft && !inQueue) {
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
          toast("Star update failed: " + e.message, true);
          starBtn.disabled = false;
        });
      });
      actions.push(starBtn);

      function moveTo(mailbox, label, danger) {
        var btn = el("button", { text: label, class: danger ? "btn-danger" : "" });
        btn.addEventListener("click", function () {
          btn.disabled = true;
          apiOrganize("/api/messages/move", { ids: [m.messageId], mailbox: mailbox }).then(function () {
            toast(mailbox ? "Moved to " + label + "." : "Restored.");
            state.selected = null;
            resetAndLoad();
            renderReading(null);
          }).catch(function (e) {
            if (e.code === 401) { logout(); return; }
            toast("Move failed: " + e.message, true);
            btn.disabled = false;
          });
        });
        return btn;
      }
      if (m.mailbox === "trash" || m.mailbox === "junk" || m.mailbox === "archive") {
        actions.push(moveTo(null, "Restore"));
      } else {
        actions.push(moveTo("archive", "Archive"));
        actions.push(moveTo("trash", "Trash", true));
        actions.push(moveTo("junk", "Junk", true));
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
    if (inQueue) {
      head.appendChild(el("div", {
        class: "queue-note",
        text: "Shared queue: read and mark-read only. Marking read is yours alone, and a reply sends as "
          + ((state.identity && state.identity.from) || "you") + "."
      }));
    }
    r.appendChild(head);
    // At phone width the list (and the focused row) just disappeared, so move focus to
    // the message heading; otherwise keyboard and screen-reader users are left nowhere.
    if (NARROW_MQ && NARROW_MQ.matches) {
      var h = head.querySelector("h2");
      if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
    }

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
          el("span", {}, [icon("clip"), " ", fileNameNode(name), " ",
            el("span", { class: "sender-addr", text: (a.mime || "?") + ", " + fmtSize(a.size) })]),
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
        // The worker bounds a thread read (#649) and says so with a cursor. Printing just
        // the page length would claim the thread HAS that many messages, which is the
        // completeness lie the bound exists to prevent, moved to the human door.
        var partial = body.cursor ? ", first page" : "";
        box.appendChild(el("h3", { text: "Thread (" + msgs.length + partial + ")" }));
        msgs.forEach(function (tm) {
          var t = el("div", { class: "t-item" }, [
            el("div", { class: "top" }, [
              el("b", { text: parseAddr(tm.from).name }),
              el("span", { class: "sender-addr", text: " " + fmtDate(tm.date) })
            ]),
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
  $("settingsSignout").addEventListener("click", function () { $("settingsPanel").classList.remove("on"); logout(); });
  $("railBtn").addEventListener("click", function () {
    setRail($("app").getAttribute("data-rail") !== "open");
  });
  $("scrim").addEventListener("click", function () { setRail(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && $("app").getAttribute("data-rail") === "open") { setRail(false); $("railBtn").focus(); }
  });
  $("backBtn").addEventListener("click", function () {
    setView("list");
    var sel = $("list").querySelector(".row-item.sel");
    if (sel) sel.focus();
  });
  $("composeBtn").addEventListener("click", function () { renderComposeForm({}); });
  function setSettings(open) {
    $("settingsPanel").classList.toggle("on", open);
    $("settingsBtn").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) $("themeSelect").focus();
  }
  $("settingsBtn").addEventListener("click", function () {
    setSettings(!$("settingsPanel").classList.contains("on"));
  });
  $("skipLink").addEventListener("click", function (e) {
    e.preventDefault();
    var target = $("list").querySelector(".row-item.sel") || $("list").querySelector(".row-item");
    if (target) focusRow(target); else $("list").focus();
  });
  // Single-key shortcuts (#797). Never while typing, never with a modifier, and only
  // once the mailbox is showing.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if ($("settingsPanel").classList.contains("on")) { setSettings(false); $("settingsBtn").focus(); return; }
      if (NARROW_MQ && NARROW_MQ.matches && $("app").getAttribute("data-view") === "reading" &&
          $("app").getAttribute("data-rail") !== "open") { $("backBtn").click(); return; }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || !$("app").classList.contains("on")) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === "/") { e.preventDefault(); $("search").focus(); return; }
    if (e.key === "c" && $("composeBtn").style.display !== "none") { e.preventDefault(); $("composeBtn").click(); return; }
    if (e.key === "j" || e.key === "k") {
      var rows = listRows();
      if (!rows.length) return;
      var cur = rows.indexOf($("list").querySelector(".row-item.sel"));
      var next = e.key === "j" ? Math.min(cur + 1, rows.length - 1) : Math.max(cur - 1, 0);
      if (cur < 0) next = 0;
      e.preventDefault();
      focusRow(rows[next]);
      rows[next].click();
    }
  });
  $("themeSelect").addEventListener("change", function (e) {
    prefSet("postern_theme", THEMES.indexOf(e.target.value) >= 0 ? e.target.value : "system");
    applyChromePrefs();
  });
  $("themeBtn").addEventListener("click", function () {
    var next = THEMES[(THEMES.indexOf(themePref()) + 1) % THEMES.length];
    prefSet("postern_theme", next);
    applyChromePrefs();
  });
  if (DARK_MQ) {
    var onScheme = function () { if (themePref() === "system") retintPlainFrames(); };
    if (DARK_MQ.addEventListener) DARK_MQ.addEventListener("change", onScheme);
    else if (DARK_MQ.addListener) DARK_MQ.addListener(onScheme);
  }
  $("densitySelect").addEventListener("change", function (e) {
    prefSet("postern_density", e.target.value === "compact" ? "compact" : "comfortable");
    applyChromePrefs();
  });
  $("signinForm").addEventListener("submit", function (e) { e.preventDefault(); signIn(); });
  $("setupForm").addEventListener("submit", function (e) { e.preventDefault(); setupSubmit(); });
  $("pwForm").addEventListener("submit", function (e) { e.preventDefault(); changePassword(); });
  Array.prototype.forEach.call(document.querySelectorAll(".pw-toggle"), function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.getAttribute("data-toggle-for");
      setPwVisible(id, $(id).type === "password");
      $(id).focus();
    });
  });
  $("toTokenGate").addEventListener("click", function () { showGate(""); });
  $("toTokenFromOff").addEventListener("click", function () { showGate(""); });
  $("toSignin").addEventListener("click", function () { showSignin(""); });
  $("search").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { state.q = e.target.value.trim(); resetAndLoad(); }
  });
  $("searchMode").addEventListener("change", function (e) {
    state.searchMode = normalizeSearchMode(e.target.value);
    SS.setItem("postern_search_mode", state.searchMode);
    if (state.q) resetAndLoad();
  });
  $("chipUnseen").addEventListener("click", function () {
    state.filters.seen = state.filters.seen === false ? null : false;
    syncFilterChips();
    if (state.q) resetAndLoad();
  });
  $("chipSeen").addEventListener("click", function () {
    state.filters.seen = state.filters.seen === true ? null : true;
    syncFilterChips();
    if (state.q) resetAndLoad();
  });
  $("chipHasAtt").addEventListener("click", function () {
    state.filters.hasAttachment = state.filters.hasAttachment === true ? null : true;
    syncFilterChips();
    if (state.q) resetAndLoad();
  });
  function applyTextFilters() {
    state.filters.from = $("filterFrom").value.trim();
    state.filters.after = $("filterAfter").value || "";
    state.filters.before = $("filterBefore").value || "";
    updateFilterCount();
    if (state.q) resetAndLoad();
  }
  $("filterFrom").addEventListener("change", applyTextFilters);
  $("filterAfter").addEventListener("change", applyTextFilters);
  $("filterBefore").addEventListener("change", applyTextFilters);
  $("filtersBtn").addEventListener("click", function () {
    var open = $("filters").hasAttribute("hidden");
    if (open) $("filters").removeAttribute("hidden"); else $("filters").setAttribute("hidden", "");
    $("filtersBtn").setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("clearFilters").addEventListener("click", function () {
    state.filters = { from: "", after: "", before: "", seen: null, hasAttachment: null };
    syncFilterChips();
    if (state.q) resetAndLoad();
  });
  syncFilterChips();
  applyChromePrefs();
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
      state.setupRequired = !!(res.body && res.body.setupRequired === true);
      afterNoSession();
    }).catch(function () {
      state.authBackend = "off";
      state.discoveryFailed = true;
      afterNoSession();
    });
  }
  // No live session: honor an existing BYO-token in this tab, else show sign-in
  // (native backend) or the token gate (sessions off / unreachable).
  function afterNoSession() {
    if (state.origin && state.token) { state.authMode = "token"; showApp(); resetAndLoad(); return; }
    // setupRequired is only meaningful on an explicitly native backend (the server only
    // sends it then); never show first run on any other answer.
    if (state.authBackend === "native" && state.setupRequired) { showSetup(""); return; }
    if (state.authBackend === "native") { showSignin(""); return; }
    // Discovery failed (network): do not claim sign-in is off; offer the token gate.
    if (state.discoveryFailed) { showGate("Could not reach the server to check sign-in. Try again, or connect with an API token."); return; }
    showDisabled();
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

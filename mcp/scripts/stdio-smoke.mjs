#!/usr/bin/env node
// Stdio smoke for the Postern MCP server: boot the built server over a real stdio
// JSON-RPC transport and assert the tool surface matches the configured scope.
//
//   - Read-only (POSTERN_API_TOKEN, no send token): exactly the 4 read tools.
//   - Send-enabled (+ POSTERN_SEND_TOKEN): the 4 read tools + the 2 send tools.
//
// This is a BOOT/registration check: tools register at startup, so no network call
// is made and the dummy URL/token are never dialed. It proves the default-OFF gate
// (send tools are absent unless a send token is present). Live request scope-gating
// (read token -> 403 on send, send token -> 403 on read) is enforced by the worker
// (#85) and verified separately against the live API.
//
// Run: node scripts/stdio-smoke.mjs   (from mcp/, after `npm run build`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "..", "dist", "index.js");

const READ_TOOLS = ["mailbox_get", "mailbox_list", "mailbox_search", "mailbox_thread"];
const SEND_TOOLS = ["mailbox_reply", "mailbox_send"];

// Drive one server process: initialize, list tools, return the sorted tool names.
function listTools(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout; stderr:\n${stderr}`));
    }, 10000);

    child.stdout.on("data", (d) => {
      out += d.toString();
      // tools/list reply is id:2; resolve once we have seen it.
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          resolvePromise({ names: msg.result.tools.map((t) => t.name).sort(), stderr });
          return;
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

function assertEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`ok   ${label}: ${a}`);
  return true;
}

const baseEnv = { POSTERN_API_URL: "https://example.invalid", POSTERN_API_TOKEN: "read-dummy" };

console.log("postern-mcp stdio smoke (boot-level scope gate)\n");

// 1) Read-only: no send token -> send tools must NOT register.
const readOnly = await listTools({ ...baseEnv, POSTERN_SEND_TOKEN: "" });
assertEqual("read-only server exposes exactly the read tools", readOnly.names, READ_TOOLS);
if (readOnly.names.some((n) => SEND_TOOLS.includes(n))) {
  console.error("FAIL send tools leaked into the read-only server");
  process.exitCode = 1;
}

// 2) Send-enabled: send token present -> read + send tools register.
const sendEnabled = await listTools({ ...baseEnv, POSTERN_SEND_TOKEN: "send-dummy" });
assertEqual("send-enabled server exposes read + send tools", sendEnabled.names, [...READ_TOOLS, ...SEND_TOOLS].sort());
if (!/send tools ENABLED/.test(sendEnabled.stderr)) {
  console.error("FAIL expected the 'send tools ENABLED' startup notice on stderr");
  process.exitCode = 1;
} else {
  console.log("ok   startup notice: 'send tools ENABLED' present on stderr");
}

console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");

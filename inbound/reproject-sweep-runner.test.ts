import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";

// #507: the sweep RUNNER, driven as a real process against a real HTTP server.
//
// The runner is a loop, and the failure mode that matters is not a crash: it is a loop
// that stops early and prints a clean summary. That already happened once in this repo
// (a sweep paged on a field name the API does not return and quietly finished at 50 of
// 64 rows, reporting success). A unit test of the script internals cannot see that,
// because the bug lives in the agreement between the loop and the wire. So these gates
// spawn the actual script against a scripted server and read its exit code.

const SCRIPT = "scripts/reproject-sweep.mjs";

interface Recorded {
  bodies: any[];
}

function serve(pages: any[], recorded: Recorded): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      recorded.bodies.push(raw ? JSON.parse(raw) : {});
      const next = pages.shift() ?? { ok: true, done: true, processed: 0 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(next));
    });
  });
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server);
}

function run(server: Server, args: string[] = [], env: Record<string, string> = {}) {
  const port = (server.address() as AddressInfo).port;
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: {
      ...process.env,
      POSTERN_BASE_URL: `http://127.0.0.1:${port}`,
      POSTERN_ADMIN_TOKEN: "admin-token",
      ...env,
    },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

let open: Server | null = null;
afterEach(async () => {
  if (open) {
    open.close();
    open = null;
  }
});

describe("reproject sweep runner (#507)", () => {
  it("is dry-run by DEFAULT and never asks the worker to write", async () => {
    const recorded: Recorded = { bodies: [] };
    open = await serve(
      [{ ok: true, total: 2, processed: 2, updated: 2, unchanged: 0, missing: 0, failed: 0, nextCursor: null, done: true, dryRun: true }],
      recorded,
    );
    const { code, out } = await run(open);
    expect(code).toBe(0);
    expect(recorded.bodies.every((b) => b.dryRun === true)).toBe(true);
    expect(out).toContain("dry-run");
    expect(out).toContain("Nothing was written");
  });

  it("--yes is what flips it to writing", async () => {
    const recorded: Recorded = { bodies: [] };
    open = await serve(
      [{ ok: true, total: 1, processed: 1, updated: 1, unchanged: 0, missing: 0, failed: 0, nextCursor: null, done: true, dryRun: false }],
      recorded,
    );
    const { code, out } = await run(open, ["--yes"]);
    expect(code).toBe(0);
    // The walk itself writes (dryRun:false); the end-of-run total recheck (#515) is
    // ALWAYS a dry run regardless of --yes, since it exists only to read a count, so
    // it is excluded from this check and asserted separately.
    expect(recorded.bodies.slice(0, -1).every((b) => b.dryRun === false)).toBe(true);
    expect(recorded.bodies[recorded.bodies.length - 1]).toMatchObject({ dryRun: true, limit: 1 });
    expect(out).toContain("MODE: WRITE");
  });

  it("follows nextCursor across pages and covers every row", async () => {
    const recorded: Recorded = { bodies: [] };
    open = await serve(
      [
        { ok: true, total: 5, processed: 2, updated: 2, unchanged: 0, missing: 0, failed: 0, nextCursor: "c1", done: false },
        { ok: true, processed: 2, updated: 2, unchanged: 0, missing: 0, failed: 0, nextCursor: "c2", done: false },
        { ok: true, processed: 1, updated: 1, unchanged: 0, missing: 0, failed: 0, nextCursor: null, done: true },
        // the end-of-run total recheck (#515): store unchanged since the walk started
        { ok: true, total: 5, processed: 1, updated: 0, unchanged: 1, missing: 0, failed: 0, nextCursor: null, done: true },
      ],
      recorded,
    );
    const { code, out } = await run(open, ["--yes"]);
    expect(code).toBe(0);
    expect(recorded.bodies.length).toBe(4);
    // CONTROL: it really did send the cursors back, in order. A runner that ignored
    // them would still make three calls against this server and still "pass".
    expect(recorded.bodies[1].cursor).toBe("c1");
    expect(recorded.bodies[2].cursor).toBe("c2");
    // the 4th call is the end-of-run recheck: no cursor, always dry-run, cheap (limit 1)
    expect(recorded.bodies[3]).toMatchObject({ dryRun: true, limit: 1 });
    expect(recorded.bodies[3].cursor).toBeUndefined();
    expect(out).toContain("5 of 5 row(s) examined");
  });

  it("REFUSES to call a partial sweep complete when done=false carries no cursor", async () => {
    // The trap, made into a gate: an API shape change that renamed or dropped the
    // cursor field must stop the run loudly instead of printing a clean summary.
    const recorded: Recorded = { bodies: [] };
    open = await serve(
      [{ ok: true, total: 64, processed: 50, updated: 50, unchanged: 0, missing: 0, failed: 0, cursor: "c1", done: false }],
      recorded,
    );
    const { code, err } = await run(open, ["--yes"]);
    expect(code).toBe(1);
    expect(err).toContain("no nextCursor");
    expect(err).toContain("Refusing");
  });

  // #515: storeTotal is sampled at the START of the sweep (store.ts reads it before
  // the first page's rows), and the runner now re-samples it again at the END with
  // one cheap dry-run page. A live mailbox does not only grow while the sweep runs
  // (mail arrives): it can also shrink (CI smoke self-clean, hand-run debris
  // sweeps, IMAP EXPUNGE all delete rows). The real incident this guards against
  // ran 216 pages, converted every row, and still exited FATAL because the store
  // had GROWN during the ~2h run; a symmetric incident (rows deleted mid-run) would
  // trip the identical false FATAL through the opposite door. These tests prove
  // every direction: growth alone must never fail it, deletion alone must never
  // fail it either, and a genuine shortfall (rows that existed throughout the run
  // and were never walked) still must -- checked against whichever of the start
  // and end totals is smaller, since that is the one no legitimate concurrent
  // change (growth OR deletion) can explain away.
  it("does NOT fail when the mailbox grew during the run (processed ends up above the start total)", async () => {
    const recorded: Recorded = { bodies: [] };
    open = await serve(
      [{ ok: true, total: 50, processed: 64, updated: 64, unchanged: 0, missing: 0, failed: 0, nextCursor: null, done: true }],
      recorded,
    );
    const { code, out, err } = await run(open, ["--yes"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("NOTE");
    expect(out).toContain("14 more");
    expect(out).not.toContain("FATAL");
  });

  it("does NOT fail when rows are deleted during the run (end total lower than the start total)", async () => {
    const recorded: Recorded = { bodies: [] };
    open = await serve(
      [
        // start of run: store reports 100 rows; the walk reaches 90 of them before
        // some of the remaining ones are deleted out from under it.
        { ok: true, total: 100, processed: 90, updated: 90, unchanged: 0, missing: 0, failed: 0, nextCursor: null, done: true },
        // end-of-run recheck: 15 rows were deleted meanwhile, store is down to 85.
        { ok: true, total: 85, processed: 1, updated: 0, unchanged: 1, missing: 0, failed: 0, nextCursor: null, done: true, dryRun: true },
      ],
      recorded,
    );
    const { code, out, err } = await run(open, ["--yes"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("NOTE");
    expect(out).toContain("shrank");
    expect(out).not.toContain("FATAL");
    expect(recorded.bodies.length).toBe(2);
    expect(recorded.bodies[1]).toMatchObject({ dryRun: true, limit: 1 });
    expect(recorded.bodies[1].cursor).toBeUndefined();
  });

  it("still fails when coverage is genuinely incomplete (processed ends up below both totals)", async () => {
    const recorded: Recorded = { bodies: [] };
    open = await serve(
      [{ ok: true, total: 64, processed: 50, updated: 50, unchanged: 0, missing: 0, failed: 0, nextCursor: null, done: true }],
      recorded,
    );
    const { code, err } = await run(open, ["--yes"]);
    expect(code).toBe(1);
    expect(err).toContain("did NOT cover the whole mailbox");
  });

  it("falls back to the start-of-run total, with a WARNING, when the end-of-run recheck itself fails", async () => {
    // The recheck is a real network call and can fail on its own (worker restart,
    // transient 5xx). That must degrade to the OLD (start-total-only) behavior with
    // a loud warning, never crash the run and never silently skip the guard.
    const recorded: Recorded = { bodies: [] };
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        recorded.bodies.push(body);
        if (body.limit === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "E_INTERNAL" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(
          { ok: true, total: 5, processed: 5, updated: 5, unchanged: 0, missing: 0, failed: 0, nextCursor: null, done: true },
        ));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    open = server;
    const { code, err } = await run(open, ["--yes"]);
    expect(code).toBe(0);
    expect(err).toContain("WARNING");
    expect(err).toContain("could not re-sample");
  });

  it("fails when any row did not verify on read-back", async () => {
    const recorded: Recorded = { bodies: [] };
    open = await serve(
      [{ ok: true, total: 3, processed: 3, updated: 2, unchanged: 0, missing: 0, failed: 1, nextCursor: null, done: true }],
      recorded,
    );
    const { code, err } = await run(open, ["--yes"]);
    expect(code).toBe(1);
    expect(err).toContain("did not verify on read-back");
  });

  it("stops with an error at --max-pages instead of reporting a complete sweep", async () => {
    const recorded: Recorded = { bodies: [] };
    const endless = Array.from({ length: 10 }, () => ({
      ok: true, total: 100, processed: 1, updated: 1, unchanged: 0, missing: 0, failed: 0, nextCursor: "c", done: false,
    }));
    open = await serve(endless, recorded);
    const { code, err } = await run(open, ["--yes", "--max-pages", "2"]);
    expect(code).toBe(1);
    expect(err).toContain("INCOMPLETE");
  });

  it("refuses to run without credentials, and takes them from the env only", async () => {
    const recorded: Recorded = { bodies: [] };
    open = await serve([], recorded);
    const { code, err } = await run(open, [], { POSTERN_ADMIN_TOKEN: "" });
    expect(code).toBe(2);
    expect(err).toContain("POSTERN_ADMIN_TOKEN is required");
    // CONTROL: it refused before making any request at all.
    expect(recorded.bodies.length).toBe(0);
  });

  it("surfaces a non-200 from the worker instead of continuing", async () => {
    const recorded: Recorded = { bodies: [] };
    const server = createServer((req, res) => {
      recorded.bodies.push({});
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "E_FORBIDDEN" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    open = server;
    const { code, err } = await run(open, ["--yes"]);
    expect(code).toBe(1);
    expect(err).toContain("reproject failed: HTTP 403");
  });
});

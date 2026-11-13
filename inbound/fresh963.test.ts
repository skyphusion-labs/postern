// #963 (a): eval/fresh963.mjs, the passive "send to findable" driver. A scripted fake deploy on
// a fake clock: messages arrive, the index processes them after a set delay, the search finds
// them after another. The live gap itself is proven only by the operator window.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- eval/ is plain ESM with no type declarations
import { decide, summarize, track } from "./eval/fresh963.mjs";

const SECRET = "zanzibar";
type Msg = { messageId: string; subject: string; arriveMs: number; processAfterMs: number; findAfterMs: number };

/** A deploy whose Worker clock is `skewMs` away from the driver's: gaps must use the Worker's only. */
function deploy(msgs: Msg[], clock: { t: number }, o: { skewMs?: number; noUpsert?: boolean } = {}) {
  const worker = () => clock.t + (o.skewMs ?? 0);
  const get = async (path: string) => {
    const url = new URL("https://x" + path);
    const arrived = msgs.filter((m) => m.arriveMs <= clock.t);
    if (url.pathname === "/api/messages") return { items: [...arrived].reverse().map((m) => ({ messageId: m.messageId, subject: m.subject, date: "" })) };
    const m = msgs.find((x) => x.subject === url.searchParams.get("q"))!;
    const upserted = m.arriveMs + (o.skewMs ?? 0);
    const processed = worker() >= upserted + m.processAfterMs;
    const found = worker() >= upserted + m.findAfterMs;
    if (url.pathname === "/api/admin/search-debug") {
      return {
        ok: true,
        serverNowMs: worker(),
        index: { processedUpToMs: processed ? worker() : upserted - 1, processedUpToMutation: "u", vectorCount: 1 },
        gold: { verdict: found ? "in-raw" : processed ? "outranked" : "not-yet-queryable", pending: !processed, ...(o.noUpsert ? {} : { upsertedMs: upserted }) },
      };
    }
    if (url.pathname === "/api/search") return { items: found ? [{ message: { messageId: m.messageId }, similar: { ids: [] } }] : [] };
    throw new Error("unexpected " + url.pathname);
  };
  const sleep = async (ms: number) => { clock.t += ms; };
  return { get, sleep, now: () => clock.t };
}

const OPTS = { minutes: 10, poll: 5, listEvery: 30, maxWait: 300, window: 25 };
const msg = (i: number, arriveS: number, procS: number, findS: number): Msg => ({
  messageId: `m${i}-${SECRET}@mail.example`, subject: `Subject ${SECRET} ${i}`, arriveMs: arriveS * 1000, processAfterMs: procS * 1000, findAfterMs: findS * 1000,
});

describe("#963 fresh963 track", () => {
  it("ignores the messages already there at the start, tracks the new ones, and measures on the Worker's clock", async () => {
    const clock = { t: 0 };
    const msgs = [msg(0, -60, 1, 2), msg(1, 40, 8, 12), msg(2, 100, 3, 20)];
    const d = deploy(msgs, clock, { skewMs: 3_600_000 }); // the Worker is an hour off this machine
    const res = await track(d.get, d.sleep, d.now, OPTS);
    expect(res.tracked).toBe(2);
    const [a, b] = res.rows;
    // Seen at the first listing after arrival (the 30 s cadence), so the floor is up to 30 s:
    expect(a.firstSeenS).toBeGreaterThanOrEqual(0);
    // foundS is at least the scripted find delay and at most one poll after the later of that and first sight.
    expect(a.foundS).toBeGreaterThanOrEqual(12);
    expect(a.foundS).toBeLessThanOrEqual(Math.max(12, a.firstSeenS) + 5);
    expect(b.foundS).toBeGreaterThanOrEqual(20);
    expect(a.processedS).toBeLessThanOrEqual(a.foundS);
    // An hour of skew does not leak into a gap: every gap is seconds, not thousands of them.
    for (const r of res.rows) expect(r.foundS).toBeLessThan(60);
  });

  it("records the verdict sequence, and a message never found within the wait is a timeout", async () => {
    const clock = { t: 0 };
    const d = deploy([msg(1, 10, 2, 10_000)], clock);
    const res = await track(d.get, d.sleep, d.now, { ...OPTS, maxWait: 60 });
    expect(res.rows[0].timeout).toBe(true);
    expect(res.rows[0].foundS).toBeNull();
    expect(res.rows[0].verdicts[0]).toMatch(/not-yet-queryable|outranked/);
  });

  it("a route without upsertedMs is said out loud, and gives no gap", async () => {
    const clock = { t: 0 };
    const d = deploy([msg(1, 10, 2, 4)], clock, { noUpsert: true });
    const res = await track(d.get, d.sleep, d.now, OPTS);
    expect(res.rows[0].noUpsertTime).toBe(true);
    expect(res.rows[0].foundS).toBeNull();
    expect(summarize(res)).toContain("predates #963");
  });

  it("PRIVACY: no subject or Message-ID reaches the summary or the JSON rows", async () => {
    const clock = { t: 0 };
    const d = deploy([msg(1, 10, 2, 4), msg(2, 20, 2, 4)], clock);
    const res = await track(d.get, d.sleep, d.now, OPTS);
    const out = summarize(res) + "\n" + JSON.stringify(res.rows);
    expect(JSON.stringify(await d.get("/api/messages?direction=inbound"))).toContain(SECRET); // control
    expect(out).not.toContain(SECRET);
    expect(out).not.toMatch(/@mail\.example/);
  });
});

describe("#963 decide: the rows fixed before the measurement", () => {
  it("fewer than 10 found is too few to decide", () => expect(decide([1, 2, 3]).row).toBe("too-few"));
  it("p95 <= 30 s and max <= 120 s: no product change", () => expect(decide([...Array(19).fill(5), 30]).row).toBe("no-change"));
  it("p95 above 30 s: semantic adds the fresh FTS hits", () => expect(decide([...Array(18).fill(5), 40, 40]).row).toBe("semantic-adds-fresh-fts"));
  it("one message above 2 minutes: semantic adds the fresh FTS hits", () => expect(decide([...Array(19).fill(5), 121]).row).toBe("semantic-adds-fresh-fts"));
  it("a timeout (null) is not a fast message", () => expect(decide([...Array(10).fill(5), null]).n).toBe(10));
});

import { describe, it, expect } from "vitest";
import * as ingestMod from "./src/ingest";
import { bareDomain } from "./src/headers";

// The header From is attacker input. Parsing it for trust must be LINEAR and bounded:
// a quoted-string regex that restarts at every quote is polynomial on an unterminated
// quote followed by many `\"`, which is a CPU-exhaustion vector on the Worker.

const { singleFromAddress, stripQuotedStrings } = ingestMod;
const MAX = (ingestMod as unknown as { MAX_FROM_LENGTH?: number }).MAX_FROM_LENGTH;

function timed<T>(f: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = f();
  return { value, ms: performance.now() - t0 };
}

describe("singleFromAddress: linear and bounded", () => {
  it("returns null for 50k chars of an unterminated quote plus \\\" repeats, under 50ms", () => {
    const evil = '"' + '\\"'.repeat(25_000);
    expect(evil.length).toBeGreaterThan(50_000);
    const r = timed(() => singleFromAddress(evil));
    expect(r.value).toBeNull();
    expect(r.ms).toBeLessThan(50);
  });

  it("stays linear on the same shape just under the length cap", () => {
    expect(MAX).toBe(2048);
    const evil = ('"' + '\\"'.repeat(1_100)).slice(0, 2048);
    expect(evil.length).toBe(2048);
    // Repeat to make a quadratic scan measurable at this size.
    const r = timed(() => { for (let k = 0; k < 200; k++) singleFromAddress(evil); return singleFromAddress(evil); });
    expect(r.value).toBeNull();
    expect(r.ms).toBeLessThan(50);
  });

  it("an unterminated quote makes the address untrusted", () => {
    expect(singleFromAddress('"CEO <ceo@skyphusion.org>')).toBeNull();
    expect(singleFromAddress('"CEO \\" <x@evil.example>" <ceo@skyphusion.org')).toBeNull();
    // Dropping (or keeping) the text after an open quote would leave a valid address.
    expect(singleFromAddress('ceo@skyphusion.org "trailing')).toBeNull();
    expect(stripQuotedStrings('a "b" c "open')).toBeNull();
    expect(stripQuotedStrings('a "b\\"c" d')).toBe("a  d");
  });

  it("still drops a terminated quoted display name, escapes honoured", () => {
    expect(singleFromAddress('"Doe, Jane @ HQ \\" x" <alerts@skyphusion.org>')).toBe("alerts@skyphusion.org");
    expect(singleFromAddress("alerts@skyphusion.org")).toBe("alerts@skyphusion.org");
  });

  it("caps the From value at 2048 chars: longer returns null", () => {
    const addr = "<alerts@skyphusion.org>";
    const atCap = '"' + "a".repeat(2048 - addr.length - 3) + '" ' + addr;
    expect(atCap.length).toBe(2048);
    expect(singleFromAddress(atCap)).toBe("alerts@skyphusion.org");
    const over = '"' + "a".repeat(2048 - addr.length - 2) + '" ' + addr;
    expect(over.length).toBe(2049);
    expect(singleFromAddress(over)).toBeNull();
  });
});

describe("bareDomain: long labels are refused without regex work", () => {
  it("a 100k-char label returns null quickly", () => {
    const r = timed(() => bareDomain("a".repeat(100_000) + ".example"));
    expect(r.value).toBeNull();
    expect(r.ms).toBeLessThan(50);
  });
});

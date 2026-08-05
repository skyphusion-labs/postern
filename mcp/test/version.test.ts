// Without this the advertised version is a hand-maintained copy that can drift
// silently; with it, a drifted copy cannot pass CI.
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";
import pkg from "../package.json";

describe("version", () => {
  it("advertised serverInfo version matches package.json (no npm drift)", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is not the stale hardcoded 1.3.0 this file exists to prevent", () => {
    expect(VERSION).not.toBe("1.3.0");
  });
});

import { describe, it, expect } from "vitest";
import { templateKey } from "./src/semrank";
import { shapeKey } from "./eval/shape813.mjs";

// #940: eval/replay813.mjs splits known-item probes by template family, using a copy of the
// key in eval/shape813.mjs (a plain node script cannot import TypeScript). If the copy drifts,
// the replay would report a family split the server does not make. This pins them together.
describe("eval shapeKey matches semrank.templateKey (#940)", () => {
  const cases: Array<[string, string]> = [
    ["CI <ci@example.com>", "Run failed: build (main) 3f2a9c1d0e"],
    ["ci@example.com", "Re: Fwd: Order #12345 shipped"],
    ["\"Shop\" <shop@example.com>", "Your order 998877 has shipped"],
    ["alerts@example.com", "New sign-in from Chrome on Mac"],
    ["person@example.com", "  lunch   on Thursday?  "],
    ["", ""],
    ["pr@example.com", "PR #42 checks failed: abcdef0123456"],
    ["x@example.com", "RE: fw: re: deadbeef status 7"],
    // A 7-character hex run is the boundary of the hex mask: it must be masked as a hash.
    ["ci@example.com", "Build 1a2b3c4 failed"],
  ];
  for (const [from, subject] of cases) {
    it(`agrees on ${JSON.stringify(subject)}`, () => {
      expect(shapeKey(from, subject)).toBe(templateKey(from, subject));
    });
  }
  it("a digit-only difference lands in the same family", () => {
    expect(shapeKey("a@x.io", "Invoice 1001")).toBe(shapeKey("a@x.io", "Invoice 2002"));
  });
});

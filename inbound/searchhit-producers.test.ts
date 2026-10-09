// #652: a field declared on the wire type that NOTHING produces.
//
// `snippet?: string` sat on SearchHit in inbound/src/store.ts and was mirrored on
// mcp/src/types.ts. No code path in the worker ever wrote it, so every consumer read
// `undefined`. An unproduced optional is not harmless: a client may reasonably code
// against a declared field, and a reader of the type learns something untrue about the
// store.
//
// #646 is what settled the direction. The field projection landed and deliberately left
// `snippet` OUT of SUMMARY_FIELDS, so `fields=snippet` answers 400 rather than a key
// nothing fills (see the SUMMARY_FIELDS note in store.ts). The projection was the one
// caller that could have forced a producer, and it declined. So the honest outcome is
// DELETE, and this file is what stops the declaration coming back without one.
//
// The assertion reads the SOURCE, not a response, and that is deliberate: the defect is
// a DECLARATION. A response cannot demonstrate the absence of a key that was always
// absent, so a behavioural probe here would pass on the broken tree, which is the one
// thing a test for this defect may not do.
//
// What this CANNOT see: the producer check is a source match for an assignment of the
// key name, so a field assigned only through a computed or spread expression would read
// as unproduced, and a field named in some unrelated statement would read as produced.
// It is strong where it matters -- a field nobody fills appears nowhere at all -- and it
// is stated here rather than implied.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";

const STORE_SRC = readFileSync(new URL("./src/store.ts", import.meta.url), "utf8");
const MCP_TYPES_SRC = readFileSync(new URL("../mcp/src/types.ts", import.meta.url), "utf8");

// Both halves of the pair, because the type is MIRRORED: deleting the worker's
// declaration while the published client keeps its own still leaves an agent coding
// against a field that never arrives.
const DECLARATIONS = [
  ["inbound/src/store.ts", STORE_SRC],
  ["mcp/src/types.ts", MCP_TYPES_SRC],
] as const;

/** The body of `export interface SearchHit { ... }`, or a failed expectation. */
function searchHitBody(label: string, src: string): string {
  const m = src.match(/export interface SearchHit \{([\s\S]*?)\n\}/);
  expect(m, `${label}: no SearchHit declaration, so every assertion below is vacuous`).toBeTruthy();
  return (m as RegExpMatchArray)[1];
}

/** Every optional key the declaration carries. */
function optionalKeys(body: string): string[] {
  return [...body.matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]);
}

describe("#652 SearchHit declares no field the worker cannot fill", () => {
  it("CONTROL: both declarations loaded, and the key reader finds real optional keys", () => {
    for (const [label, src] of DECLARATIONS) {
      const keys = optionalKeys(searchHitBody(label, src));
      // `score` is the positive: declared optional AND genuinely produced (the
      // score-ranked modes push it). If the reader cannot see it, a zero below is the
      // instrument, not the type.
      expect(keys, `${label}: the optional-key reader returned nothing recognizable`).toContain("score");
      expect(optionalKeys("nothing here"), "the reader invents keys").toEqual([]);
    }
  });

  it("every optional key on SearchHit has a producer in the worker", () => {
    const orphans: string[] = [];
    for (const [label, src] of DECLARATIONS) {
      for (const key of optionalKeys(searchHitBody(label, src))) {
        // A producer writes the key: `score: r.score`, `snippet: excerpt(...)`. The
        // search is the WORKER source in both passes, because the worker is the only
        // thing that can fill either copy of the type.
        if (!new RegExp(`\\b${key}\\s*:\\s*[^;\\n]*[,)}]`).test(STORE_SRC)) {
          orphans.push(`${label}: SearchHit.${key}`);
        }
      }
    }
    expect(
      orphans,
      `declared on the wire type with nothing in the worker writing it: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});

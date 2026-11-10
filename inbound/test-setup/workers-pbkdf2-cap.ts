// The deployed Cloudflare Workers runtime refuses PBKDF2 above 100,000 iterations
// ("Pbkdf2 failed: iteration counts above 100000 are not supported", #821). Node and
// local wrangler dev accept more, so a suite running on Node could never see the
// defect that broke every native credential in production. This setup file gives the
// WHOLE suite the edge's limit: any PBKDF2 derivation above the cap throws exactly as
// the edge does, so a regression goes red in every auth test, not just one.
//
// pbkdf2-cap.test.ts proves the shim itself fires (a guard is trusted only once it has
// been seen to fail on the real refusal path).

export const WORKERS_PBKDF2_MAX_ITERATIONS = 100_000;

type DeriveBits = (algorithm: unknown, baseKey: unknown, length?: unknown) => Promise<ArrayBuffer>;
interface SubtleLike { deriveBits: DeriveBits }

const subtle = (globalThis as unknown as { crypto: { subtle: SubtleLike } }).crypto.subtle;
const proto = Object.getPrototypeOf(subtle) as SubtleLike;
const original = proto.deriveBits;
const MARK = Symbol.for("postern.workersPbkdf2Cap");

if (!(original as unknown as Record<symbol, boolean>)[MARK]) {
  const capped: DeriveBits = function (this: SubtleLike, algorithm, baseKey, length) {
    const alg = algorithm as { name?: unknown; iterations?: unknown };
    if (
      typeof alg === "object" && alg !== null &&
      String(alg.name).toUpperCase() === "PBKDF2" &&
      typeof alg.iterations === "number" && alg.iterations > WORKERS_PBKDF2_MAX_ITERATIONS
    ) {
      return Promise.reject(
        new Error(
          "Pbkdf2 failed: iteration counts above " + WORKERS_PBKDF2_MAX_ITERATIONS +
            " are not supported (requested " + alg.iterations + ")",
        ),
      );
    }
    return original.call(this, algorithm, baseKey, length);
  };
  (capped as unknown as Record<symbol, boolean>)[MARK] = true;
  proto.deriveBits = capped;
}

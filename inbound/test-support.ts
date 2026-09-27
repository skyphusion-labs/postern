// Shared narrowing helpers for the test type project (#638).
//
// Deliberately NOT in fakes.ts: fakes.ts simulates the store contract, and has twice
// been found simulating a DIFFERENT contract than the real store. These helpers assert
// nothing about behaviour; they only turn an optional binding into a checked one.

/**
 * `Env.VECTORIZE` is optional (src/env.d.ts:45) because a deployment may legitimately
 * run with no Vectorize binding. Every fake env provides it, so a test may rely on it,
 * but it must narrow to do so.
 *
 * This throws instead of using a bare non-null assertion on purpose. A `!` erases the
 * question at compile time and leaves a fake that silently stopped providing the binding
 * to fail later as `undefined.upsert is not a function`, several frames from the cause.
 * The throw names the cause at the point the assumption is made.
 */
export function vectorizeOf(env: Env): VectorizeIndex {
  const index = env.VECTORIZE;
  if (index === undefined) {
    throw new Error("fake env is missing the VECTORIZE binding that this test requires");
  }
  return index;
}

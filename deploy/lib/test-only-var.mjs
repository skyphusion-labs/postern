// POSTERN_TEST_PBKDF2_ITERATIONS lowers password hashing strength. It is legal
// only inside the vitest suite. A deploy (tag workflow or installer) that would
// carry it in wrangler vars or as a Worker secret is refused by name. The value
// never appears in the message: this is a public repo, and the count is not needed
// to act.

export const TEST_PBKDF2_ITERATIONS_VAR = "POSTERN_TEST_PBKDF2_ITERATIONS";

function secretNameList(secretNames) {
  if (!Array.isArray(secretNames)) return [];
  return secretNames
    .map((s) => (typeof s === "string" ? s : s && s.name))
    .filter((n) => typeof n === "string");
}

export function testOnlyVarPresent(vars, secretNames) {
  const inVars = vars != null && typeof vars === "object" && !Array.isArray(vars)
    && Object.prototype.hasOwnProperty.call(vars, TEST_PBKDF2_ITERATIONS_VAR);
  const inSecrets = secretNameList(secretNames).includes(TEST_PBKDF2_ITERATIONS_VAR);
  return { inVars, inSecrets };
}

export function testOnlyVarRefusal(vars, secretNames) {
  const { inVars, inSecrets } = testOnlyVarPresent(vars, secretNames);
  if (!inVars && !inSecrets) return null;
  const where = [
    inVars ? "the wrangler config vars being deployed" : null,
    inSecrets ? "the Worker secret list" : null,
  ].filter(Boolean).join(" and ");
  return (
    TEST_PBKDF2_ITERATIONS_VAR +
    " is set in " + where +
    ". That variable is test-only and lowers password hashing strength. Remove it and re-run."
  );
}

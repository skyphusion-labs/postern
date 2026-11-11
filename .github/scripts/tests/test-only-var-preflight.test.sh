#!/usr/bin/env bash
# Regression suite for the test-only PBKDF2 deploy gate (#909).
#
# POSTERN_TEST_PBKDF2_ITERATIONS lowers hashing strength. The tagged deploy must
# go RED when that name appears in the wrangler vars being shipped or in the
# Worker secret list, and stay GREEN on a clean config. The un-stubbable seam
# (the live secret list against the real account) runs only on a tag deploy.
# What is testable here is the verdict: a planted name is red, a clean file is
# green, a read it could not perform is red, and the value never appears.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/test-only-var-preflight.mjs"
work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

pass_count=0
fail_count=0
ok()  { printf "  ok    %s\n" "$1"; pass_count=$((pass_count + 1)); }
bad() { printf "  FAIL  %s\n" "$1"; fail_count=$((fail_count + 1)); }

# Distinctive planted VALUE. The gate must name the variable and never this.
PLANTED="WEAK-ITER-77"

mkconfig() { # mkconfig <file> <planted? 0|1>
  if [ "$2" = "1" ]; then
    cat > "$1" <<JSON
{
  // JSONC comment, plus a URL whose // must survive the stripper.
  "name": "postern",
  "main": "src/index.ts",
  "vars": {
    "DOCS": "https://example.invalid/docs#anchor",
    "FORWARD_TO": "",
    "POSTERN_TEST_PBKDF2_ITERATIONS": "$PLANTED",
  },
}
JSON
  else
    cat > "$1" <<JSON
{
  "name": "postern",
  "main": "src/index.ts",
  "vars": {
    "DOCS": "https://example.invalid/docs#anchor",
    "FORWARD_TO": "",
  },
}
JSON
  fi
}

mksecrets() { # mksecrets <file> <planted? 0|1>
  if [ "$2" = "1" ]; then
    cat > "$1" <<JSON
{ "success": true, "result": [
  { "name": "POSTERN_API_TOKEN", "type": "secret_text" },
  { "name": "POSTERN_TEST_PBKDF2_ITERATIONS", "type": "secret_text" }
] }
JSON
  else
    cat > "$1" <<JSON
{ "success": true, "result": [
  { "name": "POSTERN_API_TOKEN", "type": "secret_text" }
] }
JSON
  fi
}

run() { # run <config> <secrets> <status> ; sets RC and OUT
  OUT="$(node "$script" "$1" "$2" "$3" 2>&1)"
  RC=$?
}

mkconfig "$work/cfg_clean.jsonc" 0
mkconfig "$work/cfg_planted.jsonc" 1
mksecrets "$work/sec_clean.json" 0
mksecrets "$work/sec_planted.json" 1
printf '{ "success": true, "result": [] }\n' > "$work/sec_empty.json"

echo "== G: a clean config stays green =="
run "$work/cfg_clean.jsonc" "$work/sec_clean.json" 200
[ "$RC" -eq 0 ] && ok "G1 clean vars and a normal secret list pass" || bad "G1 expected rc=0 got $RC :: $OUT"
run "$work/cfg_clean.jsonc" "$work/sec_empty.json" 200
[ "$RC" -eq 0 ] && ok "G2 clean vars and an empty secret list pass" || bad "G2 expected rc=0 got $RC"
run "$work/cfg_clean.jsonc" "$work/sec_clean.json" 404
[ "$RC" -eq 0 ] && ok "G3 HTTP 404 (worker does not exist yet) is a first deploy" || bad "G3 expected rc=0 got $RC"
case "$OUT" in *"does not exist on the account yet"*) ok "G3 announces the 404 rather than passing quietly";; *) bad "G3 silent skip :: $OUT";; esac
case "$OUT" in *"Test-only var preflight OK"*) ok "G1/G3 say OK";; *) : ;; esac
run "$work/cfg_clean.jsonc" "$work/sec_clean.json" 200
case "$OUT" in *"Test-only var preflight OK"*) ok "G1 names the OK";; *) bad "G1 no OK line :: $OUT";; esac

echo "== F: a planted name is REFUSED =="
run "$work/cfg_planted.jsonc" "$work/sec_clean.json" 200
[ "$RC" -eq 1 ] && ok "F1 planted var in wrangler vars is REFUSED" || bad "F1 expected rc=1 got $RC :: $OUT"
case "$OUT" in *"POSTERN_TEST_PBKDF2_ITERATIONS"*"wrangler config vars"*) ok "F1 names the variable and vars";; *) bad "F1 weak diagnostic :: $OUT";; esac
run "$work/cfg_clean.jsonc" "$work/sec_planted.json" 200
[ "$RC" -eq 1 ] && ok "F2 planted name in the secret list is REFUSED" || bad "F2 expected rc=1 got $RC :: $OUT"
case "$OUT" in *"POSTERN_TEST_PBKDF2_ITERATIONS"*"Worker secret list"*) ok "F2 names the variable and the secret list";; *) bad "F2 weak diagnostic :: $OUT";; esac
run "$work/cfg_planted.jsonc" "$work/sec_planted.json" 200
[ "$RC" -eq 1 ] && ok "F3 planted in both is REFUSED" || bad "F3 expected rc=1 got $RC"
run "$work/cfg_planted.jsonc" "$work/sec_clean.json" 404
[ "$RC" -eq 1 ] && ok "F4 a first deploy still refuses a planted var" || bad "F4 expected rc=1 got $RC :: $OUT"

echo "== R: a read it could not perform is NEVER a pass =="
run "$work/cfg_clean.jsonc" "$work/sec_clean.json" 500
[ "$RC" -eq 1 ] && ok "R1 HTTP 500 REFUSES rather than passing" || bad "R1 expected rc=1 got $RC"
run "$work/cfg_clean.jsonc" "$work/sec_clean.json" 403
[ "$RC" -eq 1 ] && ok "R2 HTTP 403 REFUSES (an under-scoped token is not an empty worker)" || bad "R2 expected rc=1 got $RC"
printf '{ "success": false, "errors": [ { "code": 10000 } ] }\n' > "$work/sec_fail.json"
run "$work/cfg_clean.jsonc" "$work/sec_fail.json" 200
[ "$RC" -eq 1 ] && ok "R3 success:false REFUSES even on HTTP 200" || bad "R3 expected rc=1 got $RC"
printf 'Total Upload: 1 KiB\n' > "$work/sec_notjson.json"
run "$work/cfg_clean.jsonc" "$work/sec_notjson.json" 200
[ "$RC" -eq 1 ] && ok "R4 unparseable body REFUSES" || bad "R4 expected rc=1 got $RC"
printf '{ "success": true }\n' > "$work/sec_noresult.json"
run "$work/cfg_clean.jsonc" "$work/sec_noresult.json" 200
[ "$RC" -eq 1 ] && ok "R5 no result array REFUSES, never assumes empty" || bad "R5 expected rc=1 got $RC"
printf '{ "name": "postern", "vars": [ "not", "an", "object" ] }\n' > "$work/cfg_badvars.json"
run "$work/cfg_badvars.json" "$work/sec_clean.json" 200
[ "$RC" -eq 1 ] && ok "R6 a non-object vars REFUSES" || bad "R6 expected rc=1 got $RC"

echo "== P: never print the planted VALUE =="
run "$work/cfg_planted.jsonc" "$work/sec_planted.json" 200
case "$OUT" in
  *"$PLANTED"*) bad "P1 the gate LEAKED the planted value into its output";;
  *) ok "P1 refusal output contains no planted value";;
esac
case "$OUT" in
  *"vars=PRESENT"*) ok "P2 reports PRESENT/ABSENT instead, so it is still debuggable";;
  *) bad "P2 lost the PRESENT/ABSENT projection :: $OUT";;
esac
if printf 'leaking %s here\n' "$PLANTED" | grep -q "$PLANTED"; then
  ok "P3 negative control: the leak detector does detect a seeded leak"
else
  bad "P3 the leak detector cannot see a known leak, so P1 is vacuous"
fi

echo "== usage =="
OUT="$(node "$script" 2>&1)"; RC=$?
[ "$RC" -eq 2 ] && ok "U1 missing arguments exit 2, distinct from a refusal" || bad "U1 expected rc=2 got $RC"

total=$((pass_count + fail_count))
echo "== assertions run: ${total} (floor 20), failures: ${fail_count} =="
if [ "$total" -lt 20 ]; then
  echo "FLOOR BREACHED: only ${total} assertions ran. A suite that shrank is not a suite that passed." >&2
  exit 1
fi
[ "$fail_count" -eq 0 ] || exit 1
echo "TEST-ONLY VAR PREFLIGHT TESTS: COMPLETE"

#!/usr/bin/env bash
# Regression suite for the forwarding deploy gate (#611).
#
# The un-stubbable seam (the real Cloudflare settings read against the live account) can only
# run on a real tag deploy. What IS testable here is the verdict logic, and the cases that
# matter are the REFUSALS: a preflight that cannot read the live state must go RED, never
# green-by-default, because an absent check reads exactly like a passed one.
#
# The privacy case (P1) is load-bearing, not decoration. postern is a PUBLIC repo, so Actions
# logs are public and FORWARD_TO is a personal address. P1 asserts the gate never emits a var
# VALUE, which is the property a later "just print the value so it is easier to debug" edit
# would quietly destroy.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/forwarding-preflight.mjs"
work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

pass_count=0
fail_count=0
ok()  { printf "  ok    %s\n" "$1"; pass_count=$((pass_count + 1)); }
bad() { printf "  FAIL  %s\n" "$1"; fail_count=$((fail_count + 1)); }

# A stand-in for the estate value. Never a real address, and P1 greps for THIS string.
SECRET_ADDR="someone@example.invalid"
ALLOW_ADDR="alerts@example.invalid"

mkbindings() { # mkbindings <file> <forward_to> <forward_for>
  cat > "$1" <<JSON
{ "success": true, "result": { "bindings": [
  { "type": "plain_text", "name": "TRUSTED_SENDER_DOMAINS", "text": "example.invalid" },
  { "type": "plain_text", "name": "FORWARD_TO",  "text": "$2" },
  { "type": "plain_text", "name": "FORWARD_FOR", "text": "$3" },
  { "type": "secret_text", "name": "POSTERN_API_TOKEN" }
] } }
JSON
}

mkconfig() { # mkconfig <file> <forward_to> <forward_for>
  cat > "$1" <<JSON
{
  // A JSONC comment, plus a URL whose // must survive the stripper.
  "name": "postern",
  "main": "src/index.ts",
  "vars": {
    "DOCS": "https://example.invalid/docs#anchor",
    "FORWARD_TO": "$2",
    "FORWARD_FOR": "$3",
  },
}
JSON
}

run() { # run <live-file> <config-file> <status> ; sets RC and OUT
  OUT="$(node "$script" "$1" "$2" "$3" 2>&1)"
  RC=$?
}

mkbindings "$work/live_both.json"   "$SECRET_ADDR" "$ALLOW_ADDR"
mkbindings "$work/live_none.json"   ""             ""
mkbindings "$work/live_to_only.json" "$SECRET_ADDR" ""
mkconfig   "$work/cfg_both.jsonc"   "$SECRET_ADDR" "$ALLOW_ADDR"
mkconfig   "$work/cfg_empty.jsonc"  ""             ""
mkconfig   "$work/cfg_changed.jsonc" "other@example.invalid" "$ALLOW_ADDR"
mkconfig   "$work/cfg_for_only.jsonc" "$SECRET_ADDR" ""

echo "== G: the safe cases pass =="
run "$work/live_both.json" "$work/cfg_both.jsonc" 200
[ "$RC" -eq 0 ] && ok "G1 identical live and incoming is safe" || bad "G1 expected rc=0 got $RC :: $OUT"
run "$work/live_none.json" "$work/cfg_empty.jsonc" 200
[ "$RC" -eq 0 ] && ok "G2 both sides empty is store-only, not a regression" || bad "G2 expected rc=0 got $RC"
run "$work/live_none.json" "$work/cfg_both.jsonc" 200
[ "$RC" -eq 0 ] && ok "G3 EMPTY to SET is turning forwarding ON, allowed" || bad "G3 expected rc=0 got $RC"
case "$OUT" in *"goes from EMPTY to SET"*) ok "G3 says so in a notice";; *) bad "G3 no notice :: $OUT";; esac

echo "== F: the refusals, which are the whole point =="
run "$work/live_both.json" "$work/cfg_empty.jsonc" 200
[ "$RC" -eq 1 ] && ok "F1 clearing a live FORWARD_TO is REFUSED" || bad "F1 expected rc=1 got $RC"
case "$OUT" in *"turn transparent forwarding OFF"*) ok "F1 names the consequence, not just the diff";; *) bad "F1 weak diagnostic :: $OUT";; esac
run "$work/live_both.json" "$work/cfg_for_only.jsonc" 200
[ "$RC" -eq 1 ] && ok "F2 dropping a live FORWARD_FOR is REFUSED" || bad "F2 expected rc=1 got $RC"
case "$OUT" in *"widens it to every recipient"*) ok "F2 says dropping the allowlist WIDENS forwarding";; *) bad "F2 missed the widening :: $OUT";; esac

echo "== R: a read it could not perform is NEVER a pass =="
run "$work/live_both.json" "$work/cfg_both.jsonc" 500
[ "$RC" -eq 1 ] && ok "R1 HTTP 500 REFUSES rather than passing" || bad "R1 expected rc=1 got $RC"
run "$work/live_both.json" "$work/cfg_both.jsonc" 403
[ "$RC" -eq 1 ] && ok "R2 HTTP 403 REFUSES (an under-scoped token is not an empty worker)" || bad "R2 expected rc=1 got $RC"
printf '{ "success": false, "errors": [ { "code": 10000 } ] }\n' > "$work/live_fail.json"
run "$work/live_fail.json" "$work/cfg_both.jsonc" 200
[ "$RC" -eq 1 ] && ok "R3 success:false REFUSES even on HTTP 200" || bad "R3 expected rc=1 got $RC"
printf 'Total Upload: 1 KiB\n' > "$work/live_notjson.json"
run "$work/live_notjson.json" "$work/cfg_both.jsonc" 200
[ "$RC" -eq 1 ] && ok "R4 unparseable body REFUSES" || bad "R4 expected rc=1 got $RC"
printf '{ "success": true, "result": { } }\n' > "$work/live_nobind.json"
run "$work/live_nobind.json" "$work/cfg_both.jsonc" 200
[ "$RC" -eq 1 ] && ok "R5 no bindings array REFUSES, never assumes empty" || bad "R5 expected rc=1 got $RC"
printf '{ "name": "postern", "vars": [ "not", "an", "object" ] }\n' > "$work/cfg_badvars.json"
run "$work/live_both.json" "$work/cfg_badvars.json" 200
[ "$RC" -eq 1 ] && ok "R6 a non-object vars REFUSES" || bad "R6 expected rc=1 got $RC"

echo "== S: the ONE tolerated not-red state, and it says so out loud =="
run "$work/live_both.json" "$work/cfg_both.jsonc" 404
[ "$RC" -eq 0 ] && ok "S1 HTTP 404 (worker does not exist yet) is a first deploy" || bad "S1 expected rc=0 got $RC"
case "$OUT" in *"does not exist on the account yet"*) ok "S1 announces it rather than passing quietly";; *) bad "S1 silent skip :: $OUT";; esac

echo "== J: the JSONC stripper is string-aware =="
run "$work/live_both.json" "$work/cfg_changed.jsonc" 200
[ "$RC" -eq 0 ] && ok "J1 a config with // inside a URL still parses" || bad "J1 stripper corrupted a URL :: $OUT"
case "$OUT" in *"changes value"*) ok "J1 a value change is reported as a notice";; *) bad "J1 change not reported :: $OUT";; esac

echo "== P: PRIVACY. public repo, public logs, never print a var VALUE =="
run "$work/live_both.json" "$work/cfg_empty.jsonc" 200
case "$OUT" in
  *"$SECRET_ADDR"*) bad "P1 the gate LEAKED the FORWARD_TO value into its output";;
  *) ok "P1 refusal output contains no FORWARD_TO value";;
esac
case "$OUT" in
  *"$ALLOW_ADDR"*) bad "P2 the gate LEAKED the FORWARD_FOR value into its output";;
  *) ok "P2 refusal output contains no FORWARD_FOR value";;
esac
case "$OUT" in
  *"FORWARD_TO: live=SET incoming=EMPTY"*) ok "P3 reports SET/EMPTY instead, so it is still debuggable";;
  *) bad "P3 lost the SET/EMPTY projection :: $OUT";;
esac
# Negative control: the suite must be able to SEE a leak, or P1/P2 prove nothing.
if printf 'leaking %s here\n' "$SECRET_ADDR" | grep -q "$SECRET_ADDR"; then
  ok "P4 negative control: the leak detector does detect a seeded leak"
else
  bad "P4 the leak detector cannot see a known leak, so P1 and P2 are vacuous"
fi

echo "== usage =="
OUT="$(node "$script" 2>&1)"; RC=$?
[ "$RC" -eq 2 ] && ok "U1 missing arguments exit 2, distinct from a refusal" || bad "U1 expected rc=2 got $RC"

total=$((pass_count + fail_count))
echo "== assertions run: ${total} (floor 23), failures: ${fail_count} =="
if [ "$total" -lt 23 ]; then
  echo "FLOOR BREACHED: only ${total} assertions ran. A suite that shrank is not a suite that passed." >&2
  exit 1
fi
[ "$fail_count" -eq 0 ] || exit 1
echo "FORWARDING PREFLIGHT TESTS: COMPLETE"

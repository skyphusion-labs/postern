#!/usr/bin/env bash
# Regression suite for the post-deploy artifact check (#418 item 5).
#
# The un-stubbable seam (the real `wrangler deployments status --json` call
# against the live account) can only run on a real tag deploy. What IS testable
# here is the verdict logic, and the cases that matter are the refusals: a
# read-back that cannot prove the uploaded version is live must go RED, never
# green-by-default. The pass fixture uses the shape wrangler 4.x actually emits
# (versions[].version_id + percentage, created_on), read off the pinned CLI.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/verify-worker-deployment.mjs"
work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

pass_count=0
fail_count=0
ok()  { printf "  ok    %s\n" "$1"; pass_count=$((pass_count + 1)); }
bad() { printf "  FAIL  %s\n" "$1"; fail_count=$((fail_count + 1)); }

live_id="1a2b3c4d-0000-4000-8000-abcdefabcdef"
other_id="9f8e7d6c-1111-4111-8111-fedcbafedcba"

cat > "${work}/live.json" <<JSON
{
  "id": "deployment-1",
  "source": "api",
  "strategy": "percentage",
  "created_on": "2026-07-26T12:00:00.000Z",
  "versions": [ { "version_id": "${live_id}", "percentage": 100 } ]
}
JSON

printf '{ "id": "d", "created_on": "x", "versions": [] }\n' > "${work}/empty.json"
printf '{ "id": "d", "created_on": "x" }\n' > "${work}/noversions.json"
printf '{ "id": "d", "versions": [ { "percentage": 100 } ] }\n' > "${work}/noid.json"
printf 'Total Upload: 123 KiB\n' > "${work}/notjson.json"
printf '[ "not", "an", "object" ]\n' > "${work}/array.json"

run_case() {
  local desc="$1" want_rc="$2" want_text="$3"
  shift 3
  local out rc
  out="$(node "$script" "$@" 2>&1)"
  rc=$?
  if [ "$rc" != "$want_rc" ]; then
    bad "${desc} (exit ${rc}, wanted ${want_rc})"
    printf "%s\n" "$out" | sed "s/^/        /"
    return
  fi
  if [ -n "$want_text" ] && ! printf "%s" "$out" | grep -qF -- "$want_text"; then
    bad "${desc} (no \"${want_text}\" in output)"
    printf "%s\n" "$out" | sed "s/^/        /"
    return
  fi
  ok "$desc"
}

# Positive control first: if this one cannot pass, every refusal below is a dead
# path and the suite proves nothing.
run_case "live deployment serving the uploaded version passes" \
  0 "Artifact verified" "${work}/live.json" "$live_id"
run_case "a DIFFERENT version live fails (the deploy did not take)" \
  1 "production is NOT running this tag" "${work}/live.json" "$other_id"
run_case "empty versions array fails" \
  1 "carries no versions array" "${work}/empty.json" "$live_id"
run_case "missing versions key fails" \
  1 "carries no versions array" "${work}/noversions.json" "$live_id"
run_case "versions without version_id fails (shape drift)" \
  1 "shape may have changed" "${work}/noid.json" "$live_id"
run_case "non-JSON read-back fails" \
  1 "is not JSON" "${work}/notjson.json" "$live_id"
run_case "JSON array instead of an object fails" \
  1 "not a deployment object" "${work}/array.json" "$live_id"
run_case "missing file fails" \
  1 "cannot read" "${work}/absent.json" "$live_id"
run_case "missing expected version id fails" \
  1 "usage:" "${work}/live.json"

printf "\n%d passed, %d failed\n" "$pass_count" "$fail_count"
[ "$fail_count" = "0" ]

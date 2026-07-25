#!/usr/bin/env bash
# Regression suite for the release-gate scripts (#418): tag-preflight.sh and its
# shared CHANGELOG matcher changelog-section.sh.
#
# The gate cannot be exercised by pushing tags (a tag is a one-way, public act),
# so it is exercised HERE, against a real throwaway git repo with a real remote:
# `git fetch origin main` and `git merge-base --is-ancestor` run for real, no
# stub. Every case asserts the EXIT CODE and the reason text, and the negative
# cases are the point: a gate whose refusals were never watched to fail is
# decoration.
#
# Usage: bash .github/scripts/tests/tag-preflight.test.sh
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
scripts_src="${repo_root}/.github/scripts"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

pass_count=0
fail_count=0

ok()   { printf "  ok    %s\n" "$1"; pass_count=$((pass_count + 1)); }
bad()  { printf "  FAIL  %s\n" "$1"; fail_count=$((fail_count + 1)); }

# ------------------------------------------------------------------ fixture
# A bare "origin" plus a clone, so ancestry is a real fetch against a real
# remote rather than a mocked answer.
git init --quiet --bare "${work}/origin.git"
fixture="${work}/repo"
git init --quiet -b main "$fixture"
cd "$fixture" || exit 2
git config user.email "test@example.net"
git config user.name "preflight test"
git remote add origin "${work}/origin.git"

mkdir -p .github/scripts clients/python/postern_client inbound mcp
cp "${scripts_src}/tag-preflight.sh" "${scripts_src}/changelog-section.sh" .github/scripts/

write_pyproject() { printf "[build-system]\nrequires = [\"setuptools\"]\n\n[project]\nname = \"postern-client\"\nversion = \"%s\"\n" "$1" > clients/python/pyproject.toml; }
write_dunder()    { printf "__version__ = \"%s\"\n" "$1" > clients/python/postern_client/__init__.py; }
write_inbound()   { printf "{\n  \"name\": \"postern-inbound\",\n  \"version\": \"%s\"\n}\n" "$1" > inbound/package.json; }
write_mcp()       { printf "{\n  \"name\": \"@skyphusion/postern-mcp\",\n  \"version\": \"%s\"\n}\n" "$1" > mcp/package.json; }
write_changelog() {
  # Dated heading on purpose: the repo real style, the one the old exact-line
  # matcher in release.yml could not see.
  printf "# Changelog\n\n## v%s -- 2026-01-02\n\nreal notes for this release\n\n## v1.0.0\n\nfirst\n" "$1" > CHANGELOG.md
}

write_pyproject 1.2.3
write_dunder 1.2.3
write_inbound 1.2.3
write_mcp 3.4.5
write_changelog 1.2.3

git add -A
git commit --quiet -m "fixture"
git push --quiet origin main
main_sha="$(git rev-parse HEAD)"

# A commit that exists but was never merged to main (the unreviewed-tag case).
git checkout --quiet -b side
printf "stray\n" > stray.txt
git add stray.txt
git commit --quiet -m "unmerged work"
side_sha="$(git rev-parse HEAD)"
git checkout --quiet main

# ------------------------------------------------------------------ runner
# want_rc: expected exit code. want_text: substring the output must contain.
run_case() {
  local desc="$1" want_rc="$2" want_text="$3" track="$4" ref="$5" ref_name="$6" sha="$7"
  local out rc
  out="$(cd "$fixture" && GITHUB_REF="$ref" GITHUB_REF_NAME="$ref_name" GITHUB_SHA="$sha" \
    GITHUB_STEP_SUMMARY="" bash .github/scripts/tag-preflight.sh "$track" 2>&1)"
  rc=$?
  if [ "$rc" != "$want_rc" ]; then
    bad "${desc} (exit ${rc}, wanted ${want_rc})"
    printf "%s\n" "$out" | sed "s/^/        /"
    return
  fi
  if [ -n "$want_text" ] && ! printf "%s" "$out" | grep -qF -- "$want_text"; then
    bad "${desc} (exit ok, but no \"${want_text}\" in output)"
    printf "%s\n" "$out" | sed "s/^/        /"
    return
  fi
  ok "$desc"
}

echo "release track, v* tag"
run_case "clean release tag passes (dated CHANGELOG heading and all four pins)" \
  0 "Tag preflight (release): PASS" release refs/tags/v1.2.3 v1.2.3 "$main_sha"

write_pyproject 1.2.4
run_case "pyproject drift fails" \
  1 "clients/python/pyproject.toml version is 1.2.4, expected 1.2.3" release refs/tags/v1.2.3 v1.2.3 "$main_sha"
write_pyproject 1.2.3

write_dunder 1.0.4
run_case "__version__ drift fails (the v1.0.6 defect)" \
  1 "postern_client.__version__ is 1.0.4, expected 1.2.3" release refs/tags/v1.2.3 v1.2.3 "$main_sha"
write_dunder 1.2.3

write_inbound 1.0.1
run_case "inbound/package.json drift fails (item 8: the frozen pin)" \
  1 "inbound/package.json version is 1.0.1, expected 1.2.3" release refs/tags/v1.2.3 v1.2.3 "$main_sha"
write_inbound 1.2.3

rm -f inbound/package.json
run_case "unreadable pin fails instead of reading as no-drift" \
  1 "could not read a version" release refs/tags/v1.2.3 v1.2.3 "$main_sha"
write_inbound 1.2.3

write_changelog 9.9.9
run_case "missing CHANGELOG section fails BEFORE anything deploys" \
  1 "no non-empty" release refs/tags/v1.2.3 v1.2.3 "$main_sha"

printf "# Changelog\n\n## v1.2.3 -- 2026-01-02\n\n## v1.0.0\n\nfirst\n" > CHANGELOG.md
run_case "CHANGELOG heading with an empty body fails (empty release notes)" \
  1 "no non-empty" release refs/tags/v1.2.3 v1.2.3 "$main_sha"
write_changelog 1.2.3

run_case "non-SemVer tag fails" \
  1 "not a SemVer version tag" release refs/tags/v1.2 v1.2 "$main_sha"

run_case "tag off main fails (unreviewed commit)" \
  1 "is not an ancestor of origin/main" release refs/tags/v1.2.3 v1.2.3 "$side_sha"

echo "release track, non-tag ref (workflow_dispatch / push to main)"
run_case "agreeing pins pass" \
  0 "version pins agree (1.2.3)" release refs/heads/main main "$main_sha"

write_dunder 1.2.9
run_case "cross-pin drift fails even with no tag to compare against" \
  1 "version pins disagree" release refs/heads/main main "$main_sha"
write_dunder 1.2.3

write_changelog 9.9.9
run_case "missing CHANGELOG is advisory on a non-tag ref" \
  0 "advisory on a non-tag ref" release refs/heads/main main "$main_sha"
write_changelog 1.2.3

echo "mcp track"
run_case "clean mcp tag passes" \
  0 "Tag preflight (mcp): PASS" mcp refs/tags/postern-mcp-v3.4.5 postern-mcp-v3.4.5 "$main_sha"

run_case "mcp version drift fails (the gate npm-mcp.yml never had)" \
  1 "mcp/package.json version is 3.4.5, expected 3.4.6" mcp refs/tags/postern-mcp-v3.4.6 postern-mcp-v3.4.6 "$main_sha"

run_case "mcp track on a v* tag fails (wrong train)" \
  1 "is not a postern-mcp-v* tag" mcp refs/tags/v1.2.3 v1.2.3 "$main_sha"

run_case "mcp tag off main fails" \
  1 "is not an ancestor of origin/main" mcp refs/tags/postern-mcp-v3.4.5 postern-mcp-v3.4.5 "$side_sha"

echo "argument handling"
run_case "unknown track exits 2 (never a silent pass)" \
  2 "track must be release or mcp" bogus refs/tags/v1.2.3 v1.2.3 "$main_sha"

echo "changelog-section.sh matcher"
cl_case() {
  local desc="$1" want_rc="$2" ver="$3" file="$4" want_text="${5:-}"
  local out rc
  out="$(bash "${fixture}/.github/scripts/changelog-section.sh" "$ver" "$file" 2>&1)"
  rc=$?
  if [ "$rc" != "$want_rc" ]; then bad "${desc} (exit ${rc}, wanted ${want_rc})"; return; fi
  if [ -n "$want_text" ] && ! printf "%s" "$out" | grep -qF -- "$want_text"; then
    bad "${desc} (no \"${want_text}\" in output)"; return
  fi
  ok "$desc"
}

printf "# CL\n\n## v1x1x0\n\nnear miss\n\n## v1.1.0 -- 2026-02-02\n\ndated body\n\n## v1.0.9\n\nold\n" > "${work}/cl.md"
cl_case "dated heading extracts its body" 0 1.1.0 "${work}/cl.md" "dated body"
cl_case "section stops at the next heading" 0 1.1.0 "${work}/cl.md" ""
if bash "${fixture}/.github/scripts/changelog-section.sh" 1.1.0 "${work}/cl.md" | grep -qF "old"; then
  bad "section must not bleed into the next release"
else
  ok "section stops before the next release heading"
fi
if bash "${fixture}/.github/scripts/changelog-section.sh" 1.1.0 "${work}/cl.md" | grep -qF "near miss"; then
  bad "dots must be literal (v1x1x0 must not match v1.1.0)"
else
  ok "dots are literal (v1x1x0 does not match v1.1.0)"
fi
cl_case "absent version fails" 1 4.5.6 "${work}/cl.md" "no non-empty"
cl_case "missing file fails" 1 1.1.0 "${work}/nope.md" "no such file"

printf "\n%d passed, %d failed\n" "$pass_count" "$fail_count"
[ "$fail_count" = "0" ]

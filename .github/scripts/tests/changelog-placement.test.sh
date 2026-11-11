#!/usr/bin/env bash
# Unit suite for changelog-placement.mjs: a change must not add lines inside an
# already-released "## vX.Y.Z" section of CHANGELOG.md.
#
# Every case asserts an EXACT exit code. Each fixture is a commit in a throwaway git
# repository, so the script reads real git objects, as it does in CI.
#
# Positive controls (must exit 1): an entry appended inside the newest released
# section, which is the shape a clean merge produces after a release; a changed line in
# an older release; a re-added released heading.
# Negative controls (must exit 0): an entry under Unreleased, a new Unreleased above the
# newest release, a release change that renames Unreleased, blank lines only, the
# preamble, no CHANGELOG change, and a history edit carrying the override trailer.
# Could not measure (must exit 2): an unknown revision.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/changelog-placement.mjs"

pass_count=0
fail_count=0
ok()  { printf "  ok    %s\n" "$1"; pass_count=$((pass_count + 1)); }
bad() { printf "  FAIL  %s\n" "$1"; fail_count=$((fail_count + 1)); }

echo "changelog-placement suite"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
cd "$work" || exit 2
git init -q -b main .
git config user.email suite@example.invalid
git config user.name suite
# Fixture commits must not run any hook from the caller's environment.
git config core.hooksPath /dev/null

base_text() {
  cat <<'MD'
# Changelog

Preamble text.

## Unreleased

### Fixed

- **Pending fix.** Not released yet.

## v1.1.0

MINOR. Second release.

### Added

- **Feature B.** Shipped in 1.1.0.

## v1.0.0

First release.

- **Feature A.** Shipped in 1.0.0.
MD
}
base_text > CHANGELOG.md
echo x > other.txt
git add -A && git commit -q -m base
BASE="$(git rev-parse HEAD)"

# variant <name> <commit-message> : CHANGELOG.md on stdin, committed on a branch off BASE.
variant() {
  local name="$1" msg="$2"
  git checkout -q -B "$name" "$BASE"
  cat > CHANGELOG.md
  git add -A
  git commit -q --allow-empty -m "$msg"
  git rev-parse HEAD
}

expect() { # <label> <want-exit> <base> <head>
  local out rc
  out="$(node "$script" "$3" "$4" 2>&1)"; rc=$?
  if [ "$rc" -eq "$2" ]; then ok "$1 (exit $rc)"; else bad "$1: want exit $2, got $rc: $(echo "$out" | tail -1)"; fi
}

# --- must exit 1 -------------------------------------------------------------------
H="$(base_text | awk '{print} /Shipped in 1.1.0/{print ""; print "### Fixed"; print ""; print "- **Late fix.** Lands after the release."}' | variant appended-into-release "add fix")"
expect "an entry appended inside the newest released section" 1 "$BASE" "$H"

H="$(base_text | sed 's/Shipped in 1.0.0./Shipped in 1.0.0, revised./' | variant edit-old-release "edit")"
expect "a changed line inside an older released section" 1 "$BASE" "$H"

H="$(base_text | awk '{print} /^Preamble text\./{print ""; print "## v1.0.0"; print ""; print "- **Duplicate.**"}' | variant duplicate-heading "dup")"
expect "a re-added released heading with an entry" 1 "$BASE" "$H"

# The real shape: a branch cut before a release, merged after it. Git merges cleanly.
git checkout -q -B before-release "$BASE"
base_text | awk '{print} /Not released yet\./{print "- **Branch fix.** Written before the release."}' > CHANGELOG.md
git commit -q -am "branch fix"
BRANCH="$(git rev-parse HEAD)"
git checkout -q -B release "$BASE"
base_text | sed 's/^## Unreleased$/## v1.2.0/' > CHANGELOG.md
git commit -q -am "chore(release): v1.2.0"
RELEASED="$(git rev-parse HEAD)"
git checkout -q -B merged "$BRANCH"
if git merge -q --no-edit "$RELEASED" >/dev/null 2>&1; then
  ok "git merges the pre-release branch into the release cleanly (the case only a check can see)"
  expect "that clean merge, against the released base" 1 "$RELEASED" "$(git rev-parse HEAD)"
else
  bad "expected a clean merge for the fixture; got a conflict"
  git merge --abort 2>/dev/null
fi

# --- must exit 0 -------------------------------------------------------------------
H="$(base_text | awk '{print} /Not released yet\./{print "- **Another fix.** Under Unreleased."}' | variant under-unreleased "fix")"
expect "an entry under Unreleased" 0 "$BASE" "$H"

H="$(base_text | sed 's/^## Unreleased$/## v1.2.0/' | variant release-pr "chore(release): v1.2.0")"
expect "a release change that renames Unreleased to a new version" 0 "$BASE" "$H"

git checkout -q -B fresh-unreleased "$RELEASED"
awk '{print} /^Preamble text\./{print ""; print "## Unreleased"; print ""; print "### Fixed"; print ""; print "- **Next fix.**"}' CHANGELOG.md > c.tmp && mv c.tmp CHANGELOG.md
git commit -q -am "fix"
expect "a new Unreleased above the newest release" 0 "$RELEASED" "$(git rev-parse HEAD)"

H="$(base_text | awk '{print} /Shipped in 1.1.0/{print ""; print ""}' | variant blank-lines "blank")"
expect "only blank lines added inside a released section" 0 "$BASE" "$H"

H="$(base_text | sed 's/^Preamble text\./Preamble text, revised./' | variant preamble "preamble")"
expect "an edit to the preamble" 0 "$BASE" "$H"

git checkout -q -B no-changelog "$BASE"; echo y > other.txt; git commit -q -am "other"
expect "a change that does not touch CHANGELOG.md" 0 "$BASE" "$(git rev-parse HEAD)"

H="$(base_text | sed 's/Shipped in 1.0.0./Shipped in 1.0.0, revised./' | variant history-edit "docs: correct the 1.0.0 note

Changelog-History-Edit: the 1.0.0 entry named the wrong file")"
expect "a history edit with the Changelog-History-Edit trailer" 0 "$BASE" "$H"

H="$(base_text | sed 's/Shipped in 1.0.0./Shipped in 1.0.0, revised./' | variant empty-trailer "docs: edit

Changelog-History-Edit:")"
expect "an empty Changelog-History-Edit trailer does not allow it" 1 "$BASE" "$H"

# --- must exit 2 -------------------------------------------------------------------
expect "an unknown base revision is not measured" 2 "0000000000000000000000000000000000000000" "$BASE"

echo "changelog-placement: ${pass_count} ok, ${fail_count} failed"
[ "$fail_count" -eq 0 ] && [ "$pass_count" -ge 14 ]

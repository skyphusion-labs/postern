#!/usr/bin/env bash
# ONE preflight for every tag-triggered workflow (#418 item 1).
#
# WHY: the tag workflows (deploy, release, publish-pypi, relay-image,
# imap-image, plus npm-mcp on its own tag track) fire as PEERS with no shared
# gate. `git push origin vX.Y.Z` could therefore put PRODUCTION ahead of the
# release ledger: v1.0.5 is the live proof -- deploy succeeded and both door
# images built and roll-dispatched, while release + PyPI failed downstream on
# the missing version pins. Every tag workflow now runs THIS script in a
# `preflight` job that all its other jobs list in `needs:`, so a tag-hostile
# state stops the whole fan-out instead of half of it.
#
# WHY here and not only in ci.yml: nothing forces a tag to come from a merged
# release PR. A hand-cut tag (the normal ship path: pins land on main, THEN
# `git tag -a`) never touches a PR gate, so the assert has to run on the tag.
#
# Usage: tag-preflight.sh <release|mcp>
#
#   release  the v* train: inbound Worker + postern-client + door images.
#   mcp      the postern-mcp-v* train: @skyphusion/postern-mcp on npm.
#
# Environment (GitHub Actions provides these; the test harness sets them):
#   GITHUB_REF           full ref, e.g. refs/tags/v1.1.0 (tag detection)
#   GITHUB_REF_NAME      short ref name, e.g. v1.1.0
#   GITHUB_SHA           the commit under test (defaults to HEAD)
#   GITHUB_STEP_SUMMARY  optional file; the verdict is appended when set
#
# Checks:
#   ancestry (BOTH tracks, EVERY ref, hard): GITHUB_SHA is an ancestor of
#     origin/main, so no unreviewed commit deploys, publishes, or rolls.
#   release track on a v* tag (hard, all four pins plus the ledger):
#     tag == clients/python/pyproject.toml [project] version
#     tag == clients/python/postern_client/__init__.py __version__
#     tag == inbound/package.json version            (#418 item 8)
#     CHANGELOG.md has a non-empty `## v<version>` section  (#418 item 2)
#   release track on a NON-tag ref (workflow_dispatch, push to main):
#     the three pins agree with EACH OTHER (hard: cross-pin drift is the exact
#       defect class this gate exists for and it never depends on tag timing)
#     CHANGELOG section for the pinned version (WARNING only: a dispatch is a
#       recovery path, not a release ledger, and a merge to main ships nothing)
#   mcp track on a postern-mcp-v* tag (hard):
#     tag == mcp/package.json version                (#418 item 3)
#     no CHANGELOG or GitHub Release assert: postern-mcp-v* tags are
#     release-less by convention (see the CHANGELOG.md preamble); the npm
#     registry is that train ledger.
#
# Exit 0 only when every hard check passed. Failures are COLLECTED, not
# fail-fast, so one run shows the operator every drift to fix.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${PREFLIGHT_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$repo_root" || exit 2

track="${1:-}"
case "$track" in
  release|mcp) ;;
  *) echo "::error::tag-preflight: track must be release or mcp (got \"${track}\")" >&2; exit 2 ;;
esac

ref="${GITHUB_REF:-}"
ref_name="${GITHUB_REF_NAME:-}"
sha="${GITHUB_SHA:-$(git rev-parse HEAD)}"

rc=0
summary=""

record() { summary="${summary}$1"$'\n'; }
fail() { echo "::error::$*" >&2; record "- FAIL: $*"; rc=1; }
warn() { echo "::warning::$*" >&2; record "- warn: $*"; }
note() { echo "::notice::$*"; record "- ok: $*"; }

# ---------------------------------------------------------------- readers
# Each reader prints the version or nothing; an unreadable pin is a FAILURE,
# never a silent pass (a missing file used to read as "no drift").

pyproject_version() {
  awk '
    /^\[/ { in_project = ($0 == "[project]") }
    in_project && /^[ \t]*version[ \t]*=/ {
      if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
    }
  ' clients/python/pyproject.toml 2>/dev/null
}

dunder_version() {
  sed -n 's/^__version__[ \t]*=[ \t]*"\([^"]*\)".*/\1/p' \
    clients/python/postern_client/__init__.py 2>/dev/null | head -1
}

json_version() {
  node -e '
    const fs = require("fs");
    try {
      const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
      if (typeof v === "string") process.stdout.write(v);
    } catch (e) { /* unreadable: print nothing, the caller fails loudly */ }
  ' "$1" 2>/dev/null
}

check_pin() {
  local label="$1" want="$2" got="$3"
  if [ -z "$got" ]; then
    fail "${label}: could not read a version (unreadable or missing pin)"
  elif [ "$got" != "$want" ]; then
    fail "${label} is ${got}, expected ${want}"
  else
    note "${label} == ${want}"
  fi
}

# ---------------------------------------------------------------- ancestry
# Same assert the individual workflows each carried a private copy of; it lives
# here now so there is one implementation instead of nine.
if ! git fetch --no-tags --quiet origin main 2>/dev/null; then
  fail "could not fetch origin/main (ancestry unverifiable; refusing to pass)"
elif ! git merge-base --is-ancestor "$sha" origin/main; then
  fail "commit ${sha} (${ref_name:-unknown ref}) is not an ancestor of origin/main; refusing to ship an unreviewed commit"
else
  note "commit ${sha} is on origin/main"
fi

# ---------------------------------------------------------------- version pins
is_tag=0
case "$ref" in refs/tags/*) is_tag=1 ;; esac

if [ "$track" = "release" ]; then
  if [ "$is_tag" = "1" ]; then
    case "$ref_name" in
      v*) ;;
      *) fail "release track ran on tag ${ref_name}, which is not a v* tag"; ref_name="" ;;
    esac
    version="${ref_name#v}"
    if ! printf "%s" "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
      fail "tag ${ref_name} is not a SemVer version tag (expected vX.Y.Z)"
    else
      check_pin "clients/python/pyproject.toml version" "$version" "$(pyproject_version)"
      check_pin "postern_client.__version__" "$version" "$(dunder_version)"
      check_pin "inbound/package.json version" "$version" "$(json_version inbound/package.json)"
      if notes="$(bash "${here}/changelog-section.sh" "$version" 2>&1)"; then
        note "CHANGELOG.md has a non-empty ## v${version} section"
      else
        fail "CHANGELOG.md: ${notes}"
      fi
    fi
  else
    # Not a tag: there is no version to compare AGAINST, but the pins must still
    # agree with each other. This is what keeps a workflow_dispatch publish and
    # a door-image build off a half-bumped tree.
    py="$(pyproject_version)"
    du="$(dunder_version)"
    inb="$(json_version inbound/package.json)"
    if [ -z "$py" ] || [ -z "$du" ] || [ -z "$inb" ]; then
      fail "lockstep unreadable (pyproject=\"${py}\" __version__=\"${du}\" inbound=\"${inb}\")"
    elif [ "$py" != "$du" ] || [ "$py" != "$inb" ]; then
      fail "version pins disagree: pyproject=${py} __version__=${du} inbound/package.json=${inb}"
    else
      note "version pins agree (${py}) on non-tag ref ${ref_name:-HEAD}"
      if bash "${here}/changelog-section.sh" "$py" >/dev/null 2>&1; then
        note "CHANGELOG.md has a ## v${py} section"
      else
        warn "no CHANGELOG.md ## v${py} section yet (advisory on a non-tag ref; it is a HARD failure when the tag is cut)"
      fi
    fi
  fi
else
  if [ "$is_tag" = "1" ]; then
    case "$ref_name" in
      postern-mcp-v*) ;;
      *) fail "mcp track ran on tag ${ref_name}, which is not a postern-mcp-v* tag"; ref_name="" ;;
    esac
    version="${ref_name#postern-mcp-v}"
    if [ -z "$version" ]; then
      : # already failed above
    elif ! printf "%s" "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
      fail "tag ${ref_name} is not a SemVer version tag (expected postern-mcp-vX.Y.Z)"
    else
      check_pin "mcp/package.json version" "$version" "$(json_version mcp/package.json)"
      note "postern-mcp-v* tags cut no GitHub Release and no CHANGELOG section by convention (npm is that ledger)"
    fi
  else
    note "mcp track on non-tag ref ${ref_name:-HEAD}: publishes mcp/package.json version $(json_version mcp/package.json)"
  fi
fi

# ---------------------------------------------------------------- verdict
if [ "$rc" = "0" ]; then
  verdict="### Tag preflight (${track}): PASS"
else
  verdict="### Tag preflight (${track}): FAIL -- nothing downstream will run"
fi
printf "%s\n\n%s\n" "$verdict" "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf "%s\n\n%s\n" "$verdict" "$summary" >> "$GITHUB_STEP_SUMMARY"
fi
exit "$rc"

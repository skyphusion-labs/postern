#!/usr/bin/env bash
# Print the CHANGELOG.md body for one version, or fail if it is absent/empty.
#
# ONE matcher, two callers (#418 item 2): the tag preflight uses it to assert the
# section EXISTS before anything deploys, and release.yml uses it to build the
# GitHub Release notes. Before this, release.yml owned a private copy that
# matched the heading with `$0 == ver` (exact line), which cannot see the repo
# own dated heading style (`## v1.0.1 -- 2026-07-16`), so a dated release would
# have shipped with empty notes AFTER production was already deployed.
#
# Usage: changelog-section.sh <version-without-v> [changelog-path]
#   prints the section body on stdout; exit 1 (with a reason on stderr) when the
#   heading is missing or the section has no content.
set -euo pipefail

ver="${1:?usage: changelog-section.sh <version> [changelog-path]}"
file="${2:-CHANGELOG.md}"

if [ ! -f "$file" ]; then
  echo "changelog-section: no such file: $file" >&2
  exit 1
fi

# Escape the dots so 1.1.0 cannot match a heading like `## v1x1x0`.
ver_re="${ver//./\\\\.}"

body="$(
  awk -v ver_re="$ver_re" '
    # Prefix match: the heading may carry a date or any trailing text, but the
    # version must end at a space, a tab, or end-of-line.
    $0 ~ "^## v" ver_re "([ \t]|$)" { found = 1; next }
    # Any following level-2 heading closes the section.
    found && /^## / { exit }
    found { print }
  ' "$file"
)"

# A heading with only blank lines under it is as broken as a missing heading:
# the release would ship with empty notes.
if [ -z "$(printf "%s" "$body" | tr -d "[:space:]")" ]; then
  echo "changelog-section: no non-empty \"## v${ver}\" section in ${file}" >&2
  exit 1
fi

printf "%s\n" "$body"

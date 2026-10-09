#!/usr/bin/env bash
# assert-relay-go-pin.sh -- fail if the SCANNED Go version and the SHIPPED Go
# version disagree (#704).
#
# WHY THIS EXISTS. Two files name a Go version and nothing kept them equal:
#
#   relay/go.mod     `toolchain goX.Y.Z`   -> what CI installs, via
#                                             `go-version-file: relay/go.mod`
#                                             (ci.yml, relay-image.yml)
#   relay/Dockerfile `FROM golang:X.Y.Z-*` -> what the shipped image builds with
#
# govulncheck reports standard-library CVEs against the toolchain it runs under.
# So the go.mod line is the version the GATE measures, and the Dockerfile line is
# the version the ARTIFACT ships. While they differed, a green `relay` job said
# nothing true about the relay image.
#
# They did differ, for months: the gate scanned go1.25.13 while the image shipped
# a binary built with 1.26.6. Both directions are unsafe. A stdlib CVE affecting
# only the image version ships with the gate green. A CVE affecting only the
# scanned version reds the gate over a binary nobody runs.
#
# Nothing in Go closes this for us, which is why the gate is needed. Measured
# behaviour, with `toolchain go1.26.9` declared and a 1.26.5 toolchain present:
#   GOTOOLCHAIN=auto  -> builds with 1.26.9, downloading it
#   GOTOOLCHAIN=local -> builds with 1.26.5, IGNORING the directive, exit 0
# So the directive is a selection hint, not a constraint, and neither setting
# makes a mismatch an error. The builder stage pins GOTOOLCHAIN=local so the
# image's own tag is the truth about the binary, and THIS gate asserts that tag
# equals the scanned toolchain. Together: scanned == FROM == actually-built.
#
# This gate is deliberately NOT a derivation. Dependabot maintains the Dockerfile
# tag and a human maintains the toolchain directive, so an ARG-derived tag would
# take the image out of dependabot's reach. Two hand-maintained strings are fine
# as long as disagreeing is a loud CI failure, which is what this is.
#
# Usage:
#   bash .github/scripts/assert-relay-go-pin.sh
#   RELAY_PIN_ROOT=/path/to/fixture bash .github/scripts/assert-relay-go-pin.sh
#
# Exit 0 when the pins agree, 1 on a real mismatch or an unpinned tag, 2 on a
# usage/tooling error. An unreadable pin NEVER reads as agreement.
set -uo pipefail

root="${RELAY_PIN_ROOT:-}"
if [[ -z "$root" ]]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

gomod="${root}/relay/go.mod"
dockerfile="${root}/relay/Dockerfile"

for f in "$gomod" "$dockerfile"; do
  if [[ ! -f "$f" ]]; then
    echo "assert-relay-go-pin: cannot read ${f}" >&2
    exit 2
  fi
done

# --- the scanned version: relay/go.mod `toolchain goX.Y.Z` -----------------
toolchain_raw="$(sed -n -E 's/^toolchain[[:space:]]+go([0-9]+\.[0-9]+(\.[0-9]+)?)[[:space:]]*$/\1/p' "$gomod")"
toolchain_lines="$(grep -cE '^toolchain[[:space:]]' "$gomod")"

if [[ "$toolchain_lines" -eq 0 ]]; then
  cat >&2 <<EOF
assert-relay-go-pin: relay/go.mod has NO \`toolchain\` directive (#704).

CI resolves its Go from this file. Without the directive the installed version
drifts with whatever setup-go defaults to, and the gate stops being pinned to
anything. Add \`toolchain goX.Y.Z\`, matching relay/Dockerfile.
EOF
  exit 2
fi
if [[ "$toolchain_lines" -ne 1 || -z "$toolchain_raw" ]]; then
  echo "assert-relay-go-pin: cannot parse a single \`toolchain goX.Y.Z\` from relay/go.mod" >&2
  exit 2
fi

# --- the shipped version: every `FROM golang:` in relay/Dockerfile ---------
# No `mapfile`: this file runs under `#!/usr/bin/env bash`, which is bash 3.2 on
# macOS, and `mapfile` is bash 4+. A bash-4-only builtin would work on the ubuntu
# runner and break for anyone running the gate locally. That is the worst shape a
# check can have, so the loop below is portable (fleet-chezmoi#2241).
from_tags="$(sed -n -E 's/^FROM[[:space:]]+golang:([^[:space:]]+).*$/\1/p' "$dockerfile")"

if [[ -z "$from_tags" ]]; then
  echo "assert-relay-go-pin: relay/Dockerfile has no \`FROM golang:\` builder stage" >&2
  exit 2
fi

rc=0
while IFS= read -r tag; do
  [[ -z "$tag" ]] && continue
  # Require a full patch pin. A floating `1.26-bookworm` or `latest` defeats the
  # whole point: the gate cannot know which patch the image will resolve to.
  img_ver="$(printf '%s' "$tag" | sed -n -E 's/^([0-9]+\.[0-9]+\.[0-9]+)(-.*)?$/\1/p')"
  if [[ -z "$img_ver" ]]; then
    cat >&2 <<EOF
assert-relay-go-pin: relay/Dockerfile pins \`golang:${tag}\`, which is not a full
patch version (#704).

The gate compares patch levels, because a stdlib CVE is fixed at a patch release.
A floating tag resolves to a different Go on every build, so nothing can be
asserted about the shipped binary. Pin X.Y.Z, e.g. \`golang:${toolchain_raw}-bookworm\`.
EOF
    rc=1
    continue
  fi

  if [[ "$img_ver" != "$toolchain_raw" ]]; then
    cat >&2 <<EOF
assert-relay-go-pin: SCANNED and SHIPPED Go versions disagree (#704).

  relay/go.mod      toolchain go${toolchain_raw}   <- what CI scans
  relay/Dockerfile  FROM golang:${tag}   <- what the image ships

A green \`relay\` job says nothing true about the relay image while these differ.
govulncheck measures the toolchain it runs under, so it is reporting on
go${toolchain_raw} and the published binary is built with ${img_ver}.

Fix by moving BOTH to the same version in ONE commit. If dependabot bumped the
image alone, bump relay/go.mod \`toolchain\` to match in the same PR. If a stdlib
advisory forced the toolchain up, bump the \`FROM\` tag with it.
EOF
    rc=1
  fi
done <<< "$from_tags"

# --- sanity: the toolchain may not sit BELOW the language version ----------
go_directive="$(sed -n -E 's/^go[[:space:]]+([0-9]+\.[0-9]+(\.[0-9]+)?)[[:space:]]*$/\1/p' "$gomod")"
if [[ -n "$go_directive" ]]; then
  lowest="$(printf '%s\n%s\n' "$go_directive" "$toolchain_raw" | sort -V | head -1)"
  if [[ "$lowest" != "$go_directive" && "$go_directive" != "$toolchain_raw" ]]; then
    cat >&2 <<EOF
assert-relay-go-pin: relay/go.mod \`go ${go_directive}\` is ABOVE
\`toolchain go${toolchain_raw}\`.

The toolchain must be able to build the declared language version. Raise the
toolchain, or lower the \`go\` directive.
EOF
    rc=1
  fi
fi

if [[ "$rc" -ne 0 ]]; then
  exit "$rc"
fi

echo "relay Go pin: go.mod toolchain go${toolchain_raw} == Dockerfile golang:${toolchain_raw} (scanned == shipped)"
exit 0

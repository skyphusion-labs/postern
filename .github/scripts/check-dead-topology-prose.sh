#!/usr/bin/env bash
# check-dead-topology-prose.sh -- fail if live files still name retired topology (#806, #632 F10).
#
# The Hetzner fleet and its Swarm are gone. Live files (README, docs, CLAUDE.md,
# comments, workflows) must not name them. History stays: CHANGELOG release notes,
# docs/reviews/, and inbound migration comments. This script and its suite are
# excluded because they have to name the banned words in order to refuse them.
#
# .github/scripts/check-topology-scrub.sh is a different gate (box hostnames and
# RFC1918). Do not fold that denylist into this one.
#
# Usage:
#   bash .github/scripts/check-dead-topology-prose.sh
#   DEAD_TOPOLOGY_ROOT=/path/to/fixture bash .github/scripts/check-dead-topology-prose.sh
#
# Exit 0 when clean, 1 when a hit is found, 2 on usage/tooling error.
set -euo pipefail

root="${DEAD_TOPOLOGY_ROOT:-}"
if [[ -z "$root" ]]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
cd "$root" || exit 2

# Portable word match. git grep -E on this laptop does not treat \b as a word
# boundary, and CI must agree with that laptop, so the class is written out.
# shellcheck disable=SC2016
swarm_re='(^|[^A-Za-z0-9_])swarm([^A-Za-z0-9_]|$)'
hetzner_re='(^|[^A-Za-z0-9_])hetzner([^A-Za-z0-9_]|$)'

# History, plus the files that implement this gate. Everything else is scanned.
exclude_pathspecs=(
  ':!CHANGELOG.md'
  ':!docs/reviews'
  ':!inbound/migrations'
  ':!.github/scripts/check-dead-topology-prose.sh'
  ':!.github/scripts/tests/check-dead-topology-prose.test.sh'
  ':!.github/scripts/tests/fixtures/dead-topology-prose'
)

hits=""
scan() {
  local label="$1"
  local pattern="$2"
  local out
  if [[ -d "$root/.git" ]] && git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && [[ -z "${DEAD_TOPOLOGY_ROOT:-}" ]]; then
    out="$(git -C "$root" grep -nIEi -e "$pattern" -- . "${exclude_pathspecs[@]}" 2>/dev/null || true)"
  else
    # Fixture mode. Same excludes, by directory and file name, so a CHANGELOG
    # or a review note can carry the old words without failing the control.
    out="$(grep -RInEi \
      --exclude-dir=.git \
      --exclude-dir=reviews \
      --exclude-dir=migrations \
      --exclude-dir=dead-topology-prose \
      --exclude='CHANGELOG.md' \
      --exclude='check-dead-topology-prose.sh' \
      --exclude='check-dead-topology-prose.test.sh' \
      -e "$pattern" "$root" 2>/dev/null || true)"
  fi
  if [[ -n "$out" ]]; then
    hits+="--- ${label} ---"$'\n'"${out}"$'\n'
  fi
}

scan "swarm" "$swarm_re"
scan "hetzner" "$hetzner_re"

if [[ -n "$hits" ]]; then
  cat >&2 <<EOF
dead topology prose failed (#806 / #632 F10): a live file still names retired infrastructure.

Excluded as history: CHANGELOG.md, docs/reviews/, inbound/migrations/.
Excluded as this gate: check-dead-topology-prose.sh and its test.
Not excluded, and not to be edited here: .github/scripts/check-topology-scrub.sh.

${hits}
Say what the operator runs now, or drop the name. Do not describe the retired fleet as current.
EOF
  exit 1
fi

echo "dead topology prose: clean (no swarm, no hetzner in live tracked files)"
exit 0

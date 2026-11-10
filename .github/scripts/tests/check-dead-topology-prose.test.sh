#!/usr/bin/env bash
# Unit suite for check-dead-topology-prose.sh (#806).
#
# Positive control: a fixture that names Swarm or Hetzner MUST fail. Without
# that, a green run could be a dead path. Negative controls: history files may
# keep the old words, and product words (self-hosted, fleet-chezmoi, an L4
# load balancer) are not this gate. The real tree at HEAD must be clean.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/check-dead-topology-prose.sh"

pass_count=0
fail_count=0
ok()  { printf "  ok    %s\n" "$1"; pass_count=$((pass_count + 1)); }
bad() { printf "  FAIL  %s\n" "$1"; fail_count=$((fail_count + 1)); }

echo "check-dead-topology-prose suite"

# --- real tree is clean ---
if out="$(bash "$script" 2>&1)"; then
  ok "repo HEAD is clean"
else
  bad "repo HEAD is clean (gate failed on current tree): $out"
fi

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

# --- positive control: Swarm in a live doc ---
mkdir -p "$work/swarm/docs"
printf 'The Swarm host ran the door.\n' >"$work/swarm/docs/note.md"
if DEAD_TOPOLOGY_ROOT="$work/swarm" bash "$script" >/dev/null 2>&1; then
  bad "detects Swarm (expected fail, got pass)"
else
  ok "detects Swarm"
fi

# --- positive control: Hetzner in a live readme ---
mkdir -p "$work/hetz"
printf 'Released with the Hetzner cut.\n' >"$work/hetz/README.md"
if DEAD_TOPOLOGY_ROOT="$work/hetz" bash "$script" >/dev/null 2>&1; then
  bad "detects Hetzner (expected fail, got pass)"
else
  ok "detects Hetzner"
fi

# --- negative control: history may keep the words ---
mkdir -p "$work/hist/docs/reviews" "$work/hist/inbound/migrations"
printf '%s\n' 'Swarm and Hetzner, past release.' >"$work/hist/CHANGELOG.md"
printf '%s\n' 'Review noted the Swarm host.' >"$work/hist/docs/reviews/old.md"
printf '%s\n' '-- Swarm and Hetzner, historical migration comment' >"$work/hist/inbound/migrations/0014.sql"
printf 'A self-hosted mailbox. See fleet-chezmoi. An L4 load balancer is optional.\n' >"$work/hist/docs/live.md"
if DEAD_TOPOLOGY_ROOT="$work/hist" bash "$script" >/dev/null 2>&1; then
  ok "allows history files and product wording"
else
  bad "allows history files and product wording"
fi

# --- negative control: the banned word inside a longer token is not a hit ---
mkdir -p "$work/token/docs"
printf 'swarming is not the retired orchestrator\n' >"$work/token/docs/note.md"
if DEAD_TOPOLOGY_ROOT="$work/token" bash "$script" >/dev/null 2>&1; then
  ok "allows the letters inside a longer token"
else
  bad "allows the letters inside a longer token"
fi

echo
echo "${pass_count} passed, ${fail_count} failed"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
exit 0

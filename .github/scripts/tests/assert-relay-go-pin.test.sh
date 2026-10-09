#!/usr/bin/env bash
# Unit suite for assert-relay-go-pin.sh (#704).
#
# The gate exists because the SCANNED Go version and the SHIPPED Go version
# drifted apart silently. A gate for a silent defect is worthless unless it is
# watched failing, so every case below asserts an EXACT EXIT CODE, not a
# truthiness. The distinction matters: the failure this gate replaces was a
# check that could not fail, and an unreadable pin must exit 2 rather than read
# as agreement.
#
# Negative control: the real tree at HEAD agrees.
# Positive controls: both skew directions, the real historical skew, a
# patch-only skew, floating tags, and missing pins.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/assert-relay-go-pin.sh"

pass_count=0
fail_count=0
skip_count=0
ok()   { printf "  ok    %s\n" "$1"; pass_count=$((pass_count + 1)); }
bad()  { printf "  FAIL  %s\n" "$1"; fail_count=$((fail_count + 1)); }
skip() { printf "  SKIP  %s\n" "$1"; skip_count=$((skip_count + 1)); }

echo "assert-relay-go-pin suite"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

# mkfix <name> <go-directive-or-> <toolchain-line-or-> <from-line...>
# Builds a fixture tree at $work/<name> and echoes its path.
mkfix() {
  local name="$1"; shift
  local godir="$1"; shift
  local tc="$1"; shift
  local d="$work/$name"
  mkdir -p "$d/relay"
  {
    echo "module github.com/skyphusion/skyphusion-email/relay"
    echo
    [[ "$godir" != "-" ]] && echo "go ${godir}"
    [[ "$tc" != "-" ]] && echo "toolchain ${tc}"
    echo
    echo "require ("
    echo "	github.com/emersion/go-smtp v0.25.0"
    echo ")"
  } >"$d/relay/go.mod"
  {
    echo "# fixture"
    for line in "$@"; do echo "$line"; done
    echo "FROM debian:bookworm-slim AS runtime"
  } >"$d/relay/Dockerfile"
  echo "$d"
}

# expect <label> <expected-exit> <fixture-root-or-REAL>
expect() {
  local label="$1" want="$2" r="$3" got
  if [[ "$r" == "REAL" ]]; then
    bash "$script" >/dev/null 2>&1
  else
    RELAY_PIN_ROOT="$r" bash "$script" >/dev/null 2>&1
  fi
  got=$?
  if [[ "$got" -eq "$want" ]]; then
    ok "${label} (exit ${got})"
  else
    bad "${label}: expected exit ${want}, got ${got}"
  fi
}

# --- negative control: the real tree agrees -------------------------------
expect "repo HEAD: scanned == shipped" 0 REAL

# --- negative control: an aligned fixture passes --------------------------
expect "aligned fixture passes" 0 \
  "$(mkfix aligned 1.25.0 go1.26.9 'FROM golang:1.26.9-bookworm AS builder')"

# --- positive control: the REAL historical skew (#704) --------------------
expect "catches the historical skew (gate 1.25.13 over image 1.26.6)" 1 \
  "$(mkfix historical 1.25.0 go1.25.13 'FROM golang:1.26.6-bookworm AS builder')"

# --- positive control: image NEWER than the toolchain ---------------------
# This is the direction GOTOOLCHAIN=local in the builder CANNOT catch: a newer
# local toolchain satisfies the directive, so the build succeeds silently.
expect "catches image newer than toolchain" 1 \
  "$(mkfix img_newer 1.25.0 go1.26.9 'FROM golang:1.27.0-bookworm AS builder')"

# --- positive control: toolchain NEWER than the image --------------------
expect "catches toolchain newer than image" 1 \
  "$(mkfix tc_newer 1.25.0 go1.27.0 'FROM golang:1.26.9-bookworm AS builder')"

# --- positive control: a PATCH-only skew must be caught ------------------
# A stdlib CVE is fixed at a patch release, so comparing only the minor line
# would miss exactly the advisory class this gate was built for.
expect "catches a patch-only skew (1.26.9 vs 1.26.6)" 1 \
  "$(mkfix patch_skew 1.25.0 go1.26.9 'FROM golang:1.26.6-bookworm AS builder')"

# --- positive control: floating tags are not pins ------------------------
expect "rejects a floating minor tag (1.26-bookworm)" 1 \
  "$(mkfix floating 1.25.0 go1.26.9 'FROM golang:1.26-bookworm AS builder')"
expect "rejects golang:latest" 1 \
  "$(mkfix latest 1.25.0 go1.26.9 'FROM golang:latest AS builder')"

# --- positive control: a second builder stage is checked too -------------
expect "catches a skewed SECOND golang stage" 1 \
  "$(mkfix two_stage 1.25.0 go1.26.9 \
      'FROM golang:1.26.9-bookworm AS builder' \
      'FROM golang:1.25.13-bookworm AS tools')"

# --- positive control: an unreadable pin is NOT agreement ----------------
expect "missing toolchain directive exits 2, not 0" 2 \
  "$(mkfix no_toolchain 1.25.0 - 'FROM golang:1.26.9-bookworm AS builder')"
expect "no FROM golang stage exits 2, not 0" 2 \
  "$(mkfix no_from 1.25.0 go1.26.9 'FROM alpine:3.20 AS builder')"
expect "missing relay/ files exit 2, not 0" 2 "$work/does-not-exist"

# --- positive control: the toolchain may not sit below the language ------
expect "catches a go directive above the toolchain" 1 \
  "$(mkfix inverted 1.27.0 go1.26.9 'FROM golang:1.26.9-bookworm AS builder')"

# --- the gate must carry no bash-4-only construct, checked STATICALLY ----
#
# This case replaces an exit-status-only check that could not fail. The old one
# ran the gate under /bin/bash and asserted a non-zero exit with stderr thrown
# away. A bash-4 builtin is NON-FATAL under bash 3.2: `mapfile` prints
# `mapfile: command not found`, the script carries on, the skew is still detected,
# and the exit stays 1. So the case reported ok while the gate was broken.
# Demonstrated by mutation on #711; this is the guard that catches it instead.
#
# The static scan is what pins the floor IN CI, because /bin/bash on the ubuntu
# runner is bash 5 and the dynamic case below can only SKIP there.
b4_src="$work/gate-nocomments.sh"
sed -E 's/#.*$//' "$script" > "$b4_src"
b4_re='(^|[^[:alnum:]_])(mapfile|readarray|coproc)([^[:alnum:]_]|$)|(declare|local|typeset)[[:space:]]+-[A-Za-z]*A([[:space:]]|$)|\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?(\^\^|,,)'
b4_hits="$(grep -nE "$b4_re" "$b4_src")"
if [[ -n "$b4_hits" ]]; then
  bad "gate uses a bash-4-only construct (breaks under /bin/bash 3.2): $(echo "$b4_hits" | tr '\n' ' ')"
else
  ok "gate carries no bash-4-only construct (mapfile, readarray, declare -A, case modification)"
fi

# --- and the gate must actually RUN CLEAN under bash 3.x when one exists --
# Asserted on STDERR, not only on the exit code, for the reason above. A
# /bin/bash that is not 3.x cannot pin the floor, so it SKIPs loudly rather than
# reporting a pass it did not earn (fleet-chezmoi#2241).
if [[ -x /bin/bash ]]; then
  b32_ver="$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"' 2>/dev/null)"
  b32_err="$work/b32.stderr"
  RELAY_PIN_ROOT="$(mkfix b32 1.25.0 go1.26.9 'FROM golang:1.26.6-bookworm AS builder')" \
    /bin/bash "$script" >/dev/null 2>"$b32_err"
  b32_code=$?
  b32_interp_re='command not found|syntax error|unrecognized|bad substitution|not supported'
  # Only the INTERPRETER lines. The gate's own skew report is on stderr too and is
  # the expected output here, so printing all of stderr would bury the finding.
  if grep -qiE "$b32_interp_re" "$b32_err"; then
    bad "/bin/bash $b32_ver run is free of interpreter errors: $(grep -iE "$b32_interp_re" "$b32_err" | tr '\n' ' ')"
  elif [[ "$b32_code" -ne 1 ]]; then
    bad "/bin/bash $b32_ver still detects skew: expected exit 1, got $b32_code"
  elif [[ "${b32_ver%%.*}" == "3" ]]; then
    ok "gate runs clean and detects skew under /bin/bash $b32_ver (bash 3.x floor pinned)"
  else
    skip "/bin/bash is $b32_ver, not 3.x: this run does NOT pin the bash-3.2 floor (the static scan above does)"
  fi
fi

echo
echo "${pass_count} passed, ${fail_count} failed, ${skip_count} skipped"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
exit 0

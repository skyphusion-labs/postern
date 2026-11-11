#!/usr/bin/env bash
# Regression suite for the post-deploy principals backfill (#901).
#
# The live seam (the real instance on a tag deploy) can only run on a release. What is
# testable here is the verdict logic, driven against a local stub instance. The cases that
# matter are the REFUSALS: a missing secret, an edge still on the old version, a non-200 and
# a malformed report must each go RED, because a skipped backfill reads exactly like a
# converged one. P (privacy) is load-bearing: postern is a PUBLIC repo, so the script must
# never print the token, a response message or a mailbox address.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/principals-backfill.mjs"
work="$(mktemp -d)"
srv_pid=""
cleanup() { [ -n "$srv_pid" ] && kill "$srv_pid" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

pass_count=0; fail_count=0
ok()  { printf "  ok    %s\n" "$1"; pass_count=$((pass_count + 1)); }
bad() { printf "  FAIL  %s\n" "$1"; fail_count=$((fail_count + 1)); }

TOKEN="admin-token-MUST-NOT-PRINT-4c1d"
ADDR="someone-private@example.invalid"
MSG="SECRET-MESSAGE-MUST-NOT-PRINT"

# The stub: behaviour comes from $work/mode, so one server serves every case.
cat > "$work/stub.mjs" <<'JS'
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const dir = process.argv[2];
const mode = () => readFileSync(`${dir}/mode`, "utf8").trim();
let healthHits = 0;
const srv = createServer((req, res) => {
  const m = mode();
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") {
    healthHits++;
    const v = m === "never" ? "1.0.0" : m === "late" && healthHits < 3 ? "1.0.0" : "1.2.3";
    return send(200, { ok: true, version: v });
  }
  if (req.url === "/api/admin/principals/backfill" && req.method === "POST") {
    writeFileSync(`${dir}/auth`, req.headers.authorization || "");
    if (m === "e500") return send(500, { ok: false, error: "E_INTERNAL", message: process.env.MSG });
    if (m === "e403") return send(403, { ok: false, error: "forbidden", message: process.env.MSG });
    if (m === "malformed") return send(200, { ok: true, services: { added: 1 } });
    const conflicts = m === "conflict" ? [{ address: process.env.ADDR, principalId: "prn_abc123", ownerId: "idn_owner9" }] : [];
    return send(200, { ok: true, services: { added: 3 }, agents: { added: 1, synced: 0 }, humans: { added: 2, synced: 0, orphansRevoked: 0 }, addressConflicts: conflicts });
  }
  send(404, { ok: false });
});
srv.listen(0, "127.0.0.1", () => { writeFileSync(`${dir}/port`, String(srv.address().port)); });
JS
echo ok > "$work/mode"
ADDR="$ADDR" MSG="$MSG" node "$work/stub.mjs" "$work" & srv_pid=$!
for _ in $(seq 1 50); do [ -s "$work/port" ] && break; sleep 0.1; done
[ -s "$work/port" ] || { echo "FATAL: stub did not start"; exit 2; }
BASE="http://127.0.0.1:$(cat "$work/port")"

run() { # run <mode> [extra env assignments...]; sets RC and OUT
  echo "$1" > "$work/mode"; shift
  : > "$work/auth"
  OUT="$(env POSTERN_BASE_URL="$BASE" POSTERN_DEPLOY_ADMIN_TOKEN="$TOKEN" POSTERN_EXPECT_VERSION=v1.2.3 \
    BACKFILL_POLL_MS=50 BACKFILL_VERSION_TIMEOUT_MS=1500 "$@" node "$script" 2>&1)"
  RC=$?
}
private() { # private <label>: no token, address or message in the output
  case "$OUT" in *"$TOKEN"*|*"$ADDR"*|*"$MSG"*) bad "$1: printed the token, an address or a message";; *) ok "$1: printed no token, address or message";; esac
}

echo "== green =="
run ok
[ "$RC" -eq 0 ] && ok "G1 a converged 200 exits 0" || bad "G1 rc=$RC :: $OUT"
grep -qF '@event principals-backfill {"services_added":3,"agents_added":1,"agents_synced":0,"humans_added":2,"humans_synced":0,"humans_orphans_revoked":0,"address_conflicts":0}' <<<"$OUT" && ok "G1 prints the counts as one event line" || bad "G1 counts :: $OUT"
[ "$(cat "$work/auth")" = "Bearer $TOKEN" ] && ok "G1 sends the token as a Bearer" || bad "G1 auth header"
private "G1"
run late
[ "$RC" -eq 0 ] && grep -q "reports 1.2.3" <<<"$OUT" && ok "G2 waits for /health to report the tag, then runs" || bad "G2 rc=$RC :: $OUT"
run conflict
[ "$RC" -eq 0 ] && ok "G3 a conflict is a warning, not a failure" || bad "G3 rc=$RC"
grep -q '^::warning title=principals backfill::an address claimed by principal prn_abc123 is already owned by idn_owner9' <<<"$OUT" && ok "G3 names the conflict by opaque ids" || bad "G3 warning :: $OUT"
private "G3 (the planted address must not appear)"

echo "== red =="
run ok POSTERN_DEPLOY_ADMIN_TOKEN=
[ "$RC" -eq 2 ] && grep -q "POSTERN_DEPLOY_ADMIN_TOKEN is not set" <<<"$OUT" && ok "R1 a missing token fails by name (exit 2)" || bad "R1 rc=$RC :: $OUT"
[ -z "$(cat "$work/auth")" ] && ok "R1 makes no request" || bad "R1 made a request"
run ok POSTERN_BASE_URL=
[ "$RC" -eq 2 ] && grep -q "POSTERN_BASE_URL is not set" <<<"$OUT" && ok "R2 a missing base URL fails by name" || bad "R2 rc=$RC"
run ok POSTERN_EXPECT_VERSION=
[ "$RC" -eq 2 ] && grep -q "POSTERN_EXPECT_VERSION is not set" <<<"$OUT" && ok "R3 a missing version fails by name" || bad "R3 rc=$RC"
run never
[ "$RC" -eq 1 ] && grep -q "never reported 1.2.3" <<<"$OUT" && ok "R4 an edge that never reports the tag fails, and does not POST" || bad "R4 rc=$RC :: $OUT"
[ -z "$(cat "$work/auth")" ] && ok "R4 made no POST" || bad "R4 posted to the old version"
run e500
[ "$RC" -eq 1 ] && grep -q "answered HTTP 500 E_INTERNAL" <<<"$OUT" && ok "R5 a 500 fails the release, with the error code" || bad "R5 rc=$RC :: $OUT"
private "R5"
run e403
[ "$RC" -eq 1 ] && grep -q "answered HTTP 403 forbidden" <<<"$OUT" && ok "R6 a 403 (token without admin) fails" || bad "R6 rc=$RC :: $OUT"
private "R6"
run malformed
[ "$RC" -eq 1 ] && grep -q "not the documented shape" <<<"$OUT" && ok "R7 a 200 with a malformed report fails" || bad "R7 rc=$RC :: $OUT"
run ok POSTERN_BASE_URL=http://127.0.0.1:9 BACKFILL_VERSION_TIMEOUT_MS=300
[ "$RC" -eq 1 ] && ok "R8 an unreachable instance fails" || bad "R8 rc=$RC :: $OUT"

echo "cases_run=$((pass_count + fail_count)) passed=$pass_count failed=$fail_count"
[ "$fail_count" -eq 0 ] || exit 1
echo "principals-backfill.test.sh: COMPLETE"

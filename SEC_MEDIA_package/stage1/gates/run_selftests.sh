#!/usr/bin/env bash
# SEC-MEDIA · Stage 1 · OFFLINE gate (ağ yok, canlıya istek yok):
#   node --check + üç --selftest + offline rehearsal + iki secret scan + SHA256SUMS.
# Exit: 0 PASS · 1 FAIL · 4 rehearsal SKIPPED (bağımlılık yok) — 4 PASS sayılmaz.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
fail=0; skipped=0
for f in gates/*.mjs; do node --check "$f" || { echo "SYNTAX_FAIL $f"; fail=1; }; done
node gates/s1_admin_upload_acceptance.mjs --selftest 2>/dev/null || fail=1
node gates/s1_negative.mjs --selftest 2>/dev/null || fail=1
node gates/s1_snapshot_diff.mjs --selftest 2>/dev/null || fail=1
node gates/s1_offline_rehearsal.mjs 2>/dev/null; rc=$?
if [ "$rc" = "4" ]; then skipped=1; elif [ "$rc" != "0" ]; then fail=1; fi
bash "$ROOT/CDP3C_package/gates/secret_scan.sh" . || fail=1
mapfile -t files < <(find . -type f ! -path './node_modules/*' | sort)
bash "$ROOT/CDP3D_package/gates/cdp3d_secret_scan.sh" "${files[@]}" || fail=1
sha256sum --quiet -c SHA256SUMS || { echo "SHA256SUMS_MISMATCH"; fail=1; }
if [ "$fail" != "0" ]; then echo "S1_OFFLINE_GATE_FAIL"; exit 1; fi
if [ "$skipped" != "0" ]; then echo "S1_OFFLINE_GATE_INCOMPLETE (rehearsal skipped)"; exit 4; fi
echo "S1_OFFLINE_GATE_PASS"

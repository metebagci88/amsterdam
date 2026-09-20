#!/usr/bin/env bash
# =====================================================================
# CDP-3D · Secret-scan SELF-TEST (pozitif + negatif). Gate mantığını doğrular:
#  - Pozitif: yalnız bilinen local demo JWT + local DBURL -> redakte -> CLEAN (geçmeli).
#  - Negatif: gerçek görünümlü JWT / re_ / sb_secret_ / PEM / GitHub token / farklı conn-string
#             -> her biri KIRMIZI (yakalanmalı).
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCAN="$HERE/cdp3d_secret_scan.sh"
TMP="$(mktemp -d)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "PASS $2"; pass=$((pass+1)); else echo "FAIL $2"; fail=$((fail+1)); fi; }

# Bilinen local (ephemeral) sırlar — redakte edilecek
DEMO_JWT='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8ifQ.LOCALDEMOSIGNATURExxxxxxxxxxxxxxx'
DEMO_DBURL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
export LOCAL_SECRETS="$DEMO_JWT
$DEMO_DBURL"

# POZİTİF: yalnız local demo değerler -> CLEAN
printf '%s\nserving on %s\n' "$DEMO_JWT" "$DEMO_DBURL" > "$TMP/pos.log"
out="$(bash "$SCAN" "$TMP/pos.log")"; rc=$?
[ "$rc" = "0" ] && echo "$out" | grep -q SECRET_SCAN_CLEAN && ok 1 "pozitif: local demo redakte -> CLEAN" || ok 0 "pozitif (out=$out rc=$rc)"

# NEGATİF vakalar -> GATE_FAILED
neg(){ printf '%s\n' "$2" > "$TMP/neg.log"; out="$(bash "$SCAN" "$TMP/neg.log")"; rc=$?; { [ "$rc" != "0" ] && echo "$out" | grep -q GATE_FAILED; } && ok 1 "negatif: $1 yakalandı" || ok 0 "negatif: $1 YAKALANMADI (out=$out rc=$rc)"; }
neg "gerçek JWT"    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWFsIiwieCI6MTIzNDU2fQ.ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'
neg "resend re_"    're_A1b2C3d4E5f6G7h8i9J0'
neg "sb_secret_"    'sb_secret_A1b2C3d4E5f6G7h8'
neg "PEM key"       '-----BEGIN PRIVATE KEY-----MIIEvAIBADANBg...'
neg "github token"  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
neg "conn parola"   'postgresql://admin:Sup3rSecretProdPw@db.prod.example.com:5432/app'

echo ""
echo "SELFTEST pass=$pass fail=$fail"
[ "$fail" = "0" ] && echo "SECRET_SCAN_SELFTEST_PASS" || echo "SECRET_SCAN_SELFTEST_FAIL"
[ "$fail" = "0" ]

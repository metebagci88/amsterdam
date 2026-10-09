#!/usr/bin/env bash
# WP8 secret-scan SELF-TEST. Every fake secret is built at RUNTIME from random bytes, so no file in
# the repository holds a key- or JWT-shaped literal (the scan of the repository stays meaningful).
#  - positive: the real WP8 scope and the real dispatch Edge (Deno.env.get("..._KEY") reads) -> CLEAN
#  - negative: a fake JWT / Resend key / sb_secret_ / whsec_ / PEM / GitHub token / conn string /
#    quoted secret assignment / literal dispatch token / literal bearer -> each one is caught,
#    in the Edge source, in a SQL file and inside the default WP8 scope (mirror root).
# Sentinel WP8_SECRET_SCAN_SELFTEST_PASS only when pass == EXPECTED and fail == 0.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${WP8_ROOT:-$(cd "$HERE/../.." && pwd)}"
SCAN="$HERE/wp8_secret_scan.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/wp8scan.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
EXPECTED=24
pass=0; fail=0
ok() { if [[ "$1" == "1" ]]; then echo "PASS $2"; pass=$((pass+1)); else echo "FAIL $2"; fail=$((fail+1)); fi; }
rnd() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
EDGE="$ROOT/CDP3D_package/edge/service-email-dispatch/index.ts"

out="$(WP8_ROOT="$ROOT" bash "$SCAN" 2>&1)"; rc=$?
ok "$([[ $rc -eq 0 && "$out" == *SECRET_SCAN_CLEAN* ]] && echo 1)" "positive: the WP8 scope (package, dispatch Edge, workflow) is clean"
out="$(WP8_ROOT="$ROOT" bash "$SCAN" "$EDGE" 2>&1)"; rc=$?
ok "$([[ $rc -eq 0 && "$out" == *SECRET_SCAN_CLEAN* ]] && grep -q 'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")' "$EDGE" && echo 1)" "positive: Deno.env.get(\"..._KEY\") reads in the dispatch Edge are not a finding"
if [[ -f "$ROOT/CDP3C_package/gates/secret_scan.sh" ]]; then
  info="$(bash "$ROOT/CDP3C_package/gates/secret_scan.sh" "$EDGE" 2>&1 | tail -1)"
  echo "INFO generic CDP-3C scanner on the same Edge file (pre-existing false-positive pattern, not gating): ${info:0:120}"
fi

hdr="$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)"
pay="$(printf '{"iss":"supabase","ref":"%s","role":"service_role","iat":%s}' "$(rnd 20)" "$(date +%s)" | b64url)"
FAKE_JWT="$hdr.$pay.$(rnd 43)"
declare -A FAKE=(
  [jwt]="const k = \"$FAKE_JWT\";"
  [resend_key]="re_$(rnd 28)"
  [sb_secret]="sb_secret_$(rnd 30)"
  [webhook_secret]="whsec_$(rnd 32)"
  [pem]="$(printf -- '-----%s %s-----' BEGIN 'PRIVATE KEY')"
  [github_token]="ghp_$(rnd 36)"
  [conn_string]="postgresql://app:$(rnd 18)@db.$(rnd 8 | tr 'A-Z' 'a-z').example:5432/app"
  [quoted_assignment]="const RESEND_API_KEY = \"$(rnd 32)\";"
  [dispatch_token_literal]="headers: { \"x-asalocal-dispatch-token\": \"$(rnd 40)\" }"
  [bearer_literal]="authorization: Bearer $(rnd 48)"
)
for k in jwt resend_key sb_secret webhook_secret pem github_token conn_string quoted_assignment dispatch_token_literal bearer_literal; do
  cp "$EDGE" "$TMP/index.ts"; printf '\n// %s\n' "${FAKE[$k]}" >> "$TMP/index.ts"
  out="$(WP8_ROOT="$ROOT" bash "$SCAN" "$TMP/index.ts" 2>&1)"; rc=$?
  ok "$([[ $rc -ne 0 && "$out" == *GATE_FAILED:secret_scan* ]] && echo 1)" "negative: runtime-built $k in the dispatch Edge is caught"
done
for k in jwt resend_key quoted_assignment bearer_literal; do
  { head -c 2000 "$ROOT/WP8_package/db/WP8_DB_up.src.sql"; printf '\n-- %s\n' "${FAKE[$k]}"; } > "$TMP/x.sql"
  out="$(WP8_ROOT="$ROOT" bash "$SCAN" "$TMP/x.sql" 2>&1)"; rc=$?
  ok "$([[ $rc -ne 0 && "$out" == *GATE_FAILED:secret_scan* ]] && echo 1)" "negative: runtime-built $k in a SQL file is caught"
done
# Default scope really covers WP8_package/**, the Edge and the workflow (mirror root, fake injected).
mkroot() { rm -rf "$TMP/root"; mkdir -p "$TMP/root/CDP3D_package/gates" "$TMP/root/CDP3D_package/edge/service-email-dispatch" "$TMP/root/.github/workflows"
  cp -r "$ROOT/WP8_package" "$TMP/root/WP8_package"; rm -rf "$TMP/root/WP8_package/gates/node_modules"
  cp "$ROOT/CDP3D_package/gates/cdp3d_secret_scan.sh" "$TMP/root/CDP3D_package/gates/"; cp "$EDGE" "$TMP/root/CDP3D_package/edge/service-email-dispatch/"
  [[ -f "$ROOT/.github/workflows/wp8-gates.yml" ]] && cp "$ROOT/.github/workflows/wp8-gates.yml" "$TMP/root/.github/workflows/"; true; }
mkroot; out="$(WP8_ROOT="$TMP/root" bash "$TMP/root/WP8_package/gates/wp8_secret_scan.sh" 2>&1)"; rc=$?
ok "$([[ $rc -eq 0 && "$out" == *SECRET_SCAN_CLEAN* ]] && echo 1)" "positive: the mirror root is clean before injection"
for target in WP8_package/WP8_README.md WP8_package/ops/WP8_OPS_kill_switch_soft.sql WP8_package/gates/wp8_db_suite.mjs CDP3D_package/edge/service-email-dispatch/index.ts; do
  mkroot; [[ -f "$TMP/root/$target" ]] || touch "$TMP/root/$target"; printf '\n%s\n' "${FAKE[jwt]}" >> "$TMP/root/$target"
  out="$(WP8_ROOT="$TMP/root" bash "$TMP/root/WP8_package/gates/wp8_secret_scan.sh" 2>&1)"; rc=$?
  ok "$([[ $rc -ne 0 && "$out" == *GATE_FAILED:secret_scan* ]] && echo 1)" "negative: a runtime-built JWT in $target is caught by the default scope"
done
mkroot; mkdir -p "$TMP/root/.github/workflows"; printf 'env:\n  X: "%s"\n' "$FAKE_JWT" >> "$TMP/root/.github/workflows/wp8-gates.yml"
out="$(WP8_ROOT="$TMP/root" bash "$TMP/root/WP8_package/gates/wp8_secret_scan.sh" 2>&1)"; rc=$?
ok "$([[ $rc -ne 0 && "$out" == *GATE_FAILED:secret_scan* ]] && echo 1)" "negative: a runtime-built JWT in .github/workflows/wp8-gates.yml is caught by the default scope"
ok "$([[ "$out" != *"$FAKE_JWT"* ]] && echo 1)" "the scan output never echoes the secret value"
ok "$(! grep -rEq 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.' "$HERE/wp8_secret_scan.sh" "$HERE/wp8_secret_scan_selftest.sh" && echo 1)" "the scanner and this self-test hold no JWT-shaped literal"

echo
echo "SECRET SELFTEST RESULT pass=$pass fail=$fail expected=$EXPECTED"
if [[ $fail -eq 0 && $pass -eq $EXPECTED ]]; then echo "WP8_SECRET_SCAN_SELFTEST_PASS"; else echo "WP8_SECRET_SCAN_SELFTEST_FAIL"; exit 1; fi

#!/usr/bin/env bash
# WP8 secret scan, scoped like CDP3D_package/gates/cdp3d_secret_scan.sh (value patterns, not
# variable names). The generic CDP-3C scanner flags every "..._KEY = Deno.env.get(...)" read,
# which is a pre-existing false positive of the dispatch Edge (v3 and v4); this gate does not.
# It still fails on a real-looking key or JWT anywhere in its scope (see wp8_secret_scan_selftest.sh).
# Scope (default): every file under WP8_package (node_modules excluded), the dispatch Edge source
# and .github/workflows/wp8-gates.yml. Explicit file arguments replace the default scope.
#   bash WP8_package/gates/wp8_secret_scan.sh [file ...]      -> SECRET_SCAN_CLEAN or GATE_FAILED:secret_scan
# WP8_ROOT overrides the repo root (mutation suite). No network.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${WP8_ROOT:-$(cd "$HERE/../.." && pwd)}"
files=()
if [[ $# -gt 0 ]]; then
  files=("$@")
else
  while IFS= read -r f; do files+=("$f"); done < <(find "$ROOT/WP8_package" -type f -not -path '*/node_modules/*' | sort)
  files+=("$ROOT/CDP3D_package/edge/service-email-dispatch/index.ts")
  [[ -f "$ROOT/.github/workflows/wp8-gates.yml" ]] && files+=("$ROOT/.github/workflows/wp8-gates.yml")
fi
[[ ${#files[@]} -gt 0 ]] || { echo "GATE_FAILED:secret_scan:no_files"; exit 1; }

# 1) The CDP-3D value patterns: JWT, sb_secret_, Resend re_, PEM, GitHub tokens, user:pass@host.
base="$(bash "$ROOT/CDP3D_package/gates/cdp3d_secret_scan.sh" "${files[@]}" 2>&1)"; base_rc=$?

# 2) WP8 extras (values only, never bare variable names; case-sensitive, so the SQL column
#    pref_key = 'welcome_service_email' is not an upper-case secret-name assignment):
PATTERNS=(
  'whsec_[A-Za-z0-9+/=]{16,}'
  '[Bb]earer [A-Za-z0-9._~+/-]{30,}'
  '(KEY|TOKEN|SECRET|PASSWORD|JWT|PEPPER)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/_+.=~-]{16,}["'"'"']'
  'x-asalocal-dispatch-token["'"'"']?[[:space:]]*[:,][[:space:]]*["'"'"'][A-Za-z0-9/_+.=~-]{16,}["'"'"']'
  'service_role.{0,20}eyJ[A-Za-z0-9_-]{10,}'
)
leak=0
for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  for p in "${PATTERNS[@]}"; do
    if grep -Eq -- "$p" "$f"; then echo "SECRET_LEAK[wp8:$p] in ${f#"$ROOT"/}"; leak=1; fi
  done
done
if [[ $base_rc -ne 0 ]]; then printf '%s\n' "$base" | grep -v '^GATE_FAILED' ; leak=1; fi
echo "scanned_files=${#files[@]}"
if [[ $leak -eq 0 ]]; then echo "SECRET_SCAN_CLEAN"; exit 0; else echo "GATE_FAILED:secret_scan"; exit 1; fi

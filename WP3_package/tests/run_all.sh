#!/usr/bin/env bash
# WP3 · browser storage city isolation — tek komutla tüm kapılar (ağ gerektirmez, production'a dokunmaz).
#
#   NODE_PATH=<playwright + jsdom içeren node_modules> bash WP3_package/tests/run_all.sh
#
# Sıra: lib + WP3 birim testleri → UX Sprint 1 sözleşmesi (jsdom) → Playwright e2e (yerel statik sunucu,
# tüm dış istekler route() stub'ı; masaüstü + 390px mobil) → SHA256SUMS → secret scan (yeni dosyalar +
# sayfalara EKLENEN satırlar). Çıkış: 0 = WP3_GATES_PASS · 1 = WP3_GATES_FAIL · 4 = bağımlılık yok
# (WP3_GATES_INCOMPLETE; PASS sayılmaz).
# Ortam: WP3_BASE_REF (WP3 öncesi commit; geri dönüş kanıtı + eklenen-satır taraması, varsayılan 7a548e9).
set -uo pipefail
cd "$(dirname "$0")/../.."
BASE_REF="${WP3_BASE_REF:-7a548e9}"
fail=0; missing=0

echo "== 1/6 node unit (lib + WP3) =="
node --test lib/asa-storage/asa_storage.test.mjs WP3_package/tests/wp3_unit.test.mjs || fail=1

echo "== 2/6 UX Sprint 1 trust check (jsdom) =="
if node -e 'require("jsdom")' >/dev/null 2>&1; then
  node scripts/ux_sprint1_trust_check.mjs || fail=1
else
  echo "MISSING_DEP jsdom (NODE_PATH ile ver)"; missing=1
fi

echo "== 3/6 Playwright e2e =="
if ! git -C . cat-file -e "${BASE_REF}:amsterdam/index.html" 2>/dev/null; then
  echo "MISSING_DEP git history for ${BASE_REF} (actions/checkout fetch-depth: 0)"; missing=1
fi
if node -e 'require("playwright")' >/dev/null 2>&1; then
  WP3_BASE_REF="$BASE_REF" node WP3_package/tests/wp3_e2e.mjs || fail=1
else
  echo "MISSING_DEP playwright (NODE_PATH ile ver)"; missing=1
fi

echo "== 4/6 SHA256SUMS =="
sha256sum --quiet -c SHA256SUMS || { echo "SHA256SUMS_MISMATCH"; fail=1; }

echo "== 5/6 Kopenhag stub byte-identical to ${BASE_REF} =="
if git -C . cat-file -e "${BASE_REF}:kopenhag/index.html" 2>/dev/null; then
  if [ "$(git show "${BASE_REF}:kopenhag/index.html" | sha256sum | cut -d' ' -f1)" = "$(sha256sum kopenhag/index.html | cut -d' ' -f1)" ]; then echo "CPH_STUB_IDENTICAL"; else echo "CPH_STUB_CHANGED"; fail=1; fi
else
  missing=1
fi

echo "== 6/6 secret scan =="
SCAN=(WP3_package lib/asa-storage scripts/ux_sprint1_trust_check.mjs .github/workflows/wp3-storage-gates.yml)
tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
if git -C . cat-file -e "${BASE_REF}^{commit}" 2>/dev/null; then
  # The pages already carry the public anon key (pre-existing); scan only the lines WP3 adds to them.
  git diff "${BASE_REF}" -- index.html amsterdam/index.html | grep '^+' | grep -v '^+++' > "$tmpd/wp3_added_page_lines.txt" || true
  SCAN+=("$tmpd/wp3_added_page_lines.txt")
fi
bash CDP3C_package/gates/secret_scan.sh "${SCAN[@]}" || fail=1
mapfile -t files < <(find "${SCAN[@]}" -type f | sort)
bash CDP3D_package/gates/cdp3d_secret_scan.sh "${files[@]}" || fail=1

if [ "$fail" != "0" ]; then echo "WP3_GATES_FAIL"; exit 1; fi
if [ "$missing" != "0" ]; then echo "WP3_GATES_INCOMPLETE"; exit 4; fi
echo "WP3_GATES_PASS"

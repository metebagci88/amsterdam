#!/usr/bin/env bash
# WP5 · ad-soyad ve profil tamamlama (web) — tek komutla tüm kapılar (ağ gerektirmez, production'a dokunmaz).
#
#   PLAYWRIGHT_BROWSERS_PATH=<chromium> NODE_PATH=<playwright + jsdom + tailwindcss deps> bash WP5_package/web/tests/run_all.sh
#
# Sıra: WP5 birim (ASA_NAME mantığı + istemci≡sunucu isim politikası + statik sayfa sözleşmesi) → WP5 Playwright e2e
# (yerel statik sunucu; tüm dış istekler route() stub'ı; Tailwind her sayfanın kendi config'i ile yerelde derlenir;
# 1366 / 390 / 360) → WP4 kapıları (regresyon; içinde WP3 kapıları, UX Sprint 1, WSE tripwire; WP4_SCOPE_CHECKS=0)
# → ASA_NAME pin (v = sha256(16)) + SHA256SUMS → WP5 secret scan (yeni dosyalar + sayfalara WP5'in EKLEDİĞİ satırlar).
# Çıkış: 0 = WP5_WEB_GATES_PASS · 1 = WP5_WEB_GATES_FAIL · 4 = bağımlılık/geçmiş yok (WP5_WEB_GATES_INCOMPLETE; PASS sayılmaz).
# Ortam: WP5_PARENT_REF (WP5'in atası = WP4 sonrası main; varsayılan cfdf79e) — eklenen-satır taraması ve "dokunulmadı" kontrolleri.
#        WP5_DB_SQL (isteğe bağlı) — WP5_DB_up.sql yolu: istemci politikası DB CHECK literal'leriyle birebir mi (drift tripwire).
set -uo pipefail
cd "$(dirname "$0")/../../.."
export WP5_PARENT_REF="${WP5_PARENT_REF:-cfdf79e}"
fail=0; missing=0

for ref in "$WP5_PARENT_REF" 7a548e9 7801394; do
  git -C . cat-file -e "${ref}^{commit}" 2>/dev/null || { echo "MISSING_DEP git history for ${ref} (actions/checkout fetch-depth: 0)"; missing=1; }
done

echo "== 1/5 WP5 node unit (ASA_NAME + politika + statik sözleşme) =="
node --test WP5_package/web/tests/wp5_unit.test.mjs || fail=1

echo "== 2/5 WP5 Playwright e2e (1366 / 390 / 360) =="
if node -e 'require("playwright")' >/dev/null 2>&1; then
  node WP5_package/web/tests/wp5_e2e.mjs; rc=$?
  if [ "$rc" = "4" ]; then missing=1; elif [ "$rc" != "0" ]; then fail=1; fi
else
  echo "MISSING_DEP playwright (NODE_PATH ile ver)"; missing=1
fi

echo "== 3/5 WP4 gates (regresyon: WP4 + WP3 + UX Sprint 1 + WSE) =="
WP4_SCOPE_CHECKS=0 bash WP4_package/tests/run_all.sh; rc=$?
if [ "$rc" = "4" ]; then missing=1; elif [ "$rc" != "0" ]; then fail=1; fi

echo "== 4/5 ASA_NAME pin + SHA256SUMS =="
v="$(sha256sum lib/asa-name/asa_name.js | cut -c1-16)"
for p in index.html amsterdam/index.html; do
  n="$(grep -c "<script src=\"/lib/asa-name/asa_name.js?v=${v}\"></script>" "$p")"
  if [ "$n" = "1" ]; then echo "ASA_NAME_PIN_OK ${p} v=${v}"; else echo "ASA_NAME_PIN_STALE ${p} (beklenen v=${v})"; fail=1; fi
done
sha256sum --quiet -c SHA256SUMS && echo "SHA256SUMS_OK" || { echo "SHA256SUMS_MISMATCH"; fail=1; }

echo "== 5/5 WP5 secret scan =="
SCAN=(WP5_package/web lib/asa-name .github/workflows/wp5-web-gates.yml)
tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
if git -C . cat-file -e "${WP5_PARENT_REF}^{commit}" 2>/dev/null; then
  # Sayfalar önceden public anon key taşır; yalnız WP5'in eklediği satırlar taranır.
  git diff "${WP5_PARENT_REF}" -- index.html amsterdam/index.html scripts SHA256SUMS | grep '^+' | grep -v '^+++' > "$tmpd/wp5_added_page_lines.txt" || true
  SCAN+=("$tmpd/wp5_added_page_lines.txt")
fi
bash CDP3C_package/gates/secret_scan.sh "${SCAN[@]}" || fail=1
mapfile -t files < <(find "${SCAN[@]}" -type f | sort)
bash CDP3D_package/gates/cdp3d_secret_scan.sh "${files[@]}" || fail=1

if [ "$fail" != "0" ]; then echo "WP5_WEB_GATES_FAIL"; exit 1; fi
if [ "$missing" != "0" ]; then echo "WP5_WEB_GATES_INCOMPLETE"; exit 4; fi
echo "WP5_WEB_GATES_PASS"

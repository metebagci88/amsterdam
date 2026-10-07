#!/usr/bin/env bash
# WP4 · üye hesabı ve profil navigasyonu — tek komutla tüm kapılar (ağ gerektirmez, production'a dokunmaz).
#
#   PLAYWRIGHT_BROWSERS_PATH=<chromium> NODE_PATH=<playwright + jsdom + tailwindcss deps> bash WP4_package/tests/run_all.sh
#
# Sıra: WP4 statik sözleşme birim testleri → WP4 Playwright e2e (yerel statik sunucu; tüm dış istekler
# route() stub'ı; Tailwind sayfanın kendi config'i ile yerelde derlenir; masaüstü + 390px) → WP3 kapıları
# (regresyon: lib + WP3 birim, UX Sprint 1 jsdom, WP3 e2e, SHA256SUMS, Kopenhag byte eşitliği, secret scan)
# → WSE statik tripwire (şehir sayfası tercih etiketi eşlemesi) + WSE SHA256SUMS
# → WP4 secret scan (yeni dosyalar + sayfalara WP4'ün EKLEDİĞİ satırlar).
# Çıkış: 0 = WP4_GATES_PASS · 1 = WP4_GATES_FAIL · 4 = bağımlılık/geçmiş yok (WP4_GATES_INCOMPLETE; PASS sayılmaz).
# Ortam: WP4_BASE_REF (main, WP3 öncesi; varsayılan 7a548e9) · WP4_PARENT_REF (WP4'ün atası = WP3 başı; varsayılan 7801394)
#        WP4_SCOPE_CHECKS (1 = yalnız WP4 PR'ına ait tek seferlik "sadece şu değişti / WP5 yok" kontrolleri de koşar;
#                          verilmezse: geçerli branch wp4-member-nav ise 1, değilse 0 — sonraki PR'lar (WP5…) yalnız
#                          kalıcı sözleşmeyi koşar) · WP4_HEAD_REF (kapsam kontrollerinin okuduğu commit; CI'da PR head sha)
set -uo pipefail
cd "$(dirname "$0")/../.."
export WP4_BASE_REF="${WP4_BASE_REF:-7a548e9}"
export WP4_PARENT_REF="${WP4_PARENT_REF:-7801394}"
fail=0; missing=0
if [ -z "${WP4_SCOPE_CHECKS:-}" ]; then
  if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "wp4-member-nav" ]; then WP4_SCOPE_CHECKS=1; else WP4_SCOPE_CHECKS=0; fi
fi
export WP4_SCOPE_CHECKS
echo "WP4_SCOPE_CHECKS=${WP4_SCOPE_CHECKS} WP4_HEAD_REF=${WP4_HEAD_REF:-<working tree>}"

for ref in "$WP4_BASE_REF" "$WP4_PARENT_REF"; do
  git -C . cat-file -e "${ref}^{commit}" 2>/dev/null || { echo "MISSING_DEP git history for ${ref} (actions/checkout fetch-depth: 0)"; missing=1; }
done

echo "== 1/5 WP4 node unit (statik sözleşme) =="
node --test WP4_package/tests/wp4_unit.test.mjs || fail=1

echo "== 2/5 WP4 Playwright e2e (desktop + 390px) =="
if node -e 'require("playwright")' >/dev/null 2>&1; then
  node WP4_package/tests/wp4_e2e.mjs; rc=$?
  if [ "$rc" = "4" ]; then missing=1; elif [ "$rc" != "0" ]; then fail=1; fi
else
  echo "MISSING_DEP playwright (NODE_PATH ile ver)"; missing=1
fi

echo "== 3/5 WP3 gates (regresyon) =="
bash WP3_package/tests/run_all.sh; rc=$?
if [ "$rc" = "4" ]; then missing=1; elif [ "$rc" != "0" ]; then fail=1; fi

echo "== 4/5 WSE static tripwire (şehir sayfası not_configured eşlemesi) + WSE SHA256SUMS =="
node WSE_DEFAULT_package/gates/wse_static_check.mjs || fail=1
(cd WSE_DEFAULT_package && sha256sum --quiet -c SHA256SUMS) || { echo "WSE_SHA256SUMS_MISMATCH"; fail=1; }

echo "== 5/5 WP4 secret scan =="
SCAN=(WP4_package scripts/ux_sprint1_trust_check.mjs .github/workflows/wp4-member-nav-gates.yml
      WSE_DEFAULT_package/gates/wse_static_check.mjs WSE_DEFAULT_package/WSE_DESIGN.md WSE_DEFAULT_package/WSE_TEST_MATRIX.md WSE_DEFAULT_package/SHA256SUMS)
tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
if git -C . cat-file -e "${WP4_PARENT_REF}^{commit}" 2>/dev/null; then
  # Sayfalar önceden public anon key taşır; yalnız WP4'ün eklediği satırlar taranır.
  git diff "${WP4_PARENT_REF}" -- index.html amsterdam/index.html | grep '^+' | grep -v '^+++' > "$tmpd/wp4_added_page_lines.txt" || true
  SCAN+=("$tmpd/wp4_added_page_lines.txt")
fi
bash CDP3C_package/gates/secret_scan.sh "${SCAN[@]}" || fail=1
mapfile -t files < <(find "${SCAN[@]}" -type f | sort)
bash CDP3D_package/gates/cdp3d_secret_scan.sh "${files[@]}" || fail=1

if [ "$fail" != "0" ]; then echo "WP4_GATES_FAIL"; exit 1; fi
if [ "$missing" != "0" ]; then echo "WP4_GATES_INCOMPLETE"; exit 4; fi
echo "WP4_GATES_PASS"

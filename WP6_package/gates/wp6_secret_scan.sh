#!/usr/bin/env bash
# WP6 · kapı 6 — SHA256SUMS + secret scan (ağ gerektirmez, production'a dokunmaz).
#
#   bash WP6_package/gates/wp6_secret_scan.sh
#
# Sayfalar (amsterdam/index.html, index.html) WP6'dan ÖNCE de public Supabase anon key (role anon) taşır: tüm sayfayı taramak
# her sürümde (origin/main dahil) GATE_FAILED:secret_scan verir ve WP6 hakkında bir şey söylemez. WP5 kapısıyla aynı kapsam
# (WP5_package/web/tests/run_all.sh): WP6_package + bu dalın sayfalara / SHA256SUMS'a / lib'e EKLEDİĞİ satırlar.
# İkinci kontrol: eklenen satırlarda hiç JWT ("eyJ...") yok (anon key de yeniden eklenmez/çoğaltılmaz).
# Ortam: WP6_PARENT_REF (WP6'nın atası = WP5 sonrası main; varsayılan e1bfd04).
# Çıkış: 0 = WP6_SECRET_GATE_PASS · 1 = WP6_SECRET_GATE_FAIL · 4 = git geçmişi yok (WP6_SECRET_GATE_INCOMPLETE; PASS sayılmaz).
set -uo pipefail
cd "$(dirname "$0")/../.."
REF="${WP6_PARENT_REF:-e1bfd04}"
fail=0
git -C . cat-file -e "${REF}^{commit}" 2>/dev/null || { echo "MISSING_DEP git history for ${REF} (actions/checkout fetch-depth: 0)"; echo "WP6_SECRET_GATE_INCOMPLETE"; exit 4; }

sha256sum --quiet -c SHA256SUMS && echo "SHA256SUMS_OK" || { echo "SHA256SUMS_MISMATCH"; fail=1; }

tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
# yalnız bu dalın eklediği satırlar (izlenmeyen yeni dosyalar WP6_package altında doğrudan taranır)
git diff "${REF}" -- index.html amsterdam/index.html lib SHA256SUMS | grep '^+' | grep -v '^+++' > "$tmpd/wp6_added_page_lines.txt" || true
echo "added page lines: $(wc -l < "$tmpd/wp6_added_page_lines.txt")"
if grep -En 'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}' "$tmpd/wp6_added_page_lines.txt" >/dev/null; then echo "WP6_ADDED_LINES_CONTAIN_JWT"; fail=1; else echo "wp6_added_lines_no_jwt"; fi

SCAN=(WP6_package "$tmpd/wp6_added_page_lines.txt")
bash CDP3C_package/gates/secret_scan.sh "${SCAN[@]}" || fail=1
mapfile -t files < <(find "${SCAN[@]}" -type f | sort)
bash CDP3D_package/gates/cdp3d_secret_scan.sh "${files[@]}" || fail=1

if [ "$fail" != "0" ]; then echo "WP6_SECRET_GATE_FAIL"; exit 1; fi
echo "WP6_SECRET_GATE_PASS"

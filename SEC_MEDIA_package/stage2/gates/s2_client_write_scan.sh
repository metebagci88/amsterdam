#!/usr/bin/env bash
# =====================================================================
# SEC-MEDIA · STAGE 2 · gates/s2_client_write_scan.sh
# S2 önkoşul/regresyon kapısı: tarayıcıya servis edilen (client) HTML/JS dosyalarında
# Storage'a DOĞRUDAN yazma yolu var mı? S2 sonrası böyle bir yol RLS hatası alır ve kırılır.
#   FAIL: storage.from(...)                 supabase-js Storage istemcisi (client'ta hiç olmamalı)
#   FAIL: /storage/v1/object/<x>  (x != public)   REST upload/update/delete/move/copy/sign/list
#   FAIL: createSignedUploadUrl / uploadToSignedUrl
#   İZİNLİ: /storage/v1/object/public/<bucket>/...   salt-okuma URL'i
# Kapsam dışı (server/test): */edge/*, */gates/*, */tests/*, ./*_package/*, */vendor/*,
#   ./LIVE_CHECKS/* (GitHub Actions'ta Node ile koşan canlı kabul harness'ı; qa_runner.mjs `s2-http`
#   reddedilmesi BEKLENEN doğrudan yazmaları bilerek dener), node_modules, .git, *.test.* —
#   Edge fonksiyonları service_role (BYPASSRLS) kullanır.
#   Koruma: taranan HTML'lerden biri LIVE_CHECKS'e referans verirse (sayfaya yüklenirse) FAIL.
# .zip arşivleri taranmaz (çalıştırılabilir sayfa değil); INFO olarak listelenir.
# Kullanım: bash s2_client_write_scan.sh [repo_root]     Sentinel: S2_CLIENT_WRITE_SCAN_CLEAN
# =====================================================================
set -uo pipefail
REPO="${1:-$(cd "$(dirname "$0")/../../.." && pwd)}"
cd "$REPO" || { echo "GATE_FAILED:client_scan_no_repo"; exit 2; }

mapfile -t FILES < <(find . \( -path ./.git -o -path '*/node_modules' -o -path '*/edge' -o -path '*/gates' \
    -o -path '*/tests' -o -path '*/vendor' -o -path './*_package' -o -path ./LIVE_CHECKS \) -prune \
    -o -type f \( -name '*.html' -o -name '*.htm' -o -name '*.js' -o -name '*.mjs' \) ! -name '*.test.*' -print | sort)
echo "scanned_client_files=${#FILES[@]}"
[ "${#FILES[@]}" -gt 0 ] || { echo "GATE_FAILED:client_scan_no_files"; exit 2; }

HITS=0
report() { # $1=label, stdin=grep -n çıktısı
  local out; out="$(cat)"
  [ -n "$out" ] || return 0
  printf '%s\n' "$out" | cut -c1-240 | sed "s/^/CLIENT_WRITE[$1] /"
  HITS=1
}
# process substitution: report() ana kabukta çalışır (HITS korunur)
report "storage.from"    < <(grep -nEH -e 'storage[[:space:]]*\.[[:space:]]*from[[:space:]]*\(' "${FILES[@]}" 2>/dev/null)
report "signed_upload"   < <(grep -nEH -e 'createSignedUploadUrl|uploadToSignedUrl' "${FILES[@]}" 2>/dev/null)
report "rest_non_public" < <(grep -nEoH -e '/storage/v1/object/[A-Za-z0-9_-]+' "${FILES[@]}" 2>/dev/null | grep -v '/storage/v1/object/public$')
# kapsam dışı test harness'ı bir sayfaya bağlanmışsa artık client kodudur -> FAIL
report "html_loads_excluded_harness" < <(grep -nEH -e 'LIVE_CHECKS' "${FILES[@]}" 2>/dev/null | grep -E '\.html?:')

pub="$(grep -nEoH -e '/storage/v1/object/public/[A-Za-z0-9_-]+' "${FILES[@]}" 2>/dev/null || true)"
[ -n "$pub" ] && printf '%s\n' "$pub" | sed 's/^/INFO_PUBLIC_READ_URL /'

find . -path ./.git -prune -o -type f -name '*.zip' -print | sort | sed 's/^/INFO_ARCHIVE_NOT_SCANNED /'

if [ "$HITS" != "0" ]; then echo "GATE_FAILED:client_direct_storage_write"; exit 1; fi
echo "S2_CLIENT_WRITE_SCAN_CLEAN"

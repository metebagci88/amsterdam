#!/usr/bin/env bash
# CDP-3C · Secret/token GERÇEK-DEĞER taraması (fail-closed).
# Rol adı 'service_role' bir secret DEĞİLDİR ve TARANMAZ (grant ... to service_role serbesttir).
# Yalnız gerçek gizli DEĞER kalıpları: JWT, Supabase secret/publishable/PAT, PEM özel anahtar,
# AWS erişim anahtarı, "...KEY=<değer>" / "...SECRET=<değer>" / "password=<değer>" atamaları.
# Kullanım: secret_scan.sh <path> [<path> ...]   → sızıntı bulunursa exit 1.
set -uo pipefail
PATHS=("$@"); [ "${#PATHS[@]}" -gt 0 ] || { echo "secret_scan: path yok"; exit 2; }

# Gerçek-değer kalıpları (rol/isim/sözleşme metinleri DEĞİL)
PATTERNS=(
  'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}'   # JWT (3 parça: anon/service key)
  'sb_secret_[A-Za-z0-9]{16,}'                                      # Supabase secret key
  'sbp_[A-Za-z0-9]{20,}'                                            # Supabase PAT
  'AKIA[0-9A-Z]{16}'                                                # AWS access key id
  '-----BEGIN [A-Z ]*PRIVATE KEY'                                   # PEM özel anahtar
  '(SERVICE_ROLE_KEY|SERVICE_KEY|SECRET_KEY|API_KEY|ACCESS_KEY|DB_PASSWORD|SUPABASE_KEY)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/_+.-]{12,}'  # ATAMA=değer
  'password[[:space:]]*=[[:space:]]*[^[:space:]"'"'"']{8,}'         # password=<değer>
)
# self-test dosyası kasıtlı sahte-secret fixture ÜRETİR (parçalardan); onu ve SHA256SUMS'ı hariç tut.
HITS=0
for p in "${PATTERNS[@]}"; do
  if grep -rEnI -e "$p" "${PATHS[@]}" 2>/dev/null \
     | grep -vE '(^|/)(SHA256SUMS|secret_scan_selftest\.sh|secret_scan\.sh):' ; then
    HITS=1
  fi
done
if [ "$HITS" != "0" ]; then echo "GATE_FAILED:secret_scan"; exit 1; fi
echo "secret_scan_clean"

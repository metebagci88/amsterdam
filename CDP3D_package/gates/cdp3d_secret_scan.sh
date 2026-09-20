#!/usr/bin/env bash
# =====================================================================
# CDP-3D · Secret scan — genel sızıntı taraması + yalnız BİLİNEN LOCAL sırların redaksiyonu.
# Kapsam: JWT, Supabase sb_secret_, Resend re_, PEM/private key, GitHub token, bağlantı
#         dizesi/parola. Genel JWT taraması KALDIRILMAZ; yalnız Supabase local stack'in
#         bilinen sabit değerleri (env LOCAL_SECRETS) [REDACTED_LOCAL] yapılır -> ephemeral
#         demo JWT/DBURL yanlış-pozitif üretmez, GERÇEK sırlar yakalanır.
# Kullanım: LOCAL_SECRETS=$'<jwt1>\n<jwt2>\n<dburl>' bash cdp3d_secret_scan.sh <dosya...>
# =====================================================================
set -uo pipefail

# Gerçek sır desenleri (redaksiyon SONRASI aranır)
PATTERNS=(
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}'   # JWT (JWS 3-parça)
  'sb_secret_[A-Za-z0-9_-]{8,}'                                     # Supabase secret key
  're_[A-Za-z0-9]{16,}'                                             # Resend API key
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                             # PEM private key
  'gh[posru]_[A-Za-z0-9]{20,}'                                      # GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)
  'github_pat_[A-Za-z0-9_]{20,}'                                    # GitHub fine-grained PAT
  '://[A-Za-z0-9._%+-]+:[^@/[:space:]]{3,}@[A-Za-z0-9.-]+'          # conn-string user:pass@host
)

redact() {
  local content; content="$(cat "$1")"
  local s
  if [ -n "${LOCAL_SECRETS:-}" ]; then
    while IFS= read -r s; do
      [ -n "$s" ] || continue
      content="${content//"$s"/[REDACTED_LOCAL]}"
    done <<< "$LOCAL_SECRETS"
  fi
  printf '%s' "$content"
}

leak=0
for f in "$@"; do
  [ -f "$f" ] || continue
  red="$(redact "$f")"
  for p in "${PATTERNS[@]}"; do
    if printf '%s' "$red" | grep -Eq -- "$p"; then
      echo "SECRET_LEAK[$p] in $(basename "$f")"
      leak=1
    fi
  done
done

if [ "$leak" = "0" ]; then echo "SECRET_SCAN_CLEAN"; exit 0; else echo "GATE_FAILED:secret_scan"; exit 1; fi

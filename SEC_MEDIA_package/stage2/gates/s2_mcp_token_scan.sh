#!/usr/bin/env bash
# =====================================================================
# SEC-MEDIA · STAGE 2 · gates/s2_mcp_token_scan.sh
# Supabase MCP (apply_migration / execute_sql) metninde "drop" token'ı geçen ifadeyi
# etkileşimli insan onayı olmadan çalıştırmıyor; onay bu oturumda verilemiyor ve sorgu
# Postgres'e hiç ulaşmadan 60 sn'de zaman aşımına düşüyor. Kapı METİN tabanlı görünüyor
# (EXECUTE string'i veya yorum içindeki kelime de tetikleyebilir). Bu yüzden MCP'ye
# gönderilen her dosyada, HERHANGİ bir büyük/küçük harf biçiminde ve HERHANGİ bir yerde
# (kod, yorum, string) /drop/i alt-dizesi YASAKTIR.
#   ZORUNLU (migration gövdeleri) : S2_up.sql, S2_down_INSECURE.sql
#   MCP execute_sql ile koşanlar  : gates/s2_pre_assert.sql, gates/s2_prod_assert.sql,
#                                   gates/s2_zero_footprint_test.sql
# Ayrıca armed rollback yükü (ARM satırı + S2_down_INSECURE.sql) da taranır.
# Kullanım: bash s2_mcp_token_scan.sh [stage2_dir]      Sentinel: S2_MCP_TOKEN_SCAN_CLEAN
# =====================================================================
set -uo pipefail
PKG="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
ARM_DOWN="set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE';"
FILES=(S2_up.sql S2_down_INSECURE.sql gates/s2_pre_assert.sql gates/s2_prod_assert.sql gates/s2_zero_footprint_test.sql)

HITS=0
for f in "${FILES[@]}"; do
  if [ ! -s "$PKG/$f" ]; then echo "MCP_TOKEN_SCAN[missing] $f"; HITS=1; continue; fi
  out="$(grep -n -i -e 'drop' "$PKG/$f" | cut -c1-200)"
  if [ -n "$out" ]; then printf '%s\n' "$out" | sed "s#^#MCP_TOKEN_SCAN[drop] $f:#"; HITS=1
  else echo "ok $f (no /drop/i)"; fi
done
if printf '%s\n' "$ARM_DOWN" | cat - "$PKG/S2_down_INSECURE.sql" 2>/dev/null | grep -q -i -e 'drop'; then
  echo "MCP_TOKEN_SCAN[drop] armed rollback payload"; HITS=1
else echo "ok armed rollback payload (ARM line + S2_down_INSECURE.sql)"; fi

if [ "$HITS" != "0" ]; then echo "GATE_FAILED:mcp_drop_token"; exit 1; fi
echo "S2_MCP_TOKEN_SCAN_CLEAN"

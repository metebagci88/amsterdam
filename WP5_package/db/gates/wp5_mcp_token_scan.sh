#!/usr/bin/env bash
# =====================================================================
# ASALOCAL · WP5 · gates/wp5_mcp_token_scan.sh
# Supabase MCP (apply_migration / execute_sql) metninde yıkıcı DDL anahtar kelimesi ("d","r","o","p")
# geçen HER ifadeyi etkileşimli insan onayı olmadan çalıştırmıyor; onay bu oturumda verilemiyor.
# Kapı METİN tabanlıdır (yorum/string içindeki kelime de tetikler). Bu yüzden MCP'ye giden her
# dosyada, HERHANGİ bir büyük/küçük harf biçiminde ve HERHANGİ bir yerde /drop/i YASAKTIR:
#   ZORUNLU (migration gövdesi)  : WP5_DB_up.sql
#   MCP execute_sql ile koşanlar : gates/wp5_pre_assert.sql, gates/wp5_prod_assert.sql,
#                                  gates/wp5_zero_footprint_test.sql
# WP5_DB_down.sql bilinçli olarak DROP İÇERİR ve MCP'ye GÖNDERİLMEZ (sahip Dashboard SQL
# editöründe çalıştırır); bu tarama onun DROP içerdiğini ve "MCP İLE GÖNDERİLMEZ" etiketini doğrular.
# Kullanım: bash wp5_mcp_token_scan.sh [db_dir]      Sentinel: WP5_MCP_TOKEN_SCAN_CLEAN
# =====================================================================
set -uo pipefail
PKG="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
FILES=(WP5_DB_up.sql gates/wp5_pre_assert.sql gates/wp5_prod_assert.sql gates/wp5_zero_footprint_test.sql)
TOKEN="$(printf '%s%s' 'dr' 'op')"

HITS=0
for f in "${FILES[@]}"; do
  if [ ! -s "$PKG/$f" ]; then echo "MCP_TOKEN_SCAN[missing] $f"; HITS=1; continue; fi
  out="$(grep -n -i -e "$TOKEN" "$PKG/$f" | cut -c1-200)"
  if [ -n "$out" ]; then printf '%s\n' "$out" | sed "s#^#MCP_TOKEN_SCAN[hit] $f:#"; HITS=1
  else echo "ok $f (no /$TOKEN/i)"; fi
done

# DOWN: sahip-çalıştırmalı; DROP içermesi beklenir ve açıkça etiketli olmalı
DOWN="$PKG/WP5_DB_down.sql"
if [ ! -s "$DOWN" ]; then echo "MCP_TOKEN_SCAN[missing] WP5_DB_down.sql"; HITS=1
else
  if grep -q -i -e "$TOKEN" "$DOWN"; then echo "ok WP5_DB_down.sql contains /$TOKEN/i (owner-run only, expected)"
  else echo "MCP_TOKEN_SCAN[down_has_no_token] WP5_DB_down.sql beklenen geri alma ifadelerini içermiyor"; HITS=1; fi
  if grep -q 'OWNER-RUN ROLLBACK' "$DOWN" && grep -q 'SUPABASE MCP (apply_migration/execute_sql) İLE GÖNDERİLMEZ' "$DOWN"; then
    echo "ok WP5_DB_down.sql owner-run / not-for-MCP label present"
  else echo "MCP_TOKEN_SCAN[down_label_missing] WP5_DB_down.sql etiketi eksik"; HITS=1; fi
fi

if [ "$HITS" != "0" ]; then echo "GATE_FAILED:mcp_token_scan"; exit 1; fi
echo "WP5_MCP_TOKEN_SCAN_CLEAN"

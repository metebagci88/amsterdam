#!/usr/bin/env bash
# MCP metin kapısı: execute_sql/apply_migration'a giden dosyalarda /drop/i olmamalı.
set -euo pipefail
cd "$(dirname "$0")/.."
bad=0
for f in SEC_VIEWS_up.sql gates/sec_views_prod_assert.sql gates/sec_views_zero_footprint_test.sql; do
  if grep -qi 'drop' "$f"; then echo "TOKEN_FOUND drop in $f"; bad=1; fi
done
grep -q 'SEC_VIEWS_DOWN_NOT_ARMED' SEC_VIEWS_down_INSECURE.sql || { echo "down file not armed-guarded"; bad=1; }
[ "$bad" = 0 ] && echo SEC_VIEWS_TOKEN_SCAN_CLEAN || exit 1

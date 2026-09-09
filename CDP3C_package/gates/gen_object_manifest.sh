#!/usr/bin/env bash
# CDP-3C · KANONİK obje manifesti ÜRETİCİ (CDP3C_up.sql tek kaynak).
# GERÇEK multiline destekli: tüm dosya whitespace-normalize edilir (satır sınırı yok);
# yorumlar (-- ve /* */) çıkarılır (yorum içindeki sahte CREATE sayılmaz). AD düzeyinde authoritative;
# `--raw` tüm declaration'ları (overload dahil, dup'lı) verir → manifest_check overload/format sağlaması yapar.
# NOT: type'lar 'do $$ … create type … $$' bloklarında yaşadığı için dollar-gövde SİLİNMEZ.
# Kullanım: gen_object_manifest.sh <CDP3C_up.sql> [--raw]
set -euo pipefail
UP="${1:?CDP3C_up.sql yolu gerekli}"; MODE="${2:-uniq}"
python3 - "$UP" "$MODE" <<'PY'
import sys, re
src=open(sys.argv[1], encoding='utf-8').read()
src=re.sub(r'/\*.*?\*/', ' ', src, flags=re.S)   # blok yorum
src=re.sub(r'--[^\n]*', ' ', src)                 # satır yorum
src=re.sub(r'\s+', ' ', src)                      # whitespace normalize → multiline birleşir
def find(pat): return [m.lower() for m in re.findall(pat, src, re.I)]
tables=find(r'create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_][a-z0-9_]*)')
types =find(r'create\s+type\s+public\.([a-z_][a-z0-9_]*)')
funcs =find(r'create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_][a-z0-9_]*)')
lines=[f"table:{t}" for t in tables]+[f"type:{t}" for t in types]+[f"func:{t}" for t in funcs]
if sys.argv[2]=='--raw':
    print("\n".join(lines))          # dup'lı (overload sayımı için)
else:
    print("\n".join(sorted(set(lines))))
PY

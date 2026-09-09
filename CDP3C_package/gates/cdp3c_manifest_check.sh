#!/usr/bin/env bash
# CDP-3C · Manifest DRIFT gate: CDP3C_up.sql'den yeniden üret + committed manifest ile DIFF +
# RAW-declaration-sayısı == manifest-sayısı (overload/format kaçağını yakalar; #8).
# v9-#2: hem üretici hem çapraz-sayım GERÇEK multiline destekli (whitespace-normalize; satır-bazlı grep DEĞİL).
# Fixed 20/12/48 sağlaması. Ad-authoritative + raw-declaration tutarlılığı.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
UP="$DIR/../CDP3C_up.sql"; MAN="$DIR/cdp3c_objects.manifest"
[ -r "$UP" ] && [ -r "$MAN" ] || { echo "GATE_FAILED:manifest_check(dosya yok/okunamaz)"; exit 1; }
gen="$(bash "$DIR/gen_object_manifest.sh" "$UP")" || { echo "GATE_FAILED:manifest_gen"; exit 1; }
if ! diff <(printf '%s\n' "$gen") "$MAN" >/tmp/mandiff 2>&1; then echo "GATE_FAILED:manifest_drift"; cat /tmp/mandiff; exit 1; fi
nt=$(grep -c '^table:' "$MAN"); ny=$(grep -c '^type:' "$MAN"); nf=$(grep -c '^func:' "$MAN")
# RAW declaration sayıları (multiline-aware, dup-inclusive) == manifest (uniq) sayıları
# → aynı ada overload / mükerrer create varsa raw>uniq olur ve fail-closed.
raw="$(bash "$DIR/gen_object_manifest.sh" "$UP" --raw)" || { echo "GATE_FAILED:manifest_gen_raw"; exit 1; }
ct=$(printf '%s\n' "$raw" | grep -c '^table:')
cy=$(printf '%s\n' "$raw" | grep -c '^type:')
cf=$(printf '%s\n' "$raw" | grep -c '^func:')
[ "$ct" = "$nt" ] || { echo "GATE_FAILED:manifest_table_count(raw=$ct manifest=$nt)"; exit 1; }
[ "$cy" = "$ny" ] || { echo "GATE_FAILED:manifest_type_count(raw=$cy manifest=$ny)"; exit 1; }
[ "$cf" = "$nf" ] || { echo "GATE_FAILED:manifest_func_count(raw=$cf manifest=$nf; overload/mükerrer olabilir)"; exit 1; }
[ "$nt" = 20 ] && [ "$ny" = 12 ] && [ "$nf" = 48 ] || { echo "GATE_FAILED:manifest_expected(table=$nt type=$ny func=$nf; beklenen 20/12/48)"; exit 1; }
echo "CDP3C_MANIFEST_CHECK_PASS (table=$nt type=$ny func=$nf; raw-declaration=table $ct/type $cy/func $cf)"

#!/usr/bin/env bash
# CDP-3C · Manifest-driven OBJE-YOKLUĞU preflight (SALT-OKUNUR; production'da güvenli).
# FAIL-CLOSED: sorgu exit code'u ANA shell'de kontrol edilir (command-substitution içinde
# 'exit' KAYBOLDUĞU için kullanılmaz; düzeltme v9-#1). Değer yalnız tam 't'/'f' olabilir; aksi fail-closed.
# Kullanım: cdp3c_preflight_objects.sh "<PSQL_URI>" "<manifest>"
set -uo pipefail
URI="${1:?}"; MAN="${2:?}"
[ -r "$MAN" ] || { echo "GATE_FAILED:preflight_objects_manifest_unreadable($MAN)"; exit 1; }
QOUT=""; QRC=0
run_q(){ QOUT="$(psql "$URI" -tAqc "$1" 2>&1)"; QRC=$?; QOUT="$(printf '%s' "$QOUT" | tr -d '[:space:]')"; }
bool_true(){ # $1=sql ; ANA shell'de rc + değer doğrulanır
  run_q "$1"
  if [ $QRC -ne 0 ]; then echo "GATE_FAILED:preflight_objects_query(rc=$QRC: $QOUT)"; exit 1; fi
  case "$QOUT" in t) return 0 ;; f) return 1 ;; *) echo "GATE_FAILED:preflight_objects_bad_value('$QOUT')"; exit 1 ;; esac
}
present=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  kind="${line%%:*}"; name="${line#*:}"
  case "$kind" in
    table) if bool_true "select to_regclass('public.$name') is not null"; then echo "PREFLIGHT_OBJECTS_FAIL:table:$name"; present=1; fi ;;
    type)  if bool_true "select exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname='$name')"; then echo "PREFLIGHT_OBJECTS_FAIL:type:$name"; present=1; fi ;;
    func)  if bool_true "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$name')"; then echo "PREFLIGHT_OBJECTS_FAIL:func:$name"; present=1; fi ;;
    *)     echo "GATE_FAILED:preflight_objects_bad_manifest_kind($kind)"; exit 1 ;;
  esac
done < "$MAN"
if [ "$present" != 0 ]; then echo "GATE_FAILED:preflight_objects (CDP-3C nesnesi zaten var; fail-closed)"; exit 1; fi
echo "CDP3C_PREFLIGHT_OBJECTS_PASS ($(grep -c . "$MAN") nesne yok)"

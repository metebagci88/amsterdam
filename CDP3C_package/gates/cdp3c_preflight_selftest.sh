#!/usr/bin/env bash
# CDP-3C · preflight NEGATİF fixture selftest (fail-closed).
# İLK reset'ten ÖNCE ÜÇ-KATMAN guard: opt-in + loopback + SENTINEL MARKER (düzeltme #3/#6).
# Çağıran (workflow/runner) bu DB'yi ÖNCEDEN baseline+sentinel ile hazırlamalı; script sentinel'i
# doğrular, sonra kendi reset döngüsünü çalıştırır. reset'in HER adımı fail-closed (ON_ERROR_STOP).
# Kullanım: cdp3c_preflight_selftest.sh "<URI>" "<SHIM|/dev/null>" "<BASE>" "<PRE>"
set -uo pipefail
URI="${1:?}"; SHIM="${2:?}"; BASE="${3:?}"; PRE="${4:?}"
DIR="$(cd "$(dirname "$0")" && pwd)"; MAN="$DIR/cdp3c_objects.manifest"; OBJ="$DIR/cdp3c_preflight_objects.sh"
source "$DIR/_ephemeral_guard.sh"
require_ephemeral "$URI"   # opt-in + loopback + sentinel MARKER; herhangi bir DROP'tan ÖNCE fail-closed
P(){ psql "$URI" -v ON_ERROR_STOP=1 "$@"; }
reset(){
  P -qtAc "drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; drop schema if exists vault cascade; drop schema if exists extensions cascade;" >/dev/null || { echo "PREFLIGHT_SELFTEST_FAIL:reset_drop"; exit 1; }
  P -f "$SHIM" >/dev/null || { echo "PREFLIGHT_SELFTEST_FAIL:reset_shim"; exit 1; }
  P -f "$BASE" >/dev/null || { echo "PREFLIGHT_SELFTEST_FAIL:reset_base"; exit 1; }
}
mut(){ P -qtAc "$1" >/dev/null || { echo "PREFLIGHT_SELFTEST_FAIL:mutate($2)"; exit 1; }; }
runpre(){ psql "$URI" -v ON_ERROR_STOP=1 -f "$PRE" 2>&1; }
expect_fail(){ local out rc; out="$(runpre)"; rc=$?; if [ $rc -eq 0 ]; then echo "PREFLIGHT_SELFTEST_FAIL:$1:hata YOK(rc=0)"; exit 1; fi
  grep -qE "$2" <<<"$out" || { echo "PREFLIGHT_SELFTEST_FAIL:$1:yanlis hata"; echo "$out"|tail -3; exit 1; }; }
expect_obj_fail(){ local out rc; out="$(bash "$OBJ" "$URI" "$MAN" 2>&1)"; rc=$?; if [ $rc -eq 0 ]; then echo "PREFLIGHT_SELFTEST_FAIL:$1:obj hata YOK(rc=0)"; exit 1; fi
  grep -qE "$2" <<<"$out" || { echo "PREFLIGHT_SELFTEST_FAIL:$1:yanlis obj hata"; echo "$out"; exit 1; }; }

# --- CONTRACT negatifleri (hem rc!=0 hem doğru mesaj) ---
reset; mut "alter table public.members drop column email" email; expect_fail email_missing "members\.email metin kolonu YOK"
reset; mut "alter table public.admin_write_log drop column actor_uid" auid; expect_fail actor_uid_missing "admin_write_log\.actor_uid uuid"
reset; mut "alter table public.admin_write_log drop column before; alter table public.admin_write_log add column before text" beforetype; expect_fail before_wrong_type "admin_write_log\.before jsonb"
reset; mut "drop function public._admin_active(uuid)" adminfn; expect_fail admin_active_missing "_admin_active\(uuid\) yok"
reset; mut "drop table public.admin_roles; drop type public.admin_role; create type public.admin_role as enum ('super_admin','support'); create table public.admin_roles(user_id uuid, role public.admin_role, primary key(user_id,role))" adminrole; expect_fail admin_role_value_missing "admin_role değeri eksik: crm"

# --- OBJE-VARLIĞI: pozitif + tablo/type/func negatifleri (hem rc!=0 hem doğru mesaj) ---
reset; out="$(bash "$OBJ" "$URI" "$MAN" 2>&1)"; rc=$?; { [ $rc -eq 0 ] && grep -q "CDP3C_PREFLIGHT_OBJECTS_PASS" <<<"$out"; } || { echo "PREFLIGHT_SELFTEST_FAIL:objects_positive(rc=$rc)"; echo "$out"|tail -3; exit 1; }
reset; mut "create table public.member_service_pref_events(id int)" objt; expect_obj_fail objects_table "PREFLIGHT_OBJECTS_FAIL:table:member_service_pref_events"
reset; mut "create type public.suppression_channel as enum ('x')" objy; expect_obj_fail objects_type "PREFLIGHT_OBJECTS_FAIL:type:suppression_channel"
reset; mut "create function public.marketing_readiness_check() returns void language sql as \$\$ select \$\$" objf; expect_obj_fail objects_func "PREFLIGHT_OBJECTS_FAIL:func:marketing_readiness_check"

# POZİTİF kontrol: temiz baseline → contract sections geçer, yerelde extensions adiminda durur (prod/CI'da PASS)
reset; out="$(runpre)"; grep -qE "supabase_vault extension yok|CDP3C_PREFLIGHT_PASS" <<<"$out" || { echo "PREFLIGHT_SELFTEST_FAIL:positive_unexpected"; echo "$out"|tail -3; exit 1; }

echo "PREFLIGHT_SELFTEST_PASS"

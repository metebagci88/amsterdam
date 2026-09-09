#!/usr/bin/env bash
# CDP-3C · MANIFEST-SCOPED authoritative privilege matrisi (SALT-OKUNUR; canlı katalog).
# YALNIZ kanonik cdp3c_objects.manifest'teki CDP-3C fonksiyonları denetlenir — önceki-faz meşru
# RPC'lerine (trip_save, log_behavior_event vb.) KARIŞMAZ (düzeltme #4). regprocedure(oid) ile doğrular;
# aynı ada birden fazla overload varsa FAIL-CLOSED. FAIL-CLOSED: her sorgu exit code'u kontrol edilir.
# Kural: 3 kullanıcı RPC → authenticated açık; CDP-3C service RPC → yalnız service_role; helper/trigger → anon+authenticated kapalı.
# Kullanım: cdp3c_privilege_matrix.sh "<PSQL_URI>" "<manifest>"
set -uo pipefail
URI="${1:?}"; MAN="${2:?}"
[ -r "$MAN" ] || { echo "GATE_FAILED:privilege_matrix_manifest_unreadable"; exit 1; }
q(){ local out; out="$(psql "$URI" -tAqc "$1" 2>&1)"; local rc=$?
  if [ $rc -ne 0 ]; then echo "GATE_FAILED:privilege_matrix_query(rc=$rc: $out)" >&2; exit 1; fi
  printf '%s' "$out" | tr -d '[:space:]'; }

USER_RPC=" consent_get_my_state consent_set_pref_center service_pref_set "
SERVICE_RPC=" consent_set_via_flow legal_notice_record anon_subject_create anon_consent_set anon_merge_into_user \
 admin_q_member_consent admin_w_apply_suppression iys_supersede_red admin_w_set_marketing_enabled \
 admin_w_set_marketing_capture_enabled admin_w_add_readiness_attestation admin_w_revoke_readiness_attestation \
 admin_w_set_service_pref_default admin_w_set_anon_ttl admin_w_approve_consent_text \
 admin_w_publish_controller_version admin_w_publish_consent_text marketing_readiness_check \
 marketing_capture_readiness_check service_delivery_readiness_check "

fail(){ echo "GATE_FAILED:privilege_matrix -> $1"; exit 1; }
while IFS= read -r line; do
  [ -n "$line" ] || continue
  [ "${line%%:*}" = "func" ] || continue
  name="${line#*:}"
  # overload kontrolü: ada göre pg_proc satır sayısı == 1 olmalı (imza belirsizliği fail-closed)
  cnt="$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$name'")"
  [ "$cnt" = "1" ] || fail "overload_or_missing:$name(count=$cnt)"
  # NUMERIC oid ile doğrula (regprocedure imzasındaki boşluklar bozmasın; oid tekil)
  oid="$(q "select p.oid::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$name'")"
  a_auth="$(q "select has_function_privilege('authenticated', ${oid}::oid, 'EXECUTE')")"
  a_anon="$(q "select has_function_privilege('anon', ${oid}::oid, 'EXECUTE')")"
  [ "$a_anon" = "f" ] || fail "anon_exec:$name"
  case "$USER_RPC" in *" $name "*)
      [ "$a_auth" = "t" ] || fail "user_rpc_authenticated_missing:$name"; continue ;;
  esac
  case "$SERVICE_RPC" in *" $name "*)
      [ "$a_auth" = "f" ] || fail "service_rpc_authenticated_open:$name"
      s_sr="$(q "select has_function_privilege('service_role', ${oid}::oid, 'EXECUTE')")"
      [ "$s_sr" = "t" ] || fail "service_rpc_service_role_missing:$name"; continue ;;
  esac
  # geri kalan → helper/trigger: authenticated de kapalı
  [ "$a_auth" = "f" ] || fail "helper_authenticated_open:$name"
done < "$MAN"
echo "CDP3C_PRIVILEGE_MATRIX_PASS (manifest-scoped)"

#!/usr/bin/env bash
# WP8 scheduler test on a throwaway PostgreSQL with pg_cron/pg_net doubles. Sentinel WP8_SCHED_PASS.
set -uo pipefail
source "$(dirname "$0")/wp8_lib.sh"
EXPECTED=17
pass=0; fail=0
ck() { if [[ "$2" == "1" ]]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 :: ${3:-}"; fail=$((fail+1)); fi; }
DB="wp8_sched_$$"
trap 'wp8_dropdb "$DB"; rm -rf "$WP8_TMP"' EXIT
set -e
wp8_newdb "$DB"; wp8_load_chain "$DB" norm; wp8_fixture "$DB"; wp8_apply "$DB" >/dev/null
wp8_psql "$DB" -1 -f "$WP8_GATES/wp8_sched_stub.sql" >/dev/null
set +e
armed="$WP8_TMP/sched_armed.sql"
sed 's/@@ARM_YES@@/YES/' "$WP8_ROOT/WP8_package/db/WP8_DB_scheduler_optin.sql" > "$armed"
out="$(wp8_psql_notice "$DB" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_scheduler_optin.sql" 2>&1)"; rc=$?
ck "unarmed (placeholder) refused" "$([[ $rc -ne 0 && "$out" == *wp8_scheduler_refused_without_explicit_arm* ]] && echo 1)" "$out"
ck "unarmed wrote nothing" "$([[ "$(wp8_psql "$DB" -tAc "select count(*) from cron.job")" == "0" && "$(wp8_psql "$DB" -tAc "select to_regprocedure('public.email_dispatch_kick()') is null")" == "t" ]] && echo 1)"
out="$(wp8_psql_notice "$DB" -1 -f "$armed" 2>&1)"; rc=$?
ck "armed without vault secrets refused" "$([[ $rc -ne 0 && "$out" == *wp8_scheduler_requires_vault_secrets* ]] && echo 1)" "$out"
wp8_psql "$DB" -c "insert into vault.decrypted_secrets(name, decrypted_secret) values ('wp8_dispatch_url','https://ciproject.supabase.co/functions/v1/service-email-dispatch'),('wp8_dispatch_gateway_jwt','ci-gateway-placeholder'),('wp8_dispatch_token','$(printf 'c%.0s' $(seq 1 40))')" >/dev/null
out="$(wp8_psql_notice "$DB" -f "$armed" 2>&1)"; rc=$?
ck "armed in autocommit mode refused (arm is transaction-local)" "$([[ $rc -ne 0 && "$out" == *wp8_scheduler_refused_without_explicit_arm* ]] && echo 1)" "$out"
out="$(wp8_psql_notice "$DB" -1 -f "$armed" 2>&1)"; rc=$?
ck "armed -> WP8_SCHEDULER_OK" "$([[ $rc -eq 0 && "$out" == *WP8_SCHEDULER_OK* ]] && echo 1)" "$out"
jobs="$(wp8_psql "$DB" -tAc "select string_agg(jobname || '|' || schedule || '|' || command || '|' || (username = current_user)::text, ';' order by jobname) from cron.job")"
ck "3 jobs with exact names, schedules, commands and owner" "$([[ "$jobs" == "wp8-email-dispatch-kick|2-59/5 * * * *|select public.email_dispatch_kick()|true;wp8-email-purge|17 3 * * *|select public.email_purge_expired_content()|true;wp8-welcome-sweep|*/5 * * * *|select public.welcome_enqueue_sweep()|true" ]] && echo 1)" "$jobs"
out="$(wp8_psql_notice "$DB" -1 -f "$armed" 2>&1)"; rc=$?
ck "re-run is idempotent (still 3 jobs)" "$([[ $rc -eq 0 && "$(wp8_psql "$DB" -tAc "select count(*) from cron.job")" == "3" ]] && echo 1)" "$out"
ck "kick not executable by anon/authenticated/service_role" "$([[ "$(wp8_psql "$DB" -tAc "select not (has_function_privilege('anon','public.email_dispatch_kick()','execute') or has_function_privilege('authenticated','public.email_dispatch_kick()','execute') or has_function_privilege('service_role','public.email_dispatch_kick()','execute'))")" == "t" ]] && echo 1)"
r="$(wp8_psql "$DB" -tAc "select public.email_dispatch_kick()->>'reason'")"
ck "kick: classes disabled -> no HTTP" "$([[ "$r" == "classes_disabled" && "$(wp8_psql "$DB" -tAc "select count(*) from net.calls")" == "0" ]] && echo 1)" "$r"
r="$(wp8_psql "$DB" -tAc "select public.welcome_enqueue_sweep()->>'gate'")"
ck "sweep job command runs inert (auto_disabled)" "$([[ "$r" == "auto_disabled" ]] && echo 1)" "$r"
wp8_psql "$DB" -c "update public.email_provider_config set service_enabled = true where id = 1" >/dev/null
r="$(wp8_psql "$DB" -tAc "select public.email_dispatch_kick()->>'reason'")"
ck "kick: nothing due -> no HTTP" "$([[ "$r" == "nothing_due" && "$(wp8_psql "$DB" -tAc "select count(*) from net.calls")" == "0" ]] && echo 1)" "$r"
wp8_psql "$DB" -c "insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac) values ('ci-kick-1','ci','optional_service','welcome_service_email','s',gen_random_uuid(),repeat('a',64))" >/dev/null
wp8_psql "$DB" -c "update vault.decrypted_secrets set decrypted_secret = 'https://evil.example.test/x' where name = 'wp8_dispatch_url'" >/dev/null
r="$(wp8_psql "$DB" -tAc "select public.email_dispatch_kick()->>'reason'")"
ck "kick: foreign URL refused" "$([[ "$r" == "secret_missing_or_invalid" && "$(wp8_psql "$DB" -tAc "select count(*) from net.calls")" == "0" ]] && echo 1)" "$r"
wp8_psql "$DB" -c "update vault.decrypted_secrets set decrypted_secret = 'https://ciproject.supabase.co/functions/v1/service-email-dispatch' where name = 'wp8_dispatch_url'; update vault.decrypted_secrets set decrypted_secret = 'short' where name = 'wp8_dispatch_token'" >/dev/null
r="$(wp8_psql "$DB" -tAc "select public.email_dispatch_kick()->>'reason'")"
ck "kick: short token refused" "$([[ "$r" == "secret_missing_or_invalid" ]] && echo 1)" "$r"
wp8_psql "$DB" -c "update vault.decrypted_secrets set decrypted_secret = repeat('c', 40) where name = 'wp8_dispatch_token'" >/dev/null
r="$(wp8_psql "$DB" -tAc "select public.email_dispatch_kick()::text")"
call="$(wp8_psql "$DB" -tAc "select (headers ? 'x-asalocal-dispatch-token') and headers->>'x-asalocal-dispatch-token' = repeat('c', 40) and headers->>'authorization' = 'Bearer ci-gateway-placeholder' and body = '{\"limit\": 10}'::jsonb and timeout_milliseconds = 30000 and url like 'https://ciproject.supabase.co/%' from net.calls")"
ck "kick: one POST with token header, gateway JWT and body {limit:10}" "$([[ "$r" == *'"kicked": true'* && "$call" == "t" && "$(wp8_psql "$DB" -tAc "select count(*) from net.calls")" == "1" ]] && echo 1)" "$r $call"
out="$(wp8_psql_notice "$DB" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_scheduler_unschedule.sql" 2>&1)"; rc=$?
ck "unschedule removes all 3 jobs" "$([[ $rc -eq 0 && "$out" == *WP8_UNSCHEDULE_OK* && "$(wp8_psql "$DB" -tAc "select count(*) from cron.job")" == "0" ]] && echo 1)" "$out"
wp8_psql "$DB" -1 -f "$armed" >/dev/null 2>&1
out="$(wp8_psql_notice "$DB" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_kill_switch_soft.sql" 2>&1)"; out2="$(wp8_psql_notice "$DB" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_kill_switch_hard.sql" 2>&1)"; rc=$?
ck "kill switch soft+hard: jobs unscheduled, wp8 flags off" "$([[ $rc -eq 0 && "$out" == *WP8_KILL_SOFT_OK* && "$out2" == *WP8_KILL_HARD_OK* && "$(wp8_psql "$DB" -tAc "select count(*) from cron.job")" == "0" && "$(wp8_psql "$DB" -tAc "select not service_enabled from public.email_provider_config")" == "t" ]] && echo 1)" "$out $out2"
ck "no file in WP8_package/db references the kick except the opt-in" "$([[ "$(grep -l 'net[.]http_post(' "$WP8_ROOT"/WP8_package/db/*.sql | xargs -n1 basename | tr '\n' ' ')" == "WP8_DB_scheduler_optin.sql " ]] && echo 1)"
echo
echo "SCHED RESULT pass=$pass fail=$fail expected=$EXPECTED"
if [[ $fail -eq 0 && $pass -eq $EXPECTED ]]; then echo "WP8_SCHED_PASS"; else echo "WP8_SCHED_FAIL"; exit 1; fi

#!/usr/bin/env bash
# WP8 ephemeral SQL suite on a throwaway PostgreSQL (never production; refuses *supabase.co*).
# Normalized (production-like) and raw CDP-3D chains, PRE/POST asserts, inert proof, behaviour
# suite, ZF probe, owner-setup rehearsal (sequential acceptance), rollback + cleanup + re-apply.
# Sentinel WP8_EPHEMERAL_PASS only when every check passed and the count equals EXPECTED.
set -uo pipefail
source "$(dirname "$0")/wp8_lib.sh"
EXPECTED=58
pass=0; fail=0
ck() { if [[ "$2" == "1" ]]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 :: ${3:-}" | cut -c1-600; fail=$((fail+1)); fi; }
is() { [[ "$1" == "$2" ]] && echo 1; }
has() { [[ "$1" == *"$2"* ]] && echo 1; }
N="wp8e_n_$$"; R="wp8e_r_$$"; A="wp8e_a_$$"; H="wp8e_h_$$"
trap 'for d in $N $R $A $H; do wp8_dropdb $d; done; rm -rf "$WP8_TMP"' EXIT
LIVE='_email_can_set_delivery=164c0e3f3dea09585542573229d8179d _email_send_decision=4da18d72fb4822ba4307da5f7ff06ba2 _email_status_rank=444c0b885722582d4ea1278488bede3f _email_system_apply_suppression=cbc5c3cc473ea251ae7e86a6ff7e0032 _seed_welcome_service_pref_on_member_insert=92e4db755ce2d41584c302073e60fdb1 admin_q_email_delivery_status=49e1ae64d77f0f922b5ecef7dffd5c4c consent_get_my_state=32b33d6ca355f9d89804eb74b5e2bbaf email_claim_batch=08fc00397182c86929bcb9afa6a6a995 email_enqueue=ba947a7c1c2f085e8b251877bb67c9a6 email_ingest_provider_event=8688c2d9c96cbc7428fd297d8f2fedc0 email_mark_result=5d34c6af5d4934e23f6508a4a56a562c email_purge_expired_content=efec09f92a2d7f8fd4610b9461ecbc4c service_delivery_readiness_check=5e74aa1d695c2b573e90cc85fb2d4060 service_pref_set=f171f1ab1a2c183f861f63060a1ad5de'
MD5Q="select string_agg(proname || '=' || md5(prosrc), ' ' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('_email_send_decision','email_enqueue','email_claim_batch','email_mark_result','email_ingest_provider_event','_email_system_apply_suppression','email_purge_expired_content','_email_can_set_delivery','_email_status_rank','admin_q_email_delivery_status','_seed_welcome_service_pref_on_member_insert','consent_get_my_state','service_pref_set','service_delivery_readiness_check')"
SNAPQ="select md5(concat_ws('|', (select string_agg((to_jsonb(o) - array['rate_limit_releases','first_attempt_at','service_template_id'])::text, ',' order by o.id) from public.email_outbox o), (select string_agg(row(e.*)::text, ',' order by e.id) from public.email_send_events e), (select string_agg(row(a.*)::text, ',' order by a.user_id) from public.email_send_allowlist a), (select string_agg(row(c.*)::text, ',' order by c.user_id, c.pref_key) from public.member_service_pref_current c), (select string_agg(row(m.*)::text, ',' order by m.id) from public.marketing_config m), (select string_agg(row(u.*)::text, ',' order by u.id) from auth.users u), (select string_agg(row(p.*)::text, ',' order by p.id) from public.email_service_policy p), (select count(*)::text from public.email_wp8_run_ledger), (select string_agg(row(x.*)::text, ',' order by x.id) from public.member_service_pref_events x), (select string_agg(row(k.*)::text, ',' order by k.id) from public.email_provider_config k)))"

# --- md5 parity by loading the repo SQL (STOP-1 evidence)
wp8_newdb "$N" && wp8_load_chain "$N" norm && wp8_fixture "$N"
wp8_newdb "$R" && wp8_load_chain "$R" raw && wp8_fixture "$R"
got_n="$(wp8_psql "$N" -tAc "$MD5Q")"; got_r="$(wp8_psql "$R" -tAc "$MD5Q")"
ck "md5(prosrc) of N(repo) = live PRE md5 for all 14 functions" "$(is "$got_n" "$LIVE")" "$got_n"
same=0; diff=0; for kv in $got_r; do [[ " $LIVE " == *" $kv "* ]] && same=$((same+1)) || diff=$((diff+1)); done
ck "raw repo: 8 functions byte-identical to live, 6 differ (comment-only drift)" "$([[ $same == 8 && $diff == 6 ]] && echo 1)" "same=$same diff=$diff"
pre="$(wp8_ro "$N" "$WP8_ROOT/WP8_package/db/WP8_DB_pre_assert.sql")"
ck "PRE assert on the production-like fixture -> wp8_pre true" "$(has "$pre" '"wp8_pre": true')" "$pre"

# --- autocommit apply refused, no residue
wp8_newdb "$A" && wp8_load_chain "$A" norm && wp8_fixture "$A"
out="$(wp8_psql_notice "$A" -f "$WP8_ROOT/WP8_package/db/WP8_DB_up.sql" 2>&1)"
ck "autocommit apply refused (WP8_NOT_SINGLE_TRANSACTION)" "$(has "$out" WP8_NOT_SINGLE_TRANSACTION)" "$out"
ck "autocommit apply left no residue" "$(is "$(wp8_psql "$A" -tAc "select to_regclass('public.email_service_templates') is null and to_regclass('public.email_service_policy') is null and (select count(*) from information_schema.columns where table_name='email_outbox' and column_name='first_attempt_at') = 0")" t)"

# --- apply twice (normalized), POST, inert proof
before="$(wp8_psql "$N" -tAc "select md5(concat_ws('|', (select string_agg((to_jsonb(o) - array['rate_limit_releases','first_attempt_at','service_template_id'])::text, ',' order by o.id) from public.email_outbox o), (select string_agg(row(e.*)::text, ',' order by e.id) from public.email_send_events e), (select string_agg(row(c.*)::text, ',' order by c.user_id) from public.member_service_pref_current c), (select string_agg(row(u.*)::text, ',' order by u.id) from auth.users u), (select string_agg(row(k.*)::text, ',' order by k.id) from public.email_provider_config k), (select string_agg(row(m.*)::text, ',' order by m.id) from public.marketing_config m)))")"
out="$(wp8_apply "$N")"; ck "apply #1 (normalized chain) -> WP8_UP_OK" "$(has "$out" WP8_UP_OK)" "$out"
out="$(wp8_apply "$N")"; ck "apply #2 is a no-op -> WP8_UP_OK" "$(has "$out" WP8_UP_OK)" "$out"
after="$(wp8_psql "$N" -tAc "select md5(concat_ws('|', (select string_agg((to_jsonb(o) - array['rate_limit_releases','first_attempt_at','service_template_id'])::text, ',' order by o.id) from public.email_outbox o), (select string_agg(row(e.*)::text, ',' order by e.id) from public.email_send_events e), (select string_agg(row(c.*)::text, ',' order by c.user_id) from public.member_service_pref_current c), (select string_agg(row(u.*)::text, ',' order by u.id) from auth.users u), (select string_agg(row(k.*)::text, ',' order by k.id) from public.email_provider_config k), (select string_agg(row(m.*)::text, ',' order by m.id) from public.marketing_config m)))")"
ck "apply wrote no outbox/event/pref/auth/config/marketing data" "$(is "$before" "$after")"
post="$(wp8_ro "$N" "$WP8_ROOT/WP8_package/db/WP8_DB_post_assert.sql")"
ck "POST assert -> wp8_post true, n=43" "$([[ "$post" == *'"wp8_post": true'* && "$post" == *'"n": 43'* ]] && echo 1)" "$post"
pre2="$(wp8_ro "$N" "$WP8_ROOT/WP8_package/db/WP8_DB_pre_assert.sql")"
ck "PRE assert after apply fails exactly on the WP8 objects" "$(has "$pre2" '"failed": ["md5_email_claim_batch", "md5_email_mark_result", "wp8_tables_absent", "wp8_functions_absent", "wp8_outbox_columns_absent", "no_other_enqueue_or_http_callers"]')" "$pre2"
s1="$(wp8_psql "$N" -tAc "$SNAPQ")"
r="$(wp8_psql "$N" -tAc "select public.welcome_enqueue_sweep()::text")"
ck "inert: sweep -> auto_disabled" "$(is "$r" '{"ok": true, "gate": "auto_disabled", "expired": 0, "reconciled": 0}')" "$r"
ck "inert: email_claim_batch(10) -> 0 rows" "$(is "$(wp8_psql "$N" -tAc "select count(*) from public.email_claim_batch(10)")" 0)"
ck "inert: reconcile -> nothing linked (legacy orphans untouched)" "$(is "$(wp8_psql "$N" -tAc "select public.email_reconcile_orphan_events(50)->>'linked'")" 0)"
ck "inert: purge (CDP-3D) callable, nothing purged that is younger than 30 days" "$(has "$(wp8_psql "$N" -tAc "begin; select public.email_purge_expired_content()::text; rollback;")" '"ok": true')"
s2="$(wp8_psql "$N" -tAc "$SNAPQ")"
ck "inert: sweep + claim + reconcile changed no data" "$(is "$s1" "$s2")"
ck "inert: anon cannot call the sweep (PostgREST surface)" "$(has "$(wp8_psql "$N" -tAc "set role anon; select public.welcome_enqueue_sweep()" 2>&1)" 'permission denied')"

# --- behaviour suite (normalized)
b="$(wp8_behavior "$N")"
ck "behaviour suite (normalized chain): ${WP8_BEHAVIOR_EXPECTED}/${WP8_BEHAVIOR_EXPECTED}" "$(has "$b" "BEHAVIOR_COUNT pass=${WP8_BEHAVIOR_EXPECTED} fail=0")" "$(printf '%s\n' "$b" | grep -v '^PASS' | head -20)"
ck "behaviour suite rolled back (no residue)" "$(is "$(wp8_psql "$N" -tAc "$SNAPQ")" "$s2")"

# --- ZF probe
out="$(wp8_psql_notice "$N" -f "$WP8_ROOT/WP8_package/db/WP8_DB_zf_probe.sql" 2>&1)"
ck "ZF probe raises WP8_ZF_DONE with pass=true" "$([[ "$out" == *WP8_ZF_DONE* && "$out" == *'"pass": true'* ]] && echo 1)" "$out"
ck "ZF probe zero footprint (autocommit)" "$(is "$(wp8_psql "$N" -tAc "$SNAPQ")" "$s2")"
out="$( { echo "begin;"; cat "$WP8_ROOT/WP8_package/db/WP8_DB_zf_probe.sql"; echo "commit;"; } | wp8_psql_notice "$N" 2>&1)"
ck "ZF probe zero footprint even when wrapped in begin/commit" "$([[ "$out" == *WP8_ZF_DONE* ]] && [[ "$(wp8_psql "$N" -tAc "$SNAPQ")" == "$s2" ]] && echo 1)" "$out"

# --- raw chain
out="$(wp8_apply "$R")"; ck "apply #1 (raw repo chain) -> WP8_UP_OK" "$(has "$out" WP8_UP_OK)" "$out"
out="$(wp8_apply "$R")"; ck "apply #2 (raw) -> WP8_UP_OK" "$(has "$out" WP8_UP_OK)" "$out"
post="$(wp8_ro "$R" "$WP8_ROOT/WP8_package/db/WP8_DB_post_assert.sql")"
ck "POST assert (raw chain) -> wp8_post true" "$(has "$post" '"wp8_post": true')" "$post"
b="$(wp8_behavior "$R")"
ck "behaviour suite (raw chain): ${WP8_BEHAVIOR_EXPECTED}/${WP8_BEHAVIOR_EXPECTED}" "$(has "$b" "BEHAVIOR_COUNT pass=${WP8_BEHAVIOR_EXPECTED} fail=0")" "$(printf '%s\n' "$b" | grep -v '^PASS' | head -20)"

# --- owner-setup rehearsal: allowlist phase + sequential acceptance (A, C, then B), evidence, close
wp8_newdb "$H" && wp8_load_chain "$H" norm && wp8_fixture "$H" && wp8_apply "$H" >/dev/null
wp8_psql "$H" -1 -f "$WP8_GATES/wp8_sched_stub.sql" >/dev/null
wp8_psql "$H" -c "insert into vault.decrypted_secrets(name, decrypted_secret) values ('wp8_dispatch_url','https://ciproject.supabase.co/functions/v1/service-email-dispatch'),('wp8_dispatch_gateway_jwt','ci-gateway-placeholder'),('wp8_dispatch_token',repeat('c',40))" >/dev/null
sed 's/@@ARM_YES@@/YES/' "$WP8_ROOT/WP8_package/db/WP8_DB_scheduler_optin.sql" > "$WP8_TMP/sched.sql"
wp8_psql "$H" -1 -f "$WP8_TMP/sched.sql" >/dev/null 2>&1
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_owner_setup.sql" 2>&1)"
ck "owner setup template unreplaced -> refused" "$(has "$out" wp8_setup_refused_without_explicit_arm)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist A 0000000f-0000-4000-8000-0000000000f3)" 2>&1)"
ck "owner setup allowlist before enable -> refused" "$(has "$out" wp8_setup_allowlist_requires_enable_step)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file enable)" 2>&1)"
ck "owner setup enable -> WP8_SETUP_ENABLE_OK" "$(has "$out" WP8_SETUP_ENABLE_OK)" "$out"
ck "after enable: service_enabled only; essential/go-live off; allowlist 0; caps 40/1200; boundary set" "$(is "$(wp8_psql "$H" -tAc "select c.service_enabled and not c.essential_enabled and not c.public_go_live and p.welcome_auto_enqueue_enabled and p.welcome_enqueue_from is not null and p.service_daily_cap = 40 and p.service_monthly_cap = 1200 and (select count(*) from public.email_send_allowlist) = 0 from public.email_provider_config c, public.email_service_policy p")" t)"
r="$(wp8_psql "$H" -tAc "select public.welcome_enqueue_sweep()->>'candidates'")"
ck "after enable: sweep open, 0 candidates (nobody allowlisted, nobody new)" "$(is "$r" 0)" "$r"
QA="insert into auth.users(id, email, created_at) values (md5('wp8-qa-X')::uuid, 'qa-x@example.test', clock_timestamp()); insert into public.members(user_id, email) values (md5('wp8-qa-X')::uuid, 'qa-x@example.test');"
wp8_psql "$H" -c "${QA//X/A}" -c "${QA//X/B}" -c "${QA//X/C}" >/dev/null
wp8_psql "$H" -c "update public.members set first_name = 'O''Neil' where user_id = md5('wp8-qa-A')::uuid" >/dev/null
wp8_psql "$H" -c "select set_config('request.jwt.claims', json_build_object('sub', md5('wp8-qa-C')::uuid, 'role', 'authenticated')::text, false); select public.service_pref_set('welcome_service_email', false, 'qa-c-off', md5('qa-c-off')::uuid);" >/dev/null
UA="$(wp8_psql "$H" -tAc "select md5('wp8-qa-A')::uuid")"; UB="$(wp8_psql "$H" -tAc "select md5('wp8-qa-B')::uuid")"; UC="$(wp8_psql "$H" -tAc "select md5('wp8-qa-C')::uuid")"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist A 0000000f-0000-4000-8000-0000000000f3)" 2>&1)"
ck "allowlist refuses a user who signed up before the boundary (no backfill)" "$(has "$out" wp8_setup_qa_user_signed_up_before_boundary)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist C "$UA")" 2>&1)"
ck "allowlist C refuses a user whose pref is ON" "$(has "$out" wp8_setup_qa_c_pref_must_be_off)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist B "$UB")" 2>&1)"
ck "allowlist B before A -> refused (sequential acceptance)" "$(has "$out" wp8_setup_b_requires_a_first)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist A "$UA")" 2>&1)"; out2="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist C "$UC")" 2>&1)"
ck "allowlist A and C -> OK" "$([[ "$out" == *WP8_SETUP_ALLOWLIST_OK* && "$out2" == *WP8_SETUP_ALLOWLIST_OK* ]] && echo 1)" "$out $out2"
r="$(wp8_psql "$H" -tAc "select public.welcome_enqueue_sweep()->>'candidates'")"
ck "delay not elapsed -> 0 candidates" "$(is "$r" 0)" "$r"
wp8_psql "$H" -c "update public.members set created_at = now() - interval '11 minutes' where user_id in (md5('wp8-qa-A')::uuid, md5('wp8-qa-B')::uuid, md5('wp8-qa-C')::uuid)" >/dev/null
r="$(wp8_psql "$H" -tAc "select public.welcome_enqueue_sweep() = '{\"ok\": true, \"race\": 0, \"gate\": \"open\", \"errors\": 0, \"expired\": 0, \"reasons\": {}, \"enqueued\": 1, \"candidates\": 1, \"idempotent\": 0, \"reconciled\": 0, \"not_eligible\": 0}'::jsonb")"
ck "sweep after the delay: A enqueued, C excluded (pref OFF), B not allowlisted (exact counts)" "$(is "$r" t)" "$r"
kick="$(wp8_psql "$H" -tAc "select public.email_dispatch_kick()->>'kicked'")"
ck "kick fires once a row is due" "$(is "$kick" true)" "$kick"
wp8_psql "$H" -c "select count(*) from public.email_claim_batch(10)" >/dev/null
wp8_psql "$H" -c "select public.email_mark_result((select id from public.email_outbox where user_id = md5('wp8-qa-A')::uuid), true, 'prov-qa-A', null)" >/dev/null
wp8_psql "$H" -c "select public.email_ingest_provider_event('svix-qa-A-1', 'email.sent', 'prov-qa-A', 'qa-a@example.test', now(), null); select public.email_ingest_provider_event('svix-qa-A-2', 'email.delivered', 'prov-qa-A', 'qa-a@example.test', now(), null);" >/dev/null
r="$(wp8_psql "$H" -tAc "select public.welcome_enqueue_sweep()->>'enqueued'")"
ck "further sweeps add nothing for A" "$(is "$r" 0)" "$r"
ev="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql")"
ck "evidence after A: stop=false, A delivered once, escaped greeting, C has 0 rows" "$(python3 -c '
import json,sys; d=json.loads(sys.argv[1]); a=d["qa"]["wp8-qa-A"]; c=d["qa"]["wp8-qa-C"]
ok = (not d["stop"]) and a["welcome_rows"]==1 and a["statuses"]=={"delivered":1} and a["html_greeting_escaped_oneil"] and a["text_greeting_oneil"] and a["key_ok"] and a["template_v32"] and c["welcome_rows"]==0 and c["pref_enabled"] is False and d["global"]["ledger_24h"]["errors"]==0
print(1 if ok else 0)' "$ev")" "$ev"
ck "evidence output carries no address and no user id" "$([[ "$ev" != *@* ]] && ! printf '%s' "$ev" | grep -Eq '[0-9a-f]{8}-[0-9a-f]{4}-' && echo 1)" "$ev"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist B "$UB")" 2>&1)"
ck "allowlist B (step 2 of the sequential acceptance) -> OK" "$(has "$out" WP8_SETUP_ALLOWLIST_OK)" "$out"
r="$(wp8_psql "$H" -tAc "select public.welcome_enqueue_sweep()->>'enqueued'")"
wp8_psql "$H" -c "select count(*) from public.email_claim_batch(10)" >/dev/null
wp8_psql "$H" -c "select public.email_mark_result((select id from public.email_outbox where user_id = md5('wp8-qa-B')::uuid), true, 'prov-qa-B', null)" >/dev/null
wp8_psql "$H" -c "select public.email_ingest_provider_event('svix-qa-B-2', 'email.delivered', 'prov-qa-B', 'qa-b@example.test', now(), null)" >/dev/null
dup="$(wp8_psql "$H" -tAc "select (public.email_ingest_provider_event('svix-qa-B-2', 'email.delivered', 'prov-qa-B', 'qa-b@example.test', now(), null)->>'duplicate') || ':' || (select count(*) from public.email_send_events where svix_id = 'svix-qa-B-2')")"
ck "B enqueued once; webhook replay with the same svix-id is a duplicate (event count 1)" "$([[ "$r" == 1 && "$dup" == "true:1" ]] && echo 1)" "$r $dup"
ev="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql")"
ck "evidence after B: stop=false, B delivered with the neutral greeting, 2 wp8 rows total, legacy rows 3" "$(python3 -c '
import json,sys; d=json.loads(sys.argv[1]); b=d["qa"]["wp8-qa-B"]; g=d["global"]
ok = (not d["stop"]) and b["welcome_rows"]==1 and b["statuses"]=={"delivered":1} and b["html_greeting_neutral"] and g["wp8_rows_total"]==2 and g["legacy_rows"]==3 and g["cron_jobs"]==3
print(1 if ok else 0)' "$ev")" "$ev"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file close)" 2>&1)"
ck "close -> allowlist rows inactive, automation on, go-live off" "$([[ "$out" == *WP8_SETUP_CLOSE_OK* ]] && [[ "$(wp8_psql "$H" -tAc "select (select count(*) from public.email_send_allowlist where active) = 0 and (select welcome_auto_enqueue_enabled from public.email_service_policy) and not (select public_go_live from public.email_provider_config)")" == t ]] && echo 1)" "$out"
ev="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql")"
ck "evidence after close: stop=false, no duplicate, no backfill" "$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(1 if not d["stop"] and d["global"]["allowlist_active"]==0 else 0)' "$ev")" "$ev"
wp8_psql "$H" -c "update public.email_outbox set status = 'queued', next_attempt_at = now() where user_id = md5('wp8-qa-B')::uuid" >/dev/null
wp8_psql "$H" -c "insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status) values ('wp8:welcome_service_email:v1:' || md5('wp8-qa-Z')::uuid, 'x', 'optional_service', 'welcome_service_email', 's', md5('wp8-qa-Z')::uuid, repeat('a',64), 'failed')" >/dev/null
ev="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql")"
ck "evidence raises stop on a failed wp8 row" "$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(1 if d["stop"] and "wp8_failed_row" in d["stop_reasons"] else 0)' "$ev")" "$ev"

# --- kill switch, rollback (functional), cleanup, re-apply (on the rehearsal DB: armed state)
wp8_psql "$H" -c "update public.email_outbox set status = 'sending', lease_expires_at = now() + interval '2 minutes' where user_id = md5('wp8-qa-B')::uuid" >/dev/null
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_rollback.sql" 2>&1)"
ck "rollback refuses while a wp8 row is sending under an active lease" "$(has "$out" wp8_rollback_inflight_wait_for_lease)" "$out"
wp8_psql "$H" -c "update public.email_outbox set status = 'queued', lease_expires_at = null where user_id = md5('wp8-qa-B')::uuid" >/dev/null
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_kill_switch_soft.sql" 2>&1)"
ck "kill switch soft -> paused, automation off" "$(has "$out" WP8_KILL_SOFT_OK)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_kill_switch_hard.sql" 2>&1)"
ck "kill switch hard -> queued wp8 welcome canceled, service off, jobs unscheduled" "$([[ "$out" == *WP8_KILL_HARD_OK* ]] && [[ "$(wp8_psql "$H" -tAc "select status||'/'||last_error from public.email_outbox where user_id = md5('wp8-qa-B')::uuid")" == "canceled/wp8_kill_switch" ]] && [[ "$(wp8_psql "$H" -tAc "select count(*) from cron.job")" == 0 ]] && echo 1)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_rollback.sql" 2>&1)"
ck "functional rollback -> WP8_ROLLBACK_OK" "$(has "$out" WP8_ROLLBACK_OK)" "$out"
pr="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_post_rollback_assert.sql")"
ck "post-rollback assert: live CDP-3D claim/mark md5, flags off, no queued wp8 rows, guard off" "$(has "$pr" '"wp8_rolled_back": true')" "$pr"
wp8_psql "$H" -c "update public.email_provider_config set service_enabled = true where id = 1; insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac) values ('ci-after-rb','x','optional_service','welcome_service_email','s',md5('wp8-qa-A')::uuid,repeat('a',64))" >/dev/null 2>&1
r="$(wp8_psql "$H" -tAc "select count(*) from public.email_claim_batch(10)")"
ck "after rollback the CDP-3D claim still cannot send a welcome (pref/allowlist decision)" "$(is "$r" 0)" "$r"
wp8_psql "$H" -c "update public.email_provider_config set service_enabled = false where id = 1; update public.email_outbox set status = 'canceled' where status in ('queued','sending')" >/dev/null
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_rollback_cleanup_optional.sql" 2>&1)"
ck "optional cleanup -> WP8_CLEANUP_OK (functions and guard removed, data kept)" "$([[ "$out" == *WP8_CLEANUP_OK* ]] && [[ "$(wp8_psql "$H" -tAc "select count(*) from public.email_outbox where idempotency_key like 'wp8:%'")" == 3 ]] && echo 1)" "$out"
pr="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_post_rollback_assert.sql")"
ck "post-rollback assert still true after cleanup" "$(has "$pr" '"wp8_rolled_back": true')" "$pr"
out="$(wp8_apply "$H")"
ck "re-apply after rollback + cleanup -> WP8_UP_OK" "$(has "$out" WP8_UP_OK)" "$out"
ck "re-apply re-enabled the go-live guard and kept automation off" "$(is "$(wp8_psql "$H" -tAc "select (select tgenabled from pg_trigger where tgname = 'email_provider_config_golive_guard') = 'O' and not (select welcome_auto_enqueue_enabled from public.email_service_policy)")" t)"
out="$(wp8_psql_notice "$N" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_rollback.sql" 2>&1)"
pr="$(wp8_ro "$N" "$WP8_ROOT/WP8_package/db/WP8_DB_post_rollback_assert.sql")"
ck "rollback on the inert DB -> OK + assert true" "$([[ "$out" == *WP8_ROLLBACK_OK* && "$pr" == *'"wp8_rolled_back": true'* ]] && echo 1)" "$out $pr"
out="$(wp8_apply "$N")"; post="$(wp8_ro "$N" "$WP8_ROOT/WP8_package/db/WP8_DB_post_assert.sql")"
ck "inert DB: rollback -> re-apply -> POST true" "$([[ "$out" == *WP8_UP_OK* && "$post" == *'"wp8_post": true'* ]] && echo 1)" "$out $post"

echo
echo "EPHEMERAL RESULT pass=$pass fail=$fail expected=$EXPECTED"
if [[ $fail -eq 0 && $pass -eq $EXPECTED ]]; then echo "WP8_EPHEMERAL_PASS"; else echo "WP8_EPHEMERAL_FAIL"; exit 1; fi

#!/usr/bin/env bash
# WP8 ephemeral SQL suite on a throwaway PostgreSQL (never production; refuses *supabase.co*).
# Normalized (production-like) and raw CDP-3D chains, PRE/POST asserts, inert proof, behaviour
# suite, ZF probe, owner-setup rehearsal (sequential acceptance), rollback + cleanup + re-apply.
# Sentinel WP8_EPHEMERAL_PASS only when every check passed and the count equals EXPECTED.
set -uo pipefail
source "$(dirname "$0")/wp8_lib.sh"
EXPECTED=76
pass=0; fail=0
ck() { if [[ "$2" == "1" ]]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 :: ${3:-}" | cut -c1-600; fail=$((fail+1)); fi; }
is() { [[ "$1" == "$2" ]] && echo 1; }
has() { [[ "$1" == *"$2"* ]] && echo 1; }
N="wp8e_n_$$"; R="wp8e_r_$$"; A="wp8e_a_$$"; H="wp8e_h_$$"; F="wp8e_f_$$"
trap 'for d in $N $R $A $H $F; do wp8_dropdb $d; done; rm -rf "$WP8_TMP"' EXIT
EVQ="$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql"
# evidence inside a transaction that is rolled back, after the given setup statements
ev_rb() { local db="$1"; shift; { echo "begin;"; printf '%s\n' "$@"; cat "$EVQ"; echo "rollback;"; } | wp8_psql "$db" -tA 2>&1; }
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
# --- trigger inventory (amendment 14): a benign trigger body that only mentions a URL is not
# risky; a trigger that would call HTTP (net.http_post) on members is a PRE FAIL (STOP).
wp8_psql "$A" -c "create function public._ci_benign_url() returns trigger language plpgsql as \$f\$ begin new.display_name := coalesce(new.display_name, 'https://asalocal.club/r/x'); return new; end \$f\$; create trigger ci_benign_url before insert on public.members for each row execute function public._ci_benign_url();" >/dev/null
pre="$(wp8_ro "$A" "$WP8_ROOT/WP8_package/db/WP8_DB_pre_assert.sql")"
ck "PRE trigger inventory: a benign URL-mentioning trigger is recorded but not risky" "$(python3 -c '
import json,sys; d=json.loads(sys.argv[1]); t=[x for x in d["facts"]["triggers"] if x["trigger"]=="ci_benign_url"]
print(1 if d["wp8_pre"] and len(t)==1 and t[0]["risky"] is False and "definition" in t[0] and "writes" in t[0] else 0)' "$pre")" "$pre"
wp8_psql "$A" -c "create function public._ci_risky_http() returns trigger language plpgsql as \$f\$ begin perform net.http_post(url := 'x'); return new; end \$f\$; create trigger ci_risky_http after insert on public.members for each row execute function public._ci_risky_http();" >/dev/null
pre="$(wp8_ro "$A" "$WP8_ROOT/WP8_package/db/WP8_DB_pre_assert.sql")"
ck "PRE trigger inventory: an HTTP-calling trigger on members -> wp8_pre false (STOP)" "$([[ "$pre" == *'"wp8_pre": false'* && "$pre" == *no_risky_triggers_on_members_auth* ]] && echo 1)" "$pre"
wp8_psql "$A" -c "drop trigger ci_risky_http on public.members; drop trigger ci_benign_url on public.members" >/dev/null

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
wp8_psql "$H" -c "create function public._ci_risky_enqueue() returns trigger language plpgsql as \$f\$ begin perform public.email_enqueue(null, null, null, null, null, null, null, null, null); return new; end \$f\$; create trigger ci_risky_enqueue after insert on public.members for each row execute function public._ci_risky_enqueue();" >/dev/null
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file enable)" 2>&1)"
ck "owner setup refuses while an unreviewed enqueue-calling trigger exists on members" "$(has "$out" wp8_setup_unreviewed_trigger_on_members_or_auth)" "$out"
wp8_psql "$H" -c "drop trigger ci_risky_enqueue on public.members" >/dev/null
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
# kick STOP rule with pg_net present (stub net._http_response): a 500 or a failed request (NULL
# status -> "error") in this run is a STOP; only 200s are not.
k5="$(ev_rb "$H" "insert into net._http_response(id, status_code, created) values (9001, 200, now()), (9002, 500, now());")"
ke="$(ev_rb "$H" "insert into net._http_response(id, status_code, created) values (9003, null, now());")"
k2="$(ev_rb "$H" "insert into net._http_response(id, status_code, created) values (9004, 200, now()), (9005, 200, now());")"
ck "with pg_net: kick HTTP 500 or a failed request (NULL status) in this run -> stop kick_http_not_200; only 200s -> no kick reason" "$(python3 -c '
import json,sys
a,b,c=[json.loads(next(l for l in x.splitlines() if l.startswith("{"))) for x in sys.argv[1:4]]
ok = a["stop"] and "kick_http_not_200" in a["stop_reasons"] and a["global"]["kick_http_this_run_24h"]=={"200":1,"500":1} \
  and b["stop"] and "kick_http_not_200" in b["stop_reasons"] and b["global"]["kick_http_this_run_24h"]=={"error":1} \
  and "kick_http_not_200" not in c["stop_reasons"] and c["global"]["kick_http_this_run_24h"]=={"200":2} and c["global"]["pg_net_present"] is True
print(1 if ok else 0)' "$k5" "$ke" "$k2" 2>/dev/null)" "$k5 | $ke | $k2"

# --- kill switch, rollback (functional), cleanup, re-apply (on the rehearsal DB: armed state)
wp8_psql "$H" -c "update public.email_outbox set status = 'sending', lease_expires_at = now() + interval '2 minutes' where user_id = md5('wp8-qa-B')::uuid" >/dev/null
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_rollback.sql" 2>&1)"
ck "rollback refuses while a wp8 row is sending under an active lease" "$(has "$out" wp8_rollback_inflight_wait_for_lease)" "$out"
wp8_psql "$H" -c "update public.email_outbox set status = 'queued', lease_expires_at = null where user_id = md5('wp8-qa-B')::uuid" >/dev/null
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_kill_switch_soft.sql" 2>&1)"
ck "kill switch soft -> paused, automation off" "$(has "$out" WP8_KILL_SOFT_OK)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_kill_switch_hard.sql" 2>&1)"
ck "kill switch hard -> queued wp8 welcome canceled, service off, jobs unscheduled" "$([[ "$out" == *WP8_KILL_HARD_OK* ]] && [[ "$(wp8_psql "$H" -tAc "select status||'/'||last_error from public.email_outbox where user_id = md5('wp8-qa-B')::uuid")" == "canceled/wp8_kill_switch" ]] && [[ "$(wp8_psql "$H" -tAc "select count(*) from cron.job")" == 0 ]] && echo 1)" "$out"
# --- re-run after a hard kill (README section 6): scheduler opt-in again, close, enable, NEW QA
# accounts. The earlier run's QA rows stay inactive as evidence; the labels, the B gate and the
# evidence are scoped to the run (rows since the current boundary), so a fresh A can be allowlisted,
# B waits for the NEW A, and the evidence judges only the new run.
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file enable)" 2>&1)"
ck "re-run: enable before the scheduler opt-in is re-run -> refused (wp8_setup_scheduler_incomplete:0)" "$(has "$out" 'wp8_setup_scheduler_incomplete:0')" "$out"
b1="$(wp8_psql "$H" -tAc "select welcome_enqueue_from from public.email_service_policy where id = 1")"
out="$(wp8_psql_notice "$H" -1 -f "$WP8_TMP/sched.sql" 2>&1)"; out2="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file close)" 2>&1)"; out3="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file enable)" 2>&1)"
ck "re-run: scheduler opt-in, close, enable -> OK and the boundary moved forward" "$([[ "$out" == *WP8_SCHEDULER_OK* && "$out2" == *WP8_SETUP_CLOSE_OK* && "$out3" == *WP8_SETUP_ENABLE_OK* ]] && [[ "$(wp8_psql "$H" -tAc "select welcome_enqueue_from > '$b1'::timestamptz from public.email_service_policy where id = 1")" == t ]] && echo 1)" "$out $out2 $out3"
QA2="insert into auth.users(id, email, created_at) values (md5('wp8-qa2-X')::uuid, 'qa2-x@example.test', clock_timestamp()); insert into public.members(user_id, email) values (md5('wp8-qa2-X')::uuid, 'qa2-x@example.test');"
wp8_psql "$H" -c "${QA2//X/A}" -c "${QA2//X/B}" -c "${QA2//X/C}" -c "${QA2//X/D}" >/dev/null
wp8_psql "$H" -c "update public.members set first_name = 'O''Neil' where user_id = md5('wp8-qa2-A')::uuid" >/dev/null
wp8_psql "$H" -c "select set_config('request.jwt.claims', json_build_object('sub', md5('wp8-qa2-C')::uuid, 'role', 'authenticated')::text, false); select public.service_pref_set('welcome_service_email', false, 'qa2-c-off', md5('qa2-c-off')::uuid);" >/dev/null
U2A="$(wp8_psql "$H" -tAc "select md5('wp8-qa2-A')::uuid")"; U2B="$(wp8_psql "$H" -tAc "select md5('wp8-qa2-B')::uuid")"; U2C="$(wp8_psql "$H" -tAc "select md5('wp8-qa2-C')::uuid")"; U2D="$(wp8_psql "$H" -tAc "select md5('wp8-qa2-D')::uuid")"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist A "$UA")" 2>&1)"
ck "re-run: the earlier run's QA-A account is refused (signed up before the new boundary)" "$(has "$out" wp8_setup_qa_user_signed_up_before_boundary)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist A "$U2A")" 2>&1)"; out2="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist C "$U2C")" 2>&1)"
ck "re-run: allowlist A and C for NEW accounts -> OK (labels scoped to the run, earlier rows kept)" "$([[ "$out" == *WP8_SETUP_ALLOWLIST_OK* && "$out2" == *WP8_SETUP_ALLOWLIST_OK* ]] && [[ "$(wp8_psql "$H" -tAc "select count(*) from public.email_send_allowlist where note in ('wp8-qa-A','wp8-qa-B','wp8-qa-C')")" == 5 ]] && echo 1)" "$out $out2"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist A "$U2D")" 2>&1)"
ck "re-run: label A cannot be used twice in one run" "$(has "$out" wp8_setup_qa_label_already_used_in_this_run)" "$out"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist B "$U2B")" 2>&1)"
ck "re-run: allowlist B refused until the NEW A's welcome is sent (the earlier run's delivered A does not count)" "$(has "$out" wp8_setup_b_requires_a_first)" "$out"
wp8_psql "$H" -c "update public.members set created_at = now() - interval '11 minutes' where user_id in (md5('wp8-qa2-A')::uuid, md5('wp8-qa2-B')::uuid, md5('wp8-qa2-C')::uuid)" >/dev/null
r="$(wp8_psql "$H" -tAc "select public.welcome_enqueue_sweep() = '{\"ok\": true, \"race\": 0, \"gate\": \"open\", \"errors\": 0, \"expired\": 0, \"reasons\": {}, \"enqueued\": 1, \"candidates\": 1, \"idempotent\": 0, \"reconciled\": 0, \"not_eligible\": 0}'::jsonb")"
wp8_psql "$H" -c "select count(*) from public.email_claim_batch(10)" >/dev/null
wp8_psql "$H" -c "select public.email_mark_result((select id from public.email_outbox where user_id = md5('wp8-qa2-A')::uuid), true, 'prov-qa2-A', null)" >/dev/null
wp8_psql "$H" -c "select public.email_ingest_provider_event('svix-qa2-A-2', 'email.delivered', 'prov-qa2-A', 'qa2-a@example.test', now(), null)" >/dev/null
ev="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql")"
ck "re-run evidence: stop=false; only the new run is judged (A 1 delivered escaped, C 0, no B yet; this_run 1 row; 3 earlier QA rows as history)" "$([[ "$r" == t ]] && python3 -c '
import json,sys; d=json.loads(sys.argv[1]); q=d["qa"]; g=d["global"]; t=g["this_run"]
ok = (not d["stop"]) and set(q)=={"wp8-qa-A","wp8-qa-C"} and q["wp8-qa-A"]["welcome_rows"]==1 and q["wp8-qa-A"]["statuses"]=={"delivered":1} and q["wp8-qa-A"]["html_greeting_escaped_oneil"] and q["wp8-qa-A"]["signed_up_after_boundary"] and q["wp8-qa-C"]["welcome_rows"]==0 and t["wp8_rows"]==1 and t["qa_labels"]==2 and t["earlier_qa_rows"]==3 and g["wp8_rows_total"]==4
print(1 if ok else 0)' "$ev")" "$r $ev"
bf="$( { echo "begin;"; echo "insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status) values ('wp8:welcome_service_email:v1:0000000f-0000-4000-8000-0000000000f3', 'x', 'optional_service', 'welcome_service_email', 's', '0000000f-0000-4000-8000-0000000000f3', repeat('a',64), 'canceled');"; cat "$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql"; echo "rollback;"; } | wp8_psql "$H" -tA 2>&1)"
bh="$( { echo "begin;"; echo "insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status, created_at) values ('wp8:welcome_service_email:v1:0000000f-0000-4000-8000-0000000000f2', 'x', 'optional_service', 'welcome_service_email', 's', '0000000f-0000-4000-8000-0000000000f2', repeat('a',64), 'canceled', '$b1'::timestamptz + interval '1 second');"; cat "$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql"; echo "rollback;"; } | wp8_psql "$H" -tA 2>&1)"
ck "re-run evidence still flags backfill: a current-run row and an earlier-run row (boundary of that run from the setter audit log)" "$([[ "$bf" == *'"stop": true'* && "$bf" == *'"backfill"'* && "$bh" == *'"stop": true'* && "$bh" == *'"backfill"'* ]] && echo 1)" "$bf $bh"
out="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file allowlist B "$U2B")" 2>&1)"
wp8_psql "$H" -c "select public.welcome_enqueue_sweep()" -c "select count(*) from public.email_claim_batch(10)" >/dev/null
wp8_psql "$H" -c "select public.email_mark_result((select id from public.email_outbox where user_id = md5('wp8-qa2-B')::uuid), true, 'prov-qa2-B', null)" -c "select public.email_ingest_provider_event('svix-qa2-B-2', 'email.delivered', 'prov-qa2-B', 'qa2-b@example.test', now(), null)" >/dev/null
out2="$(wp8_psql_notice "$H" -1 -f "$(wp8_setup_file close)" 2>&1)"
ev="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_evidence.sql")"
ck "re-run: B after the new A -> OK; evidence B delivered neutral, this_run 2 rows, stop=false; close OK" "$([[ "$out" == *WP8_SETUP_ALLOWLIST_OK* && "$out2" == *WP8_SETUP_CLOSE_OK* ]] && python3 -c '
import json,sys; d=json.loads(sys.argv[1]); b=d["qa"]["wp8-qa-B"]; t=d["global"]["this_run"]
print(1 if (not d["stop"]) and b["welcome_rows"]==1 and b["statuses"]=={"delivered":1} and b["html_greeting_neutral"] and t["wp8_rows"]==2 and d["global"]["allowlist_active"]==0 else 0)' "$ev")" "$out $out2 $ev"
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_kill_switch_soft.sql" 2>&1)"; out2="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/ops/WP8_OPS_kill_switch_hard.sql" 2>&1)"
ck "re-run: kill switch soft + hard again -> OK, the 3 re-scheduled jobs unscheduled" "$([[ "$out" == *WP8_KILL_SOFT_OK* && "$out2" == *'WP8_KILL_HARD_OK unscheduled=3 still_sending=0'* ]] && echo 1)" "$out $out2"
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_rollback.sql" 2>&1)"
ck "functional rollback -> WP8_ROLLBACK_OK" "$(has "$out" WP8_ROLLBACK_OK)" "$out"
pr="$(wp8_ro "$H" "$WP8_ROOT/WP8_package/db/WP8_DB_post_rollback_assert.sql")"
ck "post-rollback assert: live CDP-3D claim/mark md5, flags off, no queued wp8 rows, guard off" "$(has "$pr" '"wp8_rolled_back": true')" "$pr"
# After rollback (CDP-3D claim restored): a fresh user who signed up now and is NOT allowlisted,
# service_enabled on, one queued welcome row. Separate statements, errors not hidden; the setup
# itself is asserted, then the decision outcome, then a positive control (allowlisted -> claimable).
setup="$(wp8_psql "$H" -c "insert into auth.users(id, email, created_at) values (md5('wp8-qa-RB')::uuid, 'qa-rb@example.test', clock_timestamp()); insert into public.members(user_id, email) values (md5('wp8-qa-RB')::uuid, 'qa-rb@example.test');" 2>&1)"
setup+="$(wp8_psql "$H" -c "update public.email_provider_config set service_enabled = true where id = 1" 2>&1)"
setup+="$(wp8_psql "$H" -c "insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac) values ('ci-after-rb', 'x', 'optional_service', 'welcome_service_email', 's', md5('wp8-qa-RB')::uuid, repeat('a',64))" 2>&1)"
st="$(wp8_psql "$H" -tAc "select (select service_enabled from public.email_provider_config where id = 1)::text || ':' || (select count(*) from public.email_outbox where idempotency_key = 'ci-after-rb' and status = 'queued') || ':' || (select count(*) from public.member_service_pref_current where user_id = md5('wp8-qa-RB')::uuid and enabled)")"
r="$(wp8_psql "$H" -tAc "select count(*) from public.email_claim_batch(10)")"
st2="$(wp8_psql "$H" -tAc "select status || '/' || coalesce(skip_reason::text, '') from public.email_outbox where idempotency_key = 'ci-after-rb'")"
ck "after rollback the CDP-3D claim does not send a welcome to a non-allowlisted user (service on, row queued, pref on -> skipped/not_in_allowlist)" "$([[ "$st" == "true:1:1" && "$r" == 0 && "$st2" == "skipped/not_in_allowlist" ]] && echo 1)" "setup=[$setup] state=$st claimed=$r row=$st2"
wp8_psql "$H" -c "insert into public.email_send_allowlist(user_id, note, active) values (md5('wp8-qa-RB')::uuid, 'wp8-ci-rb', true)" -c "update public.email_outbox set status = 'queued', skip_reason = null, next_attempt_at = now() where idempotency_key = 'ci-after-rb'" >/dev/null
r="$(wp8_psql "$H" -tAc "select count(*) from public.email_claim_batch(10)")"
ck "control: once allowlisted, the same row is claimed after rollback (the 0 above is the decision, not a dead claim)" "$(is "$r" 1)" "$r"
wp8_psql "$H" -c "update public.email_provider_config set service_enabled = false where id = 1; update public.email_outbox set status = 'canceled' where status in ('queued','sending'); update public.email_send_allowlist set active = false where note = 'wp8-ci-rb'" >/dev/null
out="$(wp8_psql_notice "$H" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_rollback_cleanup_optional.sql" 2>&1)"
ck "optional cleanup -> WP8_CLEANUP_OK (functions and guard removed, data kept)" "$([[ "$out" == *WP8_CLEANUP_OK* ]] && [[ "$(wp8_psql "$H" -tAc "select count(*) from public.email_outbox where idempotency_key like 'wp8:%'")" == 5 ]] && echo 1)" "$out"
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

# --- D2 fallback path (GitHub Actions scheduler): no pg_net and no pg_cron, as in production today.
# The evidence is the only acceptance gate there, so it must return and still evaluate every STOP
# rule; the kick fields are JSON null (the fallback workflow's run log is the kick evidence).
wp8_newdb "$F" && wp8_load_chain "$F" norm && wp8_fixture "$F" && wp8_apply "$F" >/dev/null
nx="$(wp8_psql "$F" -tAc "select to_regnamespace('net') is null and to_regnamespace('cron') is null and to_regclass('net._http_response') is null and to_regclass('cron.job') is null")"
ev="$(wp8_ro "$F" "$EVQ" 2>&1)"
ck "fallback path (no pg_net, no pg_cron): evidence on the inert DB returns stop=false with the kick fields null" "$([[ "$nx" == t ]] && python3 -c '
import json,sys; d=json.loads(sys.argv[1]); g=d["global"]
print(1 if d["stop"] is False and d["stop_reasons"]==[] and g["pg_net_present"] is False and g["pg_cron_present"] is False and g["kick_http_24h"] is None and g["kick_http_this_run_24h"] is None and g["cron_jobs"] is None else 0)' "$ev" 2>/dev/null)" "$nx $ev"
out="$(wp8_psql_notice "$F" -1 -f "$(wp8_setup_file enable)" 2>&1)"
wp8_psql "$F" -c "${QA//X/A}" -c "${QA//X/C}" >/dev/null
wp8_psql "$F" -c "update public.members set first_name = 'O''Neil' where user_id = md5('wp8-qa-A')::uuid" >/dev/null
wp8_psql "$F" -c "select set_config('request.jwt.claims', json_build_object('sub', md5('wp8-qa-C')::uuid, 'role', 'authenticated')::text, false); select public.service_pref_set('welcome_service_email', false, 'qa-c-off', md5('qa-c-off')::uuid);" >/dev/null
out2="$(wp8_psql_notice "$F" -1 -f "$(wp8_setup_file allowlist A "$UA")" 2>&1)"; out3="$(wp8_psql_notice "$F" -1 -f "$(wp8_setup_file allowlist C "$UC")" 2>&1)"
wp8_psql "$F" -c "update public.members set created_at = now() - interval '11 minutes' where user_id in (md5('wp8-qa-A')::uuid, md5('wp8-qa-C')::uuid)" >/dev/null
r="$(wp8_psql "$F" -tAc "select public.welcome_enqueue_sweep()->>'enqueued'")"
wp8_psql "$F" -c "select count(*) from public.email_claim_batch(10)" >/dev/null
wp8_psql "$F" -c "select public.email_mark_result((select id from public.email_outbox where user_id = md5('wp8-qa-A')::uuid), true, 'prov-qa-fa', null)" -c "select public.email_ingest_provider_event('svix-qa-fa-2', 'email.delivered', 'prov-qa-fa', 'qa-a@example.test', now(), null)" >/dev/null
ev="$(wp8_ro "$F" "$EVQ" 2>&1)"
ck "fallback path: enable (no cron check), allowlist A + C, A enqueued once and delivered; evidence stop=false, escaped greeting, C 0 rows, kick fields null" "$([[ "$out" == *WP8_SETUP_ENABLE_OK* && "$out2" == *WP8_SETUP_ALLOWLIST_OK* && "$out3" == *WP8_SETUP_ALLOWLIST_OK* && "$r" == 1 ]] && python3 -c '
import json,sys; d=json.loads(sys.argv[1]); a=d["qa"]["wp8-qa-A"]; c=d["qa"]["wp8-qa-C"]; g=d["global"]
ok = d["stop"] is False and a["welcome_rows"]==1 and a["statuses"]=={"delivered":1} and a["html_greeting_escaped_oneil"] and a["key_ok"] and a["template_v32"] and c["welcome_rows"]==0 and g["this_run"]["wp8_rows"]==1 and g["kick_http_this_run_24h"] is None and g["pg_net_present"] is False
print(1 if ok else 0)' "$ev" 2>/dev/null)" "$out $out2 $out3 enqueued=$r $ev"
sf="$(ev_rb "$F" "insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status) values ('wp8:welcome_service_email:v1:' || md5('wp8-qa-Z')::uuid, 'x', 'optional_service', 'welcome_service_email', 's', md5('wp8-qa-Z')::uuid, repeat('a',64), 'failed');" \
  "insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status) values ('wp8:welcome_service_email:v1:0000000f-0000-4000-8000-0000000000f3', 'x', 'optional_service', 'welcome_service_email', 's', '0000000f-0000-4000-8000-0000000000f3', repeat('a',64), 'canceled');" \
  "insert into public.email_wp8_run_ledger(job, gate, errors) values ('welcome_enqueue_sweep', 'open', 1);")"
ck "fallback path: STOP rules still evaluated without pg_net (failed row, sweep error, backfill -> stop=true with exactly those 3 reasons)" "$(python3 -c '
import json,sys; d=json.loads(next(l for l in sys.argv[1].splitlines() if l.startswith("{")))
print(1 if d["stop"] is True and sorted(d["stop_reasons"])==["backfill","sweep_errors","wp8_failed_row"] and d["global"]["kick_http_this_run_24h"] is None else 0)' "$sf" 2>/dev/null)" "$sf"

echo
echo "EPHEMERAL RESULT pass=$pass fail=$fail expected=$EXPECTED"
if [[ $fail -eq 0 && $pass -eq $EXPECTED ]]; then echo "WP8_EPHEMERAL_PASS"; else echo "WP8_EPHEMERAL_FAIL"; exit 1; fi

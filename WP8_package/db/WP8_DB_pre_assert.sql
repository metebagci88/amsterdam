-- WP8 PRE assert. ONE read-only SELECT, run immediately before WP8_DB_up.sql (execute_sql).
-- Any FAIL is a STOP (unexpected production state). Expected: {"wp8_pre": true, "failed": [], ...}.
-- Pins the 2026-10-08 PRE facts: flags false, allowlist 0, outbox 3 (1 canceled, 2 delivered,
-- all before 2026-10-01), events 6 (2 orphans), the 14 live function md5s, WSE active since
-- 2026-09-30T16:26:59.948763Z, readiness not ready, no WP8 objects, no HTTP or enqueue callers.
-- Facts (not pass/fail): trigger inventory on members/auth.users/auth.identities with function
-- md5, auth.users column inventory, function owners, server version, extensions.
with md5s(name, sig, live_md5) as (values
  ('_email_can_set_delivery', 'public._email_can_set_delivery(public.email_send_status,public.email_send_status)', '164c0e3f3dea09585542573229d8179d'),
  ('_email_send_decision', 'public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)', '4da18d72fb4822ba4307da5f7ff06ba2'),
  ('_email_status_rank', 'public._email_status_rank(public.email_send_status)', '444c0b885722582d4ea1278488bede3f'),
  ('_email_system_apply_suppression', 'public._email_system_apply_suppression(text,public.suppression_reason,text)', 'cbc5c3cc473ea251ae7e86a6ff7e0032'),
  ('_seed_welcome_service_pref_on_member_insert', 'public._seed_welcome_service_pref_on_member_insert()', '92e4db755ce2d41584c302073e60fdb1'),
  ('admin_q_email_delivery_status', 'public.admin_q_email_delivery_status(uuid)', '49e1ae64d77f0f922b5ecef7dffd5c4c'),
  ('consent_get_my_state', 'public.consent_get_my_state()', '32b33d6ca355f9d89804eb74b5e2bbaf'),
  ('email_claim_batch', 'public.email_claim_batch(int)', '08fc00397182c86929bcb9afa6a6a995'),
  ('email_enqueue', 'public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text)', 'ba947a7c1c2f085e8b251877bb67c9a6'),
  ('email_ingest_provider_event', 'public.email_ingest_provider_event(text,text,text,text,timestamptz,text)', '8688c2d9c96cbc7428fd297d8f2fedc0'),
  ('email_mark_result', 'public.email_mark_result(uuid,boolean,text,text)', '5d34c6af5d4934e23f6508a4a56a562c'),
  ('email_purge_expired_content', 'public.email_purge_expired_content()', 'efec09f92a2d7f8fd4610b9461ecbc4c'),
  ('service_delivery_readiness_check', 'public.service_delivery_readiness_check()', '5e74aa1d695c2b573e90cc85fb2d4060'),
  ('service_pref_set', 'public.service_pref_set(public.service_pref_key,boolean,text,uuid)', 'f171f1ab1a2c183f861f63060a1ad5de')
), trg as (
  select c.relnamespace::regnamespace::text || '.' || c.relname as tbl, t.tgname, p.oid as fn_oid,
         p.pronamespace::regnamespace::text || '.' || p.proname as fn, md5(p.prosrc) as fn_md5,
         (p.prosrc ~* '(net\.|http|email_enqueue|email_outbox|dblink|pg_net|email_claim_batch)') as risky
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal
     and c.oid in (select x from (values (to_regclass('public.members')), (to_regclass('auth.users')), (to_regclass('auth.identities'))) v(x) where x is not null)
), vault_names as (
  select (xpath('/row/n/text()', query_to_xml(
           case when to_regclass('vault.secrets') is not null then 'select string_agg(name, '','') as n from vault.secrets'
                else 'select string_agg(name, '','') as n from vault.decrypted_secrets' end, false, true, '')))[1]::text as names
), checks(name, pass) as (
  select 'server_version_14_plus', current_setting('server_version_num')::int >= 140000
  union all select 'server_encoding_utf8', current_setting('server_encoding') = 'UTF8'
  union all select 'provider_flags_false', (select not (essential_enabled or service_enabled or public_go_live) from public.email_provider_config where id = 1)
  union all select 'provider_from_domain', (select from_email = 'no-reply@send.asalocal.club' and reply_to = 'destek@asalocal.club' and lease_seconds = 120 and content_retention_days = 30 from public.email_provider_config where id = 1)
  union all select 'marketing_flags_false', case when to_regclass('public.marketing_config') is null then false else
    (xpath('/row/c/text()', query_to_xml('select bool_and(not (marketing_enabled or marketing_capture_enabled)) as c from public.marketing_config', false, true, '')))[1]::text = 'true' end
  union all select 'allowlist_empty', (select count(*) = 0 from public.email_send_allowlist)
  union all select 'outbox_total_3', (select count(*) = 3 from public.email_outbox)
  union all select 'outbox_1_canceled_2_delivered', (select count(*) filter (where status = 'canceled') = 1 and count(*) filter (where status = 'delivered') = 2 from public.email_outbox)
  union all select 'outbox_all_welcome_optional', (select bool_and(message_class = 'optional_service' and service_pref_key = 'welcome_service_email') from public.email_outbox)
  union all select 'outbox_no_inflight', (select count(*) = 0 from public.email_outbox where status in ('queued', 'sending'))
  union all select 'outbox_all_before_cutover', (select count(*) = 0 from public.email_outbox where created_at >= timestamptz '2026-10-01 00:00:00+00')
  union all select 'welcome_users_gt1_is_1', (select count(*) = 1 from (select user_id from public.email_outbox where service_pref_key = 'welcome_service_email' group by user_id having count(*) > 1) d)
  union all select 'events_total_6', (select count(*) = 6 from public.email_send_events)
  union all select 'events_orphans_2', (select count(*) = 2 from public.email_send_events where outbox_id is null)
  union all select 'events_all_before_cutover', (select count(*) = 0 from public.email_send_events where received_at >= timestamptz '2026-10-01 00:00:00+00')
  union all select 'md5_' || name, (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure(sig)) = live_md5 from md5s
  union all select 'wp8_tables_absent', to_regclass('public.email_service_templates') is null and to_regclass('public.email_service_policy') is null
      and to_regclass('public.email_send_event_links') is null and to_regclass('public.email_wp8_run_ledger') is null and to_regclass('public.email_wp8_manifest') is null
  union all select 'wp8_functions_absent', to_regprocedure('public.welcome_enqueue_sweep(int)') is null and to_regprocedure('public.email_release_claim(uuid,int,boolean)') is null
      and to_regprocedure('public.email_dispatch_kick()') is null and to_regprocedure('public.welcome_render(uuid,text)') is null
  union all select 'wp8_outbox_columns_absent', (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'email_outbox'
      and column_name in ('rate_limit_releases', 'first_attempt_at', 'service_template_id'))
  union all select 'wse_policy_active_exact', (select default_enabled is true and effective_from = timestamptz '2026-09-30 16:26:59.948763+00'
      and policy_version = 'welcome_service_email.v1' from public.service_pref_defaults where pref_key = 'welcome_service_email')
  union all select 'wse_seed_trigger_present', exists (select 1 from pg_trigger where tgname = 'trg_members_seed_welcome_service_pref' and tgrelid = to_regclass('public.members') and not tgisinternal and tgenabled = 'O')
  union all select 'readiness_not_ready', coalesce((public.service_delivery_readiness_check()->>'ready')::boolean, false) = false
  union all select 'members_first_name_column', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'members' and column_name = 'first_name')
  union all select 'auth_otp_columns_present', (select count(*) = 4 from information_schema.columns where table_schema = 'auth' and table_name = 'users'
      and column_name in ('confirmation_sent_at', 'recovery_sent_at', 'email_change_sent_at', 'reauthentication_sent_at'))
  union all select 'no_risky_triggers_on_members_auth', not exists (select 1 from trg where risky)
  union all select 'no_other_enqueue_or_http_callers', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'email_enqueue'
      and (p.prosrc ilike '%email_enqueue%' or p.prosrc ilike '%service-email-dispatch%' or p.prosrc ilike '%net.http_post%'))
  union all select 'no_email_cron_jobs', case when to_regclass('cron.job') is null then true else
    (xpath('/row/c/text()', query_to_xml('select count(*) as c from cron.job where jobname like ''wp8-%'' or command ilike ''%email%'' or command ilike ''%welcome%'' or command ilike ''%dispatch%''', false, true, '')))[1]::text::int = 0 end
  union all select 'vault_pepper_present', (select position('cdp3c_contact_pepper_v1' in coalesce(names, '')) > 0 from vault_names)
  union all select 'vault_wp8_names_absent', (select coalesce(names, '') !~ 'wp8_dispatch' from vault_names)
  union all select 'pgcrypto_present', exists (select 1 from pg_extension where extname = 'pgcrypto')
)
select jsonb_build_object(
  'wp8_pre', bool_and(coalesce(pass, false)),
  'failed', coalesce(jsonb_agg(name) filter (where not coalesce(pass, false)), '[]'::jsonb),
  'n', count(*),
  'facts', jsonb_build_object(
    'server_version_num', current_setting('server_version_num'),
    'current_user', current_user,
    'extensions', (select coalesce(jsonb_object_agg(extname, extversion), '{}'::jsonb) from pg_extension where extname in ('pg_cron', 'pg_net', 'supabase_vault', 'pgcrypto')),
    'triggers', (select coalesce(jsonb_agg(jsonb_build_object('table', tbl, 'trigger', tgname, 'function', fn, 'fn_md5', fn_md5, 'risky', risky) order by tbl, tgname), '[]'::jsonb) from trg),
    'auth_users_columns', (select coalesce(jsonb_agg(column_name::text order by ordinal_position), '[]'::jsonb) from information_schema.columns where table_schema = 'auth' and table_name = 'users'),
    'function_owners', (select coalesce(jsonb_object_agg(m.name, pg_get_userbyid(p.proowner)), '{}'::jsonb) from md5s m join pg_proc p on p.oid = to_regprocedure(m.sig)),
    'members_total', (select count(*) from public.members),
    'members_with_first_name', (select count(*) from public.members where first_name is not null)
  )) as wp8_pre
  from checks;

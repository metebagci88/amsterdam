-- WP8 POST assert. ONE read-only SELECT, run right after WP8_DB_up.sql (execute_sql).
-- Proves the migration is inert and complete. Expected: {"wp8_post": true, "failed": [], "n": 43}.
-- Counts reflect the 2026-10-08 production PRE facts (outbox 3, events 6, allowlist 0).
-- Function and table checks iterate over public.email_wp8_manifest (written by the migration
-- from the build manifest); the static gate pins the expected 14 functions and 5 tables.
with fn as (
  select m.signature, m.body_md5, m.service_role_execute, to_regprocedure(m.signature) as oid
    from public.email_wp8_manifest m where m.object_kind = 'function'
), tb as (
  select m.signature, to_regclass(m.signature) as oid from public.email_wp8_manifest m where m.object_kind = 'table'
), md5s(name, sig, ok_md5) as (values
  ('decision', 'public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)', array['4da18d72fb4822ba4307da5f7ff06ba2', 'cd4968cfd9609292ef01ce476583fd1f']),
  ('enqueue', 'public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text)', array['ba947a7c1c2f085e8b251877bb67c9a6', 'ed3c0fcd5236646e6043b79ea2eeefeb']),
  ('ingest', 'public.email_ingest_provider_event(text,text,text,text,timestamptz,text)', array['8688c2d9c96cbc7428fd297d8f2fedc0', 'c79386a511a0d4fe886247de20c8444d']),
  ('can_set', 'public._email_can_set_delivery(public.email_send_status,public.email_send_status)', array['164c0e3f3dea09585542573229d8179d', '2a017fd53d0e9d6473659449676b4d4c']),
  ('wse_seed', 'public._seed_welcome_service_pref_on_member_insert()', array['92e4db755ce2d41584c302073e60fdb1']),
  ('service_pref_set', 'public.service_pref_set(public.service_pref_key,boolean,text,uuid)', array['f171f1ab1a2c183f861f63060a1ad5de']),
  ('readiness', 'public.service_delivery_readiness_check()', array['5e74aa1d695c2b573e90cc85fb2d4060']),
  ('purge', 'public.email_purge_expired_content()', array['efec09f92a2d7f8fd4610b9461ecbc4c']),
  ('suppression', 'public._email_system_apply_suppression(text,public.suppression_reason,text)', array['cbc5c3cc473ea251ae7e86a6ff7e0032'])
), checks(name, pass) as (
  select 'provider_flags_false', (select not (essential_enabled or service_enabled or public_go_live) from public.email_provider_config where id = 1)
  union all select 'marketing_flags_false', case when to_regclass('public.marketing_config') is null then true else
    (xpath('/row/c/text()', query_to_xml('select bool_and(not (marketing_enabled or marketing_capture_enabled)) as c from public.marketing_config', false, true, '')))[1]::text = 'true' end
  union all select 'allowlist_empty', (select count(*) = 0 from public.email_send_allowlist)
  union all select 'outbox_unchanged_3', (select count(*) = 3 from public.email_outbox)
  union all select 'no_inflight', (select count(*) = 0 from public.email_outbox where status in ('queued', 'sending'))
  union all select 'no_wp8_rows', (select count(*) = 0 from public.email_outbox where idempotency_key like 'wp8:%')
  union all select 'no_service_template_ids', (select count(*) = 0 from public.email_outbox where service_template_id is not null)
  union all select 'events_unchanged_6', (select count(*) = 6 from public.email_send_events)
  union all select 'links_empty', (select count(*) = 0 from public.email_send_event_links)
  union all select 'ledger_empty', (select count(*) = 0 from public.email_wp8_run_ledger)
  union all select 'policy_inert', (select not welcome_auto_enqueue_enabled and welcome_enqueue_from is null and service_daily_cap = 0
      and service_monthly_cap = 0 and public_go_live_since is null from public.email_service_policy where id = 1)
  union all select 'policy_singleton', (select count(*) = 1 from public.email_service_policy)
  union all select 'template_single_v32', (select count(*) = 1 from public.email_service_templates)
  union all select 'template_pinned_sha', (select t.template_key = 'welcome_service_email' and t.version = 'v3.2'
      and t.html_sha256 = '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb'
      and t.text_sha256 = '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56'
      and encode(sha256(convert_to(t.body_html, 'UTF8')), 'hex') = t.html_sha256
      and encode(sha256(convert_to(t.body_text, 'UTF8')), 'hex') = t.text_sha256
      and octet_length(convert_to(t.body_html, 'UTF8')) = 13354 and octet_length(convert_to(t.body_text, 'UTF8')) = 343
      and encode(convert_to(t.subject, 'UTF8'), 'hex') = '4172616dc4b17a6120686fc59f2067656c64696e'
      from public.email_service_templates t join public.email_service_policy p on p.welcome_template_id = t.id where p.id = 1)
  union all select 'welcome_index_valid', (select indisvalid and indisunique from pg_index where indexrelid = to_regclass('public.email_outbox_welcome_once_uk'))
  union all select 'guard_triggers_enabled', (select count(*) = 5 from pg_trigger where not tgisinternal and tgenabled = 'O'
      and ((tgrelid = to_regclass('public.email_provider_config') and tgname = 'email_provider_config_golive_guard')
        or (tgrelid = to_regclass('public.email_service_policy') and tgname = 'email_service_policy_guard')
        or (tgrelid = to_regclass('public.email_service_templates') and tgname = 'email_service_templates_immutable')
        or (tgrelid = to_regclass('public.email_send_event_links') and tgname = 'email_send_event_links_append_only')
        or (tgrelid = to_regclass('public.email_wp8_manifest') and tgname = 'email_wp8_manifest_append_only')))
  union all select 'manifest_functions_14', (select count(*) = 14 from fn)
  union all select 'manifest_functions_present', (select bool_and(oid is not null) from fn)
  union all select 'manifest_functions_md5', (select bool_and(md5(p.prosrc) = fn.body_md5) from fn join pg_proc p on p.oid = fn.oid)
  union all select 'manifest_functions_not_anon', (select bool_and(not has_function_privilege('anon', fn.oid, 'execute')) from fn)
  union all select 'manifest_functions_not_authenticated', (select bool_and(not has_function_privilege('authenticated', fn.oid, 'execute')) from fn)
  union all select 'manifest_functions_service_role_as_declared', (select bool_and(has_function_privilege('service_role', fn.oid, 'execute') = fn.service_role_execute) from fn)
  union all select 'manifest_functions_security_definer_search_path', (select bool_and(not p.prosecdef or exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search_path=%'))
      from fn join pg_proc p on p.oid = fn.oid)
  union all select 'manifest_tables_5', (select count(*) = 5 from tb)
  union all select 'manifest_tables_rls_forced', (select bool_and(c.relrowsecurity and c.relforcerowsecurity) from tb join pg_class c on c.oid = tb.oid)
  union all select 'manifest_tables_not_anon', (select bool_and(not has_table_privilege('anon', tb.oid, 'select,insert,update,delete,truncate')) from tb)
  union all select 'manifest_tables_not_authenticated', (select bool_and(not has_table_privilege('authenticated', tb.oid, 'select,insert,update,delete,truncate')) from tb)
  union all select 'manifest_tables_service_role_no_write', (select bool_and(not has_table_privilege('service_role', tb.oid, 'insert,update,delete,truncate')) from tb)
  union all select 'claim_is_wp8_body', (select md5(prosrc) not in ('08fc00397182c86929bcb9afa6a6a995', '317199cf1aecb938c354602287b03b36') from pg_proc where oid = to_regprocedure('public.email_claim_batch(int)'))
  union all select 'mark_is_wp8_body', (select md5(prosrc) not in ('5d34c6af5d4934e23f6508a4a56a562c', 'e3f69dd307263b4ba5efdb50dbe65a17') from pg_proc where oid = to_regprocedure('public.email_mark_result(uuid,boolean,text,text)'))
  union all select 'no_net_http_post_callers', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%net.http_post%')
  union all select 'no_kick_function_yet', to_regprocedure('public.email_dispatch_kick()') is null
  union all select 'no_wp8_cron_jobs', case when to_regclass('cron.job') is null then true else
    (xpath('/row/c/text()', query_to_xml('select count(*) as c from cron.job where jobname like ''wp8-%''', false, true, '')))[1]::text::int = 0 end
  union all select 'readiness_still_not_ready', coalesce((public.service_delivery_readiness_check()->>'ready')::boolean, false) = false
  union all select 'md5_' || name, (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure(sig)) = any(ok_md5) from md5s
)
select jsonb_build_object('wp8_post', bool_and(coalesce(pass, false)),
  'failed', coalesce(jsonb_agg(name) filter (where not coalesce(pass, false)), '[]'::jsonb), 'n', count(*)) as wp8_post
  from checks;

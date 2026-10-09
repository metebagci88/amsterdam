-- WP8 post-rollback assert. ONE read-only SELECT after WP8_DB_rollback.sql (and optionally after
-- WP8_DB_rollback_cleanup_optional.sql). Expected: {"wp8_rolled_back": true, "failed": []}.
with md5s(name, sig, ok_md5) as (values
  ('claim_live_cdp3d', 'public.email_claim_batch(int)', array['08fc00397182c86929bcb9afa6a6a995']),
  ('mark_live_cdp3d', 'public.email_mark_result(uuid,boolean,text,text)', array['5d34c6af5d4934e23f6508a4a56a562c']),
  ('decision', 'public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)', array['4da18d72fb4822ba4307da5f7ff06ba2', 'cd4968cfd9609292ef01ce476583fd1f']),
  ('enqueue', 'public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text)', array['ba947a7c1c2f085e8b251877bb67c9a6', 'ed3c0fcd5236646e6043b79ea2eeefeb']),
  ('ingest', 'public.email_ingest_provider_event(text,text,text,text,timestamptz,text)', array['8688c2d9c96cbc7428fd297d8f2fedc0', 'c79386a511a0d4fe886247de20c8444d']),
  ('can_set', 'public._email_can_set_delivery(public.email_send_status,public.email_send_status)', array['164c0e3f3dea09585542573229d8179d', '2a017fd53d0e9d6473659449676b4d4c']),
  ('wse_seed', 'public._seed_welcome_service_pref_on_member_insert()', array['92e4db755ce2d41584c302073e60fdb1']),
  ('purge', 'public.email_purge_expired_content()', array['efec09f92a2d7f8fd4610b9461ecbc4c'])
), checks(name, pass) as (
  select 'md5_' || name, (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure(sig)) = any(ok_md5) from md5s
  union all select 'claim_mark_acl', not has_function_privilege('anon', 'public.email_claim_batch(int)', 'execute')
      and not has_function_privilege('authenticated', 'public.email_mark_result(uuid,boolean,text,text)', 'execute')
      and has_function_privilege('service_role', 'public.email_claim_batch(int)', 'execute')
  union all select 'service_and_go_live_off', (select not (service_enabled or public_go_live) from public.email_provider_config where id = 1)
  union all select 'no_queued_or_sending_wp8_rows', (select count(*) = 0 from public.email_outbox where idempotency_key like 'wp8:%' and status in ('queued', 'sending'))
  union all select 'policy_off_and_paused', case when to_regclass('public.email_service_policy') is null then true else
    (xpath('/row/c/text()', query_to_xml('select bool_and(not welcome_auto_enqueue_enabled and service_dispatch_paused) as c from public.email_service_policy', false, true, '')))[1]::text = 'true' end
  union all select 'golive_guard_disabled_or_absent', not exists (select 1 from pg_trigger where tgname = 'email_provider_config_golive_guard' and tgenabled <> 'D')
  union all select 'no_wp8_cron_jobs', case when to_regclass('cron.job') is null then true else
    (xpath('/row/c/text()', query_to_xml('select count(*) as c from cron.job where jobname like ''wp8-%''', false, true, '')))[1]::text::int = 0 end
)
select jsonb_build_object('wp8_rolled_back', bool_and(coalesce(pass, false)),
  'failed', coalesce(jsonb_agg(name) filter (where not coalesce(pass, false)), '[]'::jsonb), 'n', count(*)) as wp8_post_rollback
  from checks;

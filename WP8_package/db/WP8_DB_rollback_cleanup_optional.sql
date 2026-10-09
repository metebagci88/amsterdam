-- WP8 OPTIONAL cleanup after the functional rollback. The ONLY WP8 file that contains DROP.
-- Separate owner approval. Run ONLY after WP8_DB_rollback.sql reported WP8_ROLLBACK_OK
-- (the guard below refuses otherwise). It removes the WP8 functions and the go-live guard
-- trigger. Tables, outbox columns, indexes and all rows are KEPT as evidence.
-- The commented HARD section (owner only, irreversible) removes the WP8 tables and columns;
-- it must run BEFORE any CDP3D down (WP8 tables reference email_outbox/email_send_events).
select set_config('wp8.cleanup_txn', 'YES', true);

do $wp8_cleanup_pre$
begin
  if coalesce(current_setting('wp8.cleanup_txn', true), '') <> 'YES' then
    raise exception 'WP8_NOT_SINGLE_TRANSACTION';
  end if;
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.email_claim_batch(int)')) is distinct from '08fc00397182c86929bcb9afa6a6a995'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.email_mark_result(uuid,boolean,text,text)')) is distinct from '5d34c6af5d4934e23f6508a4a56a562c' then
    raise exception 'wp8_cleanup_requires_functional_rollback_first';
  end if;
  if exists (select 1 from public.email_provider_config where id = 1 and (service_enabled or public_go_live)) then
    raise exception 'wp8_cleanup_requires_flags_off';
  end if;
end
$wp8_cleanup_pre$;

drop function if exists public.email_dispatch_kick();
drop function if exists public.welcome_enqueue_sweep(int);
drop function if exists public.welcome_render(uuid, text);
drop function if exists public._wp8_greeting_name(text);
drop function if exists public._wp8_html_escape(text);
drop function if exists public._wp8_auth_otp_load();
drop function if exists public.email_release_claim(uuid, int, boolean);
drop function if exists public.email_reconcile_orphan_events(int);
drop function if exists public._email_link_orphans_for(uuid, text);
drop function if exists public.admin_w_welcome_automation_set(uuid, boolean, text, text);
drop function if exists public.admin_w_email_public_go_live_set(uuid, boolean, text, text);
drop trigger if exists email_provider_config_golive_guard on public.email_provider_config;
drop function if exists public._email_provider_config_golive_guard();

-- HARD section (owner only; irreversible; uncomment deliberately; run before any CDP3D down):
-- drop table if exists public.email_send_event_links;
-- drop table if exists public.email_wp8_run_ledger;
-- drop table if exists public.email_wp8_manifest;
-- alter table public.email_outbox drop column if exists service_template_id;
-- drop table if exists public.email_service_policy;
-- drop function if exists public._email_service_policy_guard();
-- drop table if exists public.email_service_templates;
-- drop index if exists public.email_outbox_welcome_once_uk;
-- drop index if exists public.email_outbox_sent_at_idx;
-- alter table public.email_outbox drop column if exists rate_limit_releases;
-- alter table public.email_outbox drop column if exists first_attempt_at;

do $wp8_cleanup_post$
begin
  if to_regprocedure('public.welcome_enqueue_sweep(int)') is not null or to_regprocedure('public.email_release_claim(uuid,int,boolean)') is not null
     or exists (select 1 from pg_trigger where tgname = 'email_provider_config_golive_guard') then
    raise exception 'WP8_CLEANUP_FAIL:objects_left';
  end if;
  raise notice 'WP8_CLEANUP_OK';
end
$wp8_cleanup_post$;

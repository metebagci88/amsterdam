-- WP8 scheduler OPT-IN (pg_cron + pg_net). NOT part of the inert migration. Owner-approved, ONE transaction.
-- Requires: WP8_DB_up.sql applied; ops/WP8_OPS_extensions_enable.sql applied (or the extensions enabled in the
-- Dashboard); Edge service-email-dispatch v4 deployed; the Edge secret DISPATCH_TRIGGER_TOKEN and the three
-- Vault secrets wp8_dispatch_url, wp8_dispatch_gateway_jwt, wp8_dispatch_token created by the owner in the
-- Dashboard (names only here; values never in files, chat or logs).
-- Arm: replace the placeholder below with YES in the approved copy. An unreplaced placeholder refuses.
-- Still inert after this file: the sweep reports auto_disabled and the kick reports classes_disabled
-- until the owner setup step runs. Undo: ops/WP8_OPS_scheduler_unschedule.sql.
select set_config('wp8.allow_scheduler', '@@ARM_YES@@', true);

do $wp8_sched_pre$
begin
  if current_setting('wp8.allow_scheduler', true) is distinct from 'YES' then
    raise exception 'wp8_scheduler_refused_without_explicit_arm';
  end if;
  if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null or to_regclass('cron.job') is null then
    raise exception 'wp8_scheduler_requires_pg_cron';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'wp8_scheduler_requires_pg_net';
  end if;
  if to_regprocedure('public.welcome_enqueue_sweep(int)') is null or to_regprocedure('public.email_release_claim(uuid,int,boolean)') is null
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.email_claim_batch(int)'))
        is distinct from (select body_md5 from public.email_wp8_manifest where object_kind = 'function' and signature = 'public.email_claim_batch(int)') then
    raise exception 'wp8_scheduler_requires_wp8_migration';
  end if;
  if (select count(*) from vault.decrypted_secrets where name in ('wp8_dispatch_url', 'wp8_dispatch_gateway_jwt', 'wp8_dispatch_token')) <> 3 then
    raise exception 'wp8_scheduler_requires_vault_secrets';
  end if;
end
$wp8_sched_pre$;

create or replace function public.email_dispatch_kick() returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_url text; v_jwt text; v_tok text; v_due int; v_req bigint;
begin
  if not exists (select 1 from public.email_provider_config where id = 1 and (service_enabled or essential_enabled)) then
    return jsonb_build_object('ok', true, 'kicked', false, 'reason', 'classes_disabled');
  end if;
  select count(*) into v_due from public.email_outbox o
   where (o.status = 'queued' and o.next_attempt_at <= now() and o.attempts < o.max_attempts)
      or (o.status = 'sending' and o.lease_expires_at < now());
  if v_due = 0 then
    return jsonb_build_object('ok', true, 'kicked', false, 'reason', 'nothing_due');
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'wp8_dispatch_url';
  select decrypted_secret into v_jwt from vault.decrypted_secrets where name = 'wp8_dispatch_gateway_jwt';
  select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'wp8_dispatch_token';
  if v_url is null or v_jwt is null or v_tok is null or char_length(v_tok) < 32
     or v_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/service-email-dispatch$' then
    return jsonb_build_object('ok', false, 'kicked', false, 'reason', 'secret_missing_or_invalid');
  end if;
  select net.http_post(
           url := v_url,
           body := jsonb_build_object('limit', 10),
           params := '{}'::jsonb,
           headers := jsonb_build_object('content-type', 'application/json', 'authorization', 'Bearer ' || v_jwt,
                                         'x-asalocal-dispatch-token', v_tok),
           timeout_milliseconds := 30000) into v_req;
  return jsonb_build_object('ok', true, 'kicked', true, 'due', v_due);
end
$fn$;
revoke all on function public.email_dispatch_kick() from public, anon, authenticated, service_role;
comment on function public.email_dispatch_kick() is 'WP8 scheduler: POSTs to the dispatch Edge (pg_net) only when a class is enabled and a row is due. Secrets read by name from Vault.';

select cron.schedule('wp8-welcome-sweep', '*/5 * * * *', $$select public.welcome_enqueue_sweep()$$);
select cron.schedule('wp8-email-dispatch-kick', '2-59/5 * * * *', $$select public.email_dispatch_kick()$$);
select cron.schedule('wp8-email-purge', '17 3 * * *', $$select public.email_purge_expired_content()$$);

do $wp8_sched_post$
begin
  if not (has_function_privilege(current_user, 'public.welcome_enqueue_sweep(int)', 'execute')
          and has_function_privilege(current_user, 'public.email_dispatch_kick()', 'execute')
          and has_function_privilege(current_user, 'public.email_purge_expired_content()', 'execute')) then
    raise exception 'wp8_scheduler_role_cannot_execute_jobs';
  end if;
  if (select count(*) from cron.job where jobname in ('wp8-welcome-sweep', 'wp8-email-dispatch-kick', 'wp8-email-purge') and username = current_user) <> 3 then
    raise exception 'wp8_scheduler_jobs_not_owned_by_current_user';
  end if;
  if (select count(*) from cron.job where jobname like 'wp8-%') <> 3 then
    raise exception 'wp8_scheduler_unexpected_job_count';
  end if;
  if has_function_privilege('anon', 'public.email_dispatch_kick()', 'execute') or has_function_privilege('authenticated', 'public.email_dispatch_kick()', 'execute')
     or has_function_privilege('service_role', 'public.email_dispatch_kick()', 'execute') then
    raise exception 'wp8_scheduler_kick_acl';
  end if;
  raise notice 'WP8_SCHEDULER_OK';
end
$wp8_sched_post$;

-- WP8 FUNCTIONAL rollback (nothing is removed; this file is free of destructive statements). Owner-approved, ONE transaction.
-- Mandatory order: ops/WP8_OPS_kill_switch_soft.sql and ops/WP8_OPS_kill_switch_hard.sql,
-- then redeploy Edge service-email-dispatch v3 (WP8_package/rollback/edge-service-email-dispatch-v3/index.ts,
-- sha256 1279d9aa52a8f8cee40d56389baf0e58f1101369ced0188f949d176536a10537), then this file,
-- then (optional, separate approval) WP8_DB_rollback_cleanup_optional.sql.
-- Effect: service_enabled=false and public_go_live=false (sending cannot re-open), automation off and paused,
-- queued wp8 welcomes canceled, wp8 cron jobs unscheduled, email_claim_batch and email_mark_result restored to
-- the exact live CDP-3D bodies (md5 08fc00397182c86929bcb9afa6a6a995 / 5d34c6af5d4934e23f6508a4a56a562c),
-- go-live guard trigger disabled (pre-WP8 behaviour). Data and evidence rows are kept.
-- Refuses while a wp8 row is still being sent under an active lease (wait 2 minutes, re-run).
select set_config('wp8.rollback_txn', 'YES', true);

do $wp8_rb_pre$
begin
  if coalesce(current_setting('wp8.rollback_txn', true), '') <> 'YES' then
    raise exception 'WP8_NOT_SINGLE_TRANSACTION';
  end if;
  if to_regclass('public.email_service_policy') is null then
    raise exception 'WP8_ROLLBACK_FAIL:wp8_not_installed';
  end if;
  if exists (select 1 from public.email_outbox where status = 'sending' and idempotency_key like 'wp8:%'
              and lease_expires_at is not null and lease_expires_at >= now()) then
    raise exception 'wp8_rollback_inflight_wait_for_lease';
  end if;
end
$wp8_rb_pre$;

update public.email_provider_config set service_enabled = false, public_go_live = false, updated_at = now() where id = 1;
update public.email_service_policy set welcome_auto_enqueue_enabled = false, service_dispatch_paused = true where id = 1;
update public.email_outbox
   set status = 'canceled', last_error = 'wp8_rollback', claimed_at = null, lease_expires_at = null, updated_at = now()
 where idempotency_key like 'wp8:welcome_service_email:v1:%'
   and (status = 'queued' or (status = 'sending' and lease_expires_at < now()));

do $wp8_rb_cron$
begin
  if to_regclass('cron.job') is not null then
    execute $q$select count(cron.unschedule(jobid)) from cron.job where jobname in ('wp8-welcome-sweep', 'wp8-email-dispatch-kick', 'wp8-email-purge')$q$;
  end if;
end
$wp8_rb_cron$;

create or replace function public.email_claim_batch(p_limit int default 10)
returns table(outbox_id uuid, message_class public.email_message_class, service_pref_key public.service_pref_key,
  subject text, body_html text, body_text text, recipient_email text, from_email text, from_name text, reply_to text)
language plpgsql security definer set search_path=public, extensions, vault as $fn$
declare r record; v_dec jsonb; v_email text; v_blocked boolean; v_cfg public.email_provider_config%rowtype;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then p_limit := 10; end if;
  select * into v_cfg from public.email_provider_config where id=1;

  update public.email_outbox
     set status='queued', next_attempt_at=now(), claimed_at=null, lease_expires_at=null, updated_at=now()
   where status='sending' and lease_expires_at is not null and lease_expires_at < now();

  for r in
    select * from public.email_outbox
     where status='queued' and next_attempt_at <= now()
     order by created_at for update skip locked limit p_limit
  loop
    v_dec := public._email_send_decision(r.user_id, r.message_class, r.service_pref_key);
    if not (v_dec->>'allow')::boolean then
      update public.email_outbox set status='skipped', skip_reason=(v_dec->>'skip_reason')::public.email_skip_reason, updated_at=now() where id=r.id;
      continue;
    end if;
    select email, coalesce(blocked,false) into v_email, v_blocked from public.members where user_id=r.user_id;
    if v_email is null or v_blocked then
      update public.email_outbox set status='skipped', skip_reason=case when v_email is null then 'recipient_missing_email' else 'recipient_blocked' end, updated_at=now() where id=r.id;
      continue;
    end if;
    update public.email_outbox
       set status='sending', attempts=attempts+1, claimed_at=now(),
           lease_expires_at=now() + make_interval(secs => coalesce(v_cfg.lease_seconds,120)), updated_at=now()
     where id=r.id;
    outbox_id := r.id; message_class := r.message_class; service_pref_key := r.service_pref_key;
    subject := r.subject; body_html := r.body_html; body_text := r.body_text; recipient_email := v_email;
    from_email := v_cfg.from_email; from_name := v_cfg.from_name; reply_to := v_cfg.reply_to;
    return next;
  end loop;
end $fn$;
create or replace function public.email_mark_result(p_outbox_id uuid, p_ok boolean, p_provider_message_id text, p_error text)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v public.email_outbox%rowtype; v_backoff interval;
begin
  select * into v from public.email_outbox where id=p_outbox_id;
  if not found then raise exception 'outbox_not_found'; end if;
  if v.status <> 'sending' then
    return jsonb_build_object('ok',true,'ignored',true,'status',v.status);
  end if;
  if p_ok then
    update public.email_outbox set status='sent', provider_message_id=nullif(btrim(p_provider_message_id),''),
           sent_at=now(), last_error=null, lease_expires_at=null, updated_at=now() where id=p_outbox_id;
    return jsonb_build_object('ok',true,'status','sent');
  else
    if v.attempts >= v.max_attempts then
      update public.email_outbox set status='failed', failed_at=now(), last_error=left(coalesce(p_error,''),300), lease_expires_at=null, updated_at=now() where id=p_outbox_id;
      return jsonb_build_object('ok',true,'status','failed');
    else
      v_backoff := (power(2, greatest(v.attempts,1)) * interval '1 minute');
      update public.email_outbox set status='queued', next_attempt_at=now()+v_backoff, last_error=left(coalesce(p_error,''),300),
             claimed_at=null, lease_expires_at=null, updated_at=now() where id=p_outbox_id;
      return jsonb_build_object('ok',true,'status','requeued','next_attempt_at',now()+v_backoff);
    end if;
  end if;
end $fn$;
revoke all on function public.email_claim_batch(int) from public, anon, authenticated;
grant execute on function public.email_claim_batch(int) to service_role;
revoke all on function public.email_mark_result(uuid,boolean,text,text) from public, anon, authenticated;
grant execute on function public.email_mark_result(uuid,boolean,text,text) to service_role;
alter table public.email_provider_config disable trigger email_provider_config_golive_guard;

do $wp8_rb_post$
begin
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.email_claim_batch(int)')) is distinct from '08fc00397182c86929bcb9afa6a6a995' then
    raise exception 'WP8_ROLLBACK_FAIL:claim_md5';
  end if;
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.email_mark_result(uuid,boolean,text,text)')) is distinct from '5d34c6af5d4934e23f6508a4a56a562c' then
    raise exception 'WP8_ROLLBACK_FAIL:mark_md5';
  end if;
  if exists (select 1 from public.email_provider_config where id = 1 and (service_enabled or public_go_live)) then
    raise exception 'WP8_ROLLBACK_FAIL:flags';
  end if;
  if exists (select 1 from public.email_outbox where status = 'queued' and idempotency_key like 'wp8:%') then
    raise exception 'WP8_ROLLBACK_FAIL:queued_wp8_rows';
  end if;
  if exists (select 1 from pg_trigger where tgname = 'email_provider_config_golive_guard' and tgenabled <> 'D') then
    raise exception 'WP8_ROLLBACK_FAIL:golive_guard_still_enabled';
  end if;
  raise notice 'WP8_ROLLBACK_OK';
end
$wp8_rb_post$;

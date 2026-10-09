-- WP8 kill switch, HARD. Off-only, no arm needed. Run after the soft step.
-- 1) service_enabled=false and public_go_live=false, 2) automation off and paused,
-- 3) cancels every queued wp8 welcome (last_error wp8_kill_switch) so nothing is sent later and
--    the purge can clear the bodies, 4) unschedules the wp8 cron jobs (if pg_cron is installed).
-- Row-lock order is provider config, then policy, then outbox: the same order the sweep uses
-- (config FOR SHARE, policy FOR SHARE, then outbox rows), so the two cannot deadlock.
-- A wp8 row whose lease already expired is canceled too. A row still 'sending' under an active
-- lease finishes within the 120 s lease (sent, or requeued by the Edge); the notice reports
-- still_sending, and the file is re-run after 2 minutes until it is 0. Provider level (owner, Dashboard):
-- remove RESEND_API_KEY or DISPATCH_TRIGGER_TOKEN from the Edge secrets (503/403).
-- Does not touch Auth SMTP, OTP or marketing.
update public.email_provider_config set service_enabled = false, public_go_live = false, updated_at = now() where id = 1;
update public.email_service_policy set welcome_auto_enqueue_enabled = false, service_dispatch_paused = true where id = 1;
update public.email_outbox
   set status = 'canceled', last_error = 'wp8_kill_switch', updated_at = now()
 where idempotency_key like 'wp8:welcome_service_email:v1:%'
   and (status = 'queued' or (status = 'sending' and lease_expires_at is not null and lease_expires_at < now()));
do $wp8_kill_hard$
declare n int := 0; v_sending int;
begin
  if to_regclass('cron.job') is not null then
    execute $q$select count(cron.unschedule(jobid)) from cron.job where jobname in ('wp8-welcome-sweep', 'wp8-email-dispatch-kick', 'wp8-email-purge')$q$ into n;
  end if;
  if exists (select 1 from public.email_outbox where status = 'queued' and idempotency_key like 'wp8:%')
     or exists (select 1 from public.email_provider_config where id = 1 and (service_enabled or public_go_live))
     or not exists (select 1 from public.email_service_policy where id = 1 and not welcome_auto_enqueue_enabled and service_dispatch_paused) then
    raise exception 'WP8_KILL_HARD_FAIL';
  end if;
  select count(*) into v_sending from public.email_outbox where status = 'sending' and idempotency_key like 'wp8:%';
  raise notice 'WP8_KILL_HARD_OK unscheduled=% still_sending=% (when still_sending > 0, re-run this file after 2 minutes)', n, v_sending;
end
$wp8_kill_hard$;

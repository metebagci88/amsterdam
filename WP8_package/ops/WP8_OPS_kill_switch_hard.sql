-- WP8 kill switch, HARD. Off-only, no arm needed. Run after the soft step.
-- 1) cancels every queued wp8 welcome (last_error wp8_kill_switch) so nothing is sent later and
--    the purge can clear the bodies, 2) service_enabled=false and public_go_live=false,
-- 3) automation off and paused, 4) unschedules the wp8 cron jobs (if pg_cron is installed).
-- Rows still 'sending' finish or expire within the 120 s lease. Provider level (owner, Dashboard):
-- remove RESEND_API_KEY or DISPATCH_TRIGGER_TOKEN from the Edge secrets (503/403).
-- Does not touch Auth SMTP, OTP or marketing.
update public.email_outbox
   set status = 'canceled', last_error = 'wp8_kill_switch', updated_at = now()
 where status = 'queued' and idempotency_key like 'wp8:welcome_service_email:v1:%';
update public.email_provider_config set service_enabled = false, public_go_live = false, updated_at = now() where id = 1;
update public.email_service_policy set welcome_auto_enqueue_enabled = false, service_dispatch_paused = true where id = 1;
do $wp8_kill_hard$
declare n int := 0;
begin
  if to_regclass('cron.job') is not null then
    execute $q$select count(cron.unschedule(jobid)) from cron.job where jobname in ('wp8-welcome-sweep', 'wp8-email-dispatch-kick', 'wp8-email-purge')$q$ into n;
  end if;
  if exists (select 1 from public.email_outbox where status = 'queued' and idempotency_key like 'wp8:%')
     or exists (select 1 from public.email_provider_config where id = 1 and (service_enabled or public_go_live)) then
    raise exception 'WP8_KILL_HARD_FAIL';
  end if;
  raise notice 'WP8_KILL_HARD_OK unscheduled=%', n;
end
$wp8_kill_hard$;

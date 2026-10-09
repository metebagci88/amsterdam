-- WP8 kill switch, SOFT (default first step). Off-only, no arm needed, safe to run any time.
-- Stops new welcome enqueues and all optional_service claims. Queued welcomes stay queued with
-- attempts unchanged; the claim cancels any wp8 welcome older than welcome_queue_expiry_hours (72 h)
-- before it checks pause, caps or flags, so a later re-enable never sends a stale welcome.
-- Does not touch Auth SMTP, OTP or marketing.
update public.email_service_policy set welcome_auto_enqueue_enabled = false, service_dispatch_paused = true where id = 1;
do $wp8_kill_soft$
begin
  if not exists (select 1 from public.email_service_policy where id = 1 and not welcome_auto_enqueue_enabled and service_dispatch_paused) then
    raise exception 'WP8_KILL_SOFT_FAIL';
  end if;
  raise notice 'WP8_KILL_SOFT_OK';
end
$wp8_kill_soft$;

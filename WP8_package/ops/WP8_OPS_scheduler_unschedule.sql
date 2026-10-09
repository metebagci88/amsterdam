-- WP8: unschedule the three wp8 pg_cron jobs (kill switch / rollback). Off-only, no arm needed.
-- Nothing is removed except the job rows; the kick function stays (it only runs when scheduled).
do $wp8_unschedule$
declare n int := 0;
begin
  if to_regclass('cron.job') is null then
    raise notice 'WP8_UNSCHEDULE_OK no_cron';
    return;
  end if;
  execute $q$select count(cron.unschedule(jobid)) from cron.job where jobname in ('wp8-welcome-sweep', 'wp8-email-dispatch-kick', 'wp8-email-purge')$q$ into n;
  execute $q$select count(*) from cron.job where jobname like 'wp8-%'$q$ into n;
  if n <> 0 then raise exception 'WP8_UNSCHEDULE_FAIL:jobs_left:%', n; end if;
  raise notice 'WP8_UNSCHEDULE_OK';
end
$wp8_unschedule$;

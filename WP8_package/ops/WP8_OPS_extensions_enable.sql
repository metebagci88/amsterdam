-- WP8: enable pg_cron and pg_net (Supabase free plan includes both). Owner-approved, separate from the
-- inert migration. Equivalent: Dashboard -> Database -> Extensions -> pg_cron, pg_net.
-- Arm: replace the placeholder with YES in the approved copy. Creates no job and sends nothing.
select set_config('wp8.allow_extensions', '@@ARM_YES@@', true);
do $wp8_ext_pre$
begin
  if current_setting('wp8.allow_extensions', true) is distinct from 'YES' then
    raise exception 'wp8_extensions_refused_without_explicit_arm';
  end if;
end
$wp8_ext_pre$;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $wp8_ext_post$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'WP8_EXTENSIONS_FAIL';
  end if;
  raise notice 'WP8_EXTENSIONS_OK';
end
$wp8_ext_post$;

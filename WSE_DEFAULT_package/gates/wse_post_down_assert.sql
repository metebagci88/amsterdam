-- CI/ephemeral ONLY. Commit edilmiş WSE_down_soft.sql sonrası.
-- Dört legacy kullanıcı durur. Policy null. Trigger yok. Read-path not_configured.
do $$
declare
  r jsonb;
begin
  if (select count(*) from auth.users) <> 4 then raise exception 'post auth'; end if;
  if (select count(*) from public.members) <> 4 then raise exception 'post members'; end if;
  if (select count(*) from public.member_service_pref_current) <> 2 then raise exception 'post current'; end if;
  if (select count(*) from public.member_service_pref_events) <> 2 then raise exception 'post events'; end if;
  if exists (
    select 1 from pg_trigger
     where tgname='trg_members_seed_welcome_service_pref' and not tgisinternal
  ) then raise exception 'post trigger remains'; end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='service_pref_defaults'
       and column_name='effective_from'
  ) then raise exception 'post column dropped'; end if;
  if exists (
    select 1 from public.service_pref_defaults
     where default_enabled is not null or effective_from is not null or policy_version is not null
  ) then raise exception 'post policy not clear'; end if;
  if (select count(*) from public.email_outbox) <> 0 then raise exception 'post outbox'; end if;
  if (select count(*) from public.email_send_allowlist) <> 0 then raise exception 'post allowlist'; end if;
  if exists (
    select 1 from public.email_provider_config
     where essential_enabled or service_enabled or public_go_live
  ) then raise exception 'post provider flags'; end if;
  if exists (
    select 1 from public.marketing_config where marketing_enabled or marketing_capture_enabled
  ) then raise exception 'post marketing'; end if;

  perform set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
  r := public.consent_get_my_state();
  if (r->'service_prefs'->>'welcome_service_email') <> 'not_configured' then
    raise exception 'post ui %', r;
  end if;
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
  r := public.consent_get_my_state();
  if (r->'service_prefs'->>'welcome_service_email') <> 'true' then
    raise exception 'post L1 %', r;
  end if;
end $$;

begin;
update public.service_pref_defaults
   set default_enabled = true,
       effective_from = clock_timestamp() - interval '1 day',
       policy_version = 'welcome_service_email.v1',
       configured_at = clock_timestamp(),
       configured_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 where pref_key = 'welcome_service_email';
insert into auth.users(id, email, created_at)
values ('17171717-1717-4717-8717-171717171717', 'post-secret@example.test', clock_timestamp());
insert into public.members(user_id, email)
values ('17171717-1717-4717-8717-171717171717', 'post-secret@example.test');
do $$
begin
  if exists (
    select 1 from public.member_service_pref_current
     where user_id='17171717-1717-4717-8717-171717171717'
  ) then raise exception 'post-down probe seeded'; end if;
end $$;
rollback;

do $$
begin
  if (select count(*) from public.members) <> 4 then raise exception 'post probe leaked'; end if;
  if exists (
    select 1 from public.service_pref_defaults where default_enabled is not null
  ) then raise exception 'post probe left policy on'; end if;
end $$;

select 'WSE_DOWN_PASS' as sentinel;

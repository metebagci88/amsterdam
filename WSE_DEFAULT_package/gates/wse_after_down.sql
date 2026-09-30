-- CI/ephemeral ONLY. wse_behavior.sql + WSE_down_soft.sql aynı transaction'da çalıştıktan sonra.
do $$
declare
  v_cur int;
  v_ev int;
  n1 uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  f1 uuid := '13131313-1313-4313-8313-131313131313';
  l1 uuid := '11111111-1111-4111-8111-111111111111';
  l3 uuid := '33333333-3333-4333-8333-333333333333';
  g1 uuid := '16161616-1616-4616-8616-161616161616';
begin
  select cur, ev into v_cur, v_ev from wse_hist_counts;
  if (select count(*) from public.member_service_pref_current) <> v_cur
     or (select count(*) from public.member_service_pref_events) <> v_ev then
    raise exception 'T13 history deleted';
  end if;
  if to_regclass('public.service_pref_defaults') is null then raise exception 'T13 dropped table'; end if;
  if exists (
    select 1 from pg_trigger
     where tgname='trg_members_seed_welcome_service_pref' and not tgisinternal
  ) then raise exception 'T13 trigger still present'; end if;
  if to_regprocedure('public._seed_welcome_service_pref_on_member_insert()') is not null then
    raise exception 'T13 seed function still present';
  end if;
  if to_regprocedure('public.admin_w_activate_welcome_service_email_default(uuid,text,text,uuid)') is not null then
    raise exception 'T13 activation function still present';
  end if;
  if exists (
    select 1 from public.service_pref_defaults
     where pref_key='welcome_service_email'
       and (default_enabled is not null or effective_from is not null or policy_version is not null)
  ) then raise exception 'T13 policy still set'; end if;

  -- Geçmiş duruyor.
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id=n1 and enabled is true
  ) then raise exception 'T13 seeded history gone'; end if;
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id=f1 and enabled is false
  ) then raise exception 'T13 off history gone'; end if;
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id=l1 and enabled is true
  ) then raise exception 'T13 L1 gone'; end if;

  -- Trigger yokken policy tekrar yazılsa da yeni INSERT seed etmez.
  update public.service_pref_defaults
     set default_enabled = true,
         effective_from = clock_timestamp() - interval '1 day',
         policy_version = 'welcome_service_email.v1',
         configured_at = clock_timestamp(),
         configured_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
   where pref_key = 'welcome_service_email';
  insert into auth.users(id, email, created_at)
  values (g1, 'after-down-secret@example.test', clock_timestamp());
  insert into public.members(user_id, email)
  values (g1, 'after-down-secret@example.test');
  if exists (select 1 from public.member_service_pref_current where user_id=g1) then
    raise exception 'T13 seeded after rollback';
  end if;

  -- Read-path düzeltmesi durur: missing hâlâ not_configured.
  perform set_config('request.jwt.claims', json_build_object('sub', l3)::text, true);
  if (select public.consent_get_my_state()->'service_prefs'->>'welcome_service_email') <> 'not_configured' then
    raise exception 'T13 ui fallback returned';
  end if;
end $$;

select 'WSE_AFTER_DOWN_PASS' as sentinel;

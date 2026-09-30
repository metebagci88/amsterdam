-- CI/ephemeral ONLY. WSE_up.sql iki kez uygulandıktan sonra. Aktivasyon YOK.
do $$
declare
  r jsonb;
  d jsonb;
  n int;
  tg int;
begin
  if (select count(*) from auth.users) <> 4 then raise exception 'T9 auth count'; end if;
  if (select count(*) from public.members) <> 4 then raise exception 'T9 members count'; end if;
  if (select count(*) from public.member_service_pref_current) <> 2 then raise exception 'T9 current count'; end if;
  if (select count(*) from public.member_service_pref_events) <> 2 then raise exception 'T9 event count'; end if;
  if (select count(*) from public.member_consent_current) <> 0 then raise exception 'T11 consent current'; end if;
  if (select count(*) from public.member_consent_events) <> 0 then raise exception 'T11 consent events'; end if;
  if (select count(*) from public.email_outbox) <> 0 then raise exception 'T10 outbox'; end if;
  if (select count(*) from public.email_send_allowlist) <> 0 then raise exception 'T10 allowlist'; end if;
  if exists (
    select 1 from public.email_provider_config
     where id=1 and (essential_enabled or service_enabled or public_go_live)
  ) then raise exception 'T10 provider flags moved'; end if;
  if exists (
    select 1 from public.marketing_config
     where id=1 and (marketing_enabled or marketing_capture_enabled)
  ) then raise exception 'T11 marketing flags'; end if;

  if exists (
    select 1 from public.service_pref_defaults
     where default_enabled is not null
        or effective_from is not null
        or policy_version is not null
        or configured_at is not null
        or configured_by is not null
  ) then raise exception 'T9 policy not inert'; end if;
  if (select count(*) from public.service_pref_defaults) <> 7 then raise exception 'T9 key count'; end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='service_pref_defaults'
       and column_name in ('effective_from','policy_version','configured_at','configured_by')
     having count(*)=4
  ) then raise exception 'A columns missing'; end if;

  select count(*) into n from pg_trigger
   where tgname='trg_members_seed_welcome_service_pref'
     and tgrelid='public.members'::regclass
     and not tgisinternal;
  if n <> 1 then raise exception 'trigger count %', n; end if;
  select tgtype into tg from pg_trigger
   where tgname='trg_members_seed_welcome_service_pref'
     and tgrelid='public.members'::regclass
     and not tgisinternal;
  -- INSERT bit 4, UPDATE bit 16, BEFORE bit 2. AFTER INSERT FOR EACH ROW = 5.
  if (tg & 4) = 0 or (tg & 16) <> 0 or (tg & 2) <> 0 then
    raise exception 'trigger is not AFTER INSERT (tgtype=%)', tg;
  end if;

  if position('service_pref_defaults' in pg_get_functiondef('public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)'::regprocedure)) > 0 then
    raise exception 'D send decision references defaults';
  end if;
  if position('not_configured' in pg_get_functiondef('public.consent_get_my_state()'::regprocedure)) = 0 then
    raise exception 'C not_configured missing';
  end if;
  if position('default_enabled' in pg_get_functiondef('public.consent_get_my_state()'::regprocedure)) > 0 then
    raise exception 'C still reads default_enabled';
  end if;
  if position('new.email' in pg_get_functiondef('public._seed_welcome_service_pref_on_member_insert()'::regprocedure)) > 0
     or position('email_enqueue' in pg_get_functiondef('public._seed_welcome_service_pref_on_member_insert()'::regprocedure)) > 0 then
    raise exception 'seed function leaks email or enqueues';
  end if;

  -- L1 gerçek satır boolean true, L3 missing = not_configured (config_pending değil).
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
  r := public.consent_get_my_state();
  if jsonb_typeof(r->'service_prefs'->'welcome_service_email') <> 'boolean' then raise exception 'T1 L1 type %', r; end if;
  if (r->'service_prefs'->>'welcome_service_email') <> 'true' then raise exception 'T1 L1 value'; end if;

  perform set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
  r := public.consent_get_my_state();
  if (r->'service_prefs'->>'welcome_service_email') <> 'not_configured' then raise exception 'T1 L3 %', r; end if;
  if (r->'service_prefs'->>'plan_reminder') <> 'not_configured' then raise exception 'T1 other key %', r; end if;

  -- Başka bir key hem default hem effective_from alamaz.
  begin
    update public.service_pref_defaults
       set default_enabled = true,
           effective_from = clock_timestamp()
     where pref_key = 'plan_reminder';
    raise exception 'welcome-only constraint missing';
  exception
    when check_violation then null;
  end;

  -- default bayrağı tek başına (effective_from yok) UI'ı ON yapmaz, seed yapmaz, gönderimi açmaz.
  begin
    update public.email_provider_config
       set service_enabled = true, public_go_live = true
     where id = 1;
    update public.service_pref_defaults
       set default_enabled = true
     where pref_key = 'welcome_service_email';

    perform set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
    r := public.consent_get_my_state();
    if (r->'service_prefs'->>'welcome_service_email') <> 'not_configured' then
      raise exception 'T1 fallback still on %', r;
    end if;
    d := public._email_send_decision(
      '33333333-3333-4333-8333-333333333333', 'optional_service', 'welcome_service_email');
    if d->>'allow' <> 'false' or d->>'skip_reason' <> 'service_pref_missing' then
      raise exception 'T1 send %', d;
    end if;
    if d::text like '%@%' then raise exception 'T1 decision leaked email'; end if;

    insert into auth.users(id, email, created_at)
    values ('99999999-9999-4999-8999-999999999999', 'probe-secret@example.test', clock_timestamp());
    insert into public.members(user_id, email)
    values ('99999999-9999-4999-8999-999999999999', 'probe-secret@example.test');
    if exists (
      select 1 from public.member_service_pref_current
       where user_id = '99999999-9999-4999-8999-999999999999'
    ) then raise exception 'T8 seeded while inert'; end if;
    if (select count(*) from public.email_outbox) <> 0 then raise exception 'T8 outbox'; end if;

    raise exception 'rollback_probe';
  exception
    when others then
      if sqlerrm <> 'rollback_probe' then raise; end if;
  end;

  if (select count(*) from public.members) <> 4 then raise exception 'probe leaked member'; end if;
  if exists (select 1 from public.service_pref_defaults where default_enabled is not null) then
    raise exception 'probe leaked default';
  end if;
  if exists (
    select 1 from public.email_provider_config
     where id=1 and (essential_enabled or service_enabled or public_go_live)
  ) then raise exception 'probe leaked flags'; end if;

  -- L1/L2 satırları birebir duruyor.
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id='11111111-1111-4111-8111-111111111111'
       and pref_key='welcome_service_email' and enabled is true
       and last_event_id='aaaaaaaa-1111-4111-8111-111111111111'
  ) then raise exception 'L1 row changed'; end if;
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id='22222222-2222-4222-8222-222222222222'
       and pref_key='welcome_service_email' and enabled is false
  ) then raise exception 'L2 row changed'; end if;
  if exists (
    select 1 from public.member_service_pref_current
     where user_id in (
       '33333333-3333-4333-8333-333333333333',
       '44444444-4444-4444-8444-444444444444')
  ) then raise exception 'L3/L4 gained a row'; end if;
end $$;

select 'WSE_INERT_PASS' as sentinel;

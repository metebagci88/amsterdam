-- CI/ephemeral ONLY. Aynı transaction'da arm + WSE_ACTIVATE.sql çalışmış olmalı.
-- Bittiğinde policy hâlâ aktif; history sayaçları temp tabloya yazılır.
do $$
declare
  r jsonb;
  d jsonb;
  v_from timestamptz;
  n int;
  l1 uuid := '11111111-1111-4111-8111-111111111111';
  l2 uuid := '22222222-2222-4222-8222-222222222222';
  l3 uuid := '33333333-3333-4333-8333-333333333333';
  l4 uuid := '44444444-4444-4444-8444-444444444444';
  n1 uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  o1 uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  p1 uuid := '12121212-1212-4212-8212-121212121212';
  f1 uuid := '13131313-1313-4313-8313-131313131313';
  b0 uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  actor uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  idem uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
begin
  if not exists (
    select 1 from public.service_pref_defaults
     where pref_key='welcome_service_email'
       and default_enabled is true
       and policy_version='welcome_service_email.v1'
       and effective_from is not null
       and configured_at is not null
       and configured_by=actor
  ) then raise exception 'activation row missing'; end if;

  -- Aktivasyon mevcut dört kullanıcıya satır eklemedi.
  if (select count(*) from public.member_service_pref_current) <> 2 then raise exception 'T9 backfill current'; end if;
  if (select count(*) from public.member_service_pref_events) <> 2 then raise exception 'T9 backfill events'; end if;
  if (select count(*) from public.member_consent_current) <> 0 then raise exception 'T11 consent'; end if;
  if (select count(*) from public.member_consent_events) <> 0 then raise exception 'T11 consent events'; end if;
  if (select count(*) from public.email_outbox) <> 0 then raise exception 'T10 outbox after activation'; end if;
  if (select count(*) from public.email_send_allowlist) <> 0 then raise exception 'T10 allowlist'; end if;
  if exists (
    select 1 from public.email_provider_config
     where id=1 and (essential_enabled or service_enabled or public_go_live)
  ) then raise exception 'T10 flags flipped by activation'; end if;
  if exists (
    select 1 from public.marketing_config where id=1 and (marketing_enabled or marketing_capture_enabled)
  ) then raise exception 'T11 marketing'; end if;
  if (select count(*) from public.admin_write_log where action='activate_welcome_service_email_default') <> 1 then
    raise exception 'activation audit count';
  end if;
  if exists (
    select 1 from public.admin_write_log
     where coalesce(reason,'') like '%@%'
        or coalesce(before::text,'') like '%@%'
        or coalesce(after::text,'') like '%@%'
        or coalesce(request_id,'') like '%@%'
        or coalesce(target_id,'') like '%@%'
  ) then raise exception 'email in admin_write_log'; end if;

  select effective_from into v_from
    from public.service_pref_defaults where pref_key='welcome_service_email';

  -- T1: eski missing kullanıcı, default artık true olsa da UI not_configured ve send missing.
  perform set_config('request.jwt.claims', json_build_object('sub', l3)::text, true);
  r := public.consent_get_my_state();
  if (r->'service_prefs'->>'welcome_service_email') <> 'not_configured' then
    raise exception 'T1 ui %', r;
  end if;
  begin
    update public.email_provider_config
       set service_enabled=true, public_go_live=true
     where id=1;
    d := public._email_send_decision(l3, 'optional_service', 'welcome_service_email');
    if d->>'skip_reason' <> 'service_pref_missing' or d->>'allow' <> 'false' then
      raise exception 'T1 send %', d;
    end if;
    if d::text like '%@%' then raise exception 'T1 email leak'; end if;
    raise exception 'rollback_probe';
  exception
    when others then
      if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  if exists (
    select 1 from public.email_provider_config
     where id=1 and (service_enabled or public_go_live)
  ) then raise exception 'T1 flag probe leaked'; end if;

  -- Replay aynı idem: tek audit.
  r := public.admin_w_activate_welcome_service_email_default(
    actor, 'ephemeral welcome v1 activation', 'wse-act-ephemeral', idem);
  if r->>'policy_version' <> 'welcome_service_email.v1' then raise exception 'replay payload'; end if;
  if (select count(*) from public.admin_write_log where idempotency_key=idem) <> 1 then
    raise exception 'replay duplicated audit';
  end if;

  begin
    perform public.admin_w_activate_welcome_service_email_default(
      actor, 'different reason without email', 'wse-act-ephemeral', idem);
    raise exception 'conflict missing';
  exception
    when others then
      if sqlerrm !~ 'idempotency_conflict' then raise; end if;
  end;

  begin
    perform public.admin_w_activate_welcome_service_email_default(
      actor, 'ephemeral welcome v1 activation', 'wse-act-second', gen_random_uuid());
    raise exception 'second activation allowed';
  exception
    when others then
      if sqlerrm !~ 'welcome_default_already_active' then raise; end if;
  end;

  -- T2: auth kullanıcısı aktivasyondan önce, members INSERT sonra → seed yok.
  insert into auth.users(id, email, created_at)
  values (o1, 'old-auth-secret@example.test', v_from - interval '1 day');
  insert into public.members(user_id, email, created_at)
  values (o1, 'old-auth-secret@example.test', clock_timestamp());
  if exists (select 1 from public.member_service_pref_current where user_id=o1) then
    raise exception 'T2 old auth seeded';
  end if;

  -- Sınır: effective_from'dan 1 mikrosaniye önce → seed yok.
  insert into auth.users(id, email, created_at)
  values (b0, 'boundary-before-secret@example.test', v_from - interval '1 microsecond');
  insert into public.members(user_id, email)
  values (b0, 'boundary-before-secret@example.test');
  if exists (select 1 from public.member_service_pref_current where user_id=b0) then
    raise exception 'T2 boundary before seeded';
  end if;

  -- T3/T4: auth.created_at = effective_from, members.created_at eski → yine seed.
  -- Sınır auth.users.created_at; members.created_at değil.
  insert into auth.users(id, email, created_at)
  values (n1, 'n1-secret@example.test', v_from);
  insert into public.members(user_id, email, created_at)
  values (n1, 'n1-secret@example.test', timestamptz '2020-01-01+00');
  if (select count(*) from public.member_service_pref_current where user_id=n1) <> 1 then
    raise exception 'T4 current count';
  end if;
  if (select count(*) from public.member_service_pref_events where user_id=n1) <> 1 then
    raise exception 'T4 event count';
  end if;
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id=n1 and pref_key='welcome_service_email' and enabled is true
  ) then raise exception 'T3 not on'; end if;
  if not exists (
    select 1 from public.member_service_pref_events
     where user_id=n1 and pref_key='welcome_service_email' and enabled is true
       and source='signup' and request_id='signup-seed'
  ) then raise exception 'T3 source'; end if;
  if exists (
    select 1 from public.member_service_pref_current
     where user_id=n1 and pref_key <> 'welcome_service_email'
  ) then raise exception 'T3 other key seeded'; end if;
  if exists (
    select 1 from public.member_service_pref_events
     where user_id=n1 and (request_id like '%@%' or fingerprint like '%@%')
  ) then raise exception 'T3 email in event'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', n1)::text, true);
  r := public.consent_get_my_state();
  if jsonb_typeof(r->'service_prefs'->'welcome_service_email') <> 'boolean'
     or (r->'service_prefs'->>'welcome_service_email') <> 'true' then
    raise exception 'T3 ui %', r;
  end if;

  -- T5: profil upsert tekrarı ikinci event yazmaz.
  insert into auth.users(id, email, created_at)
  values (p1, 'p1-secret@example.test', v_from + interval '1 second');
  insert into public.members(user_id, email)
  values (p1, 'p1-secret@example.test');
  insert into public.members(user_id, email)
  values (p1, 'p1-secret@example.test')
  on conflict (user_id) do update set updated_at = clock_timestamp(), email = excluded.email;
  if (select count(*) from public.member_service_pref_events where user_id=p1 and source='signup') <> 1 then
    raise exception 'T5 duplicate event';
  end if;
  if (select count(*) from public.member_service_pref_current where user_id=p1) <> 1 then
    raise exception 'T5 duplicate current';
  end if;

  -- T6/T7: pref_center OFF kalır; profil update ve upsert tekrar ON yapmaz.
  insert into auth.users(id, email, created_at)
  values (f1, 'f1-secret@example.test', v_from + interval '2 seconds');
  insert into public.members(user_id, email)
  values (f1, 'f1-secret@example.test');
  perform set_config('request.jwt.claims', json_build_object('sub', f1)::text, true);
  perform public.service_pref_set(
    'welcome_service_email', false, 'pc-off-1', '14141414-1414-4414-8414-141414141414'::uuid);
  update public.members set updated_at = clock_timestamp(), tier = 'silver' where user_id = f1;
  insert into public.members(user_id, email)
  values (f1, 'f1-secret@example.test')
  on conflict (user_id) do update set updated_at = clock_timestamp();
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id=f1 and pref_key='welcome_service_email' and enabled is false
  ) then raise exception 'T6 not off'; end if;
  select count(*) into n from public.member_service_pref_events where user_id=f1;
  if n <> 2 then raise exception 'T7 event count %', n; end if;
  if (select count(*) from public.member_service_pref_events where user_id=f1 and source='signup') <> 1 then
    raise exception 'T7 signup event';
  end if;
  if (select count(*) from public.member_service_pref_events where user_id=f1 and source='pref_center') <> 1 then
    raise exception 'T7 pref_center event';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', f1)::text, true);
  r := public.consent_get_my_state();
  if (r->'service_prefs'->>'welcome_service_email') <> 'false' then raise exception 'T6 ui %', r; end if;

  -- T8: policy kapatılırsa yeni auth kullanıcısı seed edilmez. Alt işlem geri alınır.
  begin
    update public.service_pref_defaults
       set default_enabled = false
     where pref_key = 'welcome_service_email';
    insert into auth.users(id, email, created_at)
    values ('15151515-1515-4515-8515-151515151515', 't8-secret@example.test', v_from + interval '1 hour');
    insert into public.members(user_id, email)
    values ('15151515-1515-4515-8515-151515151515', 't8-secret@example.test');
    if exists (
      select 1 from public.member_service_pref_current
       where user_id='15151515-1515-4515-8515-151515151515'
    ) then raise exception 'T8 seeded while disabled'; end if;
    raise exception 'rollback_probe';
  exception
    when others then
      if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  if not exists (
    select 1 from public.service_pref_defaults
     where pref_key='welcome_service_email' and default_enabled is true
  ) then raise exception 'T8 left policy disabled'; end if;

  -- Gönderim kararı: kapılar kapalıyken seeded kullanıcı da enqueue'suz deny (class_disabled).
  d := public._email_send_decision(n1, 'optional_service', 'welcome_service_email');
  if d->>'skip_reason' <> 'class_disabled' then raise exception 'T10 closed gates %', d; end if;

  update public.email_provider_config
     set service_enabled = true, public_go_live = true
   where id = 1;
  d := public._email_send_decision(n1, 'optional_service', 'welcome_service_email');
  if d->>'allow' <> 'true' then raise exception 'T3 send ready %', d; end if;
  if d::text like '%n1-secret@example.test%' or d::text like '%@%' then
    raise exception 'decision returned raw email';
  end if;
  d := public._email_send_decision(f1, 'optional_service', 'welcome_service_email');
  if d->>'skip_reason' <> 'service_pref_disabled' then raise exception 'T6 send %', d; end if;
  d := public._email_send_decision(l3, 'optional_service', 'welcome_service_email');
  if d->>'skip_reason' <> 'service_pref_missing' then raise exception 'T1 send after seeds %', d; end if;
  if (select count(*) from public.email_outbox) <> 0 then raise exception 'T10 outbox after decision'; end if;

  -- Legacy dört kullanıcı değişmedi.
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id=l1 and enabled is true and last_event_id='aaaaaaaa-1111-4111-8111-111111111111'
  ) then raise exception 'T9 L1 changed'; end if;
  if not exists (
    select 1 from public.member_service_pref_current
     where user_id=l2 and enabled is false and last_event_id='aaaaaaaa-2222-4222-8222-222222222222'
  ) then raise exception 'T9 L2 changed'; end if;
  if exists (select 1 from public.member_service_pref_current where user_id in (l3, l4)) then
    raise exception 'T9 L3/L4 gained a row';
  end if;
  if exists (
    select 1 from public.member_service_pref_events
     where user_id in (l1, l2, l3, l4)
       and id not in (
         'aaaaaaaa-1111-4111-8111-111111111111',
         'aaaaaaaa-2222-4222-8222-222222222222')
  ) then raise exception 'T9 legacy events grew'; end if;
  if (select created_at from auth.users where id=l1) <> timestamptz '2020-01-01+00' then
    raise exception 'T9 auth created_at changed';
  end if;

  if (select count(*) from public.member_consent_current) <> 0
     or (select count(*) from public.member_consent_events) <> 0 then
    raise exception 'T11 consent grew';
  end if;
  if exists (
    select 1 from public.marketing_config where id=1 and (marketing_enabled or marketing_capture_enabled)
  ) then raise exception 'T11 marketing grew'; end if;

  -- Stale replay: policy null'lansa eski idem başarı yalanı söylemez. Alt işlem geri alınır.
  begin
    update public.service_pref_defaults
       set default_enabled = null,
           effective_from = null,
           policy_version = null,
           configured_at = null,
           configured_by = null
     where pref_key = 'welcome_service_email';
    perform public.admin_w_activate_welcome_service_email_default(
      actor, 'ephemeral welcome v1 activation', 'wse-act-ephemeral', idem);
    raise exception 'stale replay returned success';
  exception
    when others then
      if sqlerrm !~ 'welcome_default_replay_stale' then raise; end if;
  end;
  if not exists (
    select 1 from public.service_pref_defaults
     where pref_key='welcome_service_email' and default_enabled is true and effective_from = v_from
  ) then raise exception 'stale probe damaged policy'; end if;

  create temp table wse_hist_counts on commit drop as
  select
    (select count(*) from public.member_service_pref_current) as cur,
    (select count(*) from public.member_service_pref_events) as ev;
end $$;

select 'WSE_BEHAVIOR_PASS' as sentinel;

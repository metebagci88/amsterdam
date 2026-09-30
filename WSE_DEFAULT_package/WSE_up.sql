-- =====================================================================
-- ASALOCAL · welcome_service_email future-default · INERT infrastructure
-- Bu dosya default_enabled atamaz, üye/preference/event satırı yazmaz,
-- backfill yapmaz, enqueue/dispatch çağırmaz.
-- Aktivasyon (default_enabled=true + effective_from + policy_version)
--   YALNIZ WSE_ACTIVATE.sql içindedir ve bu dosyadan çağrılmaz.
--
-- Şema adları repo migration'larından (uydurma kolon yok):
--   CDP3C_package/CDP3C_up.sql
--     service_pref_defaults(pref_key service_pref_key PK, default_enabled boolean)
--     member_service_pref_events(id,user_id,pref_key,enabled,source,request_id,
--       idempotency_key,fingerprint,occurred_at)
--     member_service_pref_current(user_id,pref_key,enabled,last_event_id,updated_at)
--     consent_source etiketi 'signup'
--     consent_get_my_state()
--   CDP3C_package/gates/cdp3c_tests.sql
--     auth.users(id,email,created_at)
--   CDP3C_package/gates/cdp3c_baseline.sql
--     admin_write_log.actor_uid uuid  → configured_by aynı tip, FK yok
-- Preflight, bu adlar/tipler yoksa durur.
-- =====================================================================

-- ---------- 0) Preflight (yazmaz) ----------
do $$
begin
  if to_regclass('public.service_pref_defaults') is null then
    raise exception 'WSE_PREFLIGHT: public.service_pref_defaults missing';
  end if;
  if to_regclass('public.members') is null then
    raise exception 'WSE_PREFLIGHT: public.members missing';
  end if;
  if to_regclass('public.member_service_pref_events') is null then
    raise exception 'WSE_PREFLIGHT: public.member_service_pref_events missing';
  end if;
  if to_regclass('public.member_service_pref_current') is null then
    raise exception 'WSE_PREFLIGHT: public.member_service_pref_current missing';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'WSE_PREFLIGHT: auth.users missing';
  end if;
  if to_regprocedure('public.consent_get_my_state()') is null then
    raise exception 'WSE_PREFLIGHT: public.consent_get_my_state() missing';
  end if;
  if to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception 'WSE_PREFLIGHT: extensions.digest(bytea,text) missing';
  end if;
  if to_regprocedure('pg_catalog.hashtextextended(text,bigint)') is null then
    raise exception 'WSE_PREFLIGHT: hashtextextended(text,bigint) missing';
  end if;
  if not exists (select 1 from pg_roles where rolname='anon')
     or not exists (select 1 from pg_roles where rolname='authenticated') then
    raise exception 'WSE_PREFLIGHT: anon/authenticated roles missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='service_pref_defaults'
       and column_name='pref_key' and udt_name='service_pref_key'
  ) then raise exception 'WSE_PREFLIGHT: service_pref_defaults.pref_key'; end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='service_pref_defaults'
       and column_name='default_enabled' and data_type='boolean'
  ) then raise exception 'WSE_PREFLIGHT: service_pref_defaults.default_enabled'; end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='members'
       and column_name='user_id' and data_type='uuid'
  ) then raise exception 'WSE_PREFLIGHT: members.user_id uuid'; end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='auth' and table_name='users'
       and column_name='id' and data_type='uuid'
  ) then raise exception 'WSE_PREFLIGHT: auth.users.id uuid'; end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='auth' and table_name='users'
       and column_name='created_at' and data_type='timestamp with time zone'
  ) then raise exception 'WSE_PREFLIGHT: auth.users.created_at timestamptz'; end if;

  if not exists (
    select 1 from pg_enum e
      join pg_type t on t.oid=e.enumtypid
      join pg_namespace n on n.oid=t.typnamespace
     where n.nspname='public' and t.typname='service_pref_key' and e.enumlabel='welcome_service_email'
  ) then raise exception 'WSE_PREFLIGHT: service_pref_key.welcome_service_email'; end if;
  if not exists (
    select 1 from pg_enum e
      join pg_type t on t.oid=e.enumtypid
      join pg_namespace n on n.oid=t.typnamespace
     where n.nspname='public' and t.typname='consent_source' and e.enumlabel='signup'
  ) then raise exception 'WSE_PREFLIGHT: consent_source.signup'; end if;

  -- yazacağımız event/current kolonları (CDP-3C adları)
  if (
    select count(*) from information_schema.columns
     where table_schema='public' and table_name='member_service_pref_events'
       and column_name in ('user_id','pref_key','enabled','source','request_id','idempotency_key','fingerprint')
  ) <> 7 then
    raise exception 'WSE_PREFLIGHT: member_service_pref_events columns';
  end if;
  if (
    select count(*) from information_schema.columns
     where table_schema='public' and table_name='member_service_pref_current'
       and column_name in ('user_id','pref_key','enabled','last_event_id','updated_at')
  ) <> 5 then
    raise exception 'WSE_PREFLIGHT: member_service_pref_current columns';
  end if;
end $$;

-- ---------- A) Policy metadata. Mevcut satırlara değer yazılmaz (default yok). ----------
alter table public.service_pref_defaults
  add column if not exists effective_from timestamptz,
  add column if not exists policy_version text,
  add column if not exists configured_at timestamptz,
  add column if not exists configured_by uuid;

comment on column public.service_pref_defaults.effective_from is
  'Activation instant. Seed only when auth.users.created_at >= effective_from. NULL = not activated.';
comment on column public.service_pref_defaults.policy_version is
  'Pinned policy label. This package allows only welcome_service_email.v1 on the welcome key.';
comment on column public.service_pref_defaults.configured_at is
  'When activation recorded the policy. Not a member backfill timestamp.';
comment on column public.service_pref_defaults.configured_by is
  'Actor uuid, same type as admin_write_log.actor_uid. No FK, no email.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname='service_pref_defaults_activation_welcome_only'
       and conrelid='public.service_pref_defaults'::regclass
  ) then
    alter table public.service_pref_defaults
      add constraint service_pref_defaults_activation_welcome_only
      check (
        pref_key = 'welcome_service_email'::public.service_pref_key
        or coalesce(default_enabled, false) = false
        or effective_from is null
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname='service_pref_defaults_policy_version_welcome_v1'
       and conrelid='public.service_pref_defaults'::regclass
  ) then
    alter table public.service_pref_defaults
      add constraint service_pref_defaults_policy_version_welcome_v1
      check (
        policy_version is null
        or (
          pref_key = 'welcome_service_email'::public.service_pref_key
          and policy_version = 'welcome_service_email.v1'
        )
      );
  end if;
end $$;

-- ---------- B) Seed: yalnız ilk gerçek members INSERT, yalnız welcome, yalnız aktif policy ----------
-- INSERT ... ON CONFLICT DO UPDATE yolunda INSERT trigger'ı çalışmaz (PostgreSQL).
-- Ham e-posta seçilmez. Enqueue yok. Mevcut current satırı ezilmez.
create or replace function public._seed_welcome_service_pref_on_member_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_auth_created timestamptz;
  v_from timestamptz;
  v_ver text;
  v_evid uuid;
  v_fp text;
  v_idem uuid;
begin
  if tg_op is distinct from 'INSERT' then
    return new;
  end if;

  select u.created_at into v_auth_created
    from auth.users u
   where u.id = new.user_id;
  if v_auth_created is null then
    return new;
  end if;

  select d.effective_from, d.policy_version
    into v_from, v_ver
    from public.service_pref_defaults d
   where d.pref_key = 'welcome_service_email'::public.service_pref_key
     and d.default_enabled is true
     and d.effective_from is not null
     and v_auth_created >= d.effective_from;
  if not found then
    return new;
  end if;

  -- service_pref_set ile aynı kilit: uid|welcome_service_email
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|welcome_service_email', 0));

  if exists (
    select 1 from public.member_service_pref_current c
     where c.user_id = new.user_id
       and c.pref_key = 'welcome_service_email'::public.service_pref_key
  ) then
    return new;
  end if;

  v_fp := encode(extensions.digest(convert_to(
    new.user_id::text || '|welcome_service_email|true|signup|' || coalesce(v_ver,'') || '|' || v_from::text,
    'UTF8'), 'sha256'), 'hex');
  v_idem := md5('welcome-signup|' || new.user_id::text || '|welcome_service_email')::uuid;

  insert into public.member_service_pref_events(
    user_id, pref_key, enabled, source, request_id, idempotency_key, fingerprint
  ) values (
    new.user_id,
    'welcome_service_email'::public.service_pref_key,
    true,
    'signup'::public.consent_source,
    'signup-seed',
    v_idem,
    v_fp
  ) returning id into v_evid;

  insert into public.member_service_pref_current(
    user_id, pref_key, enabled, last_event_id, updated_at
  ) values (
    new.user_id,
    'welcome_service_email'::public.service_pref_key,
    true,
    v_evid,
    clock_timestamp()
  );

  return new;
end
$fn$;

comment on function public._seed_welcome_service_pref_on_member_insert() is
  'AFTER INSERT on members. Seeds welcome_service_email only when the auth user was created at or after effective_from and the welcome policy is on. No enqueue. No email in the audit row.';

revoke all on function public._seed_welcome_service_pref_on_member_insert() from public, anon, authenticated;

drop trigger if exists trg_members_seed_welcome_service_pref on public.members;
create trigger trg_members_seed_welcome_service_pref
  after insert on public.members
  for each row
  execute function public._seed_welcome_service_pref_on_member_insert();

-- ---------- C) Read path: missing current row is not_configured. Defaults are not a runtime ON. ----------
create or replace function public.consent_get_my_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_consent jsonb;
  v_prefs jsonb;
begin
  if v_uid is null then
    raise exception 'no_auth';
  end if;
  select coalesce(
           jsonb_object_agg(purpose, jsonb_build_object(
             'state', state, 'text_version_id', text_version_id, 'epoch', consent_epoch)),
           '{}'::jsonb)
    into v_consent
    from public.member_consent_current
   where user_id = v_uid;
  -- Key list still comes from service_pref_defaults (the catalog).
  -- The value does not. A missing current row is not_configured.
  select coalesce(jsonb_object_agg(
           d.pref_key,
           case when c.user_id is not null then to_jsonb(c.enabled)
                else to_jsonb('not_configured'::text) end),
         '{}'::jsonb)
    into v_prefs
    from public.service_pref_defaults d
    left join public.member_service_pref_current c
      on c.user_id = v_uid and c.pref_key = d.pref_key;
  return jsonb_build_object('consent', v_consent, 'service_prefs', v_prefs);
end
$fn$;

revoke all on function public.consent_get_my_state() from public, anon;
grant execute on function public.consent_get_my_state() to authenticated;

-- D) _email_send_decision bu dosyada yok. Defaults fallback eklenmez.

-- =====================================================================
-- CI/ephemeral ONLY. Production'a uygulanmaz.
-- CDP-3D prereq + CDP3D_up.sql yüklendikten SONRA çalışır.
-- Üretimdeki CDP-3C yüzeyinin bu paketin ihtiyaç duyduğu parçası:
--   auth.users(id,email,created_at), auth.uid(),
--   member_service_pref_events, consent_get_my_state (ESKİ fallback'li gövde),
--   service_pref_set, _require_request_id, _consent_idem_check,
--   marketing_config bayrakları, boş member_consent tabloları,
--   service_pref_defaults satırları (hepsi null).
-- Gövdeler CDP3C_package/CDP3C_up.sql ile aynı sözleşmedir.
-- =====================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

create table if not exists public.member_service_pref_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  pref_key public.service_pref_key not null,
  enabled boolean not null,
  source public.consent_source not null,
  request_id text not null,
  idempotency_key uuid not null,
  fingerprint text not null,
  occurred_at timestamptz not null default now()
);

drop trigger if exists trg_append_only on public.member_service_pref_events;
create trigger trg_append_only
  before update or delete on public.member_service_pref_events
  for each row execute function public._append_only_guard();

insert into public.service_pref_defaults(pref_key, default_enabled)
select k, null::boolean
  from unnest(enum_range(null::public.service_pref_key)) as k
on conflict (pref_key) do nothing;

create table if not exists public.member_consent_current (
  user_id uuid not null,
  purpose text not null,
  state text,
  text_version_id uuid,
  consent_epoch bigint,
  primary key (user_id, purpose)
);

create table if not exists public.member_consent_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid
);

create table if not exists public.marketing_config (
  id int primary key,
  marketing_enabled boolean not null default false,
  marketing_capture_enabled boolean not null default false
);
insert into public.marketing_config(id, marketing_enabled, marketing_capture_enabled)
values (1, false, false)
on conflict (id) do nothing;

-- CDP-3C _require_request_id (CDP3C_up.sql)
create or replace function public._require_request_id(p text)
returns text
language plpgsql
immutable
as $fn$
declare
  v text := btrim(coalesce(p,''));
begin
  if length(v)=0 or length(v)>80 then
    raise exception 'request_id_required';
  end if;
  return v;
end
$fn$;

-- CDP-3C _consent_idem_check (CDP3C_up.sql)
create or replace function public._consent_idem_check(p_idem uuid, p_actor uuid, p_action text, p_fp text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v record;
begin
  select * into v from public.consent_write_ops where idempotency_key = p_idem;
  if found then
    if v.actor <> p_actor or v.action <> p_action or v.fingerprint <> p_fp then
      raise exception 'idempotency_conflict';
    end if;
    return coalesce(v.result, '{"ok":true,"replay":true}'::jsonb);
  end if;
  return null;
end
$fn$;

-- CDP-3C consent_get_my_state ÖNCEKİ gövde (default fallback'li). Migration bunu değiştirir.
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
  if v_uid is null then raise exception 'no_auth'; end if;
  select coalesce(jsonb_object_agg(purpose, jsonb_build_object('state',state,'text_version_id',text_version_id,'epoch',consent_epoch)),'{}'::jsonb)
    into v_consent from public.member_consent_current where user_id=v_uid;
  select coalesce(jsonb_object_agg(d.pref_key,
           case when c.user_id is not null then to_jsonb(c.enabled)
                when d.default_enabled is not null then to_jsonb(d.default_enabled)
                else to_jsonb('config_pending'::text) end),'{}'::jsonb)
    into v_prefs from public.service_pref_defaults d
    left join public.member_service_pref_current c on c.user_id=v_uid and c.pref_key=d.pref_key;
  return jsonb_build_object('consent',v_consent,'service_prefs',v_prefs);
end
$fn$;
revoke all on function public.consent_get_my_state() from public, anon;
grant execute on function public.consent_get_my_state() to authenticated;

-- CDP-3C service_pref_set (CDP3C_up.sql) — pref_center OFF yolu
create or replace function public.service_pref_set(
  p_key public.service_pref_key, p_enabled boolean, p_request_id text, p_idem uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_uid uuid := auth.uid();
  v_fp text;
  v_prev jsonb;
  v_evid uuid;
  v_rid text;
begin
  if v_uid is null then raise exception 'no_auth'; end if;
  v_rid := public._require_request_id(p_request_id);
  if p_idem is null then raise exception 'idem_required'; end if;
  v_fp := encode(extensions.digest(convert_to(v_uid::text||p_key::text||p_enabled::text,'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,v_uid,'service_pref_set',v_fp);
  if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text||'|'||p_key::text,0));
  v_prev := public._consent_idem_check(p_idem,v_uid,'service_pref_set',v_fp);
  if v_prev is not null then return v_prev; end if;
  insert into public.member_service_pref_events(user_id,pref_key,enabled,source,request_id,idempotency_key,fingerprint)
  values (v_uid,p_key,p_enabled,'pref_center',v_rid,p_idem,v_fp)
  returning id into v_evid;
  insert into public.member_service_pref_current(user_id,pref_key,enabled,last_event_id,updated_at)
  values (v_uid,p_key,p_enabled,v_evid,now())
  on conflict (user_id,pref_key) do update
    set enabled=excluded.enabled, last_event_id=excluded.last_event_id, updated_at=now();
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result)
  values (p_idem,v_uid,'service_pref_set',v_fp,jsonb_build_object('ok',true,'key',p_key,'enabled',p_enabled));
  return jsonb_build_object('ok',true,'key',p_key,'enabled',p_enabled);
end
$fn$;
revoke all on function public.service_pref_set(public.service_pref_key,boolean,text,uuid) from public, anon;
grant execute on function public.service_pref_set(public.service_pref_key,boolean,text,uuid) to authenticated;

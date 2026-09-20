do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
-- CDP-3C prereq stub (yalnız CDP-3D'nin bağlı olduğu yüzey; gerçek imzalarla)
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists vault;
create table if not exists vault.decrypted_secrets(name text primary key, decrypted_secret text);
insert into vault.decrypted_secrets(name,decrypted_secret) values ('cdp3c_contact_pepper_v1','TEST_PEPPER_LOCAL') on conflict do nothing;

-- enums (CDP-3C birebir)
do $$ begin create type public.consent_source as enum ('signup','pref_center','cookie_banner','unsubscribe','iys_sync','system','import'); exception when duplicate_object then null; end $$;
do $$ begin create type public.suppression_channel as enum ('email','sms','push','global'); exception when duplicate_object then null; end $$;
do $$ begin create type public.suppression_scope as enum ('marketing','all_email','global'); exception when duplicate_object then null; end $$;
do $$ begin create type public.suppression_reason as enum ('user_unsubscribe','iys_red','hard_bounce','spam_complaint','abuse','admin_safety_block'); exception when duplicate_object then null; end $$;
do $$ begin create type public.service_pref_key as enum ('trip_created_confirmation','trip_updated_confirmation','trip_start_minus_7_days','trip_start_minus_1_day','plan_saved_confirmation','plan_reminder','welcome_service_email'); exception when duplicate_object then null; end $$;
do $$ begin create type public.admin_role as enum ('super_admin','support','crm'); exception when duplicate_object then null; end $$;

-- members
create table if not exists public.members(user_id uuid primary key, email text not null, blocked boolean default false, tier text default 'bronze', points int default 0, created_at timestamptz default now(), updated_at timestamptz default now());
-- admin
create table if not exists public.admin_users(user_id uuid primary key, active boolean not null default true);
create table if not exists public.admin_roles(user_id uuid not null, role public.admin_role not null, primary key(user_id,role));
create table if not exists public.admin_write_log(id uuid primary key default gen_random_uuid(), actor_uid uuid, action text, target_type text, target_id text, before jsonb, after jsonb, reason text, request_id text, idempotency_key uuid, at timestamptz default now());
create table if not exists public.consent_write_ops(idempotency_key uuid primary key, actor uuid, action text, fingerprint text, result jsonb, created_at timestamptz default now());
create table if not exists public.email_templates(id uuid primary key default gen_random_uuid(), internal_name text, email_class text, status text, created_at timestamptz default now());

create or replace function public._admin_active(p_uid uuid) returns boolean language sql stable security definer set search_path=public as $fn$ select exists(select 1 from public.admin_users where user_id=p_uid and active); $fn$;
create or replace function public._admin_has_role(p_uid uuid, p_roles text[]) returns boolean language sql stable security definer set search_path=public as $fn$ select exists(select 1 from public.admin_roles where user_id=p_uid and role::text = any(p_roles)); $fn$;
create or replace function public._require_request_id(p text) returns text language plpgsql as $fn$ begin if coalesce(btrim(p),'')='' then raise exception 'request_id_required'; end if; return btrim(p); end $fn$;
create or replace function public._consent_idem_check(p_idem uuid, p_actor uuid, p_action text, p_fp text) returns jsonb language sql stable as $fn$ select result from public.consent_write_ops where idempotency_key=p_idem and fingerprint=p_fp; $fn$;

-- _contact_hmac (CDP-3C birebir)
create or replace function public._contact_hmac(p_contact text, p_pepper_version int default 1)
returns text language plpgsql security definer set search_path=public, extensions, vault as $fn$
declare v_pepper text; begin
  select decrypted_secret into v_pepper from vault.decrypted_secrets where name='cdp3c_contact_pepper_v'||p_pepper_version;
  if v_pepper is null then raise exception 'pepper_missing'; end if;
  return encode(extensions.hmac(convert_to(lower(trim(coalesce(p_contact,''))),'UTF8'), convert_to(v_pepper,'UTF8'),'sha256'),'hex');
end $fn$;

-- append-only guard (CDP-3C birebir)
create or replace function public._append_only_guard() returns trigger language plpgsql as $fn$ begin raise exception 'append_only_%', TG_TABLE_NAME; end $fn$;

-- service pref tabloları
create table if not exists public.member_service_pref_current(user_id uuid not null, pref_key public.service_pref_key not null, enabled boolean not null, last_event_id uuid, updated_at timestamptz not null default now(), primary key(user_id,pref_key));
create table if not exists public.service_pref_defaults(pref_key public.service_pref_key primary key, default_enabled boolean);

-- suppression tabloları + combo matrisi (CDP-3C birebir)
create table if not exists public.contact_suppression_events (id uuid primary key default gen_random_uuid(), channel public.suppression_channel not null, scope public.suppression_scope not null, contact_hmac text not null check (contact_hmac ~ '^[0-9a-f]{64}$'), pepper_version int not null default 1, reason public.suppression_reason not null, action text not null check (action in ('suppress','supersede')), supersede_evidence jsonb, source public.consent_source not null, request_id text not null, idempotency_key uuid not null, fingerprint text not null, occurred_at timestamptz not null default now());
create table if not exists public.contact_suppression_current (channel public.suppression_channel not null, contact_hmac text not null check (contact_hmac ~ '^[0-9a-f]{64}$'), scope public.suppression_scope not null, reason public.suppression_reason not null, pepper_version int not null default 1, status text not null check (status in ('active','superseded')), source_event_id uuid not null references public.contact_suppression_events(id), superseded_at timestamptz, superseded_by uuid references public.contact_suppression_events(id), updated_at timestamptz not null default now(), primary key (channel, contact_hmac, scope, reason));
create or replace function public._suppression_pair_ok(p_channel public.suppression_channel, p_scope public.suppression_scope) returns boolean language sql immutable as $fn$ select (p_channel,p_scope) in (('email','marketing'),('email','all_email'),('sms','marketing'),('push','marketing'),('global','global')); $fn$;
create or replace function public._suppression_combo_ok(p_channel public.suppression_channel, p_scope public.suppression_scope, p_reason public.suppression_reason) returns boolean language sql immutable as $fn$
  select public._suppression_pair_ok(p_channel,p_scope) and case p_reason
    when 'user_unsubscribe' then (p_channel,p_scope) in (('email','marketing'),('email','all_email'),('sms','marketing'),('push','marketing'))
    when 'iys_red' then (p_channel,p_scope) in (('email','marketing'),('sms','marketing'))
    when 'hard_bounce' then (p_channel,p_scope) in (('email','marketing'),('email','all_email'))
    when 'spam_complaint' then (p_channel,p_scope) in (('email','marketing'),('email','all_email'))
    when 'abuse' then (p_channel,p_scope) in (('email','marketing'),('email','all_email'),('sms','marketing'),('push','marketing'),('global','global'))
    when 'admin_safety_block' then (p_channel,p_scope) in (('email','marketing'),('sms','marketing'),('push','marketing'),('global','global'))
    else false end; $fn$;
create or replace function public._suppression_combo_guard() returns trigger language plpgsql as $fn$ begin if not public._suppression_combo_ok(new.channel,new.scope,new.reason) then raise exception 'suppression_combo_not_allowed:%/%/%', new.channel,new.scope,new.reason; end if; return new; end $fn$;
drop trigger if exists trg_supp_ev_combo on public.contact_suppression_events;
create trigger trg_supp_ev_combo before insert on public.contact_suppression_events for each row execute function public._suppression_combo_guard();
drop trigger if exists trg_supp_cur_combo on public.contact_suppression_current;
create trigger trg_supp_cur_combo before insert or update on public.contact_suppression_current for each row execute function public._suppression_combo_guard();

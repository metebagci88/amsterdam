-- ASALOCAL · CDP-3B gate baseline fixture (YALNIZ ephemeral/local test DB).
-- CDP3B_up.sql'in bağımlı olduğu mevcut admin altyapısını prod kontratıyla BİREBİR temsil eder.
-- Idempotent: create ... if not exists / create or replace. Production'da UYGULANMAZ (zaten mevcut).

-- admin_role enum (prod ile aynı 8 değer)
do $$ begin
  create type public.admin_role as enum ('super_admin','content_editor','venue_editor','moderator','support','crm','ads','analyst');
exception when duplicate_object then null; end $$;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid
);
create table if not exists public.admin_roles (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.admin_users(user_id) on delete cascade,
  role public.admin_role not null,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  unique (user_id, role)
);
create table if not exists public.admin_settings (
  key text primary key,
  bool_value boolean,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create table if not exists public.admin_write_ops (
  idempotency_key uuid primary key,
  actor_uid uuid not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  desired_value boolean,
  reason text not null,
  note text,
  fingerprint text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  desired_num int
);
create table if not exists public.admin_write_log (
  id bigint generated always as identity primary key,
  actor_uid uuid,
  action text,
  target_type text,
  target_id text,
  before jsonb,
  after jsonb,
  reason text,
  note text,
  idempotency_key uuid,
  request_id text,
  at timestamptz not null default now()
);

-- helper'lar (prod defs ile birebir)
create or replace function public._admin_active(p_actor uuid) returns boolean
 language sql stable security definer set search_path to 'pg_catalog','public' as $$
  select exists(select 1 from public.admin_users a where a.user_id=p_actor and a.active) $$;
create or replace function public._admin_has_role(p_actor uuid, p_roles text[]) returns boolean
 language sql stable security definer set search_path to 'pg_catalog','public' as $$
  select exists(select 1 from public.admin_roles r join public.admin_users a on a.user_id=r.user_id and a.active
                where r.user_id=p_actor and r.role = any(p_roles::public.admin_role[])) $$;
create or replace function public._admin_writes_enabled() returns boolean
 language sql stable security definer set search_path to 'pg_catalog','public' as $$
  select coalesce((select bool_value from public.admin_settings where key='admin_writes_enabled'), false) $$;

-- admin yazımları test için AÇIK (prod'da admin_settings zaten yönetilir)
insert into public.admin_settings(key,bool_value) values ('admin_writes_enabled', true)
  on conflict (key) do update set bool_value=excluded.bool_value;

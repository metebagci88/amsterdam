-- =====================================================================
-- SEC-MEDIA · STAGE 2 · gates/s2_fixture_storage_model.sql
-- YALNIZ PGlite / boş yerel Postgres içindir. PRODUCTION'DA veya gerçek Supabase
-- stack'inde ÇALIŞTIRILMAZ (gerçek storage şeması varsa kendini reddeder).
--
-- Production storage.objects'in S2 için önemli kısmını modeller (read-only olarak
-- 2026-10-07'de doğrulandı):
--   * roller: anon, authenticated (NOBYPASSRLS), service_role (BYPASSRLS),
--     supabase_storage_admin (tablo sahibi; postgres sahibi DEĞİL)
--   * storage.buckets / storage.objects kolonları (path_tokens generated dahil; buckets.type
--     storage.buckettype NOT NULL default 'STANDARD', versioning_status NOT NULL default 'DISABLED',
--     lifecycle_* — prod storage migration 0038/0062/0068 ile aynı; s2_*_assert satır 21 için)
--   * RLS enabled (force değil)
--   * grant: anon/authenticated/service_role -> storage.objects ALL
--   * trigger'lar: protect_objects_delete (BEFORE DELETE FOR EACH STATEMENT,
--     storage.allow_delete_query<>'true' ise 42501) + update_objects_updated_at
--   * supabase_migrations.schema_migrations (ledger) — prod_assert ledger kontrolü için
-- Modellenmeyen: supautils policy_grants (prod'da postgres non-superuser ama
--   storage.objects policy yönetimine yetkili; read-only teyit edildi), Storage API.
-- =====================================================================
do $refuse$
begin
  if to_regclass('storage.migrations') is not null then
    raise exception 'S2_FIXTURE_REFUSE: gerçek Supabase storage şeması bulundu; model fixture yalnız PGlite/boş Postgres içindir';
  end if;
end
$refuse$;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then
    create role supabase_storage_admin nologin nobypassrls;
  end if;
end
$roles$;

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

do $btype$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'storage' and t.typname = 'buckettype') then
    create type storage.buckettype as enum ('STANDARD', 'ANALYTICS', 'VECTOR');
  end if;
end
$btype$;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  owner              uuid,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  public             boolean default false,
  avif_autodetection boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  owner_id           text,
  type               storage.buckettype not null default 'STANDARD',
  versioning_status  text not null default 'DISABLED',
  lifecycle_configuration            jsonb,
  lifecycle_configuration_generation uuid
);

create table if not exists storage.objects (
  id               uuid not null default gen_random_uuid() primary key,
  bucket_id        text references storage.buckets(id),
  name             text,
  owner            uuid,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata         jsonb,
  path_tokens      text[] generated always as (string_to_array(name, '/')) stored,
  version          text,
  owner_id         text,
  user_metadata    jsonb,
  archived_at      timestamptz,
  is_delete_marker boolean not null default false,
  is_versioned     boolean not null default false
);

create or replace function storage.protect_delete() returns trigger
language plpgsql as $f$
begin
  if coalesce(current_setting('storage.allow_delete_query', true), 'false') != 'true' then
    raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
      using hint = 'This prevents accidental data loss from orphaned objects.', errcode = '42501';
  end if;
  return null;
end
$f$;

create or replace function storage.update_updated_at_column() returns trigger
language plpgsql as $f$
begin
  new.updated_at = now();
  return new;
end
$f$;

drop trigger if exists protect_objects_delete on storage.objects;
create trigger protect_objects_delete before delete on storage.objects
  for each statement execute function storage.protect_delete();
drop trigger if exists update_objects_updated_at on storage.objects;
create trigger update_objects_updated_at before update on storage.objects
  for each row execute function storage.update_updated_at_column();

alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

grant all on storage.objects to anon, authenticated, service_role;
grant all on storage.buckets to anon, authenticated, service_role;

alter schema storage owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
alter table storage.buckets owner to supabase_storage_admin;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version    text primary key,
  statements text[],
  name       text
);

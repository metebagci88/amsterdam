-- WP8 CI-ONLY test doubles. Never applied to production.
-- Loaded after CDP3D_package/gates/cdp3d_prereq_stub.sql, CDP3D_up.sql (raw or normalized),
-- WSE_DEFAULT_package/gates/wse_prereq_extra.sql and WSE_up.sql, before the exact CDP-3C
-- definitions printed by wp8_cdp3c_fns.py and before WP8_DB_up.sql.

-- (1) Supabase default privileges: objects created by the migration role are granted to
-- anon, authenticated and service_role unless the migration revokes them. This makes every
-- missed revoke visible in CI (critic amendment 11).
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- (2) WP5 private name columns (production CHECK is stricter; WP8 escaping does not rely on it).
alter table public.members add column if not exists first_name text;
alter table public.members add column if not exists last_name text;
do $ci$
begin
  if not exists (select 1 from pg_constraint where conname = 'members_first_name_ci_policy') then
    alter table public.members add constraint members_first_name_ci_policy check (
      first_name is null or (char_length(first_name) between 1 and 50 and first_name = btrim(first_name)
        and first_name !~ '[\x01-\x1f\x21-\x26\x28-\x2c\x2f-\x40\x5b-\x60\x7b-\xbf]'));
  end if;
end
$ci$;

-- (3) GoTrue columns used for the OTP lower bound, and a minimal auth.identities.
alter table auth.users add column if not exists confirmation_sent_at timestamptz;
alter table auth.users add column if not exists recovery_sent_at timestamptz;
alter table auth.users add column if not exists email_change_sent_at timestamptz;
alter table auth.users add column if not exists reauthentication_sent_at timestamptz;
create table if not exists auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid not null, provider text not null, provider_id text not null);

-- (4) Readiness: CDP-3C helper stub driven by a CI table. The md5-pinned
-- service_delivery_readiness_check() itself is loaded byte-exact from CDP3C_up.sql.
create table if not exists public.wp8_ci_readiness (id int primary key default 1 check (id = 1), ready boolean not null default false);
insert into public.wp8_ci_readiness(id) values (1) on conflict do nothing;
create or replace function public._service_delivery_missing() returns text[]
language sql stable security definer set search_path = public as $fn$
  select case when r.ready then array[]::text[] else array['ci_stub_not_ready']::text[] end from public.wp8_ci_readiness r where r.id = 1
$fn$;
revoke all on function public._service_delivery_missing() from public, anon, authenticated;

-- (5) A harmless double of the live-only members trigger (inventory tests).
create or replace function public._ci_member_ref() returns trigger language plpgsql set search_path = public as $fn$
begin
  return new;
end
$fn$;
revoke all on function public._ci_member_ref() from public, anon, authenticated;
create or replace trigger trg_member_ref before insert on public.members for each row execute function public._ci_member_ref();

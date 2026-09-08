-- =====================================================================
-- ASALOCAL · CDP-3C · CI-ONLY BASELINE (test double) — PRODUCTION'A UYGULANMAZ
-- Amaç: geçici/ephemeral Supabase stack'te, CDP-3C'nin dayandığı ÖNCEKİ FAZ
--       (0A/CDP-2) nesnelerinin MİNİMAL karşılıklarını oluşturmak. Production'da
--       bu nesneler ZATEN vardır (gerçek tanımlar); bu dosya yalnız CI için,
--       up.sql + testlerin fresh stack'te koşabilmesi içindir.
-- Gerçek üretim tanımları DEĞİLDİR; yalnız up.sql/testlerin ihtiyaç duyduğu
--   yüzey (kolonlar/imzalar/enum değerleri) taklit edilir. Asla prod'a -f edilmez.
-- =====================================================================
\set ON_ERROR_STOP on

-- admin rol enum (üretimdeki değer kümesinin kullanılan alt kümesi)
do $$ begin
  if not exists (select 1 from pg_type where typname='admin_role') then
    create type public.admin_role as enum ('super_admin','support','crm');
  end if;
end $$;

-- members: _consent_set_internal yalnız (user_id,email) OKUR
create table if not exists public.members(
  user_id uuid primary key,
  email text,
  tier text default 'bronze',
  points int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- admin kimlik/rol tabloları (_admin_active/_admin_has_role bunları okur)
create table if not exists public.admin_users(
  user_id uuid primary key,
  active boolean not null default true,
  created_at timestamptz default now()
);
create table if not exists public.admin_roles(
  user_id uuid not null,
  role public.admin_role not null,
  granted_at timestamptz default now(),
  primary key (user_id, role)
);

-- admin audit (append-only; admin_w_* buraya YAZAR). Üretimdeki kolon yüzeyi.
create table if not exists public.admin_write_log(
  id uuid primary key default gen_random_uuid(),
  actor_uid uuid not null,
  action text not null,
  target_type text,
  target_id text,
  before jsonb,
  after jsonb,
  reason text,
  request_id text,
  idempotency_key uuid,
  at timestamptz not null default now()
);

-- yetki yardımcıları (üretim imzalarıyla birebir): active + rol üyeliği
create or replace function public._admin_active(p_uid uuid) returns boolean
  language sql stable security definer set search_path=public as $fn$
  select exists(select 1 from public.admin_users where user_id=p_uid and active);
$fn$;

create or replace function public._admin_has_role(p_uid uuid, p_roles text[]) returns boolean
  language sql stable security definer set search_path=public as $fn$
  select exists(
    select 1 from public.admin_roles
    where user_id=p_uid and role::text = any(p_roles)
  );
$fn$;

-- NOT: Bu dosya CI harness'ı içindir. Production'da members/admin_users/admin_roles/
--      admin_write_log/_admin_active/_admin_has_role GERÇEK tanımlarıyla mevcuttur;
--      CDP-3C bunları YENİDEN OLUŞTURMAZ, yalnız okur/yazar. Prod'a asla uygulanmaz.


-- CDP-3C privilege-matrix icin: prior-faz admin helper'lari da authenticated/anon'a KAPALI
revoke all on function public._admin_active(uuid) from public, anon, authenticated;
revoke all on function public._admin_has_role(uuid,text[]) from public, anon, authenticated;

-- PROD-BENZERI önceki-faz MEŞRU authenticated RPC fixture'i (trip_save benzeri): privilege_matrix
-- yalnız CDP-3C manifest fonksiyonlarını denetlediği için bunu YANLIŞ reddetmemeli (düzeltme #4).
create or replace function public.trip_save() returns void language sql as $$ select $$;
grant execute on function public.trip_save() to authenticated;

-- CI ephemeral SENTINEL + sabit MARKER (guard katman 3): production bunu OLUŞTURMAZ (baseline proda uygulanmaz)
create table if not exists public._cdp3c_ephemeral_ok(marker text not null);
insert into public._cdp3c_ephemeral_ok(marker) select 'CDP3C_CI_EPHEMERAL' where not exists (select 1 from public._cdp3c_ephemeral_ok);

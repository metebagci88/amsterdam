-- =====================================================================
-- ASALOCAL · WP5 (İŞ PAKETİ 5) · gates/wp5_fixture_baseline.sql
-- YALNIZ YEREL/EPHEMERAL (PGlite). Production'a ASLA gönderilmez.
-- Production'daki members veri modelinin 2026-10-07 read-only ölçümüne dayalı birebir modeli:
--   * auth.uid()/auth.jwt()/auth.role()/auth.email() gövdeleri production'dan kopya (GUC tabanlı)
--   * public.members kolon sırası/tipleri/varsayılanları/PK/UNIQUE/FK, RLS + 3 self policy,
--     tablo ACL'i (authenticated+service_role ALL, anon YOK), 3 trigger
--   * guard_member_admin_fields / member_upsert_profile / complete_profile / _award /
--     _recompute_points / _member_ref_trg / _ensure_member_ref / _auth_user_ref_trg:
--     pg_get_functiondef çıktısının BİREBİR kopyası (md5(prosrc) gate'te production literaliyle
--     karşılaştırılır)
--   * member_public / comments_public / comment_reaction_counts: production view tanımı + reloptions;
--     ACL = SEC_VIEWS (sec_public_views_readonly) SONRASI production durumu: önce production'ın
--     2026-10-07 geniş ACL'i (anon/authenticated arwdDxtm) kurulur, ardından SEC_VIEWS_up.sql'deki
--     REVOKE birebir uygulanır -> {postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,
--     service_role=arwdDxtm/postgres}. WP5 bu durumu ÖNKOŞUL olarak ister (PRE guard).
--     comment_reaction_counts tanımı SEC_VIEWS paketinin production-md5 eşli modelinden
--     (pg_get_viewdef(oid,true) md5'leri gate'te SEC_VIEWS production literalleriyle karşılaştırılır).
--   * Supabase varsayılan ayrıcalıkları (public şemada yeni fonksiyon -> anon/authenticated/
--     service_role EXECUTE) — WP5'in REVOKE'unun gerçekten gerekli olduğunu modellemek için
-- STUB (bilinçli): _seed_welcome_service_pref_on_member_insert (WSE tabloları/pgcrypto gerektirir;
--   e-posta veya isim okumaz/yazmaz) -> no-op trigger fonksiyonu; _email_send_decision modellenmez
--   (alıcı = members.email; gate members.email değerini doğrudan doğrular).
-- Sentetik veri: yalnız gate'in ürettiği uuid'ler ve "example.invalid" alan adı; gerçek veri yok.
-- =====================================================================

do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- auth (Supabase modeli)
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid not null primary key,
  email text,
  aud text,
  role text,
  created_at timestamptz default now()
);

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$
;
CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$
;
CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$
;
CREATE OR REPLACE FUNCTION auth.email()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$function$
;

-- ---------------------------------------------------------------- migration ledger modeli
create schema if not exists supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations(version, name) values ('20261007150508', 'sec_media_close_anon_write');

-- ---------------------------------------------------------------- public.members (production ile birebir)
create table public.members (
  email        text not null,
  display_name text,
  tier         text not null default 'Kaşif'::text,
  points       integer not null default 0,
  home_city    text,
  bio          text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  blocked      boolean default false,
  gender       text,
  user_id      uuid not null,
  constraint members_pkey primary key (email),
  constraint members_user_id_key unique (user_id),
  constraint members_user_id_fkey foreign key (user_id) references auth.users(id) on delete restrict
);
alter table public.members enable row level security;
create policy members_self_insert on public.members for insert to authenticated with check (auth.uid() = user_id);
create policy members_self_select on public.members for select to authenticated using (auth.uid() = user_id);
create policy members_self_update on public.members for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.members from public, anon;
grant all on public.members to authenticated, service_role;

create table public.member_ref (
  user_id uuid not null primary key,
  stable_ref text not null unique,
  created_at timestamptz not null default now()
);

create table public.point_catalog (event_type text not null primary key, points integer not null, active boolean not null default true);
insert into public.point_catalog values ('profile_completed', 5, true);
create table public.point_events (
  id bigint generated by default as identity primary key,
  beneficiary_user_id uuid not null,
  actor_user_id uuid,
  event_type text not null,
  source_type text not null check (source_type = any (array['comment','reaction','recommendation','profile','trip','admin'])),
  source_id text,
  points integer not null,
  status text not null default 'active' check (status = any (array['active','revoked'])),
  unique_key text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text,
  created_by text not null default 'function'
);

create table public.comments (
  id bigint not null primary key,
  venue_id text not null,
  city text default 'Amsterdam'::text,
  email text,
  display_name text,
  body text,
  photo_url text,
  created_at timestamptz not null default now(),
  user_id uuid not null,
  hidden boolean not null default false
);
create table public.comment_reactions (comment_id bigint, user_id uuid, reaction text);

-- ---------------------------------------------------------------- fonksiyonlar (production pg_get_functiondef kopyası)
CREATE OR REPLACE FUNCTION public.guard_member_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce(auth.role(),'')='service_role' OR current_setting('asalocal.trusted',true)='1' THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF TG_OP='INSERT' THEN
    NEW.tier:='Kaşif'; NEW.points:=0; NEW.blocked:=false; NEW.user_id:=auth.uid();
  ELSE
    NEW.tier:=OLD.tier; NEW.points:=OLD.points; NEW.blocked:=OLD.blocked; NEW.user_id:=OLD.user_id;
  END IF;
  RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION public.member_upsert_profile(p_display_name text, p_bio text, p_home_city text, p_gender text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','no_auth'); END IF;
  INSERT INTO public.members(email,user_id,display_name,bio,home_city,gender,created_at,updated_at)
  VALUES ((auth.jwt()->>'email'),v_uid,p_display_name,p_bio,p_home_city,p_gender,now(),now())
  ON CONFLICT (user_id) DO UPDATE SET
    display_name=COALESCE(EXCLUDED.display_name, public.members.display_name),
    bio=COALESCE(EXCLUDED.bio, public.members.bio),
    home_city=COALESCE(EXCLUDED.home_city, public.members.home_city),
    gender=COALESCE(EXCLUDED.gender, public.members.gender),
    email=EXCLUDED.email, updated_at=now();
  RETURN jsonb_build_object('ok',true);
END $function$
;
CREATE OR REPLACE FUNCTION public._award(p_benef uuid, p_actor uuid, p_type text, p_src_type text, p_src_id text, p_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_pts int; v_day int; v_lock uuid;
BEGIN
  SELECT points INTO v_pts FROM public.point_catalog WHERE event_type=p_type AND active;
  IF v_pts IS NULL THEN RETURN false; END IF;
  SELECT user_id INTO v_lock FROM public.members WHERE user_id=p_benef FOR UPDATE;
  IF v_lock IS NULL THEN RETURN false; END IF;
  SELECT coalesce(sum(points),0) INTO v_day FROM public.point_events
    WHERE beneficiary_user_id=p_benef AND status='active' AND event_type<>'admin_adjustment' AND created_at > now()-interval '1 day';
  IF v_day + v_pts > 20 THEN RETURN false; END IF;
  INSERT INTO public.point_events(beneficiary_user_id,actor_user_id,event_type,source_type,source_id,points,unique_key,created_by)
  VALUES (p_benef,p_actor,p_type,p_src_type,p_src_id,v_pts,p_key,'function')
  ON CONFLICT (unique_key) DO NOTHING;
  RETURN true;
END $function$
;
CREATE OR REPLACE FUNCTION public._recompute_points(p_uid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_total int; v_tier text;
BEGIN
  SELECT GREATEST(coalesce(sum(points),0),0) INTO v_total FROM public.point_events WHERE beneficiary_user_id=p_uid AND status='active';
  v_tier := CASE WHEN v_total>=30 THEN 'Insider' WHEN v_total>=15 THEN 'Küratör' WHEN v_total>=5 THEN 'Şehirli' ELSE 'Kaşif' END;
  PERFORM set_config('asalocal.trusted','1',true);
  UPDATE public.members SET points=v_total, tier=v_tier, updated_at=now() WHERE user_id=p_uid;
  RETURN jsonb_build_object('points',v_total,'tier',v_tier);
END $function$
;
CREATE OR REPLACE FUNCTION public.complete_profile()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid:=auth.uid(); v_m record; v_pt jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','no_auth'); END IF;
  SELECT display_name,home_city,gender INTO v_m FROM public.members WHERE user_id=v_uid;
  IF v_m IS NULL OR coalesce(trim(v_m.display_name),'')='' OR coalesce(trim(v_m.home_city),'')='' OR coalesce(trim(v_m.gender),'')='' THEN
    RETURN jsonb_build_object('ok',false,'reason','incomplete_profile'); END IF;
  PERFORM public._award(v_uid,v_uid,'profile_completed','profile',v_uid::text,'profile_completed:'||v_uid);
  v_pt := public._recompute_points(v_uid);
  RETURN jsonb_build_object('ok',true,'points',v_pt->'points','tier',v_pt->'tier');
END $function$
;
CREATE OR REPLACE FUNCTION public._ensure_member_ref(p_uid uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v text; i int:=0;
begin
  select stable_ref into v from public.member_ref where user_id=p_uid;
  if v is not null then return v; end if;
  loop
    i:=i+1;
    begin
      v := left(replace(gen_random_uuid()::text,'-',''),18); -- 18 hex, kripto-random
      insert into public.member_ref(user_id,stable_ref) values(p_uid,v);
      return v;
    exception when unique_violation then
      if i>8 then raise; end if;
      select stable_ref into v from public.member_ref where user_id=p_uid;
      if v is not null then return v; end if;
    end;
  end loop;
end $function$
;
CREATE OR REPLACE FUNCTION public._member_ref_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$ begin perform public._ensure_member_ref(new.user_id); return new; end $function$
;
CREATE OR REPLACE FUNCTION public._auth_user_ref_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$ begin perform public._ensure_member_ref(new.id); return new; end $function$
;
-- STUB (bilinçli): WSE welcome seed. Production gövdesi auth.users.created_at + service_pref_defaults
-- okur ve member_service_pref_* yazar; e-posta/isim alanlarına dokunmaz. Model: no-op.
CREATE OR REPLACE FUNCTION public._seed_welcome_service_pref_on_member_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ begin return new; end $function$
;

-- production fonksiyon ACL'leri
revoke all on function public.guard_member_admin_fields() from public;
grant execute on function public.guard_member_admin_fields() to service_role;
revoke all on function public.member_upsert_profile(text, text, text, text) from public;
grant execute on function public.member_upsert_profile(text, text, text, text) to authenticated, service_role;
revoke all on function public.complete_profile() from public;
grant execute on function public.complete_profile() to authenticated, service_role;
revoke all on function public._award(uuid, uuid, text, text, text, text) from public;
grant execute on function public._award(uuid, uuid, text, text, text, text) to service_role;
revoke all on function public._recompute_points(uuid) from public;
grant execute on function public._recompute_points(uuid) to service_role;

-- triggerlar (production pg_get_triggerdef ile aynı)
CREATE TRIGGER members_admin_guard BEFORE INSERT OR UPDATE ON public.members FOR EACH ROW EXECUTE FUNCTION guard_member_admin_fields();
CREATE TRIGGER trg_member_ref AFTER INSERT ON public.members FOR EACH ROW EXECUTE FUNCTION _member_ref_trg();
CREATE TRIGGER trg_members_seed_welcome_service_pref AFTER INSERT ON public.members FOR EACH ROW EXECUTE FUNCTION _seed_welcome_service_pref_on_member_insert();
CREATE TRIGGER trg_auth_user_ref AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION _auth_user_ref_trg();

-- ---------------------------------------------------------------- view'lar (production tanımı + reloptions + ACL)
create view public.member_public with (security_invoker = false, security_barrier = true) as
  select display_name, tier from public.members where blocked = false;
create view public.comments_public with (security_invoker = false, security_barrier = true) as
  select c.id, c.venue_id, c.city, c.display_name, c.body, c.photo_url, c.created_at
    from public.comments c left join public.members m on m.user_id = c.user_id
   where c.hidden = false and coalesce(m.blocked, false) = false;
create view public.comment_reaction_counts with (security_invoker = false, security_barrier = true) as
  select cr.comment_id, cr.reaction, count(*)::integer as n
    from public.comment_reactions cr join public.comments c on c.id = cr.comment_id and c.hidden = false
    left join public.members m on m.user_id = cr.user_id
   where coalesce(m.blocked, false) = false
   group by cr.comment_id, cr.reaction;
-- production 2026-10-07 (SEC_VIEWS öncesi) ACL'i
grant all on public.member_public to anon, authenticated, service_role;
grant all on public.comments_public to anon, authenticated, service_role;
grant all on public.comment_reaction_counts to anon, authenticated, service_role;
-- SEC_VIEWS hotfix (sec_public_views_readonly) — SEC_VIEWS_up.sql ile birebir aynı REVOKE (WP5 önkoşulu)
revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.member_public, public.comments_public, public.comment_reaction_counts
  from anon, authenticated;

-- ---------------------------------------------------------------- Supabase varsayılan ayrıcalıkları (production pg_default_acl)
-- postgres'in public şemada oluşturduğu YENİ fonksiyonlar anon/authenticated/service_role'e EXECUTE alır.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

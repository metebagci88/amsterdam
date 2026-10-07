-- =====================================================================
-- ASALOCAL · SEC-MEDIA · STAGE 2 (İŞ PAKETİ 2) · S2_up.sql
-- Anonim Storage yazma izinlerini kapatma / Close anonymous write on bucket "media".
--
-- DURUM: HAZIRLIK PAKETİ — PRODUCTION'A UYGULANMADI (PREPARED ONLY, NOT APPLIED).
-- ÖNKOŞUL: Stage 1 (İŞ PAKETİ 1) SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS kanıtı olmadan
--          ÇALIŞTIRILMAZ. Bkz. S2_APPLY_ROLLBACK.md.
--
-- NE YAPAR / WHAT IT DOES
--   storage.objects üzerindeki TAM OLARAK şu üç policy'yi kaldırır (DROP POLICY IF EXISTS):
--     "media anon insert"  (INSERT, roles {public})
--     "media anon update"  (UPDATE, roles {public})
--     "media anon delete"  (DELETE, roles {public})
--   roles {public} = anon + authenticated -> ikisi de doğrudan Storage yazamaz.
--   service_role (BYPASSRLS) etkilenmez -> admin-api media_upload Edge yolu çalışmaya devam eder.
--
-- DOKUNMAZ / DOES NOT TOUCH
--   "media anon read" (public SELECT), storage.buckets (media public=true dahil),
--   email-assets-public / email-assets-draft, diğer tablo/policy/grant/trigger, Edge.
--
-- ÇALIŞTIRMA / HOW TO RUN (gövdede dış BEGIN/COMMIT YOK)
--   Supabase : apply_migration(name => 'sec_media_close_anon_write', query => <bu dosya>)
--              (apply_migration kendi transaction'ını açar -> atomik)
--   psql     : psql -1 -v ON_ERROR_STOP=1 -f S2_up.sql      (-1 ZORUNLU -> atomik)
--
-- GÜVENCELER / GUARANTEES
--   * PRE guard : canlı durum doğrulanmış baseline'dan sapmışsa (beklenmeyen policy, farklı
--                 tanım, bucket bayrağı, RLS kapalı) HİÇBİR ŞEY değiştirmeden durur.
--   * POST guard: son durum beklenen matris değilse RAISE -> tüm transaction geri alınır.
--   * İdempotent: ikinci çalıştırma no-op'tur ve aynı POST guard'dan geçer.
--   * lock_timeout 5s: storage.objects kilidi alınamazsa bekleyip trafiği kilitlemek yerine
--                 hata verir (değişiklik yok) -> daha sonra yeniden denenir.
-- =====================================================================

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- PRE guard (salt-okunur kontrol; drift varsa durur)
-- ---------------------------------------------------------------------
do $s2_pre$
declare
  v_unexpected text;
  v_bad        text;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity) then
    raise exception 'S2_PRE_FAIL: storage.objects yok veya RLS kapalı';
  end if;

  if not exists (select 1 from storage.buckets where id = 'media' and public is true) then
    raise exception 'S2_PRE_FAIL: bucket media yok veya public<>true';
  end if;
  if not exists (select 1 from storage.buckets where id = 'email-assets-public' and public is true)
     or not exists (select 1 from storage.buckets where id = 'email-assets-draft' and public is false) then
    raise exception 'S2_PRE_DRIFT: email-assets-* bucket bayrakları baseline ile uyuşmuyor';
  end if;

  -- storage.objects üzerinde baseline dışı policy olamaz (doğrulanmış baseline = 4 policy)
  select string_agg(format('%L', policyname), ', ' order by policyname) into v_unexpected
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname not in ('media anon read', 'media anon insert', 'media anon update', 'media anon delete');
  if v_unexpected is not null then
    raise exception 'S2_PRE_DRIFT: storage.objects üzerinde beklenmeyen policy: %', v_unexpected;
  end if;

  -- read policy mevcut ve birebir baseline tanımında olmalı
  if not exists (select 1 from pg_policies
                  where schemaname = 'storage' and tablename = 'objects' and policyname = 'media anon read'
                    and cmd = 'SELECT' and permissive = 'PERMISSIVE' and roles = array['public']::name[]
                    and qual = '(bucket_id = ''media''::text)' and with_check is null) then
    raise exception 'S2_PRE_DRIFT: "media anon read" yok veya tanımı baseline değil';
  end if;

  -- üç yazma policy'si: ya YOK (idempotent tekrar) ya da birebir baseline tanımında
  select string_agg(format('%L', p.policyname), ', ' order by p.policyname) into v_bad
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and p.policyname in ('media anon insert', 'media anon update', 'media anon delete')
     and not (
           p.permissive = 'PERMISSIVE' and p.roles = array['public']::name[]
       and (   (p.policyname = 'media anon insert' and p.cmd = 'INSERT'
                and p.qual is null and p.with_check = '(bucket_id = ''media''::text)')
            or (p.policyname = 'media anon update' and p.cmd = 'UPDATE'
                and p.qual = '(bucket_id = ''media''::text)' and p.with_check = '(bucket_id = ''media''::text)')
            or (p.policyname = 'media anon delete' and p.cmd = 'DELETE'
                and p.qual = '(bucket_id = ''media''::text)' and p.with_check is null)));
  if v_bad is not null then
    raise exception 'S2_PRE_DRIFT: yazma policy tanımı baseline değil (rollback belirsiz olur): %', v_bad;
  end if;
end
$s2_pre$;

-- ---------------------------------------------------------------------
-- DEĞİŞİKLİK: yalnız üç anonim yazma policy'si kaldırılır
-- ---------------------------------------------------------------------
drop policy if exists "media anon insert" on storage.objects;
drop policy if exists "media anon update" on storage.objects;
drop policy if exists "media anon delete" on storage.objects;

-- ---------------------------------------------------------------------
-- POST guard (beklenen son matris; değilse tüm transaction geri alınır)
-- ---------------------------------------------------------------------
do $s2_post$
declare
  v_names text;
  v_write bigint;
begin
  select string_agg(policyname, ',' order by policyname) into v_names
    from pg_policies where schemaname = 'storage' and tablename = 'objects';
  if v_names is distinct from 'media anon read' then
    raise exception 'S2_POST_FAIL: storage.objects policy kümesi beklenmedik: %', coalesce(v_names, '<none>');
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname = 'storage' and tablename = 'objects' and policyname = 'media anon read'
                    and cmd = 'SELECT' and permissive = 'PERMISSIVE' and roles = array['public']::name[]
                    and qual = '(bucket_id = ''media''::text)' and with_check is null) then
    raise exception 'S2_POST_FAIL: "media anon read" korunmadı';
  end if;

  select count(*) into v_write
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and roles && array['public', 'anon', 'authenticated']::name[];
  if v_write <> 0 then
    raise exception 'S2_POST_FAIL: public/anon/authenticated için yazma policy''si kaldı (%)', v_write;
  end if;

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity) then
    raise exception 'S2_POST_FAIL: storage.objects RLS kapalı';
  end if;

  if not exists (select 1 from storage.buckets where id = 'media' and public is true)
     or not exists (select 1 from storage.buckets where id = 'email-assets-public' and public is true)
     or not exists (select 1 from storage.buckets where id = 'email-assets-draft' and public is false) then
    raise exception 'S2_POST_FAIL: bucket bayrakları değişti';
  end if;

  raise notice 'S2_UP_OK: anon/authenticated media INSERT/UPDATE/DELETE policy yok; "media anon read" + media public=true korundu';
end
$s2_post$;

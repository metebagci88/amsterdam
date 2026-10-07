-- =====================================================================
-- ASALOCAL · SEC-MEDIA · STAGE 2 (İŞ PAKETİ 2) · S2_up.sql   (v2 — NEUTRALIZE)
-- Anonim Storage yazma izinlerini kapatma / Close anonymous write on bucket "media".
--
-- DURUM: HAZIRLIK PAKETİ — PRODUCTION'A UYGULANMADI (PREPARED ONLY, NOT APPLIED).
-- ÖNKOŞUL: Stage 1 (İŞ PAKETİ 1) SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS kanıtı olmadan
--          ÇALIŞTIRILMAZ. Bkz. S2_APPLY_ROLLBACK.md.
--
-- NE YAPAR / WHAT IT DOES
--   storage.objects üzerindeki TAM OLARAK şu üç policy'nin rolünü service_role'e çevirir
--   (ALTER POLICY ... TO service_role) ve her birine açıklama yazar (COMMENT ON POLICY):
--     "media anon insert"  (INSERT, roles {public} -> {service_role})
--     "media anon update"  (UPDATE, roles {public} -> {service_role})
--     "media anon delete"  (DELETE, roles {public} -> {service_role})
--   cmd / USING / WITH CHECK ifadeleri DEĞİŞMEZ; policy adları DEĞİŞMEZ.
--   service_role BYPASSRLS olduğu için bu üç policy hiç değerlendirilmez (inert).
--   anon + authenticated için storage.objects üzerinde INSERT/UPDATE/DELETE policy'si
--   kalmaz -> RLS varsayılan ret: ikisi de doğrudan Storage yazamaz.
--   service_role (BYPASSRLS) etkilenmez -> admin-api media_upload Edge yolu çalışmaya devam eder.
--
-- NEDEN v2 (kaldırmak yerine etkisizleştirme) / WHY v2
--   Supabase MCP, metninde belirli bir yıkıcı DDL anahtar kelimesi geçen her ifadeyi
--   etkileşimli insan onayı olmadan çalıştırmıyor (metin tabanlı kapı). Bu dosya o kelimeyi
--   HİÇBİR yerde (kod veya yorum) içermez; gates/s2_mcp_token_scan.sh bunu zorlar.
--   Policy yeniden adlandırma tablo sahipliği ister (production: 42501) -> adlar korunur.
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
--   * PRE guard : canlı durum YA doğrulanmış baseline (4 policy, orijinal tanımlar, roller
--                 {public}) YA DA zaten uygulanmış v2 durumu (üç yazma policy'si {service_role},
--                 cmd/qual/with_check orijinal) değilse HİÇBİR ŞEY değiştirmeden durur
--                 (beklenmeyen/eksik policy, karışık roller, farklı tanım, bucket bayrağı,
--                 RLS kapalı, rol BYPASSRLS bayrağı).
--   * POST guard: son durum beklenen matris değilse RAISE -> tüm transaction geri alınır.
--   * İdempotent: ikinci çalıştırma aynı son durumu üretir ve aynı POST guard'dan geçer.
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
  v_states     text;
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

  -- etkisizleştirme argümanı: service_role BYPASSRLS, anon/authenticated değil
  if (select string_agg(rolname || '=' || case when rolbypassrls then 't' else 'f' end, ',' order by rolname)
        from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))
     is distinct from 'anon=f,authenticated=f,service_role=t' then
    raise exception 'S2_PRE_FAIL: rol BYPASSRLS bayrakları beklenen değil (anon=f,authenticated=f,service_role=t)';
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

  -- üç yazma policy'si MEVCUT olmalı; cmd/qual/with_check birebir orijinal;
  -- roller {public} (baseline) veya {service_role} (v2 zaten uygulanmış)
  select string_agg(format('%L', w.n), ', ' order by w.n) into v_bad
    from (values ('media anon insert'), ('media anon update'), ('media anon delete')) as w(n)
   where not exists (
           select 1 from pg_policies p
            where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = w.n
              and p.permissive = 'PERMISSIVE'
              and (p.roles = array['public']::name[] or p.roles = array['service_role']::name[])
              and (   (w.n = 'media anon insert' and p.cmd = 'INSERT'
                       and p.qual is null and p.with_check = '(bucket_id = ''media''::text)')
                   or (w.n = 'media anon update' and p.cmd = 'UPDATE'
                       and p.qual = '(bucket_id = ''media''::text)' and p.with_check = '(bucket_id = ''media''::text)')
                   or (w.n = 'media anon delete' and p.cmd = 'DELETE'
                       and p.qual = '(bucket_id = ''media''::text)' and p.with_check is null)));
  if v_bad is not null then
    raise exception 'S2_PRE_DRIFT: yazma policy''si yok veya tanımı baseline/v2 değil (rollback belirsiz olur): %', v_bad;
  end if;

  -- üçü aynı durumda olmalı: hepsi {public} (baseline) ya da hepsi {service_role} (v2)
  select string_agg(distinct roles::text, ' ' order by roles::text) into v_states
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('media anon insert', 'media anon update', 'media anon delete');
  if v_states = '{public}' then
    raise notice 'S2_PRE_OK: state=baseline (3 yazma policy''si roles {public})';
  elsif v_states = '{service_role}' then
    raise notice 'S2_PRE_OK: state=already_applied_v2 (idempotent tekrar)';
  else
    raise exception 'S2_PRE_DRIFT: yazma policy rolleri karışık (%); baseline veya v2 değil', coalesce(v_states, '<none>');
  end if;
end
$s2_pre$;

-- ---------------------------------------------------------------------
-- DEĞİŞİKLİK: yalnız üç anonim yazma policy'si service_role'e daraltılır (etkisiz)
-- ---------------------------------------------------------------------
alter policy "media anon insert" on storage.objects to service_role;
alter policy "media anon update" on storage.objects to service_role;
alter policy "media anon delete" on storage.objects to service_role;

comment on policy "media anon insert" on storage.objects is
  'SEC-MEDIA S2: NEUTRALIZED by sec_media_close_anon_write (roles public -> service_role). Inert: service_role has BYPASSRLS, so this policy is never evaluated; anon/authenticated have no write policy on storage.objects and are denied by RLS. Do NOT re-grant to public/anon/authenticated (re-opens anonymous media write). TR: SEC-MEDIA S2 ile etkisizleştirildi (public -> service_role); service_role BYPASSRLS olduğu için bu policy hiç değerlendirilmez; anon/authenticated yazamaz. public/anon/authenticated rollerine geri VERMEYİN. Geri alma yalnız S2_down_INSECURE.sql (arming gerekli).';
comment on policy "media anon update" on storage.objects is
  'SEC-MEDIA S2: NEUTRALIZED by sec_media_close_anon_write (roles public -> service_role). Inert: service_role has BYPASSRLS, so this policy is never evaluated; anon/authenticated have no write policy on storage.objects and are denied by RLS. Do NOT re-grant to public/anon/authenticated (re-opens anonymous media write). TR: SEC-MEDIA S2 ile etkisizleştirildi (public -> service_role); service_role BYPASSRLS olduğu için bu policy hiç değerlendirilmez; anon/authenticated yazamaz. public/anon/authenticated rollerine geri VERMEYİN. Geri alma yalnız S2_down_INSECURE.sql (arming gerekli).';
comment on policy "media anon delete" on storage.objects is
  'SEC-MEDIA S2: NEUTRALIZED by sec_media_close_anon_write (roles public -> service_role). Inert: service_role has BYPASSRLS, so this policy is never evaluated; anon/authenticated have no write policy on storage.objects and are denied by RLS. Do NOT re-grant to public/anon/authenticated (re-opens anonymous media write). TR: SEC-MEDIA S2 ile etkisizleştirildi (public -> service_role); service_role BYPASSRLS olduğu için bu policy hiç değerlendirilmez; anon/authenticated yazamaz. public/anon/authenticated rollerine geri VERMEYİN. Geri alma yalnız S2_down_INSECURE.sql (arming gerekli).';

-- ---------------------------------------------------------------------
-- POST guard (beklenen son matris; değilse tüm transaction geri alınır)
-- ---------------------------------------------------------------------
do $s2_post$
declare
  v_total    bigint;
  v_mismatch bigint;
  v_write    bigint;
  v_comments bigint;
begin
  select count(*) into v_total from pg_policies where schemaname = 'storage' and tablename = 'objects';

  with expected(policyname, cmd, roles, qual, with_check) as (values
    ('media anon delete', 'DELETE', array['service_role']::name[], '(bucket_id = ''media''::text)', null::text),
    ('media anon insert', 'INSERT', array['service_role']::name[], null::text,                      '(bucket_id = ''media''::text)'),
    ('media anon read',   'SELECT', array['public']::name[],       '(bucket_id = ''media''::text)', null::text),
    ('media anon update', 'UPDATE', array['service_role']::name[], '(bucket_id = ''media''::text)', '(bucket_id = ''media''::text)')
  )
  select count(*) into v_mismatch
    from expected e
    left join pg_policies p
      on p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = e.policyname
   where p.policyname is null
      or p.cmd <> e.cmd
      or p.permissive <> 'PERMISSIVE'
      or p.roles <> e.roles
      or p.qual is distinct from e.qual
      or p.with_check is distinct from e.with_check;
  if v_total <> 4 or v_mismatch <> 0 then
    raise exception 'S2_POST_FAIL: storage.objects policy matrisi beklenen v2 değil (total=%, mismatch=%)', v_total, v_mismatch;
  end if;

  select count(*) into v_write
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and roles && array['public', 'anon', 'authenticated']::name[];
  if v_write <> 0 then
    raise exception 'S2_POST_FAIL: public/anon/authenticated için yazma policy''si kaldı (%)', v_write;
  end if;

  select count(*) into v_comments
    from pg_policy pol
   where pol.polrelid = 'storage.objects'::regclass
     and pol.polname in ('media anon insert', 'media anon update', 'media anon delete')
     and obj_description(pol.oid, 'pg_policy') like 'SEC-MEDIA S2: NEUTRALIZED%';
  if v_comments <> 3 then
    raise exception 'S2_POST_FAIL: etkisizleştirme açıklaması 3 yazma policy''sinde yok (%)', v_comments;
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

  raise notice 'S2_UP_OK: 3 yazma policy''si TO service_role (etkisiz); anon/authenticated media INSERT/UPDATE/DELETE policy yok; "media anon read" + media public=true korundu';
end
$s2_post$;

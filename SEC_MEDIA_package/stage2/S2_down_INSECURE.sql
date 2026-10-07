-- =====================================================================
-- ASALOCAL · SEC-MEDIA · STAGE 2 · S2_down_INSECURE.sql   (v2)
--
--   !!! INSECURE ROLLBACK — GÜVENLİĞİ GEVŞETİR / SECURITY-LOOSENING !!!
--   Bu dosya media bucket'ında ANONİM YAZMAYI YENİDEN AÇAR: herkes (anon key ile)
--   media'ya dosya ekleyebilir, değiştirebilir, silebilir. S2_up.sql'in kapattığı açığı
--   geri getirir.
--
--   * ASLA otomatik çalıştırılmaz; CI/CD, migration zinciri veya "down" script'ine KONMAZ.
--   * Yalnız Mete'nin AÇIK, yazılı kararıyla ve yalnız S2_up.sql'in admin yükleme akışını
--     bozduğu kanıtlanırsa (ve Edge düzeltmesi mümkün değilse) kullanılır.
--   * Varsayılan olarak SİLAHSIZDIR: aynı transaction'da arming GUC'u set edilmeden
--     ilk DO bloğu hata verir ve HİÇBİR ŞEY değişmez.
--
-- ARMING (aynı transaction içinde, dosyadan ÖNCE):
--   set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE';
--   Supabase : apply_migration(name => 'sec_media_s2_rollback_insecure',
--                              query => <yukarıdaki SET LOCAL satırı> + <bu dosya>)
--   psql     : psql -1 -v ON_ERROR_STOP=1 \
--                -c "set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE'" \
--                -f S2_down_INSECURE.sql
--
-- NE YAPAR: yalnız S2_up.sql'in service_role'e daralttığı üç policy'nin rolünü baseline'daki
--   {public}'e geri çevirir (ALTER POLICY ... TO public) ve S2 açıklamasını siler
--   (COMMENT ON POLICY ... IS NULL). cmd/USING/WITH CHECK zaten orijinaldir (PRE guard
--   doğrular). Sonuç canlı baseline ile BİREBİR aynıdır:
--     "media anon insert"  INSERT TO public WITH CHECK (bucket_id = 'media'::text)
--     "media anon update"  UPDATE TO public USING (bucket_id = 'media'::text)
--                                          WITH CHECK (bucket_id = 'media'::text)
--     "media anon delete"  DELETE TO public USING (bucket_id = 'media'::text)
--   İdempotent: zaten baseline'daysa aynı sonucu üretir.
--   Bu dosya da Supabase MCP metin kapısına takılan yıkıcı DDL anahtar kelimesini HİÇBİR
--   yerde içermez (gates/s2_mcp_token_scan.sh).
-- DOKUNMAZ: "media anon read", storage.buckets, email-assets-*, diğer her şey.
-- POST guard: sonuç birebir 4-policy baseline matrisi (md5 677c0f6b0f4fd37bb8b4fb7959a495fb,
--   s2_pre_assert.sql satır 6 formülü) + açıklamalar NULL değilse tüm transaction geri alınır.
-- =====================================================================

do $s2_arm$
begin
  if coalesce(current_setting('sec_media.s2_insecure_rollback', true), '') <> 'REOPEN_ANON_WRITE' then
    raise exception 'S2_DOWN_INSECURE_NOT_ARMED: bu rollback anonim yazmayı yeniden açar; aynı transaction''da set local sec_media.s2_insecure_rollback = ''REOPEN_ANON_WRITE'' gerekli. Hiçbir şey değişmedi.';
  end if;
  raise warning 'S2_DOWN_INSECURE_ARMED: media anonim INSERT/UPDATE/DELETE yeniden açılıyor (INSECURE)';
end
$s2_arm$;

set local lock_timeout = '5s';

-- PRE guard: yalnız bilinen 4 policy; read birebir; üç yazma policy'si mevcut, tanımı orijinal,
-- rolü {service_role} (S2 v2) veya {public} (zaten baseline); media public
do $s2_down_pre$
declare
  v_unexpected text;
  v_bad        text;
begin
  select string_agg(format('%L', policyname), ', ' order by policyname) into v_unexpected
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname not in ('media anon read', 'media anon insert', 'media anon update', 'media anon delete');
  if v_unexpected is not null then
    raise exception 'S2_DOWN_PRE_DRIFT: storage.objects üzerinde beklenmeyen policy: %', v_unexpected;
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'storage' and tablename = 'objects' and policyname = 'media anon read'
                    and cmd = 'SELECT' and permissive = 'PERMISSIVE' and roles = array['public']::name[]
                    and qual = '(bucket_id = ''media''::text)' and with_check is null) then
    raise exception 'S2_DOWN_PRE_DRIFT: "media anon read" yok veya tanımı baseline değil';
  end if;
  select string_agg(format('%L', w.n), ', ' order by w.n) into v_bad
    from (values ('media anon insert'), ('media anon update'), ('media anon delete')) as w(n)
   where not exists (
           select 1 from pg_policies p
            where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = w.n
              and p.permissive = 'PERMISSIVE'
              and (p.roles = array['service_role']::name[] or p.roles = array['public']::name[])
              and (   (w.n = 'media anon insert' and p.cmd = 'INSERT'
                       and p.qual is null and p.with_check = '(bucket_id = ''media''::text)')
                   or (w.n = 'media anon update' and p.cmd = 'UPDATE'
                       and p.qual = '(bucket_id = ''media''::text)' and p.with_check = '(bucket_id = ''media''::text)')
                   or (w.n = 'media anon delete' and p.cmd = 'DELETE'
                       and p.qual = '(bucket_id = ''media''::text)' and p.with_check is null)));
  if v_bad is not null then
    raise exception 'S2_DOWN_PRE_DRIFT: yazma policy''si yok veya tanımı orijinal değil: % (bu dosya yalnız rol çevirir; yeniden oluşturma için S2_APPLY_ROLLBACK.md §5)', v_bad;
  end if;
  if not exists (select 1 from storage.buckets where id = 'media' and public is true) then
    raise exception 'S2_DOWN_PRE_FAIL: bucket media yok veya public<>true';
  end if;
end
$s2_down_pre$;

alter policy "media anon insert" on storage.objects to public;
alter policy "media anon update" on storage.objects to public;
alter policy "media anon delete" on storage.objects to public;

comment on policy "media anon insert" on storage.objects is null;
comment on policy "media anon update" on storage.objects is null;
comment on policy "media anon delete" on storage.objects is null;

-- POST guard: birebir 4-policy baseline matrisi + S2 açıklamaları yok
do $s2_down_post$
declare
  v_mismatch bigint;
  v_total    bigint;
  v_md5      text;
  v_comments bigint;
begin
  with expected(policyname, cmd, qual, with_check) as (values
    ('media anon delete', 'DELETE', '(bucket_id = ''media''::text)', null::text),
    ('media anon insert', 'INSERT', null::text,                      '(bucket_id = ''media''::text)'),
    ('media anon read',   'SELECT', '(bucket_id = ''media''::text)', null::text),
    ('media anon update', 'UPDATE', '(bucket_id = ''media''::text)', '(bucket_id = ''media''::text)')
  )
  select count(*) into v_mismatch
    from expected e
    left join pg_policies p
      on p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = e.policyname
   where p.policyname is null
      or p.cmd <> e.cmd
      or p.permissive <> 'PERMISSIVE'
      or p.roles <> array['public']::name[]
      or p.qual is distinct from e.qual
      or p.with_check is distinct from e.with_check;
  select count(*) into v_total from pg_policies where schemaname = 'storage' and tablename = 'objects';
  -- s2_pre_assert.sql satır 6 ile aynı formül
  select coalesce(md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                                 || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>'),
                                 E'\n' order by policyname)), '<none>') into v_md5
    from pg_policies where schemaname = 'storage' and tablename = 'objects';
  select count(*) into v_comments
    from pg_policy pol
   where pol.polrelid = 'storage.objects'::regclass
     and pol.polname in ('media anon insert', 'media anon update', 'media anon delete')
     and obj_description(pol.oid, 'pg_policy') is not null;
  if v_mismatch <> 0 or v_total <> 4 or v_md5 <> '677c0f6b0f4fd37bb8b4fb7959a495fb' or v_comments <> 0 then
    raise exception 'S2_DOWN_POST_FAIL: baseline matrisi geri gelmedi (mismatch=%, total=%, md5=%, comments=%)',
      v_mismatch, v_total, v_md5, v_comments;
  end if;
  if not exists (select 1 from storage.buckets where id = 'media' and public is true) then
    raise exception 'S2_DOWN_POST_FAIL: bucket media public<>true';
  end if;
  raise warning 'S2_DOWN_INSECURE_APPLIED: baseline 4 policy (roles {public}) geri geldi — media ANONİM YAZMAYA AÇIK (INSECURE)';
end
$s2_down_post$;

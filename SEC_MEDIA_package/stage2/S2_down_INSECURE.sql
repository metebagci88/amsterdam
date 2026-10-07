-- =====================================================================
-- ASALOCAL · SEC-MEDIA · STAGE 2 · S2_down_INSECURE.sql
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
-- NE YAPAR: yalnız S2_up.sql'in kaldırdığı üç policy'yi canlı baseline'daki BİREBİR
--   tanımlarıyla geri oluşturur (drop-if-exists + create => idempotent, tanım kesin):
--     "media anon insert"  INSERT TO public WITH CHECK (bucket_id = 'media'::text)
--     "media anon update"  UPDATE TO public USING (bucket_id = 'media'::text)
--                                          WITH CHECK (bucket_id = 'media'::text)
--     "media anon delete"  DELETE TO public USING (bucket_id = 'media'::text)
-- DOKUNMAZ: "media anon read", storage.buckets, email-assets-*, diğer her şey.
-- POST guard: sonuç birebir 4-policy baseline matrisi değilse tüm transaction geri alınır.
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

-- PRE guard: yalnız bilinen policy adları + read policy birebir + media public
do $s2_down_pre$
declare
  v_unexpected text;
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
  if not exists (select 1 from storage.buckets where id = 'media' and public is true) then
    raise exception 'S2_DOWN_PRE_FAIL: bucket media yok veya public<>true';
  end if;
end
$s2_down_pre$;

drop policy if exists "media anon insert" on storage.objects;
create policy "media anon insert" on storage.objects
  as permissive for insert to public
  with check (bucket_id = 'media'::text);

drop policy if exists "media anon update" on storage.objects;
create policy "media anon update" on storage.objects
  as permissive for update to public
  using (bucket_id = 'media'::text)
  with check (bucket_id = 'media'::text);

drop policy if exists "media anon delete" on storage.objects;
create policy "media anon delete" on storage.objects
  as permissive for delete to public
  using (bucket_id = 'media'::text);

-- POST guard: birebir 4-policy baseline matrisi
do $s2_down_post$
declare
  v_mismatch bigint;
  v_total    bigint;
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
  if v_mismatch <> 0 or v_total <> 4 then
    raise exception 'S2_DOWN_POST_FAIL: baseline matrisi geri gelmedi (mismatch=%, total=%)', v_mismatch, v_total;
  end if;
  if not exists (select 1 from storage.buckets where id = 'media' and public is true) then
    raise exception 'S2_DOWN_POST_FAIL: bucket media public<>true';
  end if;
  raise warning 'S2_DOWN_INSECURE_APPLIED: baseline 4 policy geri geldi — media ANONİM YAZMAYA AÇIK (INSECURE)';
end
$s2_down_post$;

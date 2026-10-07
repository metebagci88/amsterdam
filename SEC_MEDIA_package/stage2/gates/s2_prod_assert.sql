-- =====================================================================
-- SEC-MEDIA · STAGE 2 · gates/s2_prod_assert.sql   (SALT-OKUNUR / READ-ONLY)   (v2 — NEUTRALIZE)
-- S2_up.sql production'a uygulandıktan SONRA çalıştırılır (Supabase execute_sql).
-- Beklenen POST policy matrisi + korunan bucket'lar + ledger kaydı + residue.
-- Yalnız SELECT; hiçbir şey yazmaz. Beklenen: OVERALL = S2_PROD_ASSERT_PASS (0 FAIL / 19 counted).
-- v2 POST matrisi: 4 policy kalır; "media anon read" baseline (SELECT, {public}); üç yazma policy'si
-- roles {service_role} (BYPASSRLS -> etkisiz), cmd/qual/with_check orijinal; public/anon/authenticated
-- için yazma policy'si 0. Satır 7 md5'i s2_pre_assert.sql satır 6 ile AYNI formülle hesaplanır:
--   md5(string_agg(ad|cmd|roller|permissive|qual|with_check, E'\n' order by ad)) = 74b56eca9c133d987aa2ac056b412473
-- Satır 18: üç yazma policy'sinde S2 etkisizleştirme açıklaması (COMMENT ON POLICY) mevcut.
-- Satır 13 (media object count) beklentisi = s2_pre_assert.sql'de kaydedilen PRE değeri
-- (2026-10-07 baseline: 0). PRE farklı kaydedildiyse karşılaştırma o değere göre yapılır.
-- Satır 20/21 = PRD "Diğer bucket/policy'lerde değişiklik yok" POST kanıtı. Beklenen literal,
-- s2_pre_assert.sql satır 20/21 ile BİREBİR aynıdır; P1 (pre_assert) PASS verdiyse bu literal
-- P1'de kaydedilen PRE değerinin kendisidir => POST == PRE. Formül iki dosyada aynıdır.
--   20: pg_policies (storage.objects HARİÇ tümü) count:md5 — schema.table|ad|cmd|roller|permissive|qual|with_check
--   21: storage.buckets count:md5 — id|name|public|file_size_limit|allowed_mime_types|type|versioning_status
-- =====================================================================
with pol as (
  select policyname, cmd, roles::text as roles, permissive, qual, with_check
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
),
def as (
  select policyname,
         cmd || '|' || roles || '|' || permissive || '|' || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>') as d
    from pol
),
chk(ord, check_name, expected, actual, counted) as (
  select 1, 'storage.objects policy count', '4', (select count(*)::text from pol), true
  union all
  select 2, 'policy "media anon read" preserved',
         'SELECT|{public}|PERMISSIVE|(bucket_id = ''media''::text)|<null>',
         coalesce((select d from def where policyname = 'media anon read'), '<absent>'), true
  union all
  select 3, 'policy "media anon insert" neutralized (TO service_role, definition unchanged)',
         'INSERT|{service_role}|PERMISSIVE|<null>|(bucket_id = ''media''::text)',
         coalesce((select d from def where policyname = 'media anon insert'), '<absent>'), true
  union all
  select 4, 'policy "media anon update" neutralized (TO service_role, definition unchanged)',
         'UPDATE|{service_role}|PERMISSIVE|(bucket_id = ''media''::text)|(bucket_id = ''media''::text)',
         coalesce((select d from def where policyname = 'media anon update'), '<absent>'), true
  union all
  select 5, 'policy "media anon delete" neutralized (TO service_role, definition unchanged)',
         'DELETE|{service_role}|PERMISSIVE|(bucket_id = ''media''::text)|<null>',
         coalesce((select d from def where policyname = 'media anon delete'), '<absent>'), true
  union all
  select 6, 'write-capable policies for public/anon/authenticated', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
             and roles && array['public', 'anon', 'authenticated']::name[]), true
  union all
  select 7, 'policy matrix md5 (expected POST v2; same formula as s2_pre_assert row 6)',
         '74b56eca9c133d987aa2ac056b412473',
         (select coalesce(md5(string_agg(policyname || '|' || d, E'\n' order by policyname)), '<none>') from def), true
  union all
  select 8, 'storage.objects RLS enabled', 'true',
         (select c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'storage' and c.relname = 'objects'), true
  union all
  select 9, 'bucket media public (unchanged)', 'true',
         coalesce((select public::text from storage.buckets where id = 'media'), '<absent>'), true
  union all
  select 10, 'bucket email-assets-public public (unchanged)', 'true',
         coalesce((select public::text from storage.buckets where id = 'email-assets-public'), '<absent>'), true
  union all
  select 11, 'bucket email-assets-draft public (unchanged)', 'false',
         coalesce((select public::text from storage.buckets where id = 'email-assets-draft'), '<absent>'), true
  union all
  select 12, 'bucket set (unchanged)', 'email-assets-draft,email-assets-public,media',
         (select coalesce(string_agg(id, ',' order by id), '<none>') from storage.buckets), true
  union all
  select 13, 'media object count = PRE (residue 0)', '0',
         (select count(*)::text from storage.objects where bucket_id = 'media'), true
  union all
  select 14, 'zero-footprint test residue (zz-sec-media-s2-zf/%)', '0',
         (select count(*)::text from storage.objects where name like 'zz-sec-media-s2-zf/%'), true
  union all
  select 15, 'ledger: sec_media_close_anon_write recorded', '1',
         (select count(*)::text from supabase_migrations.schema_migrations where name = 'sec_media_close_anon_write'), true
  union all
  select 16, 'role BYPASSRLS (anon,authenticated,service_role)', 'anon=f,authenticated=f,service_role=t',
         (select string_agg(rolname || '=' || case when rolbypassrls then 't' else 'f' end, ',' order by rolname)
            from pg_roles where rolname in ('anon', 'authenticated', 'service_role')), true
  union all
  select 17, 'storage.objects triggers (INFO; S2 dokunmaz)',
         'protect_objects_delete,update_objects_updated_at',
         (select coalesce(string_agg(tgname::text, ',' order by tgname), '<none>') from pg_trigger
           where tgrelid = 'storage.objects'::regclass and not tgisinternal), false
  union all
  select 18, 'S2 neutralization comment on the 3 write policies', '3',
         (select count(*)::text from pg_policy pol
           where pol.polrelid = 'storage.objects'::regclass
             and pol.polname in ('media anon insert', 'media anon update', 'media anon delete')
             and obj_description(pol.oid, 'pg_policy') like 'SEC-MEDIA S2: NEUTRALIZED%'), true
  union all
  select 20, 'other policies (pg_policies except storage.objects) count:md5 unchanged (== PRE, P1)',
         '25:45f0c3ac7e466783e9e3fa3702183b28',
         (select count(*)::text || ':' || coalesce(md5(string_agg(
                   schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || permissive
                   || '|' || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>'),
                   E'\n' order by schemaname, tablename, policyname)), '<none>')
            from pg_policies
           where not (schemaname = 'storage' and tablename = 'objects')), true
  union all
  select 21, 'storage.buckets attributes (id,name,public,file_size_limit,allowed_mime_types,type,versioning_status) count:md5 unchanged (== PRE, P1)',
         '3:e112c7b7523616c45bd38bf2c8c45064',
         (select count(*)::text || ':' || coalesce(md5(string_agg(
                   id || '|' || name || '|' || coalesce(public::text, '<null>') || '|' || coalesce(file_size_limit::text, '<null>')
                   || '|' || coalesce(allowed_mime_types::text, '<null>') || '|' || coalesce(type::text, '<null>')
                   || '|' || coalesce(versioning_status, '<null>'),
                   E'\n' order by id collate "C")), '<none>')
            from storage.buckets), true
)
select ord, check_name, expected, actual,
       case when not counted then 'INFO' when expected = actual then 'PASS' else 'FAIL' end as result
  from chk
union all
select 99, 'OVERALL', 'all counted rows PASS',
       (select count(*) filter (where counted and expected <> actual) || ' FAIL / ' || count(*) filter (where counted) || ' counted' from chk),
       case when (select bool_and(expected = actual) filter (where counted) from chk)
            then 'S2_PROD_ASSERT_PASS' else 'S2_PROD_ASSERT_FAIL' end
order by ord;

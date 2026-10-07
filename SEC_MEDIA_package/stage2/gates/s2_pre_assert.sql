-- =====================================================================
-- SEC-MEDIA · STAGE 2 · gates/s2_pre_assert.sql   (SALT-OKUNUR / READ-ONLY)
-- S2_up.sql UYGULANMADAN ÖNCE production'da çalıştırılır (Supabase execute_sql).
-- Canlı policy'leri ad/rol/ifade düzeyinde kaydeder (actual kolonu) ve 2026-10-07'de
-- read-only doğrulanmış baseline ile karşılaştırır. Yalnız SELECT; hiçbir şey yazmaz.
-- Beklenen: tüm satırlar PASS (INFO satırları sayılmaz) ve OVERALL = S2_PRE_ASSERT_PASS.
-- Herhangi bir FAIL => S2 uygulanmaz, STOP raporu.
-- (S2 uygulandıktan SONRA çalıştırılırsa policy satırları kasıtlı olarak FAIL verir.)
-- Satır 20/21 = PRD "Diğer bucket/policy'lerde değişiklik yok" PRE kanıtı (P1). actual kolonu
-- PRE değeridir; beklenen literal 2026-10-07 production read-only ölçümüdür ve s2_prod_assert.sql
-- satır 20/21 ile BİREBİR aynıdır. Production değeri meşru biçimde değiştiyse => STOP; iki dosya
-- birlikte yeniden baseline'lanır (SHA256SUMS yeniden üretilir), sonra yeniden P1.
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
  select 2, 'policy "media anon read"',
         'SELECT|{public}|PERMISSIVE|(bucket_id = ''media''::text)|<null>',
         coalesce((select d from def where policyname = 'media anon read'), '<absent>'), true
  union all
  select 3, 'policy "media anon insert"',
         'INSERT|{public}|PERMISSIVE|<null>|(bucket_id = ''media''::text)',
         coalesce((select d from def where policyname = 'media anon insert'), '<absent>'), true
  union all
  select 4, 'policy "media anon update"',
         'UPDATE|{public}|PERMISSIVE|(bucket_id = ''media''::text)|(bucket_id = ''media''::text)',
         coalesce((select d from def where policyname = 'media anon update'), '<absent>'), true
  union all
  select 5, 'policy "media anon delete"',
         'DELETE|{public}|PERMISSIVE|(bucket_id = ''media''::text)|<null>',
         coalesce((select d from def where policyname = 'media anon delete'), '<absent>'), true
  union all
  select 6, 'policy matrix md5 (prod baseline 2026-10-07)',
         '677c0f6b0f4fd37bb8b4fb7959a495fb',
         (select coalesce(md5(string_agg(policyname || '|' || d, E'\n' order by policyname)), '<none>') from def), true
  union all
  select 7, 'storage.objects RLS enabled', 'true',
         (select c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'storage' and c.relname = 'objects'), true
  union all
  select 8, 'bucket media public', 'true',
         coalesce((select public::text from storage.buckets where id = 'media'), '<absent>'), true
  union all
  select 9, 'bucket email-assets-public public', 'true',
         coalesce((select public::text from storage.buckets where id = 'email-assets-public'), '<absent>'), true
  union all
  select 10, 'bucket email-assets-draft public', 'false',
         coalesce((select public::text from storage.buckets where id = 'email-assets-draft'), '<absent>'), true
  union all
  select 11, 'bucket set', 'email-assets-draft,email-assets-public,media',
         (select coalesce(string_agg(id, ',' order by id), '<none>') from storage.buckets), true
  union all
  select 12, 'media object count (PRE; Stage 1 residue=0)', '0',
         (select count(*)::text from storage.objects where bucket_id = 'media'), true
  union all
  select 13, 'ledger: sec_media_close_anon_write not yet applied', '0',
         (select count(*)::text from supabase_migrations.schema_migrations where name = 'sec_media_close_anon_write'), true
  union all
  select 14, 'role BYPASSRLS (anon,authenticated,service_role)', 'anon=f,authenticated=f,service_role=t',
         (select string_agg(rolname || '=' || case when rolbypassrls then 't' else 'f' end, ',' order by rolname)
            from pg_roles where rolname in ('anon', 'authenticated', 'service_role')), true
  union all
  select 15, 'storage.objects triggers (INFO; zero-footprint testi hesaba katar)',
         'protect_objects_delete,update_objects_updated_at',
         (select coalesce(string_agg(tgname::text, ',' order by tgname), '<none>') from pg_trigger
           where tgrelid = 'storage.objects'::regclass and not tgisinternal), false
  union all
  select 20, 'other policies (pg_policies except storage.objects) count:md5 = PRE baseline 2026-10-07',
         '25:45f0c3ac7e466783e9e3fa3702183b28',
         (select count(*)::text || ':' || coalesce(md5(string_agg(
                   schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || permissive
                   || '|' || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>'),
                   E'\n' order by schemaname, tablename, policyname)), '<none>')
            from pg_policies
           where not (schemaname = 'storage' and tablename = 'objects')), true
  union all
  select 21, 'storage.buckets attributes (id,name,public,file_size_limit,allowed_mime_types,type,versioning_status) count:md5 = PRE baseline 2026-10-07',
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
            then 'S2_PRE_ASSERT_PASS' else 'S2_PRE_ASSERT_FAIL' end
order by ord;

-- =====================================================================
-- SEC-MEDIA · Stage 1 (İŞ PAKETİ 1) · PRE / MID0 / MID / POST snapshot
-- SALT-OKUNUR: tek SELECT, tek satır, tek jsonb kolon (s1_snapshot). Yazma/DDL YOK.
-- Read-only: one SELECT → one row → one jsonb column, diffable with gates/s1_snapshot_diff.mjs.
-- Obje adları maskelenir (prefix/xxxxxxxx-****) + sha256(name) ile eşleştirilir; tam path basılmaz.
-- Çalıştırma: Supabase Dashboard SQL Editor | MCP execute_sql | psql (PGOPTIONS='-c default_transaction_read_only=on').
-- =====================================================================
select jsonb_build_object(
  'schema', 's1_snapshot.v1',
  'captured_at', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  -- media bucket objects
  'media_objects', (select count(*) from storage.objects where bucket_id = 'media'),
  'media_objects_by_prefix', (
     select coalesce(jsonb_object_agg(pfx, n order by pfx), '{}'::jsonb)
       from (select split_part(name, '/', 1) as pfx, count(*) as n
               from storage.objects where bucket_id = 'media' group by 1) s),
  'media_recent', (
     select coalesce(jsonb_agg(jsonb_build_object(
              'name_masked', split_part(name, '/', 1) || '/' || left(split_part(name, '/', 2), 8) || '-****',
              'name_sha256', encode(sha256(convert_to(name, 'UTF8')), 'hex'),
              'created_at', to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'size', (metadata ->> 'size')::bigint,
              'mimetype', metadata ->> 'mimetype',
              'cache_control', metadata ->> 'cacheControl'
            ) order by created_at desc, name), '[]'::jsonb)
       from (select name, created_at, metadata from storage.objects
              where bucket_id = 'media' order by created_at desc, name limit 20) r),
  -- all buckets: public flag + object counts (unexpected writes elsewhere show up here)
  'buckets', (
     select coalesce(jsonb_agg(jsonb_build_object(
              'id', b.id, 'public', b.public,
              'file_size_limit', b.file_size_limit, 'allowed_mime_types', b.allowed_mime_types,
              'objects', (select count(*) from storage.objects o where o.bucket_id = b.id)
            ) order by b.id), '[]'::jsonb)
       from storage.buckets b),
  'media_bucket_public', (select public from storage.buckets where id = 'media'),
  -- ALL policies on storage.objects (definitions verbatim) + a single digest
  'storage_objects_policies', (
     select coalesce(jsonb_agg(jsonb_build_object(
              'policyname', policyname, 'cmd', cmd, 'roles', to_jsonb(roles), 'permissive', permissive,
              'qual', qual, 'with_check', with_check
            ) order by policyname), '[]'::jsonb)
       from pg_policies where schemaname = 'storage' and tablename = 'objects'),
  'storage_objects_policies_md5', (
     select md5(coalesce(string_agg(
              policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || permissive || '|' ||
              coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' order by policyname), ''))
       from pg_policies where schemaname = 'storage' and tablename = 'objects'),
  'storage_objects_rls_enabled', (select c.relrowsecurity from pg_class c where c.oid = 'storage.objects'::regclass),
  -- admin-api rate tokens for media_upload (one row per Edge upload that passed all gates up to IDX:74)
  'rate_media_upload_total', (select count(*) from public.admin_rate_events where action = 'media_upload'),
  'rate_media_upload_24h', (select count(*) from public.admin_rate_events where action = 'media_upload' and at > now() - interval '1 day'),
  'rate_media_upload_last_at', (select to_char(max(at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from public.admin_rate_events where action = 'media_upload'),
  -- cleanup design evidence: Storage's statement-level delete guard on storage.objects
  'protect_objects_delete_trigger', (
     select jsonb_build_object('present', count(*) > 0, 'enabled', coalesce(bool_and(t.tgenabled <> 'D'), false))
       from pg_trigger t
      where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'protect_objects_delete' and not t.tgisinternal)
) as s1_snapshot;

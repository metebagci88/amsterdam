-- =====================================================================
-- SEC-MEDIA · STAGE 2 · gates/s2_fixture_baseline.sql
-- YALNIZ EPHEMERAL TEST DB (PGlite / boş yerel Postgres / `supabase start`).
-- Production'ın 2026-10-07 read-only doğrulanmış baseline'ını kurar:
--   buckets : media public=true, email-assets-public public=true, email-assets-draft public=false
--   policies: storage.objects üzerindeki 4 policy (birebir tanım; anonim yazma AÇIK)
-- Bu dosya anonim yazmayı AÇTIĞI için production'da çalıştırılması S2'yi geri alır.
-- Bu yüzden arming GUC'u olmadan reddeder:
--   set local sec_media.s2_fixture = 'EPHEMERAL_ONLY';   (aynı transaction)
-- =====================================================================
do $arm$
begin
  if coalesce(current_setting('sec_media.s2_fixture', true), '') <> 'EPHEMERAL_ONLY' then
    raise exception 'S2_FIXTURE_NOT_ARMED: yalnız ephemeral test DB; set local sec_media.s2_fixture = ''EPHEMERAL_ONLY'' gerekli';
  end if;
end
$arm$;

insert into storage.buckets (id, name, public) values
  ('media', 'media', true),
  ('email-assets-public', 'email-assets-public', true),
  ('email-assets-draft', 'email-assets-draft', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "media anon read" on storage.objects;
create policy "media anon read" on storage.objects
  as permissive for select to public
  using (bucket_id = 'media'::text);

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

-- ASALOCAL · CDP-3B patch · Taslak görsel önizleme yetki-kapısı (salt-okuma)
-- Additive: yalnız 1 yeni SECURITY DEFINER query RPC. Tablo/şema değişikliği YOK.
--
-- YETKİ SINIRI (fail-closed):
--   (A) Asset, verilen p_template_id'nin CURRENT DRAFT (unpublished) sürümüne bağlıysa erişilebilir.
--   (B) Asset, created_by = p_actor olan ve HENÜZ HİÇBİR sürüme bağlanmamış TAZE bir upload ise erişilebilir.
--   - Başka template/version'a bağlı asset, created_by aynı olsa bile FARKLI template_id üzerinden DÖNMEZ.
--   - Eski/non-current bağlantı (yayınlanmış sürüm dâhil) YETKİ ÜRETMEZ.
--   - Published asset için signed draft preview ÜRETİLMEZ (kanonik public URL kullanılır) -> status filtresi.
--
-- VERİ MODELİ GERÇEĞİ (authoritative kaynak seçimi):
--   email_version_assets junction'ı YALNIZ publish anında dolar (admin_w_email_publish, CDP3B_up.sql).
--   TASLAK sürümler asset'i yalnız email_template_versions.asset_manifest (JSONB) içinde tutar.
--   Bu yüzden:
--     * CURRENT DRAFT bağı -> manifest ile doğrulanır (taslakta authoritative kaynak budur).
--     * "herhangi bir sürüme bağlı mı" (branch B dışlaması) -> junction (yayınlanmışlar için authoritative)
--       VE herhangi bir sürüm manifesti (taslaklar için) BİRLİKTE kontrol edilir -> fail-closed union.
--   Tutarlılık fail-closed: current draft için junction satırı VARSA (anormal), manifest de içermeli;
--   aksi hâlde branch (A) erişim üretmez (manifest zorunlu).
--
-- service_role dışına EXECUTE verilmez (deny-all sözleşmesi korunur).

create or replace function public.admin_q_email_asset_preview(
  p_actor uuid,
  p_asset_ids uuid[],
  p_template_id uuid default null
) returns table(asset_id uuid, object_path text)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- rol kapısı: yalnız düzenleme yetkisi olan (super_admin + crm)
  if not public._email_can_write(p_actor) then
    raise exception 'forbidden';
  end if;

  return query
    select a.id, a.object_path
    from public.email_assets a
    where a.id = any(p_asset_ids)
      and a.status in ('draft','promoting')                       -- published DEĞİL (o kanonik public URL kullanır)
      and (
        -- (A) YALNIZ verilen template'in CURRENT DRAFT sürümüne bağlı (unpublished).
        --     Taslak bağı manifest ile doğrulanır; tutarlılık fail-closed:
        --     current draft için junction satırı varsa manifest de içermeli (yoksa erişim yok).
        (
          p_template_id is not null and exists (
            select 1
            from public.email_templates t
            join public.email_template_versions v
              on v.id = t.current_draft_version_id
            where t.id = p_template_id
              and v.is_published = false
              and v.asset_manifest @> jsonb_build_array(jsonb_build_object('asset_id', a.id::text))
              and not exists (                                     -- fail-closed: junction VAR ama manifest YOK -> erişim yok
                select 1 from public.email_version_assets eva
                where eva.version_id = v.id and eva.asset_id = a.id
                  and not (v.asset_manifest @> jsonb_build_array(jsonb_build_object('asset_id', a.id::text)))
              )
          )
        )
        or
        -- (B) TAZE upload: created_by = actor VE asset HİÇBİR sürüme bağlı DEĞİL.
        --     "bağlı" = junction'ta (yayınlanmış) VEYA herhangi bir sürüm manifestinde (taslak) -> fail-closed union.
        (
          a.created_by = p_actor
          and not exists ( select 1 from public.email_version_assets eva2 where eva2.asset_id = a.id )
          and not exists (
            select 1 from public.email_template_versions vv
            where vv.asset_manifest @> jsonb_build_array(jsonb_build_object('asset_id', a.id::text))
          )
        )
      );
end
$$;

revoke all on function public.admin_q_email_asset_preview(uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.admin_q_email_asset_preview(uuid, uuid[], uuid) to service_role;

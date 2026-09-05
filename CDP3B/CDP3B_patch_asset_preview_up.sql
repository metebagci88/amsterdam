-- ASALOCAL · CDP-3B patch · Taslak görsel önizleme yetki-kapısı (salt-okuma)
-- Additive: yalnız 1 yeni SECURITY DEFINER query RPC. Tablo/şema değişikliği YOK.
-- İlişki YALNIZ email_templates.current_draft_version_id üzerinden kurulur (eski/current-olmayan
-- draft manifesti erişim üretmez). Taze upload: created_by = actor. Maskeli hata: 'forbidden'.
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
      and a.status in ('draft','promoting')                     -- published DEĞİL (o public URL kullanır)
      and (
        a.created_by = p_actor                                  -- (a) taze upload sahibi
        or (                                                    -- (b) YALNIZ current draft sürümünün manifestinde
          p_template_id is not null and exists (
            select 1
            from public.email_templates t
            join public.email_template_versions v
              on v.id = t.current_draft_version_id
            where t.id = p_template_id
              and v.is_published = false
              and v.asset_manifest @> jsonb_build_array(jsonb_build_object('asset_id', a.id::text))
          )
        )
      );
end
$$;

revoke all on function public.admin_q_email_asset_preview(uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.admin_q_email_asset_preview(uuid, uuid[], uuid) to service_role;

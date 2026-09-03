-- =====================================================================
-- ASALOCAL · CDP-3B (v2) · ROLLBACK
-- CDP-3B ile eklenen tüm e-posta şablon/sürüm/asset yapısını + fonksiyon/trigger'ları geri alır.
-- App/admin.html eski sürüme, Edge (email-api) kaldırıldıktan SONRA uygulanmalı.
-- Bucket'lar (email-assets-draft/public) Storage API ile ayrıca kaldırılır (SQL kapsamı dışı).
-- =====================================================================

-- WRITE + QUERY RPC'ler
drop function if exists public.admin_q_email_taxonomy(uuid);
drop function if exists public.admin_q_email_template_list(uuid);
drop function if exists public.admin_q_email_template_get(uuid,uuid);
drop function if exists public.admin_q_email_data_health(uuid);
drop function if exists public.admin_q_email_asset_gc_candidates(uuid);
drop function if exists public.admin_w_email_template_create(uuid,text,text,text,text,uuid,text);
drop function if exists public.admin_w_email_version_save(uuid,uuid,text,text,text,text,jsonb,text,text,text,jsonb,jsonb,jsonb,text,text,uuid,text);
drop function if exists public.admin_w_email_publish(uuid,uuid,uuid,text);
drop function if exists public.admin_w_email_new_version(uuid,uuid,uuid,text);
drop function if exists public.admin_w_email_duplicate(uuid,uuid,uuid,text);
drop function if exists public.admin_w_email_archive(uuid,uuid,uuid,text);
drop function if exists public.admin_w_email_asset_register(uuid,text,text,text,int,int,int,uuid,text);
drop function if exists public.admin_w_email_asset_promote(uuid,uuid,text,text,uuid,text);
drop function if exists public.admin_w_email_asset_gc_finalize(uuid,uuid[],uuid,text);

-- helper'lar
drop function if exists public._email_can_write(uuid);
drop function if exists public._email_can_publish(uuid);
drop function if exists public._email_vars_ok(jsonb);
drop function if exists public._email_manifest_ok(jsonb);
drop function if exists public._email_idem_begin(uuid,uuid,text,text,text,text);
drop function if exists public._email_idem_finish(uuid,jsonb);
drop function if exists public._email_fp(text,uuid,jsonb);

-- trigger'lar + trigger fonksiyonları
drop trigger if exists trg_email_version_immutable on public.email_template_versions;
drop trigger if exists trg_email_asset_protect on public.email_assets;
drop trigger if exists trg_email_template_pointer on public.email_templates;
drop trigger if exists trg_email_version_source on public.email_template_versions;
drop function if exists public._email_version_immutable();
drop function if exists public._email_asset_protect();
drop function if exists public._email_template_pointer_check();
drop function if exists public._email_version_source_consistency();

-- tablolar (bağımlılık sırası)
drop table if exists public.email_version_assets;
drop table if exists public.email_template_versions;
drop table if exists public.email_assets;
drop table if exists public.email_templates;

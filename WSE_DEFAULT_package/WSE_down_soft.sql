-- =====================================================================
-- ASALOCAL · welcome_service_email future-default · SOFT ROLLBACK
-- Gelecek seed'i kapatır. Üye geçmişini silmez.
--   * members / auth.users / member_service_pref_* / member_consent_* dokunulmaz
--   * kolonlar ve check constraint'ler kalır
--   * consent_get_my_state ON-fallback'e GERİ DÖNMEZ (missing = not_configured kalır)
--   * yalnız welcome_service_email policy kolonları null'a alınır
--   * trigger + seed fonksiyonu + activation RPC (varsa) düşer
-- Tekrar açmak için: önce WSE_up.sql (trigger geri gelir, policy hâlâ null),
-- sonra ayrıca onaylı WSE_ACTIVATE.sql. Yalnız activation dosyasını
-- trigger yokken çalıştırmak activation_requires_seed_trigger ile durur.
-- =====================================================================

drop trigger if exists trg_members_seed_welcome_service_pref on public.members;
drop function if exists public._seed_welcome_service_pref_on_member_insert();
drop function if exists public.admin_w_activate_welcome_service_email_default(uuid,text,text,uuid);

update public.service_pref_defaults
   set default_enabled = null,
       effective_from = null,
       policy_version = null,
       configured_at = null,
       configured_by = null
 where pref_key = 'welcome_service_email'::public.service_pref_key;

-- =====================================================================
-- ASALOCAL · CDP-3C · GERİ ALMA (SAFE / down_soft) · REVİZE v3 (fail-closed)
-- Yalnız DIŞ RPC/UI YÜZEYİNİ kapatır → sistem fail-closed kalır (consent yazılamaz).
-- KESİNLİKLE GEVŞETMEZ / KALDIRMAZ:
--   * hiçbir iş tablosu DROP edilmez (kanıt korunur),
--   * consent_text / controller published-immutability + unpublish-yasağı trigger'ları,
--   * consent_purpose_doc immutability + append-only guard trigger'ları,
--   * marketing_config hard-gate guard trigger'ı (_marketing_config_guard),
--   * retained/enforcement helper'ları (_contact_hmac, _readiness_attested,
--     _validate_controller_fields, _is_capture_gated, _consent_idem_check,
--     _require_request_id, _append_only_guard, trigger fn'leri),
--   * RLS deny-all/force, Vault pepper, admin-delete-user kill-switch.
-- Tablo/tip düşürme yalnız CDP3C_down_insecure.sql (yorumlu, elle, hukuk onaylı).
-- =====================================================================

-- Dış (kullanıcı) RPC yüzeyi
drop function if exists public.consent_get_my_state();
drop function if exists public.consent_set_pref_center(public.consent_purpose,boolean,uuid,text,text,uuid);
drop function if exists public.service_pref_set(public.service_pref_key,boolean,text,uuid);

-- Kapalı akış (service_role) RPC yüzeyi — GÜNCEL imzalar (düzeltme #3)
drop function if exists public.consent_set_via_flow(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid);
drop function if exists public.legal_notice_record(public.legal_subject_kind,uuid,public.consent_doc_type,uuid,public.consent_source,text,uuid);
drop function if exists public.anon_subject_create(text,uuid);
drop function if exists public.anon_consent_set(uuid,public.consent_purpose,boolean,uuid,text,uuid);
drop function if exists public.anon_merge_into_user(uuid,uuid,text,uuid);

-- Admin RPC yüzeyi
drop function if exists public.admin_q_member_consent(uuid,uuid);
drop function if exists public.admin_w_apply_suppression(uuid,text,public.suppression_channel,public.suppression_scope,public.suppression_reason,text,text,uuid);
drop function if exists public.iys_supersede_red(uuid,text,public.suppression_channel,public.suppression_scope,text,text,uuid);
drop function if exists public.admin_w_set_marketing_enabled(uuid,boolean,text,text,uuid);
drop function if exists public.admin_w_set_marketing_capture_enabled(uuid,boolean,text,text,uuid);
drop function if exists public.admin_w_add_readiness_attestation(uuid,public.readiness_domain,public.readiness_condition,text,timestamptz,text,text,uuid);
drop function if exists public.admin_w_revoke_readiness_attestation(uuid,uuid,text,text,uuid);
drop function if exists public.admin_w_set_service_pref_default(uuid,public.service_pref_key,boolean,text,text,uuid);
drop function if exists public.admin_w_set_anon_ttl(uuid,int,text,text,uuid);
drop function if exists public.admin_w_approve_consent_text(uuid,uuid,text,text,text,uuid);   -- yeni (düzeltme #3)
drop function if exists public.admin_w_publish_controller_version(uuid,uuid,boolean,text,text,uuid);
drop function if exists public.admin_w_publish_consent_text(uuid,uuid,boolean,text,text,uuid);

-- Readiness okuma RPC'leri (dış yüzey; enforcement helper'ları KALIR)
drop function if exists public.marketing_readiness_check();
drop function if exists public.marketing_capture_readiness_check();
drop function if exists public.service_delivery_readiness_check();

-- Internal writer'ı da kaldır (yüzey kapanınca çağrısı kalmaz):
drop function if exists public._consent_set_internal(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid);

-- KORUNANLAR (silinMEZ): tüm tablolar + RLS deny-all/force + Vault pepper +
--   _contact_hmac, _readiness_attested, _validate_controller_fields, _is_capture_gated,
--   _consent_idem_check, _require_request_id, _append_only_guard,
--   _consent_text_biu/_immutable, _controller_biu/_immutable, _consent_purpose_doc_immutable,
--   _marketing_config_guard (+ hepsinin trigger'ları) + kill-switch.
-- Sistem durumu: fail-closed (consent/suppression YAZILAMAZ; kanıt + enforcement + immutability korunur).

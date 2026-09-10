-- =====================================================================
-- ASALOCAL · CDP-3C · search_path HARDENING (dar kapsam)
-- Advisor 0011 (function_search_path_mutable) — YALNIZ advisor'ın işaretlediği
-- 18 CDP-3C fonksiyonuna SABİT search_path ekler. Fonksiyon GÖVDELERİ (prosrc),
-- tablo/kolon/trigger/ACL ve veri DEĞİŞMEZ (yalnız ALTER FUNCTION ... SET).
-- 18 fonksiyonun hepsi SECURITY DEFINER DEĞİL; güvenlik-kritik SECURITY DEFINER
-- CDP-3C fonksiyonları zaten search_path set eder (kapsam dışı).
-- Kasıtlı authenticated kullanıcı RPC'leri (consent_get_my_state /
-- consent_set_pref_center / service_pref_set) DOKUNULMAZ.
-- İmzalar production katalogdan (pg_get_function_identity_arguments) üretildi.
-- =====================================================================
alter function public._append_only_guard() set search_path = public, extensions;
alter function public._approval_immutable() set search_path = public, extensions;
alter function public._authoritative_consistency() set search_path = public, extensions;
alter function public._consent_purpose_doc_immutable() set search_path = public, extensions;
alter function public._consent_text_biu() set search_path = public, extensions;
alter function public._consent_text_immutable() set search_path = public, extensions;
alter function public._controller_biu() set search_path = public, extensions;
alter function public._controller_immutable() set search_path = public, extensions;
alter function public._is_capture_gated(p consent_purpose) set search_path = public, extensions;
alter function public._marketing_config_guard() set search_path = public, extensions;
alter function public._marketing_config_no_delete() set search_path = public, extensions;
alter function public._readiness_attestation_biu() set search_path = public, extensions;
alter function public._readiness_combo_ok(p_domain readiness_domain, p_cond readiness_condition) set search_path = public, extensions;
alter function public._require_request_id(p text) set search_path = public, extensions;
alter function public._suppression_combo_guard() set search_path = public, extensions;
alter function public._suppression_combo_ok(p_channel suppression_channel, p_scope suppression_scope, p_reason suppression_reason) set search_path = public, extensions;
alter function public._suppression_pair_ok(p_channel suppression_channel, p_scope suppression_scope) set search_path = public, extensions;
alter function public._validate_controller_fields(p_type controller_type, p_np jsonb, p_le jsonb) set search_path = public, extensions;

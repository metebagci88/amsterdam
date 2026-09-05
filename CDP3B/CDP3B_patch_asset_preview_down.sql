-- ASALOCAL · CDP-3B patch · GERİ ALMA (safe): yalnız yeni preview RPC'sini düşürür.
-- Güvenlik enforcement'ını (deny-all RLS, _email_fp revoke, immutability trigger) GEVŞETMEZ.
drop function if exists public.admin_q_email_asset_preview(uuid, uuid[], uuid);

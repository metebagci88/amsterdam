-- =====================================================================
-- CDP-3D · GÜVENLİ ROLLBACK (down_soft)
-- Yalnız CDP-3D'nin EKLEDİĞİ yüzeyi kaldırır. CDP-3C enforcement'ına DOKUNMAZ:
--   public._contact_hmac, contact_suppression_*, service_pref_*, _append_only_guard,
--   admin_write_log, consent_write_ops KORUNUR.
-- CDP-3D hiçbir mevcut veriyi koruyan yeni bir güvenlik kontrolü EKLEMEDİĞİ için,
-- bu objeleri düşürmek güvenliği GEVŞETMEZ; yalnız gönderim yeteneğini kaldırır (fail-closed).
-- Sıra: fonksiyonlar -> trigger -> tablolar -> enum'lar.
-- =====================================================================

-- fonksiyonlar
drop function if exists public.admin_q_email_delivery_status(uuid);
drop function if exists public.email_purge_expired_content();
drop function if exists public.email_ingest_provider_event(text,text,text,text,timestamptz,text);
drop function if exists public._email_system_apply_suppression(text,public.suppression_reason,text);
drop function if exists public.email_mark_result(uuid,boolean,text,text);
drop function if exists public.email_claim_batch(int);
drop function if exists public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text);
drop function if exists public._email_send_decision(uuid,public.email_message_class,public.service_pref_key);
drop function if exists public._email_can_set_delivery(public.email_send_status,public.email_send_status);
drop function if exists public._email_status_rank(public.email_send_status);

-- trigger (tablo düşmeden önce; drop table zaten kaldırır ama açıkça)
drop trigger if exists email_send_events_append_only on public.email_send_events;

-- tablolar (FK sırasına dikkat: events -> outbox)
drop table if exists public.email_send_events;
drop table if exists public.email_outbox;
drop table if exists public.email_send_allowlist;
drop table if exists public.email_provider_config;

-- enum'lar (tablolar düştükten sonra)
drop type if exists public.email_skip_reason;
drop type if exists public.email_send_status;
drop type if exists public.email_message_class;

-- NOT: Ayrı bir "INSECURE/destructive" rollback dosyası YOKTUR. CDP-3D hiçbir mevcut
-- güvenlik kontrolünü sıkılaştırmadığı/kaldırılması güvenliği gevşetecek bir enforcement
-- eklemediği için down_soft tek ve güvenli geri alma yoludur. Tek "yıkıcı" etki gönderim
-- log geçmişinin silinmesidir; bu güvenlik değil, kayıt kaybıdır.

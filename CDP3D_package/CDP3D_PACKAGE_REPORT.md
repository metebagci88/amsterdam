# CDP-3D · Paket Raporu (revizyon: 8 kapanış + gerçek CI)

## İçerik
- CDP3D_up.sql / CDP3D_down_soft.sql — additive migration + güvenli rollback.
- edge/service-email-dispatch/index.ts — service-role-only dispatcher (+ provider Idempotency-Key).
- edge/resend-webhook/index.ts — Svix-imzalı webhook (+ bounce.type sınıflandırma).
- gates/ — PGlite gate (47), Svix birim (6), prereq stub, **gerçek-Postgres DB suite**, HTTP reddetme betiği.
- .github/workflows/cdp3d-gates.yml (Docker'sız) + cdp3d-edge-integration.yml (ephemeral Supabase).

## Onaylı kararlar
Domain **send.asalocal.club**; from no-reply@send.asalocal.club; reply-to destek@asalocal.club; manuel SMTP.

## 8 kapanış (hepsi işlendi + testli)
1. Domain send.asalocal.club (SQL varsayılan + testler + dokümanlar).
2. 0C idempotency: intent fingerprint + advisory lock + recheck; aynı key+farklı payload → idempotency_conflict; concurrency testi.
3. Claim lease (claimed_at/lease_expires_at) + güvenli reclaim; provider Idempotency-Key = outbox-<id> (retry'da sabit → yanıt kaybında çift e-posta yok).
4. Monoton durum makinesi (_email_can_set_delivery): geç 'sent' delivered'ı düşürmez; mark yalnız 'sending'den.
5. Webhook dedupe: atomik INSERT ON CONFLICT (svix_id); paralel tek event/suppression.
6. Bounce sınıfı: yalnız Permanent → hard_bounce suppression; Transient/delivery_delayed → kalıcı suppression yok; complaint → spam_complaint.
7. PII/retention: outbox/events ham e-posta yok (user_id+recipient_hmac); adres gönderim anında çözülür; hata redakte (resend_<status>); email_purge_expired_content (retention).
8. Go-live kapısı ayrı: public_go_live=false kurulu, açık değil (gizlilik metni + natural-person controller ayrı, marketing izni değil).

## Yerel doğrulama
PGlite gate **47/47 PASS**, Svix **6/6 PASS**, Edge parse **2/2 OK**, YAML OK, SHA256SUMS doğrulandı.
Gerçek ephemeral Supabase CI (DB suite + HTTP reddetme + rollback residue + secret scan): GitHub'da koşacak.

## Maliyet
Resend Free ($0): 100/gün, 3.000/ay. Yeni ücretli kaynak yok.

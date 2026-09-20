# CDP-3C · Edge / Admin / Üye / Çerez — GERÇEK ENTEGRASYON PAKETİ (DEPLOY EDİLMEDİ)

> **Değişiklik:** Önceki bağımsız taslaklar (standalone `edge/consent-api.ts`,
> `admin/admin_consent_view.js`, `admin/preference_center.html`) **KALDIRILDI**.
> Yerlerine consent yüzeyi **gerçek production dosyalarına ADDITIVE** olarak entegre edildi.
> Bu tur hiçbir Edge/admin/statik **deploy** yapılmadı; yalnız kaynak-parite + testler.

## 1. E-posta Edge (consent + servis-tercihi yüzeyi)
- **Dosya:** `CDP3B/edge/email-api/index.ts` (gerçek CDP-3B email-api'ye additive).
- **Eklenen action'lar** (KULLANICI JWT client'ı ile; `svc`/service_role DEĞİL):
  - `consent_get` → `consent_get_my_state()` (authenticated).
  - `consent_set` → `consent_set_pref_center()` (yalnız pref_center; `analytics/advertising` REDDEDİLİR).
  - `service_pref_set` → `service_pref_set()` (authenticated).
- **Strict şema:** kapalı-alan (`closedFields`), gerçek boolean (`"false"/"0"` reddedilir),
  purpose/service-pref key/locale sunucu allowlist'i, `request_id`+`idem` zorunlu (WRITE kapısı),
  `text_version` uuid|null, withdraw'da null zorunlu. Hatalar maskeli: 401/403/409/422/400.
- **CORS:** yalnız `https://asalocal.club` + `https://www.asalocal.club`. Bilinmeyen origin (OPTIONS dahil)
  → 403, **ACAO yazılmaz**, yan etki yok. `Access-Control-Allow-Credentials` KASITLI yok (JWT, cookie değil).
- **Korunanlar:** `verify_jwt=true`, dependency pin'leri (std@0.224.0, supabase-js@2.45.4, deno_dom@v0.1.45),
  tüm CDP-3B email/asset action'ları (taxonomy…asset_gc) ve auth/rol kapıları. E-posta-admin action'ları
  normal üyeye KAPALI (RPC'ler admin rol kapılı; consent action'ları ise her authenticated üyeye açık).

## 2. Admin Edge (salt-okunur consent görünümü + readiness)
- **Dosya:** `CDP3B/edge/admin-api/index.ts` (gerçek admin-api v13'e additive; tam birleşik dosya).
- **Eklenen action'lar (READ; WRITE_ACTIONS'a EKLENMEDİ → admin opt-in VEREMEZ):**
  - `q_member_consent` → `admin_q_member_consent(actor,user_id)` — rol: super_admin/support/crm.
  - `marketing_readiness_check` → `marketing_readiness_check()` — rol: super_admin/support/crm.
- Yanıt RPC allowlist'iyle sınırlı: ham HMAC/parmak izi/idempotency/request_id/evidence **DÖNMEZ**.
- Mevcut CDP-2B/2C action'ları, ROLE_SETS/LIMITS, rate-limit, kill-switch, CORS DEĞİŞMEDEN korunur.

## 3. Admin panel (gerçek admin.html)
- **Dosya:** `CDP3B/admin.html` (additive; git diff = yalnızca ekleme, 0 silme).
- Yeni **"İzin Görünümü"** segmenti (CAPS.crm||CAPS.members): pazarlama readiness durum kutusu +
  user_id ile üye izin/olay/servis-tercihi tabloları (salt-okunur, tümü `esc()`). Aç/kapa/opt-in YOK.
- CDP-3B e-posta editörü (`renderEmail`) ve diğer tüm fonksiyonlar byte-değişmedi.

## 4. Üye Tercih Merkezi (gerçek şehir SPA'ları)
- **Dosyalar:** `amsterdam/index.html` + `kopenhag/index.html` (aynı şablon; her ikisine additive).
- Üye alanına **"E-posta Tercihleri"** segmenti: yalnız **servis** e-posta tercihleri
  (`consent_get_my_state` + `service_pref_set`, authenticated RPC). Türkçe etiketler; `config_pending`
  → "Varsayılan belirlenmedi". Pazarlama/SMS/push/reklam/profilleme kutuları **GİZLİ**; pazarlama bölümü
  yalnız sunucu yeteneği (`state.marketing_available===true`) gelince açılır (kalıcı hard-code değil).
  **"Tümünü reddet" yok.** İki mevcut kullanıcıya popup/backfill/re-consent YOK (sekme yalnız açınca yüklenir).

## 5. Çerez modülü (fail-closed, WIRE EDİLMEDİ)
- **Dosya:** `CDP3C_package/edge_admin/web/cookie_consent.js` (v2).
- Consent-mode default = denied. **localStorage authoritative DEĞİL** (script yüklemeyi tetiklemez).
  Gated script YALNIZ sunucu consent yazımı 2xx başarısından sonra yüklenir; sunucu reddederse denied kalır.
  Aktif hukuk metni (`active_text_version`) veya `endpoint` yoksa modül **tam pasif** (banner yok, grant yok).
  Çerez Politikası linki yalnız geçerli `policyUrl` varsa basılır. Anon subject/TTL/text_version yaşam döngüsü
  sunucuya bağlıdır. **Hukuk metinleri sonra geleceği için bu tur production'a bağlanmaz.**

## 6. Suppression / HMAC sınırı
- Bu turda gerçek gönderim (Resend/outbox/journey) YOK → suppression çağrı yüzeyi public/client routing'e
  **bağlanmadı**. Ham e-posta→HMAC dönüşümü ve pepper sınırı CDP-3D provider/webhook katmanına bırakıldı.
  Ham e-posta audit/hata/idempotency/admin yanıtına GİRMEZ. Ayrıntı: bkz. `CDP3C_SUPPRESSION_HMAC_NOTE.md`.

## 7. Deploy sırası (ileride, ayrı onayla — bu turda YAPILMADI)
Bkz. `CDP3C_APPLY_ROLLBACK.md` (DB zaten uygulı) ve `CDP3C_CLOSURE_REPORT.md` §deploy/rollback.

# CDP-3C · Uygulama + Rollback Planı (İNCELEME — UYGULANMADI) · v4

> **v4 notu:** Workflow kanonik konum `.github/workflows/cdp3c-gates.yml` (repo kökü); manifest `SHA256SUMS` repo kökünde ve **workflow'u da kapsar**. CI zinciri: `sha256sum -c SHA256SUMS` → secret-scan self-test → stack → ext → baseline → preflight self-check → up → re-apply → invariants → tests → **iki-bağlantı concurrency** → down_soft → downsoft_assert → sentinel → teardown(`always`,residue=0) → final secret-scan(`always`) → tek artifact(`always`). Tüm SQL/gate'ler **yerel Postgres 16'da geçti** (production değil). Preflight ayrıca apply öncesi **production'da salt-okunur** koşulur.


**Bu paket production'a uygulanmadı.** Aşağıdaki sıra onaylanınca, her adım ayrı doğrulama + onayla ilerler. Yeni ücretli kaynak yok; Resend/DNS/journey/outbox/gönderim yok; mevcut kullanıcılara veri yazılmaz; aktif hukuk metni oluşturulmaz.

## Kapsam (CDP-3C)
- **İçerir:** controller identity sürümleri (immutable yayımlanmış + typed alanlar), consent metin sürümleri (immutable gövde + server-side hash), üye consent (events/current, append-only), servis tercihleri (events/current + config_pending), suppression (iki tablo + çok-neden supersede), anon consent subject/events/current (yalnız analytics/advertising), `marketing_config` (hard-gate: enabled + capture) + readiness attestation (revoke-event), Vault pepper, SECDEF RPC'ler, preference-center + cookie-consent **altyapısı** (edge/admin — bkz. EDGE_ADMIN_SPEC v2).
- **İçermez (CDP-3D/3E):** `message_class`/e-posta sınıflandırma + `assertServiceContent` + send-time içerik denetimi; `unsubscribe_consume` edge; Resend/provider çağrısı; DNS/SPF/DKIM/DMARC; service-email outbox + worker; allowlist gönderimi; journey/zamanlayıcı/retry motoru; gerçek gönderim.

## Ön koşul (apply-blocker CONFIG — sessiz varsayım YOK)
Aşağıdakiler set edilmeden ilgili fail-closed kontroller **geçmez** (kasıtla); apply öncesi kararınız gerekir:
1. `app_privacy_config.anon_ttl_days` (anon TTL) — set edilmeden `anon_subject_create` → `anon_ttl_not_configured`.
2. `service_pref_defaults.default_enabled` (her servis tercihi için varsayılan) — NULL iken `config_pending`; backfill yok.
3. `controller_identity_versions` yayımlanacak **gerçek-kişi** iletişim/adres biçimi (typed alanlar) — hukuk kararı.
4. Marketing readiness attestation'ları (mersis/tüzel kişilik, İYS, marketing consent text, DNS) — hepsi girilene + aktif metin aktif controller'a bağlanana kadar `marketing_readiness_check` fail-closed.
5. `service_delivery` işleyen/yurt dışı aktarım değerlendirmesi (Resend veri işleyen — hukuk) — CDP-3D send için readiness.

## Apply sırası (her adım ayrı onay + doğrulama)
0. **Production compatibility preflight (SALT-OKUNUR):** `gates/cdp3c_preflight.sql`'i GERÇEK production'da koş — `members.email` kaynağı, admin yüzeyi, `_admin_active/_admin_has_role` imzaları, `admin_write_log` kolonları, Vault/pgcrypto var mı? `CDP3C_PREFLIGHT_PASS` görülmeden apply YOK (düzeltme #17).
1. **Ephemeral CI doğrulama (PGlite tek başına DEĞİL):** `.github/workflows/cdp3c-gates.yml` (repo kökü) geçici GERÇEK Supabase stack'te: `sha256sum -c SHA256SUMS` → baseline → preflight self-check → `CDP3C_up.sql` → **ikinci apply** → invariants → tests → `CDP3C_down_soft.sql` + `cdp3c_downsoft_assert.sql` → secret-scan → fail-closed teardown + residue=0 → `LOCAL_CDP3C_GATES_PASS`. Yeşil olmadan production'a gidilmez. **(Bu paket bu CI'ı henüz KOŞMADI — onay bekliyor.)**
2. **Vault pepper:** `cdp3c_contact_pepper_v1` oluşturuldu mu + yalnız `_contact_hmac` decrypt edebiliyor mu doğrula.
3. **Migration (additive):** `CDP3C_up.sql` uygula. Doğrula: tüm yeni tablolar RLS **enabled+forced**, policy yok; append-only + immutability trigger'ları; RPC imzaları + EXECUTE grant matrisi (authenticated yalnız `consent_get_my_state`/`consent_set_pref_center`/`service_pref_set`; service_role yalnız `consent_set_via_flow`/admin RPC'leri; helper'lar public/anon/authenticated'dan revoke); `members`/`auth.users` **değişmedi**; `message_class`/`journeys` **eklenmedi**.
4. **Advisor pass:** yeni ERROR/WARN yok (özellikle yeni RPC'ler authenticated'a sızmıyor).
5. **Hosted kabul:** test matrisi (zero-footprint); mevcut Auth + ilişkili tablo sayımları PRE/POST değişmez.
6. **Edge (email-api genişletme):** consent_get/consent_set(pref_center)/service_pref_set (authenticated) + service_role internal akışlar (consent_set_via_flow, HMAC suppression). **SEND YOK; assertServiceContent/unsubscribe_consume 3D.** verify_jwt=true; byte-exact + HTTP kabul (401/403 yolları).
7. **admin.html:** iki sekme + durum kutusu + Tercih Merkezi + servis tercihleri (config_pending görünümü) + consent salt-görünüm (allowlist) + çerez banner (script consent'e kadar yüklenmez). Canlı SHA + SRI + konsol temiz.
8. **Hukuk metni + controller yayımı AYRI iş:** onaylı gövde olmadan `consent_text_versions.is_active=true` **yapılmaz**; `marketing_capture_enabled` readiness + hukuk onayına kadar false kalır. Placeholder aktif metin **yok**.

## Rollback
- **`CDP3C_down_soft.sql` (fail-closed):** yalnız dış RPC/UI yüzeyini kaldırır (kullanıcı + service_role akış + admin + config + readiness okuma RPC'leri + `_consent_set_internal`) → sistem consent yazamaz durumda kalır. **Deny-all/force RLS, append-only + immutability trigger'ları, `_marketing_config_guard` hard-gate trigger'ı, consent/suppression VERİSİ, retained/enforcement helper'ları (`_contact_hmac`, `_readiness_attested`, `_validate_controller_fields`, `_is_capture_gated`, `_consent_idem_check`), Vault pepper, kill-switch GEVŞETİLMEZ/SİLİNMEZ.** İş tablosu DROP edilmez. Kanıt: `gates/cdp3c_downsoft_assert.sql` (immutability/append-only/hard-gate hâlâ enforce).
- **`CDP3C_down_insecure.sql`:** tablo/tip düşürme — **tamamı yorumlu, asla otomatik çalışmaz**; yalnız hukuk onaylı bilinçli kararla; Vault pepper + kill-switch'e dokunmaz.
- Rollback sonrası: iş/test verisi kalıntısı sıfır; audit + consent kanıtı korunur.

## Maliyet
$0. Yeni ücretli kaynak yok. pg_cron **kurulu değil** (saklama/temizlik job'ı ileride ücretsiz; bu pakette yok).

# CDP-3C · Edge + Admin değişiklik sözleşmesi (SPEC — kod uygulanmadı) · v3

Bu belge CDP-3C'nin Edge (email-api) ve admin.html değişikliklerini **spec** olarak tanımlar. **Gerçek gönderim/provider/outbox/journey YOK** (CDP-3D/3E). Kod uygulama paketi, plan onayı sonrası ayrı hazırlanır; verify_jwt=true korunur, byte-exact + HTTP kabul zorunludur.

> **v3 farkı (özet):** `message_class` bu fazdan tamamen çıkarıldı (düzeltme #1). `consent_set_via_flow` (yalnız `service_role`) + **source×action×purpose matrisi** SQL'de zorunlu (düzeltme #7). Edge'in kullanacağı **tek CANONICAL source sözleşmesi** aşağıda; SQL enum'u (`public.consent_source`) ile birebir hizalıdır — Edge farklı ad (`unsubscribe_flow`/`admin_tool` vb.) **kullanamaz**.

## 0. CANONICAL source sözleşmesi (SQL enum ile birebir; düzeltme #7)
`public.consent_source = { signup, pref_center, cookie_banner, unsubscribe, iys_sync, system, import }`. Edge tam bu adları kullanır. `consent_set_via_flow` yalnız `{signup, cookie_banner, unsubscribe, system}` kabul eder ve matris uygular; `pref_center` yalnız authenticated RPC'de; `iys_sync`/`import` opt-in akışına **KAPALI** (`bad_flow_source`).

| source | izin verilen | kısıt (SQL enforce) |
|---|---|---|
| `pref_center` | authenticated `consent_set_pref_center` | analytics/advertising **kapalı** (`analytics_managed_by_cookie_flow`) |
| `unsubscribe` | via_flow | yalnız withdraw (`unsubscribe_is_withdraw_only`) |
| `cookie_banner` | via_flow / anon | yalnız analytics/advertising (`cookie_banner_purpose_only`) |
| `signup` | via_flow | marketing/personalization grant **üretemez** (`signup_cannot_grant_marketing`) |
| `system` | via_flow | grant **üretemez** (`system_cannot_grant`), yalnız withdraw |
| `iys_sync` | yalnız `iys_supersede_red` (suppression) | opt-in akışına kapalı |
| `import` | — | bu fazda kapalı (`bad_flow_source`) |

## 1. email-api Edge — bu fazın (3C) action'ları (SEND YOK)
Mevcut `email-api` (v6, verify_jwt=true) sözleşmesine **eklenir** (allowlist genişletme). Yalnız consent/servis-tercihi yüzeyi:
- `consent_get` → RPC `consent_get_my_state()` (**authenticated** actor; parametresiz, yalnız kendi durumunu okur).
- `consent_set` → **yalnız** `consent_set_pref_center(...)` (authenticated). Tercih merkezi dışı akışlar (signup/cookie/unsubscribe) buradan **çağrılamaz**; onlar `consent_set_via_flow` ile ve yalnız `service_role` ile yazılır (aşağıda). `source` client'tan **alınmaz**; RPC içinde sabittir (`pref_center`).
- `service_pref_set` → RPC `service_pref_set(...)` (authenticated; kendi servis tercihi).

## 2. Yalnız-server (service_role) akışlar — Edge internal (yine SEND YOK)
Bu action'lar client JWT'siyle **erişilemez**; Edge, service-role anahtarıyla RPC'yi çağırır ve `source`'u akışa göre server-side geçer:
- `consent_set_via_flow(uid, purpose, grant, text_version_id, locale, source, request_id, idem)` — `source ∈ {signup, cookie_banner, unsubscribe, system}` (CANONICAL adlar; §0). **authenticated'a EXECUTE YOK** (invariant + test T10). Matris SQL'de zorunlu (T17).
- Anon çerez akışı: `anon_subject_create()` → `anon_consent_set(subject, purpose∈{analytics,advertising}, grant, text_version_id, request_id, idem)` → login'de `anon_merge_into_user(subject, user, request_id, idem)` (**marketing grant TAŞIMAZ**, belirsiz merge fail-closed).
- Legal notice: `legal_notice_record(subject_ref, doc_type, text_version_id, source, request_id, idem)` — **consent ÜRETMEZ**; server timestamp/source; idempotent.
- Suppression internal: edge, gerçek e-postayı `_contact_hmac()` ile HMAC'e çevirip `admin_w_apply_suppression` / `iys_supersede_red(actor, hmac, channel, scope, iys_sync_ref, request_id, idem)` çağırır. **Ham e-posta RPC parametresine/audit'e girmez**; RPC 64-hex HMAC bekler.
- Config yönetimi (super_admin, audit'li): `admin_w_set_marketing_enabled`, `admin_w_set_marketing_capture_enabled`, `admin_w_add_readiness_attestation` / `admin_w_revoke_readiness_attestation`, `admin_w_set_service_pref_default`, `admin_w_set_anon_ttl`, `admin_w_publish_controller_version`, `admin_w_publish_consent_text`. Doğrudan tablo UPDATE yerine bunlar kullanılır; marketing_config hard-gate **DB trigger** ile de korunur (doğrudan service-role UPDATE bile readiness'siz reddedilir — düzeltme #10).

## 3. CDP-3D'ye ERTELENEN (bu pakette YOK)
Aşağıdakiler **kasıtla 3C dışı**; burada yalnız sınır olarak listelenir:
- `unsubscribe_consume` (oturumsuz token tüketimi: `sha256(token)`↔`unsubscribe_tokens.token_hash`, enumeration-safe sabit yanıt, idempotent, ham token loglanmaz). Token tablosu 3C'de **var** ama tüketim edge'i 3D.
- E-posta **sınıflandırma** (`message_class`/`email_class`) ve **`assertServiceContent(html)`** (servis şablonunda pazarlama/sponsor/affiliate işaretleyici → `409 service_content_marketing_detected`) — send yolunun parçası, 3D.
- Provider (Resend), DNS/SPF/DKIM/DMARC, outbox, journey/scheduler, gerçek gönderim ve send-time readiness re-check.

## 4. admin.html — UI (server-side gate + görünüm)
- **İki sekme:** `Servis E-postaları` / `Pazarlama E-postaları`.
  - Pazarlama sekmesi **durum kutusu**: "Pazarlama gönderimi henüz aktif değil…" + `marketing_readiness_check().missing` (yalnız service_role okur; admin paneli backend üzerinden).
  - **Gönder / Aktifleştir / Kampanya Başlat / Journey Başlat kontrolleri GÖRÜNMEZ** ve server-side reddedilir (çift kilit). Aktifleştirme yalnız `admin_w_set_marketing_enabled` (readiness re-validate, txn içi) ile.
- **Consent/İzinler görünümü:** `admin_q_member_consent(actor,user)` ile kullanıcı consent durumu + event zaman çizelgesi + suppression **salt-okunur** (allowlist yanıt: purpose/state/epoch/updated_at + event action/source/at; **fingerprint/idempotency/request_id/ham HMAC/evidence DÖNMEZ** — düzeltme #12). Admin **opt-in veremez**; yalnız yetkili rolde opt-out/suppression (`admin_w_apply_suppression`; `user_unsubscribe`/`iys_red` admin'e **kapalı**).
- **Tercih Merkezi (üye tarafı):** kanal/amaç aç-kapa (`consent_set_pref_center`) + son değişiklik tarihi + kullanılan metin sürümü + "Tüm opsiyonelleri reddet"; **servis tercihleri** (`service_pref_set`) ayrı bölüm. `config_pending` servis tercihi çözülene kadar UI "varsayılan belirlenmedi" gösterir (backfill yok — düzeltme #13).
- **Kayıt ekranı:** KVKK aydınlatma linki + "okundu" (`legal_notice_events`); gerekli servis tercihleri. **Marketing kutusu readiness'e kadar GÖRÜNMEZ**; mevcut üyelere popup/backfill/otomatik opt-in **yok** (düzeltme #14).
- **Çerez banner:** "Tümünü kabul et / Opsiyonelleri reddet / Tercihleri yönet" eşit belirginlik; zorunlu çerezler ayrı; **analytics/reklam script'i consent'e kadar yüklenmez**; consent-mode ilk durum denied.
- Doğrulama: canlı admin.html SHA + GrapesJS SRI + konsol temiz (CDP-3B deseni).

## 5. Değişmeyecek güvenceler
verify_jwt=true; `--no-verify-jwt` yok; CORS ASALOCAL allowlist; deny-all/force RLS; `source` server-side; ham PII/e-posta RPC-parametresine/audit'e girmez; kill-switch (admin-delete-user) korunur; marketing hard-gate (DB `marketing_config` + `admin_w_set_marketing_enabled`/`_marketing_config_guard` trigger + [3D] send-time re-check) — **tek frontend flag marketing'i açamaz**; ham DB/storage hatası client'a dönmez; no-store.

## 6. THREAT MODEL — service_role (düzeltme #13)
`service_role` RLS'yi **BYPASS** eder; bu nedenle "tüm doğrudan yazımlar kapalı" İDDİA EDİLMEZ. Kritik invariant'lar RPC'ye değil **DB TRIGGER**'larına dayanır ve doğrudan service_role UPDATE/INSERT'e karşı da enforce edilir:
- marketing `enabled`/`capture` false→true yalnız readiness ile (`_marketing_config_guard`),
- `active_controller_version_id` yalnız aktif+yayımlı controller'a (pointer invariant),
- published controller/consent-text immutability + unpublish yasağı,
- event tabloları append-only,
- `consent_purpose_doc` immutability,
- suppression kombinasyon matrisi,
- readiness attestation kapalı-şema (domain×condition + expires + tek revoke),
- aktif consent metni için hukuk-onayı (content_hash-eşleşen) kapısı.
Non-kritik draft satır ekleme (controller/text taslağı, attestation) service_role'e açıktır; kritiklik yukarıdaki trigger kümesiyle sınırlanır. Edge, service_role'ü yalnız kapalı RPC'ler üzerinden kullanır (aşağıdaki config/approval RPC'leri dahil): `admin_w_approve_consent_text`, `admin_w_publish_controller_version`/`_consent_text` (atomik switch), `admin_w_add/revoke_readiness_attestation`, `admin_w_set_service_pref_default`, `admin_w_set_anon_ttl`, `admin_w_set_marketing_capture_enabled`. Hiçbiri kullanıcı adına opt-in üretmez; hepsi super_admin + reason + idempotency + audit.

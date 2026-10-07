# ASALOCAL — 12 Aşamalı Program · Yürütme Sonucu (STOP raporu)

**Belge türü:** PRD §7 kapanış raporu (yürütme devam ediyor)
**Son güncelleme:** 2026-10-07 — İP1–İP4 canlı PASS; İP5 incelemesinde bulunan kritik açık (yazılabilir `member_public` view) SEC-VIEWS hotfix'i ile kapatıldı
**Kaynak PRD:** `ASALOCAL_12_ASAMALI_URUNLESTIRME_PRD.md`
**Rapor tarihi:** 2026-10-07 (UTC)
**Yürüten:** Claude Code (bulut oturumu), repo `metebagci88/amsterdam`, Supabase projesi `asa-local` (`tosqsabuaomgqjtogdrn`)

---

## ASALOCAL_12_STAGE_PROGRAM_RESULT

```text
Overall: PARTIAL   (İP1–İP4 canlı PASS; İP5 sürüyor; SEC-VIEWS güvenlik hotfix'i uygulandı)
Main final SHA: cfdf79eabfa5b47621a19d14bfbe6c7c992e0217   (PR #14 WP4 merge; önceki 8acfb0e ← 7a548e9)
Production URLs: https://www.asalocal.club  (/, /amsterdam/, /kopenhag/, /admin → 302 /CDP3B/admin.html)
                 — canlı girişsiz smoke GitHub Actions + Playwright ile: 50/50 PASS (bkz. §2.1)
Production Edge versions (salt-okunur, değişmedi):
  admin-api v18 verify_jwt=true   ← 2026-10-07 Mete onayıyla deploy (repo main kaynağı); v17 KIRIKTI (bkz. B1)
  email-api v9 verify_jwt=true
  service-email-dispatch v3 verify_jwt=true
  resend-webhook v3 verify_jwt=false
  admin-delete-user v5 verify_jwt=true
  adim2-dispatch-once v6 verify_jwt=true (410 gone stub)
Migration ledger additions: sec_media_close_anon_write (2026-10-07, İP2 v2)
                            sec_public_views_readonly  (2026-10-07, SEC-VIEWS hotfix — §5.8)

Stage 01: PASS        — SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS (canlı, QA run 37629590923): gerçek admin upload Edge yolu, 17/17 negatif, residue=0 (§5.4)
Stage 02: PASS        — SEC_MEDIA_STORAGE_CLOSED: v2 (ALTER POLICY TO service_role, Mete onaylı) uygulandı; prod_assert 19/19, zero-footprint PASS, canlı HTTP 15/15, residue 0 (§5.5)
Stage 03: PASS        — PR #13 merge 8acfb0e; Cloudflare preview 55/55 + production live 55/55 + live smoke PASS (§5.6)
Stage 04: PASS        — PR #14 merge cfdf79e; preview QA üye 37/37 + production QA üye 37/37 + live smoke 50/50 + WP3 live 55/55 (§5.7)
Stage 05: IN PROGRESS — DB canlı PASS (27/27, ZF PASS); web PR #15 preview 38/38 PASS; merge + production doğrulaması sürüyor (§5.9)
Stage 06: NOT STARTED — sıra kuralı
Stage 07: NOT STARTED — sıra kuralı
Stage 08: NOT STARTED — sıra kuralı
Stage 09: NOT STARTED — sıra kuralı
Stage 10: NOT STARTED — sıra kuralı
Stage 11: NOT STARTED — sıra kuralı
Stage 12: NOT STARTED — sıra kuralı

Security:
- anon media write: KAPALI — üç yazma policy'si roles={service_role} (etkisiz, BYPASSRLS); public/anon/authenticated için yazma policy'si 0; canlı HTTP ile kanıtlandı
- public media read: AÇIK (beklenen) — "media anon read" + bucket media public=true
- secret scan: yeni eklenen dosyalarda çalıştırıldı (bkz. §5)
- public views: SALT-OKUNUR — member_public/comments_public/comment_reaction_counts üzerinde anon/authenticated yalnız SELECT (önce anon DELETE ile members satırı silinebiliyordu; §5.8)
- RLS/policy regressions: YOK (prod assert'ler: İP2 19/19, SEC-VIEWS 9/9; diğer policy/ACL md5'leri PRE ile aynı)

Product:
- Amsterdam TR V1: değişmedi (canlı doğrulama yapılamadı)
- Amsterdam EN: yok (Stage 09 başlamadı)
- Profile/navigation: değişmedi
- Trips/favorites: değişmedi; asa-storage kütüphanesi canlı HTML'e bağlı DEĞİL (beklenen)
- Welcome/OTP: değişmedi; WSE welcome_service_email.v1 default_enabled=true + effective_from set
- Copenhagen: /kopenhag/ stub (2037 bayt) değişmedi
- Image pipeline: yok (Stage 10 başlamadı); media bucket object sayısı = 0

Costs:
- paid resource created: NO
- card/plan upgrade: NO

Remaining blockers: B2 — admin ve normal üye test oturumu yok (İP1 gerçek admin upload'ı ve 403 testi için şart) — bkz. §3
Known non-goals: bkz. §7
Rollback references: main 7a548e9; admin-api v18 ezbr 96bd5e04… (önceki v17 ezbr d4ea5db5… — kırık, geri dönülmez); migration ledger son kayıt 20260930202808
```

---

## 1. Ne istendi, ne yapıldı (özet)

Mete'nin talimatı: PRD'deki 12 iş paketini sırayla tamamla; her paketten sonra canlı web sitesi ve admin panelde doğrula; hata varsa düzeltmeden sonraki adıma geçme; ücretli işlem yapma; sonunda alınan aksiyonları anlatan bir rapor hazırla.

Yapılanlar:

1. **PRD §8 başlatma kuralı uygulandı:** production ve repo durumu **salt-okunur** doğrulandı (§2).
2. Doğrulama sırasında **gerçek bir production hatası** bulundu: canlı `admin-api` v17'nin kaynağı gerçek kod değil, `PLACEHOLDER_INDEX` metni. Fonksiyon her açılışta `ReferenceError` ile çöküyor (§3 B1).
3. Ayrıca bu yürütme ortamı `www.asalocal.club` ve `*.supabase.co` adreslerine HTTP ile erişemiyor ve admin oturumu yok. Bu yüzden PRD'nin istediği "canlı /admin oturumunda gerçek yükleme" yapılamıyor (§3 B2).
4. PRD §2.2 (ilk gerçek hata kuralı) ve Mete'nin "hatayı düzeltmeden sonraki adıma geçme" talimatı gereği **İş Paketi 1'de duruldu**. Production'a hiçbir yazma, deploy, migration veya policy değişikliği yapılmadı.
5. PRD §4'ün izin verdiği şekilde, production'a dokunmayan **test taslağı ve paket hazırlığı** paralel yapıldı: İş Paketi 1 kabul test aracı ve İş Paketi 2 migration paketi (uygulanmadı) (§5).

---

## 2. Başlangıç durumu doğrulaması (PRD §3) — salt-okunur

| PRD §3 beklentisi | Gözlenen (2026-10-07) | Kaynak | Sonuç |
|---|---|---|---|
| `main` ⊇ PR #12 merge `7a548e9…` | `origin/main` = `7a548e979b7b72556622edc6a8d52391a5874b7e` | `git fetch` + `merge-base --is-ancestor` | ✅ |
| Admin frontend wiring canlı | Repo'da `CDP3B/admin.html` (SHA256 `b9fb16108d7eb0ca…`) `media_upload`'ı admin-api'ye gönderiyor; `/admin` → `/CDP3B/admin.html` (302, `_redirects`) | repo | ✅ repo / ⚠️ canlı byte doğrulanamadı (B2) |
| `admin-api` production v17, `verify_jwt=true` | v17, verify_jwt=true, ezbr `d4ea5db5d010d1fe…` | `list_edge_functions` | ✅ sürüm / ❌ **içerik kırık (B1)** |
| `media_upload` rate token production'da | Migration `20260930202808 admin_rate_check_media_upload_token` ledger'da | `list_migrations` | ✅ |
| `media` bucket public okuma | `media public=true` | `storage.buckets` | ✅ |
| `media` object sayısı | 0 | `storage.objects` | ✅ |
| `media` anon INSERT/UPDATE/DELETE/SELECT policy'leri mevcut | 4 policy, hepsi `roles={public}`, ifade `bucket_id='media'` | `pg_policies` | ✅ |
| Marketing/SMS/push/journey kapalı | `marketing_config`: marketing_enabled=false, marketing_capture_enabled=false | SQL | ✅ |
| `public_go_live=false`, provider kilitleri | `email_provider_config`: essential_enabled=false, service_enabled=false, public_go_live=false | SQL | ✅ |
| Kopenhag `/kopenhag/` stub | `kopenhag/index.html` 2037 bayt, başlık "Kopenhag · AsaLocal" | repo | ✅ repo / ⚠️ canlı doğrulanamadı |
| OTP/Auth SMTP çalışıyor | Doğrulanamadı (canlı erişim yok; test e-postası gönderilmedi) | — | ⚠️ |
| WSE `welcome_service_email.v1` future-only aktif | default_enabled=true, effective_from set, policy_version=`welcome_service_email.v1`; diğer 6 service pref NULL | `service_pref_defaults` | ✅ |
| Browser storage kütüphanesi main'de, canlıya bağlı değil | `lib/asa-storage/` var; `index.html`, `amsterdam/index.html`, `kopenhag/index.html`, `CDP3B/admin.html` içinde referans yok | grep | ✅ |
| `admin_rate_events` media_upload sayısı (PRE) | 0 | SQL | kayıt |

### 2.1 Canlı girişsiz smoke (GitHub Actions + gerçek Chromium) — 50/50 PASS

Bu bulut ortamının proxy'si `www.asalocal.club` ve `*.supabase.co` bağlantılarını reddediyor (`CONNECT 403`). Canlı doğrulama bu yüzden repo'nun kendi GitHub Actions'ında yapıldı: ücretsiz kota, kimlik bilgisi yok, yazma yok. Kullanılan araçlar `LIVE_CHECKS/live_smoke.mjs` ve `.github/workflows/live-smoke.yml`. Koşu: [37618612459](https://github.com/metebagci88/amsterdam/actions/runs/37618612459).

| Alan | Sonuç |
|---|---|
| Canlı sayfa byte eşitliği (SHA-256 canlı = repo) | `/` `25b70807…`, `/amsterdam/` `0195b7a8…`, `/kopenhag/` `8428c222…`, `/CDP3B/admin.html` `b9fb1610…` → 4/4 PASS; başlıklar doğru |
| Redirect sözleşmesi | `/admin`, `/admin.html` → 302 `/CDP3B/admin.html`; `/copenhagen`, `/kopenhag.html` → 302 `/kopenhag/`; apex → 301 `https://www.asalocal.club/` |
| admin-api v18 reddetme yolları | 8/8 PASS (bkz. §3 B1) |
| Chromium mobil 390 px + masaüstü 1366 px, 4 sayfa | console error 0, 4xx/5xx yanıt 0, yatay taşma yok → 24/24 PASS |

Not: Bu smoke girişsiz yüzeyi kapsar. Üye ve admin oturumu gerektiren yollar (İP1 upload, 403 testi, profil vb.) B2 nedeniyle test edilemedi.

**Güvenlik advisor baseline'ı (değişiklik öncesi, bilgi amaçlı):** 41 INFO `rls_enabled_no_policy` (deny-all tablolar, kasıtlı), 3 ERROR `security_definer_view` (`member_public`, `comments_public`, `comment_reaction_counts`), 2 WARN mutable search_path (`_email_status_rank`, `_email_can_set_delivery`), 23 WARN authenticated tarafından çağrılabilen SECURITY DEFINER fonksiyon, 1 WARN leaked password protection kapalı. Bunlar **önceden var olan** durumlardır, bu programın kapsamında değildir ve dokunulmadı (bkz. §7).

---

## 3. Blocker'lar (kanıtlı)

### B1 — Production `admin-api` v17 kırık (sınıf: **ürün / deploy hatası**)

**İlk hata satırı (Supabase function_logs, 2026-10-01T12:58:10Z):**

```text
event loop error: ReferenceError: PLACEHOLDER_INDEX is not defined
    at file:///var/tmp/sb-compile-edge-runtime/source/index.ts:1:1
```

**Kanıt zinciri:**

1. `get_edge_function(admin-api)` → v17'nin tek dosyası `index.ts`, içeriği tam olarak `PLACEHOLDER_INDEX`. Karşılaştırma için `admin-delete-user` v5 ve `adim2-dispatch-once` v6 gerçek kaynaklarını döndürüyor; yani bu bir okuma aracı sorunu değil.
2. Edge gateway logları:
   - 2026-10-01 12:57 `GET 401`, `POST 401`: JWT'siz istekler gateway'de reddedilmiş, fonksiyon koduna hiç ulaşmamış.
   - 2026-10-01 12:58 `OPTIONS 500`: koda ulaşan ilk istek çökmüş.
   - 2026-10-05 21:58 `OPTIONS 500`: muhtemelen admin paneli açılırken yapılan CORS preflight isteği.
3. v17 deploy zamanı: 2026-09-30 20:33 UTC, `admin_rate_check_media_upload_token` migration'ından 5 dakika sonra.

**Kök neden (çıkarım):** v17 deploy edilirken `index.ts` içeriği yerine yer tutucu metin gönderilmiş. Muhtemelen büyük dosyayı aktarmamak için konulan bir placeholder hiç gerçek içerikle değiştirilmemiş.

**Etki:**
- Tarayıcıdan gelen her admin-api çağrısında CORS preflight 500 dönüyor. Admin panelin admin-api'ye dayanan **tüm** özellikleri çalışmıyor: sayımlar, üye arama, yorum moderasyonu, puan, segmentler, şehir sağlığı, consent sorguları ve **media_upload**.
- PR #12 (2026-10-06) admin görsel yüklemesini admin-api'ye taşıdı. Bu yüzden şu an **admin panelden görsel yüklemek de mümkün değil**. Eski doğrudan Storage yolu bilinçli olarak kaldırılmış ve fallback yok.
- Veri kaybı veya güvenlik genişlemesi yok: fonksiyon hiçbir şey yapamadan çöküyor ve fail-closed davranıyor.
- PRD §3'teki "admin-api production v17" ifadesi sürüm olarak doğru, ama v17 **çalışan** bir sürüm değil. PRD §3 bu durumda STOP raporu istiyor.

**Önerilen tek düzeltme (onay bekliyor; uygulanmadı):**
- `admin-api`'yi repo'daki `main` kaynağıyla yeniden deploy etmek: `CDP3B/edge/admin-api/index.ts` (SHA256 `7dce8225a16f53d2…`) ve `CDP3B/edge/admin-api/inert/media_upload.ts` (SHA256 `4a77daf0bf682543…`), `verify_jwt=true` ile. Sonuç v18 olur.
- Bu kaynak, gerçek HTTP Edge entegrasyon testini ephemeral Supabase üzerinde iki kez geçti:
  - [run 36771170754](https://github.com/metebagci88/amsterdam/actions/runs/36771170754) (`d6620e8`)
  - [run 37377434540](https://github.com/metebagci88/amsterdam/actions/runs/37377434540) (`0cf4407`)
- Ücretsiz. Yeni kaynak oluşturmaz.
- Rollback: v17'ye dönmenin anlamı yok, çünkü v17 kırık. Sorun çıkarsa `verify_jwt=true` korunarak bir önceki repo commit'inin admin-api kaynağı deploy edilir.
- Deploy sonrası kabul testi:
  - OPTIONS (izinli origin) → 200
  - JWT'siz → 401
  - Normal üye → 403
  - Admin `counts` → 200
  - Ardından İş Paketi 1 akışı
- Bu, PRD kapsamı dışında bir production yüzeyine dokunduğu için (§2.5, §8) Mete'nin açık onayı beklendi.

**Uygulama (2026-10-07, Mete onayı: "1'e onay veriyorum"):**

| Adım | Sonuç |
|---|---|
| Kaynak = `origin/main` | `git diff origin/main -- CDP3B/edge/admin-api/` boş |
| `deploy_edge_function admin-api`, dosyalar `index.ts` + `inert/media_upload.ts`, `verify_jwt=true` | v18 ACTIVE, ezbr `96bd5e041aab6886…` (bundle derlendi) |
| Geri okuma + bağımsız byte karşılaştırması (ayrı ajan, `get_edge_function` → dosya → `sha256sum` + `diff`) | `index.ts` `7dce8225a16f53d2…` = repo; `inert/media_upload.ts` `4a77daf0bf682543…` = repo; diff boş → **IDENTICAL** |
| verify_jwt | true (değişmedi) |
| Runtime kabul — girişsiz yollar (GitHub Actions [Live smoke run 37618612459](https://github.com/metebagci88/amsterdam/actions/runs/37618612459), 2026-10-07 12:06Z) | **PASS**:<br>• OPTIONS izinli origin → 200 + ACAO=`https://www.asalocal.club`<br>• yabancı origin → 403<br>• JWT yok → 401<br>• anon JWT + JSON `media_upload` → **415 `unsupported_media_type` (fonksiyon kodu çalışıyor)**<br>• text/plain → 415<br>• anon rol `counts` → 401 `invalid_token`<br>• bozuk multipart → 401<br>• bilinmeyen action → 400<br>• yanıtlarda stack/secret yok |
| Sunucu logu (function_logs, 12:06Z sonrası) | Yalnız `booted (24–33ms)` kayıtları var; `ReferenceError` ve 5xx yok |
| Runtime kabul — girişli yollar (üye 403 / admin `counts` 200 / `media_upload`) | **BEKLİYOR**: test hesabı yok (B2) |

Not: Her iki dosyanın başlık yorumunda hâlâ "NOT deployed" yazıyor (`index.ts:8`, `inert/media_upload.ts:3-4`). Bu yorumlar artık eskidi. Deploy edilen baytlarla repo'nun eşit kalması için bu turda değiştirilmedi. Bir sonraki admin-api değişikliğinde yorumla birlikte güncellenmeli.

### B2 — Canlı site ve admin oturumu erişimi yok (sınıf: **erişim / altyapı**)

- Bu bulut yürütme ortamının ağ politikası şu adreslere izin vermiyor: `https://www.asalocal.club/` (curl → `000`) ve `https://tosqsabuaomgqjtogdrn.supabase.co/` (curl → `000`).
- Supabase'e yalnızca MCP bağlantısı üzerinden erişilebiliyor: SQL, loglar, Edge fonksiyon listesi.
- Admin girişi `signInWithPassword` ile yapılıyor (`CDP3B/admin.html:154`). Ortamda admin veya test üye kimlik bilgisi yok. Kimlik bilgileri sohbet üzerinden istenmedi (PRD §2.4).
- Sonuç: PRD İş Paketi 1 adım 2'deki "canlı /admin oturumunda bir test görseli yükle" ve Mete'nin "canlıda web sitesi ve admin panele girip kontrol et" talimatı bu ortamda yerine getirilemez.

**Gerekenler (Mete tarafında, ücretsiz):**
1. Ortam ayarları → Network access → Allowed domains: `www.asalocal.club`, `asalocal.club`, `tosqsabuaomgqjtogdrn.supabase.co`.
2. Ortam değişkenleri:
   - `ASALOCAL_ADMIN_EMAIL` / `ASALOCAL_ADMIN_PASSWORD`: tercihen yalnız bu testler için ayrılmış, gerekli admin rolüne sahip bir hesap.
   - `ASALOCAL_MEMBER_EMAIL` / `ASALOCAL_MEMBER_PASSWORD`: 403 testi için, admin rolü olmayan, mevcut ve doğrulanmış bir üye.
3. Yeni oturum. Ortam ayarları yeni oturumda geçerli olur.

**Alternatif:** Testleri Mete'nin kendi bilgisayarında, tarayıcı erişimi olan yerel bir Claude Code oturumunda çalıştırmak. Bu durumda giriş Mete tarafından tarayıcıda yapılır ve parola hiçbir yere yazılmaz.

---

## 4. Production'a yapılan değişiklikler

**Tek değişiklik:** `admin-api` v17 → v18 Edge deploy'u. Mete'nin açık onayıyla yapıldı ve kaynağı repo `main` ile bayt bayt aynı (§3 B1). Bunun dışında:
- `apply_migration` ve yazma SQL'i çalıştırılmadı. Yalnız `SELECT` sorguları, `list_*`, `get_edge_function`, `get_advisors` ve `query_logs` kullanıldı.
- Storage'a obje yüklenmedi; media object sayısı 0 → 0.
- Kullanıcı verisi okunmadı veya değiştirilmedi. Raporda e-posta, UUID ya da token yok.
- `main`'e merge yapılmadı. PR açılmadı.

---

## 5. Hazırlanan paketler (production'a dokunmaz)

PRD §4 gereği yalnız **hazırlık** yapıldı. Hiçbiri production'a uygulanmadı ve `main`'e merge edilmedi. Hepsi branch `cdp3b-asset-preview-2y4qmd` üzerinde.

### 5.1 İş Paketi 1 — `SEC_MEDIA_package/stage1/` (commit `aae20bb`)

| Bileşen | Açıklama |
|---|---|
| `S1_ACCEPTANCE.md` | Türkçe runbook. S1-00…S1-12 adımları; PRD İP1'deki her adım, negatif test ve kabul kriteri bir check ID'sine eşlenmiş. S1-00 baseline'ı: admin-api v18 + iki dosya hash'i. S1-00b: girişli runtime kontrolü (`counts` 200, OPTIONS 200, yazma 0). |
| `gates/s1_admin_upload_acceptance.mjs` | Gerçek `/admin` UI'ında Playwright ile tek seferlik upload (`S1_CONFIRM_UPLOAD=YES` şart). Doğruladıkları: multipart, tarayıcının ürettiği boundary, Bearer var ama değeri hiçbir çıktıya yazılmıyor, form alanları yalnız `action`/`prefix`/`file`, `public_url` HTTPS + `media` bucket + `venues/<uuid>`, public URL 200 `image/png` + bayt eşit, doğrudan Storage yazımı 0. Ön kontrol FAIL olursa upload yapılmaz. Kanıt dosyası create-only; ikinci koşu durdurulur. |
| `gates/s1_negative.mjs` | 17 negatif test, hiçbiri obje oluşturmaz: auth yok / anon → 401; normal üye → 403; izinsiz prefix → 400; JSON → 415; 7 bozuk multipart → 4xx. Her yanıt stack/secret taramasından geçer. Üye hesabı yoksa sonuç `INCOMPLETE` olur, PASS değil. |
| `gates/s1_snapshot.sql` + `s1_snapshot_diff.mjs` | Salt-okunur PRE / MID0 / MID / POST snapshot karşılaştırması: obje sayısı, policy md5, rate token, residue=0. |
| Temizlik tasarımı | Test objesi Supabase Dashboard → Storage üzerinden Mete tarafından silinir. SQL ile silme `protect_objects_delete` trigger'ı nedeniyle mümkün değil ve dosyayı yetim bırakır; açık anon DELETE policy'sini kullanmak yasak client fallback olur. |
| Doğrulama | Yerel: `S1_OFFLINE_GATE_PASS` (selftest 58/27/13, rehearsal 25/25 senaryo, secret scan temiz). CI: [run 37620936386](https://github.com/metebagci88/amsterdam/actions/runs/37620936386) **success**. |
| Canlı koşu | **YAPILMADI**: admin ve üye test hesabı yok (B2). |

### 5.2 İş Paketi 2 — `SEC_MEDIA_package/stage2/` (commit `aae20bb`)

| Bileşen | Açıklama |
|---|---|
| `S2_up.sql` | Yalnız `"media anon insert"`, `"media anon update"`, `"media anon delete"` policy'lerini kaldırır (`DROP POLICY IF EXISTS`). PRE guard: baseline'dan herhangi bir sapmada hiçbir şeyi değiştirmeden durur. POST guard: storage.objects'te yalnız `"media anon read"` kalmalı, public/anon/authenticated için yazma policy'si 0 olmalı, RLS açık kalmalı, bucket bayrakları değişmemeli. `lock_timeout` 5s; dış BEGIN/COMMIT yok, `apply_migration` ile atomik. |
| `S2_down_INSECURE.sql` | Üç policy'yi orijinal tanımlarıyla geri kurar. **Güvenliği gevşettiği için** ayrı bir transaction ayarı olmadan çalışmayı reddeder. |
| `gates/s2_pre_assert.sql`, `s2_prod_assert.sql` | Salt-okunur PRE/POST matrisi. Satır 20: storage.objects dışındaki 25 policy'nin md5'i. Satır 21: tüm bucket öznitelikleri. Böylece "diğer bucket/policy'ler değişmedi" kriteri kanıtlanır. Production PRE: `S2_PRE_ASSERT_PASS`. |
| `gates/s2_zero_footprint_test.sql` | Apply sonrası production'da çalışacak test. anon/authenticated INSERT 42501, UPDATE/DELETE 0 satır, SELECT izinli. Kendi içinde `RAISE` ile geri alınır, kalıntı bırakmaz. |
| Yerel doğrulama | PGlite PG17: **201/0**. psql PG16: 30/0. Client direct-write taraması temiz: canlı kodda anon yazma policy'sine dayanan yol yok. |
| CI (gerçek Supabase storage şeması, CLI 2.118.0 → storage-api v1.77.0, `storage.migrations` md5 = production) | [run 37620936407](https://github.com/metebagci88/amsterdam/actions/runs/37620936407) **39/0 PASS**:<br>• up sonrası anon upload/PUT/upsert/delete/move/copy reddediliyor<br>• service_role upload + public URL çalışıyor<br>• up iki kez idempotent<br>• down gerçekten geri açıyor, re-up yeniden kapatıyor<br>• residue 0, teardown 0 container/volume<br>• log secret taraması temiz |
| Production apply | **YAPILMADI**: önkoşul İP1 PASS (B2). |

Denetim: Her paket ayrı bir ajan tarafından adversarial olarak denetlendi. Toplam 8 "major" bulgu çıktı ve hepsi düzeltildi. Örnekler: başarısız ön kontrolden sonra upload yapılabilmesi, kanıt dosyasının üzerine yazılabilmesi, CI'da `latest` CLI kullanılması, diğer policy/bucket'lar için kanıt eksikliği.

### 5.3 Canlı kontrol aracı — `LIVE_CHECKS/` (commit `ce8202e`)

Girişsiz, yazmasız canlı smoke testi; sonuçlar §2.1'de. Her push'ta ya da elle tetiklenerek yeniden çalıştırılabilir.


---

### 5.4 İş Paketi 1 — CANLI KABUL: `SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS` (2026-10-07)

**Erişim yöntemi (Mete onaylı):**
- İki adanmış, etiketli test hesabı oluşturuldu (SQL ile, e-posta gönderilmeden):
  - `qa-admin`: yalnız `venue_editor` rolü
  - `qa-member`: rolsüz
- Parolalar GitHub Actions runner'ında rastgele üretildi ve maskelendi; Claude dahil kimse görmedi. Dışarıya yalnız bcrypt özetleri çıktı (`qa_signals/<run>/hashes.json`).
- Operatör özetleri SQL ile hesaplara yazdı. Koşu bitince parolalar yeniden kullanılamaz (`''`) yapıldı.
- Koşu: [QA live run 37629590923](https://github.com/metebagci88/amsterdam/actions/runs/37629590923). Adımlar arası operatör kapıları `go_upload` / `go_cleanup`.
- Temizlik için geçici Edge fonksiyonu `qa-media-cleanup` v1 kullanıldı:
  - verify_jwt açık; yalnız qa-admin çağırabilir; yalnız `venues/<uuid>` yolları ve 3 saatten yeni objeler.
  - Silme service-role ile Storage API üzerinden yapılır, metadata ve blob birlikte silinir.
  - İş bitince 410 stub'ına çevrilecek.

| Adım | Sonuç |
|---|---|
| S1-00 baseline | admin-api v18, `verify_jwt=true`, iki dosya hash'i = repo |
| S1-00b runtime | `RUNTIME_PASS`: gerçek UI girişi, `counts` 200, CORS OPTIONS 200, yazma 0, console error 0 |
| S1-02 PRE | PASS B1–B7 (`evidence/live_2026-10-07/pre.json`) |
| S1-03 preflight | `PREFLIGHT_PASS`: canlı kaynak statik kontrolleri S01–S13 |
| S1-04 negatif | **17/17 PASS**:<br>• JWT yok / anon → 401<br>• qa-member → 403 `not_admin`<br>• izinsiz prefix → 400<br>• JSON → 415<br>• 7 bozuk multipart → 4xx<br>• stack/secret yok |
| S1-05 MID0 | PASS: obje Δ=0, rate Δ=0 (negatif testler hiçbir şey yazmadı) |
| S1-06 tek upload | **PASS A04–A17**:<br>• admin-api'ye tam 1 multipart POST<br>• boundary tarayıcı tarafından üretildi; sayfa Content-Type set etmedi<br>• Bearer oturum JWT'si; değer hiçbir çıktıya yazılmadı<br>• form alanları yalnız `action`/`prefix`/`file`<br>• yanıt 200 ve allowlist alanları<br>• `public_url` = https + `media` + `venues/<uuid>.png`<br>• public GET 200 `image/png`, bayt eşit<br>• doğrudan Storage yazımı 0; form kaydedilmeden kapatıldı |
| S1-07 MID | PASS M1–M6: +1 obje, +1 `media_upload` rate token (Edge yolu kanıtı); sha256(name) eşleşti; 10488 B png |
| S1-08 cleanup | `qa-media-cleanup` → HTTP 200, `removed:1` |
| S1-09 POST | PASS P1–P4: **residue=0**; toplam tam 1 Edge upload; policy md5 `91917dec…` değişmedi |
| S1-10 verify-gone | public URL → 400 (`GONE`) |
| S1-11 sızıntı | çıktılarda iki secret scanner temiz; Edge loglarında token benzeri iz 0, error 0 |

**Gözlem (bilgi, kapı değil):** A01i'de gerçek Chromium'un aldığı `/CDP3B/admin` HTML'inin hash'i (`bf9eab9d…`) repo ve Node fetch hash'inden (`b9fb1610…`) farklı. Bu, Cloudflare'in tarayıcıya giden HTML'i dönüştürdüğünü düşündürüyor (ör. e-posta gizleme veya script enjeksiyonu). Statik kontroller ve işlev etkilenmedi.

### 5.5 İş Paketi 2 — CANLI: `SEC_MEDIA_STORAGE_CLOSED` (2026-10-07)

**Yöntem değişikliği (v2) ve gerekçesi:**
- Supabase MCP, metninde `DROP` geçen her ifadeyi etkileşimli bir insan onayına bağlıyor. Bu onay penceresi oturuma ulaşmadı: `apply_migration` üç kez 60 saniyede zaman aşımına düştü, sorgu Postgres'e hiç ulaşmadı ve her seferinde durumun değişmediği doğrulandı.
- Silmeyen alternatif, Mete'ye açıkça soruldu ve onaylandı ("sen uygula. onaylıyorum"): `ALTER POLICY ... TO service_role` ile üç yazma policy'si etkisizleştirildi ve `COMMENT ON POLICY` ile işaretlendi.
- Policy'ler yeniden adlandırılamadı, çünkü bu tablo sahipliği gerektiriyor (42501).
- Güvenlik etkisi PRD'nin istediğiyle aynı: anon/authenticated için `storage.objects` üzerinde yazma policy'si kalmadı.
- **PRD sapması:** PRD policy'lerin "kaldırılmasını" istiyordu; burada etkisiz hâlde duruyorlar. Kozmetik temizlik (sahibin Dashboard SQL editöründe silmesi) bir non-goal olarak not edildi.

| Adım | Sonuç |
|---|---|
| CI (gerçek Supabase storage, CLI 2.118.0 / storage-api v1.77.0) | [run 37641194409](https://github.com/metebagci88/amsterdam/actions/runs/37641194409): local-gates ✅, storage-api **43/0** ✅ |
| PRE assert | `S2_PRE_ASSERT_PASS` 16/16 (diğer 25 policy md5 + bucket öznitelikleri dahil) |
| `apply_migration sec_media_close_anon_write` | success (ledger +1) |
| `s2_prod_assert` | **19/19 PASS**: matris md5 `74b56eca…`, yazma policy (public/anon/auth) = 0, açıklama 3/3, diğer policy/bucket md5 değişmedi |
| Zero-footprint davranış testi | **PASS, 0 fail**:<br>• anon/authenticated INSERT ve UPSERT → 42501 RLS<br>• UPDATE ve DELETE → 0 satır<br>• SELECT izinli<br>• service_role yazabiliyor<br>• tüm test geri alındı |
| Güvenlik advisor'ları | baseline ile aynı, yeni bulgu yok |
| QA run [37642562397](https://github.com/metebagci88/amsterdam/actions/runs/37642562397) — S2 sonrası İP1 araçları | preflight / runtime / negatif 17/17 PASS; gerçek admin UI upload A04–A17 PASS; cleanup `removed:1`; GONE |
| QA — S2 HTTP kabulü | **15/15 PASS**:<br>• anon/üye doğrudan INSERT → 400<br>• PUT, upsert → 400<br>• DELETE → 0 obje silindi<br>• admin Edge upload 200 + public okuma bayt eşit<br>• üye Edge upload 403 `not_admin`<br>• cleanup ile 1 obje silindi |
| Final | media obje 0 (**residue 0**); toplam 3 Edge upload, hepsi temizlendi; QA hesapları kilitlendi (`encrypted_password=''`) |

Rollback: `S2_down_INSECURE.sql`. Bu dosya güvenliği gevşetir, arming GUC'u ister ve policy'leri `TO public`'e çevirir; içinde `DROP` yoktur.

### 5.6 İş Paketi 3 — CANLI: city-scoped browser storage (2026-10-07)

| Adım | Sonuç |
|---|---|
| Yerel | unit 78/78; Playwright e2e 454/0 (25 senaryo × masaüstü/390 px); UX trust PASS; mutasyon kontrolleri yakalandı |
| Adversarial denetim | 2 tur. Bulunanlar:<br>• **gerçek veri kaybı yolu:** eski sekme ve stale reader nedeniyle takvim fotoğrafı kaybı<br>• quota > %50 kullanıcılarda foto eklenip silinememesi<br>• restore_failed durumunda yanıltıcı mesaj<br>Hepsi düzeltildi. |
| PR | [#13](https://github.com/metebagci88/amsterdam/pull/13). CI: WP3 gates, CDP3C gates/edge, asa-storage ✅. Cloudflare Pages: ilk build GitHub'ın push'ta 500 verdiği anda başarısız oldu; bir sonraki gerçek commit'te ✅ |
| Preview kabul | `https://wp3-storage-city-isolation.amsterdam-zhw.pages.dev` → [run 37651095011](https://github.com/metebagci88/amsterdam/actions/runs/37651095011) **55/55 PASS** |
| Merge | normal merge commit `8acfb0e` (squash/rebase yok); rollback referansı: önceki main `7a548e9` |
| Production | Cloudflare deploy ✅. [Live smoke run 37651483258](https://github.com/metebagci88/amsterdam/actions/runs/37651483258):<br>• sayfalar canlı = main (SHA eşit)<br>• redirect + admin-api kontrolleri PASS<br>• 4 sayfa × 2 viewport console error 0<br>• **WP3 live 55/55 PASS**: migrasyon bayt bayt, legacy korunur, reload idempotent, çakışma ve yanlış şehir bildirimi, Kopenhag izolasyonu |

Açık ürün kararı (owner delegasyonuyla verildi):
- `plan_prefs` için seçenek (c) korundu: kütüphane sözleşmesi değişmedi, kullanıcıya "Amsterdam planına aktar" seçeneği sunuluyor.
- `ams_calphoto` yalnız kota hatasında, yazma anında ve bu sekmenin okuduğu baytlar aynıysa güvenli taşıma ile emekliye ayrılıyor.

### 5.7 İş Paketi 4 — CANLI: üye hesabı ve profil navigasyonu (2026-10-07)

| Adım | Sonuç |
|---|---|
| Yerel | unit 15/15; WP4 e2e 346/0 (masaüstü + 390 px); WP3 e2e 454/0 (regresyon); WSE static + UX trust PASS; mutasyon 20/20 yakalandı |
| PR | [#14](https://github.com/metebagci88/amsterdam/pull/14) — CI 6/6 ✅ (WP4 gates, WP3 gates, CDP3C gates/edge, Cloudflare Pages); review thread yok |
| Preview kabul (gerçek Supabase, adanmış QA üye) | `https://wp4-member-nav.amsterdam-zhw.pages.dev` → QA run [37661710483](https://github.com/metebagci88/amsterdam/actions/runs/37661710483) **37/37 PASS** (masaüstü + 390 px): anon etiket/giriş dialogu/ESC odak dönüşü; UI'dan gerçek login; menü tam 5 PRD öğesi; aria-expanded; Tab tuzağı; Profilim seyahatsiz 2 etkileşim; e-posta salt-okunur; tercihler "Varsayılan belirlenmedi"; seyahat boş durumu + CTA odak; çıkış (asa_session temizlenir, odak hesap düğmesi); taşma yok; console error 0 |
| İlk deneme | QA run 37660852697 WP4 adımı başlamadan düştü (runner `playwright` modülünü çözemedi — test aracı hatası, site değil). Düzeltme `31e6106` (createRequire(QA_DEPS) + `set +e`), stub'lı yerel kuru çalıştırma 37/37, sonra tekrar |
| Merge | normal merge commit `cfdf79e` (squash/rebase yok); önceki main `8acfb0e` |
| Production | Cloudflare deploy ✅. QA run [37662143135](https://github.com/metebagci88/amsterdam/actions/runs/37662143135) www.asalocal.club **37/37 PASS**; live smoke [37662143231](https://github.com/metebagci88/amsterdam/actions/runs/37662143231) 50/50 (sayfa SHA = main) + WP3 live 55/55 |
| Test verisi | QA hesapları her koşudan sonra kilitlendi (`encrypted_password=''`). QA üyenin normal login akışının oluşturduğu satırlar (members 1, member_service_pref_current 1, member_service_pref_events 1) etiketli test hesabına ait; İP5/İP6 testlerinde kullanılacak, program sonunda temizlenecek. email_outbox'a QA üye için kayıt düşmedi |

### 5.8 SEC-VIEWS hotfix — CANLI: public view'lar salt-okunur (2026-10-07)

**Nasıl bulundu:** İP5 DB paketinin adversarial incelemesi. PRD §2.2 güvenlik açığı → İP5'e geçmeden önce kapatıldı.

| Adım | Sonuç |
|---|---|
| Açık | `public.member_public` otomatik güncellenebilir (bits 28), `security_invoker=false`, sahibi `postgres` (BYPASSRLS) → yazmada members RLS uygulanmıyor; anon/authenticated `arwdDxtm`; members guard trigger'ı DELETE'i görmüyor. Herkes anon anahtarıyla `DELETE /rest/v1/member_public?…` ile üye satırı silebilirdi; giriş yapan herkes başkasının display_name'ini değiştirebilirdi |
| PRE kanıt (prod, zero-footprint) | `SV_ZF_VERDICT=VULNERABLE`, opens=6 (anon + authenticated DELETE/UPDATE/INSERT izinli; `WHERE false` + REPORT rollback → 0 satır) |
| Paket | `SEC_VIEWS_package/` — `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` (3 view, anon + authenticated), SELECT korunur; PRE guard (tanım md5, sahip, reloptions, ACL), POST guard, idempotent, armed rollback; metinde `drop` yok |
| Kapılar | PGlite PG17 26/26 + PG18 26/26 (açık gerçek satırla üretildi → düzeltme sonrası 42501); mutasyon 3/3; CI `sec-views-gates` ✅ |
| Uygulama | `apply_migration sec_public_views_readonly` ✅ |
| POST (prod) | `SEC_VIEWS_PROD_ASSERT_PASS` 0 FAIL / 9 (diğer 54 public ilişkinin ACL md5'i PRE ile aynı); zero-footprint `SV_ZF_VERDICT=PASS` |
| Canlı HTTP | live smoke [37663924663](https://github.com/metebagci88/amsterdam/actions/runs/37663924663) **56/56**: anon GET 3 view → 200; anon DELETE/PATCH/POST member_public → 401 `42501`; tüm sayfalar console error 0 (yorumlar okunuyor) |
| Rollback | `SEC_VIEWS_down_INSECURE.sql` (açığı geri açar; `sec_views.rollback_armed` GUC'u olmadan çalışmaz) |

Kalan kök neden (kapsam dışı, öneri): Supabase varsayılan yetkileri `public` şemadaki yeni view'lara anon/authenticated için tüm yetkileri veriyor. Live smoke'taki view probları ve prod assert satır 5 regresyonu yakalar.

### 5.9 İş Paketi 5 — ad-soyad ve profil tamamlama (2026-10-07)

**Veritabanı (`WP5_package/db/`, migration `wp5_member_private_name`)**

| Adım | Sonuç |
|---|---|
| Adversarial inceleme | Kritik bulgu: yazılabilir `member_public` view'ı (önceden vardı). Önce SEC-VIEWS ile kapatıldı (§5.8). Ayrıca:<br>• görünmez/dolgu karakterli isimler kabul ediliyordu → reddedildi<br>• pg_graphql varsayımı → önkoşul olarak eklendi<br>• e-posta için "verified" ifadesi → düzeltildi |
| Kapılar | PGlite PG17 114/114 + PG18 114/114; mutasyon 12/12; CI `wp5-db-gates` ✅ |
| PRE (prod, salt-okunur) | `WP5_PRE_ASSERT_PASS` 0 FAIL / 24 (SEC-VIEWS ACL ve pg_graphql yokluğu dahil) |
| Uygulama | `apply_migration` ✅ — PRE state=baseline. POST guard'da CHECK, guard ve RPC md5'leri PGlite ile birebir aynı |
| POST (prod) | `WP5_PROD_ASSERT_PASS` 0 FAIL / 27 |
| Davranış (prod, zero-footprint) | `WP5_ZF_VERDICT=PASS fails=0`:<br>• 23 ret vektörü `member_set_name` ile reddedildi<br>• 20 doğrudan PATCH 23514 ile reddedildi<br>• başka adrese e-posta PATCH sabitlendi<br>• A, B'yi güncelleyemiyor (0 satır)<br>• view üzerinden yazma 42501<br>• anon isimleri okuyamıyor<br>• service_role çalışıyor<br>Kalıntı 0 |
| Değişen satır | 0 (mevcut üyelere isim yazılmadı; zorla güncelleme yok) |

**Web (`WP5_package/web/`, PR [#15](https://github.com/metebagci88/amsterdam/pull/15))**

| Adım | Sonuç |
|---|---|
| Yerel | WP5 unit 17/0 (DB politikası eşleşmesi 18/18); WP5 e2e 405/0 (1366/390/360); mutasyon 16/16; WP4 e2e 342/0; WP3 e2e 454/0; WP3 78/78; UX PASS; Kopenhag birebir; WSE PASS |
| Preview kabul (gerçek DB, QA üye) | QA run 37672669867: 36/37. Tek FAIL testin kendisinden geliyordu: bilerek gönderilen ve reddedilen PATCH'in 400'ü konsola düştü (site hatası değil). Test düzeltildi; QA run [37673198744](https://github.com/metebagci88/amsterdam/actions/runs/37673198744) **38/38 PASS**:<br>• banner (şehir + ana sayfa) ve "Şimdi değil" kalıcılığı<br>• XSS, 51 karakter, boş girdi reddi<br>• sunucu reddi (script, U+3164, 51, boş, rakam)<br>• doğrudan PATCH 23514; e-posta sabit<br>• kayıt, düzenleme ve kalıcılık<br>• display_name korundu<br>• dolu profilde banner yok<br>• anon için isimler görünmez ve RPC çalıştırılamaz (42703/42501) |
| QA verisi | Her koşu öncesi QA üyede ad/soyad NULL, display_name işaret değeri yapılır; sonrası temizlenir. Hesaplar kilitli |

## 6. Yeniden başlamak için gereken tek karar

> ~~Karar 1: admin-api v18 deploy onayı~~ → **verildi ve uygulandı** (§3 B1).
> **Kalan karar:** B2'deki ağ izni ve test hesaplarını ortam ayarlarına ekleyip yeni oturum başlatmak. Bu ayar yalnız Mete'nin claude.ai arayüzünden yapılabilir.

Bu tamamlanınca sıra: v18 runtime kabul testleri → İş Paketi 1 (hazır araçla) → İş Paketi 2 (hazır paketle) → İş Paketi 3 …

---

## 7. Bilinen kapsam dışı konular (non-goals)

- §2'deki önceden var olan advisor uyarıları: security definer view'lar, authenticated'a açık SECURITY DEFINER fonksiyonlar, mutable search_path, leaked password protection. Bu programın paketlerinde yer almıyorlar, dokunulmadı. Ayrı bir güvenlik turu önerilir.
- `email-assets-*` bucket'ları ve Edge asset modeli: PRD §İP2 gereği dokunulmadı.
- Auth/SMTP/Resend ayarları: dokunulmadı.

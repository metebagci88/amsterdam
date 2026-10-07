# SEC-MEDIA · Stage 1 (İŞ PAKETİ 1) — Güvenli medya yükleme kabul testi · Runbook

**Durum:** Harness HAZIR, canlıda **ÇALIŞTIRILMADI**. Bu paket production'a hiçbir şey uygulamaz (migration/deploy/policy/SQL yazma yok). Canlı koşu, `www.asalocal.club` ve `*.supabase.co`'ya erişebilen bir ortamdan, aşağıdaki sırayla yapılır.
**Bağlayıcı kaynak:** `ASALOCAL_12_ASAMALI_URUNLESTIRME_PRD.md` §2, §3, İŞ PAKETİ 1 (ve İP-2 önkoşulu: İP-1 tam PASS olmadan İP-2 çalışmaz).
**Hedef çıktı:** `SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS` raporu (§11).

```
APPLY=NO  DEPLOY=NO  POLICY_CHANGE=NO  VENUE_ROW_WRITE=NO  CLIENT_DELETE_FALLBACK=NO
CANLI_YAZMA = tam 1 media objesi (+1 admin_rate_events satırı) → cleanup ile objesi geri alınır (residue=0)
```

---

## 1. Bağlayıcı kurallar (PRD §2 özeti, bu aşamaya uygulanmış hâli)

- **Tek upload.** `S1_CONFIRM_UPLOAD=YES` olmadan upload yapılmaz. Upload'dan hemen önce `out/s1_upload.attempt` *create-only* yazılır; `out/` içinde işaret **veya** önceki kanıt (`s1_upload_result.json`, `s1_object_ref.local.json`) varken script **STOP (exit 3)** verir — yalnız işareti silmek upload'u yeniden açmaz. Hata sonrası retry/rerun yok (PRD §2.2); yeni bir koşu bilinçli insan kararı + yeni/boş `S1_OUT_DIR` ister.
- **İlk gerçek hatada dur.** Upload öncesi kapılardan (A01–A03, A05, A07, A06 istemci prefix guard'ı, A04 test görseli) biri FAIL ise koşu **işaret yazmadan ve upload yapmadan** biter (`stop_reason=pre_upload_gate_failed`, exit 1, oturum `scope=local` kapatılır).
- **Kanıt üzerine yazılmaz.** `out/s1_upload_result.json` yalnız işareti yazan (upload'u deneyen) koşu tarafından *create-only* (`wx`) oluşturulur. Upload denemeyen her tam-mod çıkışı (A00 STOP/konfig, upload öncesi kapı FAIL) kendi dosyasına yazar: `out/s1_upload_blocked.<run_id>.json`. Böylece yanlışlıkla tekrar koşmak tek upload'un kanıtını (`object.path_sha256`, `test_image.bytes`, ağ/yanıt kanıtı) silemez ve S1-07/S1-09 girdisi korunur.
- **Secret yok.** Şifre/JWT/anon key/e-posta yalnız env'den ve canlı sayfadan *bellek içine* okunur. Tüm çıktı dosyaları yazılmadan önce sızıntı korumasından geçer (`writeJsonGuarded`: bilinen secret değerleri, JWT, `sb_*` key, e-posta, Bearer değeri → yazmayı reddeder). Log satırları redaksiyonludur. Authorization için yalnız `present` / rol adı yazılır.
- **Ham e-posta yok.** Kullanıcılar yalnız maskeli UUID (`xxxxxxxx-****`) ile raporlanır.
- **Yeni kullanıcı yok.** Mevcut, doğrulanmış admin + mevcut, doğrulanmış *admin olmayan* üye hesabı kullanılır (PRD §2.4).
- **Ücretli işlem yok.** Playwright/Chromium indirme dahil her şey ücretsiz.
- **Mekan kaydı yok.** Upload "Yeni mekan" formunun "Fotoğraf yükle" kontrolüyle yapılır, form **Vazgeç** ile kapatılır; REST tablo yazımı olursa A13 FAIL.
- **Oturum kapatma `scope=local`.** Admin UI'nin "Çıkış" butonu `signOut()` (varsayılan *global*) çağırır (`CDP3B/admin.html:257`); harness bunu kullanmaz, yalnız kendi oturumunu kapatır.

## 2. Başlangıç gerçekleri (salt-okunur, 2026-10-07)

| Öğe | Değer | Kaynak |
|---|---|---|
| repo | `cdp3b-asset-preview-2y4qmd` HEAD `75ce174` = `origin/main` `7a548e9` (PR #12 merge) + 3 yalnız-rapor commit'i (`d45c02d`, `8ed87eb`, `75ce174`; `git diff --stat 7a548e9 75ce174` → yalnız `ASALOCAL_12_STAGE_PROGRAM_RESULT.md`) | git |
| buckets | `media` public=true · `email-assets-public` public=true · `email-assets-draft` public=false; üçünde de 0 obje | `gates/s1_snapshot.sql` (MCP `execute_sql`, SELECT) |
| storage.objects policy'leri | 4 adet: `media anon read/insert/update/delete`, roles `{public}`; digest `91917deced4566c09eebc1f7b79d9fd6` | aynı |
| `admin_rate_events` media_upload | 0 | aynı |
| `protect_objects_delete` trigger | VAR, etkin: `BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()` | `pg_trigger` |
| pg_cron | yok (rate event'leri otomatik silinmez) | `pg_extension` |
| **admin-api** | **v18**, `verify_jwt=true`, ezbr `96bd5e041aab6886…`. v17 kırıktı (kaynak `PLACEHOLDER_INDEX`, her açılışta `ReferenceError`); v18, Mete onayıyla 2026-10-07'de repo `main` kaynağından deploy edildi. Bağımsız geri okuma (`get_edge_function` → dosya → `sha256sum` + `diff`): `index.ts` `7dce8225a16f53d2…` ve `inert/media_upload.ts` `4a77daf0bf682543…` = repo, **bayt-eşit**. Runtime kabulü (OPTIONS 200 / admin `counts` 200) henüz canlıda koşulmadı → **S1-00b**. | `ASALOCAL_12_STAGE_PROGRAM_RESULT.md` §3 B1; MCP `list_edge_functions` (salt-okunur, bu turda tekrar: version 18, verify_jwt=true, ezbr `96bd5e04…`) |

Tam baseline: `fixtures/s1_snapshot_readonly_2026-10-07.json` (`node gates/s1_snapshot_diff.mjs --phase pre --cur <dosya>` → B1–B7 PASS).

> **PRD §3 notu:** PRD metni `admin-api v17` diyor; v17 kırık bir deploy'du (B1). Onaylı düzeltme v18 = repo `main` kaynağı (program raporu §3 B1). Bu paket için beklenen sürüm **v18**'dir: S1-00 sürüm 18 + iki dosyanın hash'i + `verify_jwt=true` ister; v17'ye dönülmez (kırık). v18'den farklı bir sürüm veya farklı bir hash, onaysız bir deploy anlamına gelir → STOP.

## 3. Dosyalar

| Dosya | Görev |
|---|---|
| `S1_ACCEPTANCE.md` | Bu runbook. |
| `gates/s1_snapshot.sql` | Salt-okunur tek SELECT → tek satır/tek jsonb (`s1_snapshot`): media obje sayısı + prefix dağılımı + son 20 obje (maskeli ad, `sha256(name)`, boyut, mime), tüm bucket'lar (public, limit, obje sayısı), storage.objects'teki **tüm** policy tanımları + md5, RLS, `admin_rate_events` media_upload (toplam/24s/son), protect_delete trigger. |
| `gates/s1_snapshot_diff.mjs` | PRE/MID0/MID/POST karşılaştırıcı; faz başına değişmezleri doğrular (§6). Offline. |
| `gates/s1_admin_upload_acceptance.mjs` | Playwright: gerçek UI girişi + tek PNG upload + network/yanıt/public URL kanıtı (A00–A21). Modlar: `--preflight` (giriş yok), `--runtime` (S1-00b: giriş + `counts` 200 + OPTIONS 200, R01–R03; upload yok), varsayılan (tam), `--verify-gone`, `--selftest`. |
| `gates/s1_negative.mjs` | 17 negatif test (N1a–N5g), **obje ve rate token oluşturmaz**. `--selftest`. |
| `gates/s1_lib.mjs` | Ortak: redaksiyon/sızıntı koruması, maskeleme, sentetik PNG/GIF, URL/istek sınıflandırma, multipart, canlı kaynak statik kontrolleri (S01–S13). |
| `gates/s1_offline_rehearsal.mjs` | Offline prova: **gerçek** `CDP3B/admin.html` + **gerçek** `admin-api/index.ts` handler'ı (Deno shim + mock supabase client) + verify_jwt gateway simülasyonu; 25 senaryo (hata enjeksiyonları ve kanıt-koruma senaryoları dahil). |
| `gates/run_selftests.sh` | Offline kapı: `node --check` + 3 selftest + prova + iki secret scan + `SHA256SUMS`. |
| `fixtures/s1_snapshot_readonly_2026-10-07.json` | Bugünkü salt-okunur canlı snapshot (selftest fixture'ı + baseline kanıtı). |
| `package.json`, `.gitignore` | `playwright@1.56.1`, `@supabase/supabase-js@2.117.2` (sabit). `node_modules/`, `package-lock.json`, `out/` commit edilmez. |
| `SHA256SUMS` | Bu dizindeki dosyaların özetleri (`SHA256SUMS` hariç). |
| `../../.github/workflows/sec-media-stage1-gates.yml` | CI: PR'da (`SEC_MEDIA_package/stage1/**`, `CDP3B/admin.html`, `CDP3B/edge/admin-api/**`, workflow) + `workflow_dispatch`; sabit sürümlü bağımlılıklarla `gates/run_selftests.sh` → `S1_OFFLINE_GATE_PASS` şart (exit 4 = kırmızı); workflow dosyası secret taraması. Production'a bağlanmaz. |

## 4. Ortam ve env

- Node **≥ 22.18** (selftest/prova `.ts` dosyalarını Node type-stripping ile import eder; canlı koşu için Node ≥ 20 yeterli).
- `cd SEC_MEDIA_package/stage1 && npm install --no-audit --no-fund && npx playwright install chromium` (ücretsiz). Alternatif: global playwright veya `S1_NODE_MODULES=<dir>/node_modules`.
- Erişim: `www.asalocal.club`, `tosqsabuaomgqjtogdrn.supabase.co`, `cdn.jsdelivr.net` (admin sayfası supabase-js'i oradan yükler), `cdnjs.cloudflare.com` (Leaflet). Proxy arkasında: Node için `NODE_USE_ENV_PROXY=1`, tarayıcı için `S1_BROWSER_PROXY=http://host:port`. TLS doğrulaması asla kapatılmaz.

| Env | Zorunlu | Açıklama |
|---|---|---|
| `ASALOCAL_BASE_URL` | hayır | Varsayılan `https://www.asalocal.club`. Origin olmalı, https. **Prod dışı origin'de admin-api CORS 403 verir** (`index.ts:19,37`). |
| `ASALOCAL_ADMIN_EMAIL` / `ASALOCAL_ADMIN_PASSWORD` | evet | Mevcut admin (canlıda yalnız `super_admin` atanmış; `venues` prefix'i `super_admin|venue_editor` ister, `media_upload.ts:61-64`). |
| `ASALOCAL_MEMBER_EMAIL` / `ASALOCAL_MEMBER_PASSWORD` | N2 için evet | Mevcut, doğrulanmış, **admin olmayan** üye. Yoksa N2 = `SKIPPED` → negatif verdict `INCOMPLETE` (exit 4) → Stage 1 PASS olamaz. |
| `S1_CONFIRM_UPLOAD=YES` | tam koşu için | Tek prod objesi oluşturma onayı. |
| `S1_OUT_DIR` | hayır | Varsayılan `stage1/out/` (gitignored). |
| `S1_CHROMIUM_PATH`, `S1_HEADED=1`, `S1_BROWSER_PROXY`, `S1_NODE_MODULES` | hayır | Tarayıcı/bağımlılık ayarları. Chromium açılamazsa `/opt/pw-browsers/chromium` otomatik denenir. |

Kimlik bilgilerini shell geçmişine yazmadan alın:

```bash
read -r  -p 'admin e-posta: ' ASALOCAL_ADMIN_EMAIL;  export ASALOCAL_ADMIN_EMAIL
read -rs -p 'admin şifre: '   ASALOCAL_ADMIN_PASSWORD; echo; export ASALOCAL_ADMIN_PASSWORD
read -r  -p 'üye e-posta: '   ASALOCAL_MEMBER_EMAIL; export ASALOCAL_MEMBER_EMAIL
read -rs -p 'üye şifre: '     ASALOCAL_MEMBER_PASSWORD; echo; export ASALOCAL_MEMBER_PASSWORD
```

Çıkış kodları (tüm script'ler): `0` PASS · `1` FAIL · `2` konfig/kullanım · `3` STOP (güvenlik kilidi) · `4` INCOMPLETE/SKIPPED (PASS sayılmaz).

## 5. Kod kanıtı — beklenen davranış (satır referansları)

`IDX` = `CDP3B/edge/admin-api/index.ts` (sha256 `7dce8225…`), `MU` = `CDP3B/edge/admin-api/inert/media_upload.ts` (sha256 `4a77daf0…`), `ADM` = `CDP3B/admin.html` (sha256 `b9fb1610…`, canlı `/admin` → 302 → `/CDP3B/admin.html`, `_redirects`).

**Gateway (verify_jwt=true):** Supabase Edge gateway JWT'yi fonksiyon kodundan **önce** doğrular. `Authorization` yok/JWT değil → gateway 401 (gövde gateway biçiminde; `{"error":"missing_bearer"}` görülmez). Anon key geçerli bir JWT olduğundan gateway'den geçer, fonksiyonda `getUser` başarısız olur → 401 `invalid_token`. Harness 401'in kaynağını (`gateway|function`) raporlar; ikisini de kabul eder.

**Fonksiyon kapı sırası (multipart):** CORS/Origin `IDX:36-37` (izinsiz Origin → 403) → POST `IDX:38` → kill `IDX:39` → Bearer `IDX:40` (401 `missing_bearer`) → Content-Type dalı `IDX:41-55` (JSON+`media_upload` → **415** `IDX:54`/`MU:176-178`; diğer tipler 415 `IDX:55`) → boyut 413 `IDX:44-48` → `getUser` 401 `invalid_token` `IDX:57` → `is_current_user_admin` 403 `not_admin` `IDX:58` → rol birleşimi (`super_admin|venue_editor|ads`, `IDX:21`) 403 `forbidden` `IDX:59` → `parseMediaMultipart` `IDX:62-63` (boundary yok `MU:364-365` / bölme hatası `MU:366-367` → 400 `bad_input`; istemci yol alanları `MU:92-108,369-371` → 400 `client_path_rejected`; bilinmeyen alan `MU:110,372` → 400 `unknown_field`; tekrar eden parça `MU:377-379` → 400 `bad_input`; action≠media_upload `MU:383-384` → 415; prefix ∉ {venues,ads} `MU:386` → 400 `bad_prefix`; boyut `MU:388`) → prefix rolü `IDX:64-67` (`MU:61-64`) → `admin_api_status`/`admin_writes_status` 503 `IDX:72-73` → **`admin_rate_check` `IDX:74` (ilk DB yazımı: `admin_rate_events` satırı)** → sniff `MU:453-454` (yalnız jpeg/png/webp; GIF → 400 `bad_mime_content`) → sunucu UUID'li yol `IDX:78`/`MU:392-396` → `upload(..., upsert:false)` `IDX:80`/`MU:468-475` (çakışma 409 `MU:477`) → 200 `{request_id, data:{bucket,path,public_url,mime,bytes}}` `IDX:86`/`MU:484-490`; public URL `MU:398-412`. Log: yalnız `upload_failed` + request_id `IDX:85`.

**İstemci (ADM):** `CFG`/`FN_URL` `ADM:99-100`; giriş `#le/#lp/#abtn/#aerr` + `signInWithPassword` `ADM:145-174`; "Mekanlar" sekmesi `ADM:259`; "+ Yeni mekan" `ADM:400`; dosya input'u → `venuePhotoUpload` `ADM:449,523`; `uploadToMedia` `ADM:939-961`: prefix guard fetch'ten önce `ADM:943`, FormData `action/prefix/file` `ADM:946-949`, `fetch(FN_URL,{method:"POST",headers:{apikey,Authorization},body:fd})` — **Content-Type yok** `ADM:953`, yalnız `d.public_url` döner `ADM:957-960`. Sayfada `storage.from(` yok.

**Neden negatifler obje oluşturamaz:** (1) her beklenen red `IDX:74`'ten önce → rate token yok, upload yok; (2) her multipart gövdedeki dosya **1×1 GIF "canary"**: tüm auth/rol/prefix kapıları bozuk olsa bile sniff (`MU:453-454`) GIF'i reddeder → Storage'a hiçbir şey yazılmaz. Prova, bu ikinci savunmayı rol kapıları kaldırılmış gerçek handler'la kanıtlar (§12).

## 6. Adım adım yürütme

S1-00 beklenen tam hash'ler (repo `main` = deploy edilen v18):

```
7dce8225a16f53d233131957fc0cf8fbbfad07065db34296a3b20b73d23ac210  index.ts
4a77daf0bf6825430b7bb0d3230b20f58b6dd6ab651f17c3b5d7ef42607f705a  inert/media_upload.ts
```

Tüm komutlar `SEC_MEDIA_package/stage1/` içinde. Snapshot'lar `gates/s1_snapshot.sql`'in çıktısıdır; şu yollardan biriyle alınır ve `out/<faz>.json` olarak kaydedilir (loader ham jsonb, `{"s1_snapshot":…}` veya MCP satır dizisi biçimini kabul eder):
(a) **Supabase Dashboard → SQL Editor** (önerilen; dosyayı yapıştır, Run, `s1_snapshot` hücresini kopyala) · (b) Supabase MCP `execute_sql` (salt-okunur SELECT) · (c) `PGOPTIONS='-c default_transaction_read_only=on' psql "$S1_DB_URL" -X -At -v ON_ERROR_STOP=1 -f gates/s1_snapshot.sql > out/pre.json` (bağlantı dizesi yalnız env'den; önerilmez).

| Adım | Ne / komut | Beklenen | STOP |
|---|---|---|---|
| **S1-00** Başlangıç teyidi | `git merge-base --is-ancestor 7a548e979b7b72556622edc6a8d52391a5874b7e origin/main`; admin-api sürümü + `verify_jwt` (Dashboard → Edge Functions veya MCP `list_edge_functions`); MCP `get_edge_function(admin-api)` → **her iki** dosyayı ayrı kaydet → `sha256sum` (beklenen tam değerler aşağıda); `email_provider_config` bayrakları (essential/service/public_go_live = false/false/false) kaydı | exit 0; admin-api **version 18**, `verify_jwt=true`; `index.ts` = `7dce8225a16f53d2…` **ve** `inert/media_upload.ts` = `4a77daf0bf682543…` (ikisi de zorunlu; onay: program raporu §3 B1) | version ≠ 18; iki hash'ten biri farklı veya dosya eksik/fazla; `verify_jwt≠true`; main'de PR #12 yok |
| **S1-00b** admin-api v18 runtime kabulü (upload YOK) | `node gates/s1_admin_upload_acceptance.mjs --runtime` → `out/s1_runtime_result.json` (admin env gerekli; `S1_CONFIRM_UPLOAD` gerekmez; tekrar koşulabilir) | `RUNTIME_PASS`: A01–A03; A05 gerçek UI girişi; **R01** Özet `counts` → 200; **R02** sayfadan (origin `https://www.asalocal.club`) admin-api `OPTIONS` → 200 (tarayıcı ayrıca preflight yapar; ikisi de geçmeli); **R03** multipart/Storage/REST yazımı 0; A20 çıkış `scope=local`. JWT'siz 401 ve üye 403 S1-04'te (N1a–N1d, N2) | R01/R02 FAIL (ör. v17 gibi 500 veya CORS bloğu → `status:null`) → STOP; S1-06'ya geçilmez |
| **S1-01** Offline kapı | `bash gates/run_selftests.sh` | `S1_OFFLINE_GATE_PASS` | herhangi FAIL; exit 4 (prova atlandı) PASS sayılmaz |
| **S1-02** PRE snapshot | `out/pre.json` → `node gates/s1_snapshot_diff.mjs --phase pre --cur out/pre.json` | B1–B4, B6 PASS; B5 (0 obje) PASS veya WARN (güncel değer raporlanır); B7 PASS | B1–B4/B6 STOP (exit 3) |
| **S1-03** Preflight (giriş/upload yok) | `node gates/s1_admin_upload_acceptance.mjs --preflight` → `out/s1_preflight_result.json` | `PREFLIGHT_PASS`: A01 (200), A02 (CFG, anon key rolü `anon`), A03 (S01–S13 canlı kaynakta) | A02/A03 FAIL; sayfada privileged key → STOP |
| **S1-04** Negatif testler | `node gates/s1_negative.mjs` → `out/s1_negative_result.json` | `PASS` 17/17; her satır `leak_check: clean` | FAIL; herhangi 2xx (anında STOP); üye admin çıkarsa STOP; `INCOMPLETE` (üye hesabı yok) → Mete'den mevcut üye hesabı iste |
| **S1-05** MID0 snapshot | `out/mid0.json` → `--phase mid0 --pre out/pre.json --cur out/mid0.json` | M0-1 (obje Δ=0), M0-2 (rate Δ=0), D01–D05 | herhangi FAIL |
| **S1-06** TEK upload | Önkoşul: S1-00b `RUNTIME_PASS`, S1-04 PASS, S1-05 PASS. `S1_CONFIRM_UPLOAD=YES node gates/s1_admin_upload_acceptance.mjs` → `out/s1_upload_result.json` (create-only; + yerel `out/s1_object_ref.local.json`) | `PASS`; A04–A17 PASS | herhangi FAIL → **retry yok**. Upload öncesi kapı FAIL → işaret/upload/obje yok, çıktı `out/s1_upload_blocked.<run_id>.json` → STOP raporu. Upload sonrası FAIL → obje oluştuysa yine S1-07/S1-08/S1-09 ile temizle, sonra STOP raporu |
| **S1-07** MID snapshot | `out/mid.json` → `--phase mid --pre out/pre.json --cur out/mid.json --upload out/s1_upload_result.json` | M1 (+1 obje), M2 (+1 rate token = Edge yolu), M3 (sha256(name) eşleşir), M4 (image/png, boyut eşit), M5, M6; D02 policy aynı | herhangi FAIL |
| **S1-08** Cleanup (MANUEL, Mete) | §8 Seçenek A: Dashboard → Storage → `media` → `venues/` → `path_masked` ile eşleşen tek obje → Delete | obje silindi | Dashboard erişimi yok → STOP (Seçenek D yalnız açık onayla) |
| **S1-09** POST snapshot | `out/post.json` → `--phase post --pre out/pre.json --cur out/post.json --upload out/s1_upload_result.json` | P1 (residue=0), P2 (obje yok), P3 (toplam tam +1 rate), P4, D01–D05 (policy/bucket aynı) | herhangi FAIL |
| **S1-10** Public URL artık yok | `node gates/s1_admin_upload_acceptance.mjs --verify-gone` → `out/s1_verify_gone_result.json` | `GONE` (400/404) | `STILL_SERVED` ise SQL P1/P2 otoritedir; CDN önbelleği (max-age 3600) için ≥3600 sn sonra salt-okunur tekrar bak; SQL de objeyi gösteriyorsa STOP |
| **S1-11** Sızıntı | `bash ../../CDP3C_package/gates/secret_scan.sh out` ve `bash ../../CDP3D_package/gates/cdp3d_secret_scan.sh out/*`; opsiyonel: MCP `get_logs` (edge-function) içinde `Bearer`/JWT izi yok | `secret_scan_clean` / `SECRET_SCAN_CLEAN` | herhangi bulgu |
| **S1-12** Rapor | §11 şablonu; `out/s1_object_ref.local.json` rapora **girmez** | `SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS` | — |

Sıra notu: negatifler upload'dan **önce** koşar; bir güvenlik açığı (ör. üye 2xx) upload yapılmadan yakalanır ve MID0 negatiflerin hiçbir şey yazmadığını ayrıca kanıtlar.
Eşzamanlılık: koşu süresince başka kimse admin medya upload'u yapmamalı (Δ=+1 iddiaları bozulur) ve admin-api'ye deploy yapılmamalı (S1-00 hash teyidi koşu boyunca geçerli kalmalı). Her koşu kendi `S1_OUT_DIR`'ını kullanır; aynı dizinde eşzamanlı ikinci tam koşu A00 ile durur, yarış durumunda A21 (create-only çakışması) FAIL verir ve mevcut kanıt korunur.

## 7. PRD → kontrol eşleme

**Uygulama adımları**

| PRD İP-1 | Kontrol | Tür |
|---|---|---|
| 1 PRE snapshot (obje, 4 policy, bucket public, rate) | S1-02 `s1_snapshot.sql` + `--phase pre` B1–B8 | SQL manuel/MCP + diff otomatik |
| 2 Canlı `/admin`'de yalnız bir görsel | A05 (gerçek UI girişi), A07, A08 (tam 1 multipart POST), marker kilidi, M1/M2/P3 | otomatik |
| 3 Prefix `venues`; istemci obje adı belirlemez | A12 (yalnız action/prefix/file), A15 (sunucu UUIDv4, istemci dosya adı path'te yok), N5c, S07 | otomatik |
| 4 admin-api'ye multipart | A08, A09, A10 | otomatik |
| 5 `Authorization: Bearer` var, değer çıktıda yok | A11 (yalnız `present` + rol), çıktı sızıntı koruması, S1-11 | otomatik |
| 6 Content-Type elle set edilmemiş (browser boundary) | A10 (sayfa kodunun header adları + ağda `boundary=`), S05 | otomatik |
| 7 Yanıttan yalnız `public_url` tüketilir | A16 (`#f_photo_url == public_url`), S10 (canlı kaynakta yalnız `d.public_url`), A14 (data allowlist) | otomatik |
| 8 HTTPS + `media` + sunucu UUID path | A15 | otomatik |
| 9 Public URL 200 + doğru MIME | A17 (+ gövde sha256 = yüklenen PNG) | otomatik |
| 10 Kontrollü cleanup, client fallback yok | §8 Seçenek A (Mete, Dashboard) | **manuel** |
| 11 POST residue=0 | S1-09 P1–P4, S1-10 | diff otomatik + verify-gone |

**Negatif testler** (hepsi GIF canary; hiçbiri `IDX:74`'e ulaşmaz)

| PRD | Test | Beklenen | Referans |
|---|---|---|---|
| Auth yok → 401 | N1a (header yok), N1b (yalnız apikey), N1c (Bearer=anon key), N1d (bozuk token) | 401 (gateway veya `missing_bearer`/`invalid_token`) | gateway; `IDX:40,57` |
| Üye → 403 | N2 (önce `is_current_user_admin`=false teyidi) | 403 `not_admin` | `IDX:58` |
| İzinsiz prefix | A06 (istemci: fetch öncesi red, 0 istek), N3a `evil`, N3b `../venues`, N3c `email-assets-public` | istemci throw; sunucu 400 `bad_prefix` | `ADM:943`; `MU:386` |
| JSON → 415 | N4a, N4b (+`data_base64`) | 415 `unsupported_media_type` | `IDX:54` |
| Bozuk multipart → 4xx, stack/secret yok | N5a boundary yok, N5b kesik, N5c `path` alanı, N5d bilinmeyen alan, N5e çift file, N5f action=counts, N5g rastgele bayt | 400 `bad_input`/`client_path_rejected`/`unknown_field`, 415 | `MU:364-384` |
| Negatifler obje oluşturmaz | MID0 M0-1/M0-2 | Δ obje=0, Δ rate=0 | §5 |

Her negatif yanıtta: gövde < 2 KB, fonksiyon yanıtında anahtar kümesi yalnız `{error}`, stack/iç ayrıntı işaretleri (`at …(file:`, `.ts:NN`, `TypeError:`, `"stack"`, JWT, `sb_*`, `service_role`, `SUPABASE_*`, `postgres://`, `Deno.`, `PGRST`/`SQLSTATE`) yok.

**Kabul kriterleri**

| PRD | Kanıt |
|---|---|
| Gerçek admin upload bir kez başarılı | A14–A17 PASS + M1–M5 + P3 (toplam tam +1 rate token) |
| `storage.from("media").upload` fallback yok | S02/S03/S11 (canlı kaynak) + A13 (oturum boyunca 0 Storage yazma isteği) |
| Public URL çalışıyor | A17 |
| Token/secret/log sızıntısı yok | çıktı koruması, A14 `body_leaks=[]`, N* `leak_check=clean`, S1-11 iki tarayıcı, opsiyonel Edge log kontrolü |
| Test objesi temiz, residue=0 | P1, P2, S1-10 |
| Policy'ler değişmedi | D02 (MID0, MID, POST'ta PRE ile birebir + md5) |

## 8. Cleanup tasarımı

**Sorun:** admin-api'de medya silme action'ı yok (`MEDIA_UPLOAD_DESIGN.md:80,311` "Do not add `media_delete`"). PRD adım 10: client fallback yaratma; kontrollü service/admin yolu kullan ve kanıtla.

| Seçenek | Değerlendirme | Karar |
|---|---|---|
| **A. Dashboard Storage UI (proje sahibi Mete)** | Silme Storage API üzerinden yapılır → `storage.objects` satırı **ve** alttaki blob birlikte silinir. Secret kopyalanmaz, kod/istemci fallback'i yok, tek obje, insan gözüyle doğrulanır. Ücretsiz. Tek eksik: manuel adım. | **ÖNERİLEN** |
| B. SQL `DELETE FROM storage.objects` | Salt-okunur teyit: `protect_objects_delete` (BEFORE DELETE, FOR EACH STATEMENT) → `storage.protect_delete()` `storage.allow_delete_query` ≠ `'true'` iken `42501` + "Use the Storage API instead" fırlatır. Ayar açılarak aşılırsa yalnız metadata silinir, blob **yetim** kalır (trigger HINT'inin uyardığı durum). Ayrıca yazma SQL'i bu kapsamda yasak. | RED |
| C. Hâlâ açık `media anon delete` policy'si (anon key ile `DELETE /storage/v1/object/media/…`) | Bugün çalışır — çünkü İP-2'nin kapatacağı açık budur. Kullanmak PRD'nin yasakladığı client fallback'tir ve açığı "işe yarar" kılar. | RED |
| D. service_role ile Storage API (`curl`) | Teknik olarak doğru (metadata+blob). Risk: service_role key'in shell'de işlenmesi (geçmiş, `ps` argümanları, terminal kaydı). Yalnız A mümkün değilse, Mete'nin açık onayıyla, key env'den/`--config -` stdin ile, tek path, `set +o history`. | Yedek (onaylı) |
| E. Yeni Edge `media_delete` action'ı | Kapsam dışı (tasarım dokümanı yasaklıyor; deploy gerektirir). | RED |
| F. Objeyi bırakmak | residue=0 kabul kriterini ihlal eder. | RED |

**A — prosedür:** (1) S1-07 MID PASS olmalı (M3: tek yeni obje = acceptance çıktısındaki obje). (2) Dashboard → Project `tosqsabuaomgqjtogdrn` → Storage → `media` → `venues/` → adı `s1_upload_result.json → object.path_masked` ilk 8 hex ile başlayan `.png` (PRE=0 ise bucket'taki tek obje) → Delete → onay. (3) Başka hiçbir obje/bucket'a dokunma. (4) S1-09 + S1-10.

**Residue doğrulama sorgusu** (salt-okunur; `<PATH_SHA256>` = `object.path_sha256`):

```sql
select (select count(*) from storage.objects where bucket_id = 'media') as media_objects,
       (select count(*) from storage.objects
         where bucket_id = 'media'
           and encode(sha256(convert_to(name, 'UTF8')), 'hex') = '<PATH_SHA256>') as test_object_rows;
-- Beklenen: media_objects = PRE değeri (bugün 0), test_object_rows = 0
```

Kalıcı, beklenen yan etkiler (residue sayılmaz, rapora yazılır): `admin_rate_events`'e +1 `media_upload` satırı (Edge yolunun kanıtı; P3), admin sayfasının `counts` çağrısından gelen rate satırları, giriş/çıkışa ait Auth oturum kayıtları (çıkış `scope=local` ile iptal edilir).

## 9. STOP koşulları (ilk gerçek hata kuralı, PRD §2.2)

1. S1-00: main'de PR #12 yok; admin-api version ≠ 18 veya `index.ts` / `inert/media_upload.ts` hash'i repo'dan farklı; `verify_jwt≠true`. S1-00b: R01 (`counts`≠200) veya R02 (OPTIONS≠200) FAIL.
2. S1-02 `--phase pre` STOP (policy/bucket/RLS sapması).
3. Preflight FAIL veya canlı sayfada privileged key.
4. Negatif: herhangi FAIL; herhangi 2xx; üye hesabı admin; üye hesabı yok (INCOMPLETE).
5. MID0: obje veya rate token değişimi.
6. Acceptance: herhangi FAIL (retry yok; obje oluştuysa önce temizlik, sonra STOP raporu).
7. MID/POST diff FAIL (Δ≠+1, residue≠0, policy/bucket değişimi, başka bucket'a yazım).
8. Cleanup için Seçenek A yapılamıyor (D yalnız açık onayla).
9. Herhangi bir secret/JWT/e-posta sızıntı bulgusu.
10. Ücretli kaynak ihtiyacı; beklenmeyen production değişikliği; scope drift.

STOP'ta: yeni düzeltme/rerun yok; ilk hata satırı + sınıflandırma (harness/altyapı/ürün/veri/erişim) + production'ın güvenli son hâli (policy'ler değişmedi, obje temizlendi mi) raporlanır.

## 10. Beklenen çıktılar (örnek, maskeli)

```
S1_ACCEPTANCE runtime verdict=RUNTIME_PASS pass=8 fail=0 file=s1_runtime_result.json
  [PASS] R01 admin-api 'counts' (Özet, gerçek UI oturumu) → 200 :: {"counts_calls":1,"statuses":[200]}
  [PASS] R02 tarayıcıdan (site origin'i) admin-api OPTIONS → 200, CORS izinli :: {"page_origin":"https://www.asalocal.club","status":200,"body_ok":true}
S1_NEGATIVE verdict=PASS pass=17 fail=0 skipped=0
  [PASS] N1a … expected 401 got 401 (gateway)
  [PASS] N1c … expected 401 got 401 invalid_token (function)
  [PASS] N2 Normal üye oturumu ile upload → 403 not_admin :: expected 403 got 403 not_admin (function)
  [PASS] N4a JSON action=media_upload → 415 :: expected 415 got 415 unsupported_media_type (function)
S1_ACCEPTANCE full verdict=PASS pass=18 fail=0
  [PASS] A10 … {"boundary_present":true,"browser_generated":true,"page_set_content_type":false}
  [PASS] A11 … {"authorization":"present","role":"authenticated","is_anon_key":false}
  [PASS] A15 … {"errors":[],"path_masked":"venues/1a2b3c4d-****.png"}
  [PASS] A17 … {"status":200,"content_type":"image/png","bytes":10488,"sha256_match":true}
S1_SNAPSHOT_DIFF phase=mid verdict=PASS   (M1 Δ=+1, M2 Δ=+1, M3 sha256 eşleşti)
S1_SNAPSHOT_DIFF phase=post verdict=PASS  (P1 residue=0, D02 policy md5 aynı)
S1_VERIFY_GONE verdict=GONE status=400 url=https://<ref>.supabase.co/storage/v1/object/public/media/venues/1a2b3c4d-****.png
```

`out/` içeriği: `pre.json`, `mid0.json`, `mid.json`, `post.json`, `s1_diff_*.json`, `s1_preflight_result.json`, `s1_runtime_result.json`, `s1_negative_result.json`, `s1_upload_result.json`, `s1_upload_blocked.<run_id>.json` (yalnız upload denemeyen tam-mod koşuları; rapora STOP kanıtı olarak girer), `s1_verify_gone_result.json`, `s1_upload.attempt`, `s1_object_ref.local.json` (**yerel**, rapora girmez).

## 11. Rapor şablonu

```text
SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS            (veya SEC_MEDIA_UPLOAD_ACCEPTANCE_STOP + ilk hata)
main SHA: …   admin-api: v18 verify_jwt=true (index.ts 7dce8225… / inert/media_upload.ts 4a77daf0… = repo)   harness SHA256SUMS: …
RUN : S1-00b RUNTIME_PASS (R01 counts 200, R02 OPTIONS 200, R03 yazım 0)
PRE : media_objects=… rate_media_upload=… policies_md5=… media_public=true
NEG : 17/17 PASS (N1a–N1d 401 [kaynak], N2 403 not_admin, N3a–c 400 bad_prefix, N4a–b 415, N5a–g 4xx), leak=clean
MID0: Δobje=0 Δrate=0 policy=aynı
UPL : A04–A17 PASS; istek=POST admin-api multipart (browser boundary), Authorization=present(authenticated);
      yanıt 200 data_keys=[bucket,bytes,mime,path,public_url]; obje=venues/xxxxxxxx-****.png (sha256(name)=…);
      public GET 200 image/png sha256 eşleşti; doğrudan Storage yazımı=0; REST tablo yazımı=0
MID : Δobje=+1 Δrate=+1 (M3 eşleşti)
CLN : Seçenek A (Dashboard, Mete, zaman=…)
POST: residue=0 (P1/P2), toplam Δrate=+1, policies_md5=PRE ile aynı, bucket'lar aynı; verify-gone=GONE
SEC : secret_scan_clean / SECRET_SCAN_CLEAN (out/ dahil); Edge log kontrolü=…
COST: ücretli kaynak=NO
Next: İP-2 önkoşulu sağlandı (yalnız PASS ise)
```

## 12. Yerel doğrulama (bu ortamda yapılan; canlıya istek YOK)

| Komut | Sonuç |
|---|---|
| `node --check gates/*.mjs` | 5/5 OK |
| `node gates/s1_admin_upload_acceptance.mjs --selftest` | pass=58 fail=0 (create-only yazımın mevcut dosyayı ezmediği (EEXIST) dahil; PNG geçerliliği, gerçek `MU.planMediaUpload` çıktısının doğrulayıcıdan geçmesi, 12 kötü URL reddi, istek sınıflandırma, multipart ayrıştırma, repo `CDP3B/admin.html` üzerinde S01–S13 PASS + 5 enjekte hata yakalandı, redaksiyon/sızıntı koruması) |
| `node gates/s1_negative.mjs --selftest` | pass=27 fail=0 (her parse-düzeyi negatif beklenti **gerçek** `parseMediaMultipart` ile doğrulandı; canary GIF gerçek `planMediaUpload`'da 400 `bad_mime_content`, uploader çağrılmadı) |
| `node gates/s1_snapshot_diff.mjs --selftest` | pass=13 fail=0 |
| `node gates/s1_offline_rehearsal.mjs` | `S1_REHEARSAL PASS scenarios=25 bad=0` — gerçek admin.html + gerçek handler ile: baseline PASS (1 obje, 1 rate, 0 doğrudan/REST yazım, logout `local`); sonuç dosyası maskeli ve sızıntısız; aynı `out/`'ta marker ile ikinci koşu STOP, onaysız STOP, kimlik bilgisi yok FAIL(2) — üçü de `s1_upload_blocked.<run_id>.json`'a yazdı ve **baseline `s1_upload_result.json` hâlâ `PASS` + `object.path_sha256` = `s1_object_ref.local.json`** (kanıt korundu); marker silinmiş ama sonuç dosyası duran dizinde STOP (sentinel değişmedi); onaysız koşu (boş dizin) sonuç dosyası yazmadı; `--runtime` RUNTIME_PASS (`counts` 200, OPTIONS 200 gerçek handler'dan, 0 obje/0 media_upload rate, logout `local`); v17 benzeri kırık fonksiyon (500) → R01+R02 FAIL; hata enjeksiyonları FAIL: elle Content-Type (A10,A12,A14), doğrudan Storage fallback (A13), **istemci prefix guard'ı atlatıldı → A06 FAIL, işaret yok, upload yok, 0 obje** (`stop_reason=pre_upload_gate_failed`), mekan kaydı (A13), istemci yolu (A15,A17), yanlış MIME (A17), statik `storage.from` (A03); negatif: supabase-js ve GoTrue-REST yollarıyla 17/17 PASS (0 obje, 0 rate), üye yok → INCOMPLETE, üye admin → STOP, `not_admin` kapısı kaldırılmış sunucu → N2 FAIL, tüm rol kapıları kaldırılmış sunucu → N2 FAIL **ve hâlâ 0 obje** (canary) |
| `gates/s1_snapshot.sql` canlıda (MCP, salt-okunur) | Tek satır döndü; `--phase pre` B1–B7 PASS (fixture) |
| `CDP3C_package/gates/secret_scan.sh .` / `cdp3d_secret_scan.sh` | `secret_scan_clean` / `SECRET_SCAN_CLEAN` |

Provanın simüle **edemediği**: gerçek Supabase gateway'in 401 gövdesi, gerçek GoTrue/Storage/CDN, canlı sayfanın jsdelivr'dan yüklediği güncel supabase-js@2 (prova 2.117.2 kullandı), tarayıcıda `/admin` → 302 adımı (Playwright yönlendirme hedefini yakalayamıyor; Node tarafındaki negatif prova 302'yi izledi), **gerçek CORS bloğu** (Playwright `route.fulfill` yanıtlarına CORS başlığı ekler ve route açıkken preflight'ı kendisi yanıtlar; bu yüzden kırık-fonksiyon provasında R02 `status:500` okur — canlıda aynı durum CORS bloğu → `status:null` olur; ikisi de FAIL).

CI: `.github/workflows/sec-media-stage1-gates.yml` aynı kapıyı (`run_selftests.sh`, sabit `playwright@1.56.1` + `@supabase/supabase-js@2.117.2`, Chromium) her ilgili PR'da koşar; `S1_OFFLINE_GATE_PASS` satırı yoksa (exit 4 dahil) kırmızı. **Bu workflow henüz GitHub'da hiç koşmadı** (dosya commit edilmedi); ilk koşu onun ilk doğrulamasıdır.

## 13. Açık sorular / riskler

1. **v18 runtime kabulü canlıda henüz koşmadı** (bu ortamdan `*.supabase.co`/`www.asalocal.club` HTTP erişimi yok, B2). S1-00b ilk canlı kanıttır; FAIL ise İP-1 durur.
2. **Üye test hesabı:** PRD §2.4 yeni kullanıcı yaratmayı yasaklıyor; mevcut, doğrulanmış, admin olmayan bir hesap gerekli. Yoksa N2 yapılamaz → Stage 1 PASS olamaz.
3. **Cleanup manuel:** Seçenek A Mete'nin Dashboard erişimine bağlı; ajan bu adımı yapamaz.
4. **CDN önbelleği:** silme sonrası public URL ≤3600 sn önbellekten 200 dönebilir; SQL (P1/P2) otoritedir.
5. **Canlı HTML ≠ repo** olabilir (A01i yalnız bilgi); kapı canlı kaynağın statik kontrolüdür (A03).
6. **Auth oturumları:** her giriş bir Auth oturumu açar; `scope=local` çıkış başarısızsa (A20 WARN) oturum süresi dolana kadar kalır.
7. **Eşzamanlı kullanım:** koşu sırasında başka bir admin upload'u Δ iddialarını bozar → koordinasyon gerekli.
8. **Gateway 401 gövdesi** bilinmiyor; harness yalnız durum kodunu ve sızıntı yokluğunu şart koşar.

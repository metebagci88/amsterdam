# SEC-MEDIA · Stage 2 (İŞ PAKETİ 2) — Uygulama ve Geri Alma

**Durum:** HAZIRLIK PAKETİ. Production'a **uygulanmadı**. Yalnız Stage 1 `SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS` sonrası uygulanır.
**Değişiklik:** `storage.objects` üzerindeki **tam olarak üç** policy kaldırılır: `"media anon insert"`, `"media anon update"`, `"media anon delete"` (hepsi `roles {public}` → anon + authenticated).
**Korunan:** `"media anon read"` (public SELECT), `media` bucket `public=true`, `email-assets-public` / `email-assets-draft`, storage.objects dışındaki tüm policy'ler (25), tüm bucket öznitelikleri, tüm grant/trigger'lar, Edge fonksiyonları, `admin-api` v18 (`verify_jwt=true`, `ezbr_sha256` `96bd5e041aab6886…`; 2026-10-07 read-only `list_edge_functions`).
**Maliyet:** Yok. Yeni kaynak yok; CI yalnız GitHub Actions ücretsiz koşucuları + geçici yerel stack.

## 1. Dosyalar

| Dosya | Görev |
|---|---|
| `S2_up.sql` | PRE guard (drift → dur) + 3× `DROP POLICY IF EXISTS` + POST guard (beklenen matris değilse tümü geri alınır). İdempotent. Dış BEGIN/COMMIT yok. |
| `S2_down_INSECURE.sql` | **GÜVENLİĞİ GEVŞETİR.** Üç policy'yi canlı baseline tanımıyla geri oluşturur. Arming GUC'u olmadan reddeder; otomatik kullanılmaz. |
| `gates/s2_pre_assert.sql` | Salt-okunur PRE kaydı + baseline karşılaştırması (policy tanımları, md5 `677c0f6b0f4fd37bb8b4fb7959a495fb`; satır 20 = storage.objects dışı tüm policy'ler, satır 21 = tüm bucket öznitelikleri). |
| `gates/s2_prod_assert.sql` | Salt-okunur POST policy matrisi + bucket + ledger + residue + satır 20/21 (== PRE) → `S2_PROD_ASSERT_PASS`. |
| `gates/s2_zero_footprint_test.sql` | Production-safe davranış testi (rollback'li DO bloğu) → `REPORT:… S2_ZF_VERDICT=PASS`. |
| `gates/s2_pglite_gate.mjs` | Yerel PGlite (PG17) kapısı, 201 kontrol (satır 20/21 PRE==POST + 7 duyarlılık negatifi dahil). |
| `gates/s2_psql_gate.sh` | Yerel gerçek Postgres + `psql -1` kapısı, 30 kontrol (satır 20/21 + 4 duyarlılık negatifi dahil). |
| `gates/s2_storage_api_gate.sh` | CI'da geçici `supabase start` + storage şeması paritesi (production ile birebir) + Storage API HTTP testi. **Docker yok: yalnız SQL yolu yerel PG16 simülasyonunda koşuldu (bkz. §8); HTTP kısmı ilk CI koşusunda doğrulanır.** |
| `gates/s2_client_write_scan.sh` | Repo'daki servis edilen HTML/JS'te doğrudan Storage yazma yolu taraması. |
| `gates/s2_fixture_storage_model.sql`, `gates/s2_fixture_baseline.sql` | Yalnız ephemeral test DB fixture'ları (baseline fixture arming ister; production'da çalıştırılmaz). |
| `../../.github/workflows/sec-media-stage2-gates.yml` | `local-gates` + `storage-api` job'ları. |

## 2. Önkoşullar (biri eksikse UYGULAMA YOK → STOP raporu)

1. **Stage 1 PASS kanıtı:** canlı `/admin` üzerinden tek gerçek yükleme `admin-api` multipart ile 200; `public_url` 200 + doğru MIME; cleanup sonrası residue=0; policy'ler o aşamada değişmemiş (4 policy).
2. **CI yeşil:** `sec-media-stage2-gates` (`local-gates` + `storage-api`) ve mevcut `cdp3c-edge-integration` (ephemeral stack'te anon policy'si OLMAYAN `media` bucket'ına admin `media_upload` 200, üye 403).
   `storage-api` job log'unda şu üç satır birebir görülmeli (job bunları kendisi de doğrular, farklıysa kırmızıdır):
   `supabase_cli_version=2.118.0` · `storage_image=…storage-api:v1.77.0` · `-- storage_migrations=73:824c7cc22b2d773ff697a047f1ce5c70`.
3. **Başlangıç değişmemiş (her biri açık kontrol; herhangi bir farklılık = STOP):**
   - `main` beklenen HEAD.
   - `list_edge_functions(project_id = tosqsabuaomgqjtogdrn)` → `admin-api` için **`version = 18`**, **`verify_jwt = true`**, **`ezbr_sha256 = 96bd5e041aab688663f52742be89fd8b0dfe7b153ebd15344291d3e599ffc872`** (2026-10-07 read-only ölçüm; v17 kırık PLACEHOLDER_INDEX idi, bkz. `ASALOCAL_12_STAGE_PROGRAM_RESULT.md`). Başka bir değer → STOP. Stage 1 sırasında Mete onayıyla yeni bir `admin-api` sürümü deploy edildiyse bu satır Stage 1 kanıtındaki version/ezbr ile güncellenir ve paket yeniden imzalanır (`SHA256SUMS`); güncellenmeden uygulanmaz.
   - Storage şeması CI ile aynı: `execute_sql("select count(*)::text || ':' || md5(string_agg(id::text || ':' || name, E'\n' order by id)) from storage.migrations")` → **`73:824c7cc22b2d773ff697a047f1ce5c70`** (son migration `drop-bucketid-objname-index`). Farklıysa (Supabase storage'ı yükseltmişse) → STOP: workflow'daki CLI pin'i production storage sürümünü içeren sürüme güncellenir, `storage-api` job'ı yeniden yeşil olur, sonra devam.
   - `s2_pre_assert.sql` → `S2_PRE_ASSERT_PASS` (P1).
4. **Client tarafında doğrudan yazma yok:** `bash gates/s2_client_write_scan.sh` → `S2_CLIENT_WRITE_SCAN_CLEAN`.
   Envanter (2026-10-07, `7a548e9`):
   - `CDP3B/admin.html:939` ve `admin.html:862` `uploadToMedia()` → `FN_URL` (admin-api) multipart; `storage.from` yok. Çağıranlar: `CDP3B/admin.html:523` (venues), `:928` (ads); `admin.html:446`, `:851`.
   - `CDP3B/admin.html:1668` yalnız `/storage/v1/object/public/email-assets-public/` okuma URL'i.
   - Sunucu tarafı yazanlar service_role ile (BYPASSRLS, S2'den etkilenmez): `CDP3B/edge/admin-api/index.ts:71,80` (media), `CDP3B/edge/email-api/index.ts:359,403,434,457` (email-assets-*).
   - Repo dışı Edge'ler (read-only incelendi): `admin-delete-user` v5 ve `adim2-dispatch-once` v6 Storage kullanmıyor. `public` şemasında `storage.objects`'e dokunan SQL fonksiyonu yok.
   - Tek eski doğrudan yazma: `CDP3B/CDP3B_final.zip` içindeki arşiv `CDP3B/admin.html:858` (`storage.from("media").upload`). Servis edilen sayfa değil; canlı `/admin` → `CDP3B/admin.html` (`_redirects`). Ayrı PR ile kaldırılması önerilir.

## 3. Uygulama sırası (production, adım adım; her adım ayrı doğrulanır)

> Supabase MCP aracı: `project_id = tosqsabuaomgqjtogdrn`. Secret/JWT/e-posta hiçbir çıktıya yazılmaz.

| # | Adım | Komut | Beklenen |
|---|---|---|---|
| P0 | Paket bütünlüğü | `cd SEC_MEDIA_package/stage2 && sha256sum -c SHA256SUMS` | Tümü `OK` |
| P1 | PRE kayıt (salt-okunur) | `execute_sql(query = gates/s2_pre_assert.sql)` | `OVERALL = S2_PRE_ASSERT_PASS` (`0 FAIL / 16 counted`); çıktı (actual kolonu = policy ad/rol/ifade) rapora eklenir. Satır 20 = `25:45f0c3ac7e466783e9e3fa3702183b28` (diğer policy'ler), satır 21 = `3:e112c7b7523616c45bd38bf2c8c45064` (bucket öznitelikleri) → bunlar **PRE değeridir** |
| P1b | (isteğe bağlı) red-before-green | `execute_sql(query = gates/s2_zero_footprint_test.sql)` | Hata `REPORT:… FAIL anon.insert ALLOWED … S2_ZF_VERDICT=FAIL` (açık var; her şey geri alınır) |
| P2 | Migration | `apply_migration(name = 'sec_media_close_anon_write', query = S2_up.sql içeriği, byte-exact)` | Hata yok (NOTICE `S2_UP_OK`). `S2_PRE_DRIFT`/`S2_PRE_FAIL`/`S2_POST_FAIL`/lock timeout → hiçbir şey değişmemiştir → STOP |
| P3 | POST matris | `execute_sql(query = gates/s2_prod_assert.sql)` | `OVERALL = S2_PROD_ASSERT_PASS` (`0 FAIL / 18 counted`; ledger kaydı dahil; satır 20/21 actual == P1'deki PRE değeri) |
| P4 | Davranış (zero footprint) | `execute_sql(query = gates/s2_zero_footprint_test.sql)` | Hata metni `REPORT:… S2_ZF_VERDICT=PASS fails=0` |
| P5 | Residue | `execute_sql(query = gates/s2_prod_assert.sql)` tekrar | Satır 13/14 = `0`, `S2_PROD_ASSERT_PASS` |
| P6 | Advisor | `get_advisors(type = 'security')` | S2'nin eklediği yeni bulgu yok (önceden var olanlar not edilir) |
| P7 | Canlı HTTP kabul | Bölüm 4 | Tümü PASS |

`S2_up.sql` iki kez çalışırsa (ör. yeniden deneme) no-op'tur ve aynı POST guard'dan geçer.
`DROP POLICY` kısa bir `AccessExclusiveLock` alır; `lock_timeout=5s` ile bekleme sınırlıdır. PostgREST `pgrst_drop_watch` event trigger'ı şema-reload NOTIFY'ı tetikler (zararsız).

## 4. Production kabul testleri (PRD → komut)

Canlı HTTP adımları `*.supabase.co` erişimi olan bir makineden / tarayıcıdan yapılır (bu hazırlık container'ından erişim yok). `SUPABASE_URL` ve public anon key ortam değişkeninden okunur, belgeye/loga yazılmaz. Test objesi Stage 1 harness'ı ile yüklenen tek admin objesidir (`X` = `venues/<uuid>.<ext>`).

| PRD testi | Kanıt | Beklenen |
|---|---|---|
| Anon doğrudan INSERT reddedilir | P4 `anon.insert denied 42501 RLS` + `curl -s -o /dev/null -w '%{http_code}' -X POST "$SUPABASE_URL/storage/v1/object/media/zz-s2-accept/anon.png" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: image/png' --data-binary @tiny.png` | 4xx, gövdede `row-level security`; media sayısı değişmez |
| Anon doğrudan UPDATE reddedilir | P4 `anon.update rows=0`, `anon.upsert denied` + `curl -X PUT …/object/media/X` ve `-H 'x-upsert: true'` ile POST | 4xx; `X`'in public SHA-256'sı değişmez |
| Anon doğrudan DELETE reddedilir | P4 `anon.delete rows=0` + `curl -X DELETE …/object/media/X` (anon) | `X` hâlâ 200 ile servis edilir; object sayısı değişmez |
| Public görsel SELECT/URL çalışır | P4 `anon.select media visible` + `curl -sI "$SUPABASE_URL/storage/v1/object/public/media/X"` | 200, `content-type: image/*` |
| Yetkili admin `media_upload` Edge yolu çalışır | Stage 1 harness'ı canlı tarayıcıda yeniden (`SEC_MEDIA_package/stage1/gates/s1_admin_upload_acceptance.mjs`) | 200, HTTPS `public_url`, server UUID path |
| Normal üye upload → 403 | Stage 1 `s1_negative.mjs` (üye oturumu) | 403, obje yok |
| Auth yok → 401 | Stage 1 `s1_negative.mjs` | 401 |
| Bucket public durumu değişmez | P3 satır 9–12 | `media=true`, `email-assets-public=true`, `email-assets-draft=false` |
| Diğer bucket/policy'lerde değişiklik yok (kabul kriteri) | P1 satır 20/21 (PRE) ↔ P3 ve P5 satır 20/21 (POST) | PRE == POST: `25:45f0c3ac7e466783e9e3fa3702183b28` ve `3:e112c7b7523616c45bd38bf2c8c45064` (satır 20: storage.objects dışındaki 25 policy'nin ad/cmd/rol/permissive/qual/with_check'i; satır 21: 3 bucket'ın id/name/public/file_size_limit/allowed_mime_types/type/versioning_status'u) |
| Beklenmeyen obje yok; residue=0 | `X` Stage 1'in kontrollü cleanup prosedürüyle silinir → P5 | satır 13/14 = 0 |
| Migration ledger'da | P3 satır 15 | `sec_media_close_anon_write` = 1 |

Tümü PASS → `SEC_MEDIA_STORAGE_CLOSED` raporu: P1 PRE çıktısı, P3/P5 POST matrisi, P4 REPORT metni, HTTP kodları, maskeli obje path'i, residue kanıtı, ayrıca:
- **Diğer policy'ler:** satır 20 PRE (P1) ve POST (P3, P5) değerleri yan yana; üçü birebir aynı olmalı.
- **Bucket öznitelikleri:** satır 21 PRE (P1) ve POST (P3, P5) değerleri yan yana; üçü birebir aynı olmalı.
- Önkoşul 3'ün `list_edge_functions` çıktısı (`admin-api` version/verify_jwt/ezbr) ve storage.migrations count:md5 değeri.
- `storage-api` CI koşusu linki + log'daki `supabase_cli_version`, `storage_image`, `storage_migrations` satırları.

## 5. Geri alma

- **Güvenli (soft) rollback yoktur:** S2 yeni bir yüzey eklemez; tek geri alma güvenliği gevşetir. Bu yüzden yalnız `S2_down_INSECURE.sql` vardır.
- **Önce fix-forward:** service_role BYPASSRLS olduğu için admin `media_upload` S2'den etkilenmez. Admin yükleme bozulursa önce Edge/log incelenir; anon yazmayı açmak son çaredir.
- **Yalnız Mete'nin açık, yazılı onayıyla** ve kanıtlı neden (S2'ye bağlı canlı kırılma) varsa:
  1. `apply_migration(name = 'sec_media_s2_rollback_insecure', query = "set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE';\n" + S2_down_INSECURE.sql içeriği)`
     (psql: `psql -1 -v ON_ERROR_STOP=1 -c "set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE'" -f S2_down_INSECURE.sql`)
  2. `s2_pre_assert.sql` → satır 1–11, 14, 20, 21 PASS, policy md5 = `677c0f6b0f4fd37bb8b4fb7959a495fb` (satır 13 ledger'da up kaydı olduğu için `1` görünür — beklenen). Satır 20/21 PASS = rollback de diğer policy/bucket'lara dokunmadı.
  3. Açık yeniden açıktır: kök neden giderilince `S2_up.sql` yeniden uygulanır (idempotent).
- Arming olmadan çalıştırılırsa `S2_DOWN_INSECURE_NOT_ARMED` ile durur, hiçbir şey değişmez.
- Neden yorum satırı değil de arming guard: dosya "varsayılan olarak çalışmaz" kuralını aynı şekilde sağlar, ama CI ve yerel kapılar elle düzenlenmiş bir kopyayı değil **tam bu baytları** test eder (silahsız red + armed baseline birebir dönüş).

## 6. Değişmeyenler

`"media anon read"`; `storage.buckets` (tüm bayraklar; kanıt satır 21); storage.objects dışındaki tüm policy'ler (kanıt satır 20); `email-assets-*` bucket/objeleri; `storage.objects` grant'ları, RLS (enabled), trigger'ları (`protect_objects_delete`, `update_objects_updated_at`); roller; Edge fonksiyonları ve `verify_jwt`; `admin_rate_check`; kill-switch; Auth/Resend/`email_provider_config`; HTML dosyaları.

## 7. Notlar / riskler

- **protect_objects_delete trigger'ı:** `storage.allow_delete_query<>'true'` iken her rolün doğrudan SQL DELETE'ini **42501** ile reddeder (RLS değil). Testler bu yüzden hata *metnini* doğrular ve RLS kanıtını GUC=`true` altında 0 satır olarak alır; yanlış-pozitif 42501 kabul edilmez.
- **Yetki:** production'da `postgres` süper kullanıcı değil; `supautils.policy_grants` `storage.objects`'i kapsıyor (read-only teyit) → `apply_migration` ile `DROP/CREATE POLICY` yapılabilir. PGlite bunu modellemez; gerçek kanıt CI `storage-api` job'ı (yerel Supabase) ve P2'dir.
- **Kapsam dışı gözlemler (S2 değiştirmez):** `"media anon read"` anon'un tüm media objelerini *listelemesine* izin verir (public URL için gerekmez; PRD public SELECT stratejisini koruyor). `anon`/`authenticated` `storage.objects` üzerinde Supabase varsayılanı tablo grant'larına (TRUNCATE dahil) sahip; PostgREST varsayılan olarak `storage` şemasını sunmaz (bu pakette ayrıca doğrulanmadı). `cdp3c_edge_integration.sh:207` doğrudan `delete from storage.objects` kullanıyor; daha yeni storage imajında `protect_delete` nedeniyle kırılabilir (CLI 1.226.4 sabit).
- **CI pin (storage-api job):** `supabase/setup-cli@v1` `version: 2.118.0` ('latest' yasak, `cdp3c-gates.yml` kuralı). 2.118.0'ın gömülü imajı `supabase/storage-api:v1.77.0` (CLI kaynağı `apps/cli/src/shared/services/Dockerfile` ve `apps/cli-go/pkg/config/templates/Dockerfile`, tag v2.118.0). v1.77.0'ın migration listesi (`src/internal/database/migrations/types.ts`) 73 satır, son `drop-bucketid-objname-index`; `count:md5(id:name)` = `73:824c7cc22b2d773ff697a047f1ce5c70` = production (2026-10-07 read-only). Daha yeni CLI'lar (2.119.0 → v1.79.28, 2.120.0 → v1.79.36) production'da olmayan `0073-revoke-grants-to-unused-operations`'ı içerir; daha eskiler (2.117.0 → v1.72.1) `0068`–`0072`'yi içermez. **1.226.4 KULLANILMAZ:** storage-api v1.11.13 (25 migration) — `prevent-direct-deletes` (0055) ve `object-versioning-core` (0062) yok. Job, CLI sürümünü, storage imaj tag'ini ve `storage.migrations` paritesini kendisi doğrular; production storage yükseltilirse önkoşul 3 STOP verir ve pin güncellenir.
- **2.118.0 uyarısı:** bu sürüm Supabase'in TypeScript tabanlı CLI'ıdır (npm `bin: dist/supabase.js` + Go sidecar). `init --force`, `start`, `status -o json` (`API_URL`/`DB_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY` anahtarları) ve `stop --no-backup` kaynak kodda doğrulandı; GitHub release asset'i `supabase_linux_amd64.tar.gz` mevcut (HTTP 200). Binary bu container'da **çalıştırılmadı**.
- **Satır 20 formülü:** sıralama açıkça `order by schemaname, tablename, policyname` (`name` tipi → C sıralama, ortamdan bağımsız). Aggregate içinde `order by 1` bir sabite göre sıralar (sıra tanımsız) — kullanılmadı; bu yüzden inceleme notundaki `16bcde76…` md5'i bu formülle karşılaştırılamaz. NULL'lar `<null>` ile kodlanır (boş string ile karışmaz). Satır 21 `order by id collate "C"`.
- **Yerel ortamda satır 20:** 25 uygulama policy'si yerel fixture'da yoktur → yerel kapılar satır 20'yi "env satırı" olarak ele alır: değer PRE'de kaydedilir, her POST/rollback/re-up sonrası PRE ile birebir karşılaştırılır; FAIL kümesi tam olarak `{20}` olmalıdır. Satır 21 yerelde de production literaline birebir eşit olmalıdır (fixture bucket şeması production ile aynı).
- **Doğrulanmamış:** `s2_storage_api_gate.sh`'ın HTTP kısmı + `storage-api` job'ı yerelde koşulamadı (Docker yok); production HTTP kabul testleri yalnız P7'de koşulur.

## 8. Yerel doğrulama (2026-10-07)

```
PGLITE_DIR=<pglite 0.3.16 dizini> node gates/s2_pglite_gate.mjs   -> RESULT pass=201 fail=0 · S2_LOCAL_PGLITE_GATE_PASS (PostgreSQL 17.5)
PGLITE_DIR=<pglite 0.5.8 dizini>  node gates/s2_pglite_gate.mjs   -> RESULT pass=201 fail=0 · S2_LOCAL_PGLITE_GATE_PASS (PostgreSQL 18.3)
bash gates/s2_psql_gate.sh                                        -> RESULT pass=30 fail=0 · S2_PSQL_GATE_PASS (PostgreSQL 16.15)
bash gates/s2_client_write_scan.sh                                -> S2_CLIENT_WRITE_SCAN_CLEAN (11 client dosyası)
bash CDP3C_package/gates/secret_scan.sh SEC_MEDIA_package/stage2 .github/workflows/sec-media-stage2-gates.yml -> secret_scan_clean
shellcheck -S warning gates/*.sh ; actionlint sec-media-stage2-gates.yml -> temiz
```
- **Mutasyon kontrolü (PGlite gate'in duyarlılığı):** prod_assert satır 20 literali bozulunca → 14 FAIL; prod_assert satır 20'de sıralama `order by 1` yapılınca → FAIL (pre/prod SQL eşitliği); model fixture'da `versioning_status` varsayılanı değişince → 19 FAIL.
- **storage-api gate SQL yolu simülasyonu (Docker yok):** yerel PG16 + model fixture + production ile birebir `storage.migrations` (73 satır) + **`supabase_migrations` şeması YOK** (boş `supabase start` gibi) + erişilemeyen API URL. Eski script: `ERROR: relation "supabase_migrations.schema_migrations" does not exist` → `FAIL pre_assert baseline` (bulgu yeniden üretildi). Düzeltilmiş script: parite (`storage_migrations=73:824c7cc2…`), protect trigger, baseline md5, satır 20 PRE (`0:<none>`), pre_assert, S2_up, zero-footprint, prod_assert (env satırı dışında PASS), idempotency, silahsız/armed down, down sonrası pre_assert (`13,20`), re-up ve final prod_assert kontrollerinin **hepsi PASS**; FAIL'lerin 14'ü de yalnız HTTP kontrolleri (API yok → `000`). HTTP kısmı ilk CI koşusunda doğrulanacak.

Production'da **salt-okunur** (2026-10-07, yalnız SELECT, güncel dosyaların SQL gövdesiyle): `s2_pre_assert.sql` → `S2_PRE_ASSERT_PASS` (`0 FAIL / 16 counted`; satır 20 = `25:45f0c3ac7e466783e9e3fa3702183b28`, satır 21 = `3:e112c7b7523616c45bd38bf2c8c45064`); `s2_prod_assert.sql` → beklenen `S2_PROD_ASSERT_FAIL` (`7 FAIL / 18 counted`: satır 1,3,4,5,6,7,15 — S2 henüz uygulanmadı; bucket/RLS/rol/residue ve satır 20/21 PASS). `list_edge_functions` → `admin-api` version 18, verify_jwt true, ezbr `96bd5e041aab6886…`. `storage.migrations` → `73:824c7cc22b2d773ff697a047f1ce5c70`, son `drop-bucketid-objname-index`. Zero-footprint testi production'da **çalıştırılmadı** (P4'te koşulacak).
Baseline fixture'ın policy md5'i production'da read-only ölçülen `677c0f6b0f4fd37bb8b4fb7959a495fb` ile birebir aynıdır; `S2_down_INSECURE.sql` sonrası da aynı md5'e döner.

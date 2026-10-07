# SEC-MEDIA · Stage 2 (İŞ PAKETİ 2) — Uygulama ve Geri Alma (v2: NEUTRALIZE)

**Durum:** HAZIRLIK PAKETİ v2. Production'a **uygulanmadı** (2026-10-07 read-only: policy matrix md5 `677c0f6b0f4fd37bb8b4fb7959a495fb`, ledger `sec_media_close_anon_write` = 0, policy açıklamaları NULL). Stage 1 `SEC_MEDIA_UPLOAD_ACCEPTANCE_PASS` alındı (canlı kanıt: `SEC_MEDIA_package/stage1/evidence/live_2026-10-07/`).
**Değişiklik (v2):** `storage.objects` üzerindeki **tam olarak üç** policy — `"media anon insert"`, `"media anon update"`, `"media anon delete"` — **silinmez**, `ALTER POLICY … TO service_role` ile **etkisizleştirilir** ve her birine `COMMENT ON POLICY` ile not düşülür. `cmd`, `USING`, `WITH CHECK` ve adlar değişmez.
**Etki:** `service_role` BYPASSRLS olduğundan bu üç policy hiç değerlendirilmez (inert). `anon` / `authenticated` (ve `public`) için `storage.objects` üzerinde hiçbir INSERT/UPDATE/DELETE policy'si kalmaz → RLS varsayılan ret. `"media anon read"` (SELECT, `{public}`) birebir kalır; `media` bucket `public=true` kalır.
**Korunan:** `email-assets-public` / `email-assets-draft`, storage.objects dışındaki tüm policy'ler (25), tüm bucket öznitelikleri, grant/trigger'lar, Edge fonksiyonları, `admin-api` v18 (`verify_jwt=true`, `ezbr_sha256` `96bd5e041aab6886…`).
**Maliyet:** Yok. Yeni kaynak yok; CI yalnız GitHub Actions ücretsiz koşucuları + geçici yerel stack.

## 0. Neden v2 (DROP yerine ALTER … TO service_role)

| Gözlem (2026-10-07, production, read-only / sıfır iz) | Sonuç |
|---|---|
| Supabase MCP, metninde `DROP` token'ı geçen her ifadeyi etkileşimli insan onayı ister; bu oturumda onay iletilemiyor. `apply_migration` ve `execute_sql` 60 sn'de zaman aşımına düşüyor, sorgu Postgres'e **hiç ulaşmıyor**. Kapı metin tabanlı görünüyor (EXECUTE string'i veya yorumdaki kelime de tetikleyebilir). | v1 (`DROP POLICY IF EXISTS`) MCP ile uygulanamaz. v2 `S2_up.sql` ve `S2_down_INSECURE.sql` **hiçbir yerde, hiçbir harf biçiminde** `drop` alt-dizesi içermez; `gates/s2_mcp_token_scan.sh` (CI `local-gates`) ve PGlite statik kontrolleri bunu MCP'ye giden 5 dosyanın tamamı için zorlar. |
| Geri alınan DO bloğu ile: `alter policy "media anon insert\|update\|delete" on storage.objects to service_role` **çalışıyor** (11 ms). `comment on policy … on storage.objects is '…'` **çalışıyor**. | v2 değişikliği production yetkileriyle (postgres non-superuser + supautils) uygulanabilir. |
| `alter policy … rename to …` **başarısız**: `42501 must be owner of table objects`. | Adlar korunur (`"media anon …"`); niyet `COMMENT ON POLICY` ile belgelenir. |
| `service_role` `rolbypassrls = true`; `anon`, `authenticated` `false`. | `TO service_role` policy'leri etkisizdir; S2_up PRE/POST guard ve prod_assert satır 16 bu bayrakları doğrular (değişirse argüman çöker → STOP). |

**PRD sapması (bilinçli, işlevsel eşdeğer):** PRD İP2 §Uygulama 3 "Migration yalnız şu policy'leri kaldırmalı". v2'de anon/public için bu üç yetki **kaldırılır** (anon/authenticated'a uygulanan yazma policy'si yok; kabul testleri bunu davranış olarak kanıtlar), fakat policy *nesneleri* `service_role`'e daraltılmış, etkisiz hâlde durur. Rollback (§Uygulama 6) üç policy'yi önceki tanımlarına **birebir** döndürür (baseline md5 `677c0f6b…` eşitliği). Kozmetik temizlik (§7) kapsam dışıdır.

## 1. Dosyalar

| Dosya | Görev |
|---|---|
| `S2_up.sql` | PRE guard (baseline **veya** zaten uygulanmış v2 durumu; başka her şey → dur) + 3× `ALTER POLICY … TO service_role` + 3× `COMMENT ON POLICY` + POST guard. İdempotent. Dış BEGIN/COMMIT yok; `set local lock_timeout = '5s'`. `drop` alt-dizesi yok. |
| `S2_down_INSECURE.sql` | **GÜVENLİĞİ GEVŞETİR.** Arming GUC'u olmadan reddeder. 3× `ALTER POLICY … TO public` + 3× `COMMENT ON POLICY … IS NULL`; POST = birebir baseline (md5 `677c0f6b0f4fd37bb8b4fb7959a495fb`, açıklamalar NULL). `drop` alt-dizesi yok. |
| `gates/s2_pre_assert.sql` | Salt-okunur PRE kaydı + baseline karşılaştırması (değişmedi; 16 counted). |
| `gates/s2_prod_assert.sql` | Salt-okunur v2 POST matrisi (4 policy, satır 7 md5 `74b56eca9c133d987aa2ac056b412473`, satır 18 açıklama) + bucket + ledger + residue + satır 20/21 (== PRE) → `S2_PROD_ASSERT_PASS` (19 counted). |
| `gates/s2_zero_footprint_test.sql` | Production-safe davranış testi (rollback'li DO bloğu) → `REPORT:… S2_ZF_VERDICT=PASS`. v2'de rapora canlı policy rolleri INFO olarak eklenir. |
| `gates/s2_mcp_token_scan.sh` | **Yeni.** MCP'ye giden 5 dosyada (`S2_up`, `S2_down_INSECURE`, pre/prod assert, ZF) ve armed rollback yükünde `/drop/i` → FAIL. |
| `gates/s2_pglite_gate.mjs` | Yerel PGlite kapısı (PG17 + PG18), 257 kontrol. |
| `gates/s2_psql_gate.sh` | Yerel gerçek Postgres 16 + `psql -1` kapısı, 43 kontrol (NOTICE'lar, iki oturumla `lock_timeout`, tek-mesaj atomikliği dahil). |
| `gates/s2_storage_api_gate.sh` | CI'da geçici `supabase start` (non-superuser `postgres` + supautils) + storage şeması paritesi + Storage API HTTP testi. Docker yok → yerelde yalnız SQL yolu simüle edildi (§8). |
| `gates/s2_client_write_scan.sh` | Servis edilen HTML/JS'te doğrudan Storage yazma yolu taraması (`LIVE_CHECKS/` Node harness'ı kapsam dışı; bir sayfa onu yüklerse FAIL). |
| `gates/s2_fixture_storage_model.sql`, `gates/s2_fixture_baseline.sql` | Yalnız ephemeral test DB fixture'ları (MCP'ye gitmez; baseline fixture arming ister). |
| `../../.github/workflows/sec-media-stage2-gates.yml` | `local-gates` (SHA256SUMS, secret scan, MCP token scan, client scan, PGlite PG17+PG18, psql PG16) + `storage-api`. |

## 2. Önkoşullar (biri eksikse UYGULAMA YOK → STOP raporu)

1. **Stage 1 PASS kanıtı** (alındı): canlı `/admin` üzerinden gerçek yükleme `admin-api` multipart 200; `public_url` 200 + doğru MIME; cleanup sonrası residue=0; policy'ler o aşamada değişmemiş (4 policy).
2. **CI yeşil (bu v2 baytlarıyla):** `sec-media-stage2-gates` (`local-gates` + `storage-api`) ve `cdp3c-edge-integration`. `storage-api` log'unda birebir: `supabase_cli_version=2.118.0` · `storage_image=…storage-api:v1.77.0` · `-- storage_migrations=73:824c7cc22b2d773ff697a047f1ce5c70` · `-- runner role=postgres superuser=f` ve `PASS 3 yazma policy'sinde S2 açıklaması (COMMENT ON POLICY, runner superuser=f)`.
3. **Başlangıç değişmemiş:**
   - `main` beklenen HEAD.
   - `list_edge_functions` → `admin-api` **`version = 18`**, **`verify_jwt = true`**, **`ezbr_sha256 = 96bd5e041aab688663f52742be89fd8b0dfe7b153ebd15344291d3e599ffc872`**. Başka değer → STOP (Stage 1'de Mete onayıyla yeni sürüm deploy edildiyse bu satır güncellenir, `SHA256SUMS` yeniden üretilir).
   - `execute_sql("select count(*)::text || ':' || md5(string_agg(id::text || ':' || name, E'\n' order by id)) from storage.migrations")` → **`73:824c7cc22b2d773ff697a047f1ce5c70`**. Farklıysa → STOP (CLI pin güncellenir, `storage-api` yeniden yeşil).
   - `s2_pre_assert.sql` → `S2_PRE_ASSERT_PASS` (P1).
4. **Client tarafında doğrudan yazma yok:** `bash gates/s2_client_write_scan.sh` → `S2_CLIENT_WRITE_SCAN_CLEAN`. Envanter (değişmedi): `CDP3B/admin.html` / `admin.html` `uploadToMedia()` → `admin-api` multipart; sunucu yazanları service_role (`CDP3B/edge/admin-api`, `CDP3B/edge/email-api`); `CDP3B/CDP3B_final.zip` içindeki eski `storage.from("media").upload` servis edilmiyor (ayrı PR ile kaldırılması önerilir). `LIVE_CHECKS/qa/qa_runner.mjs` (`s2-http`) reddedilmesi beklenen doğrudan yazmaları **bilerek** dener; GitHub Actions'ta Node ile koşar, hiçbir HTML onu yüklemez (tarama bunu ayrıca doğrular).

## 3. Uygulama sırası (production)

> Supabase MCP: `project_id = tosqsabuaomgqjtogdrn`. Secret/JWT/e-posta hiçbir çıktıya yazılmaz. MCP'ye giden her sorgu metni bu paketteki dosyanın **byte-exact** içeriğidir (P0b taramasından geçmiş).

| # | Adım | Komut | Beklenen |
|---|---|---|---|
| P0 | Paket bütünlüğü | `cd SEC_MEDIA_package/stage2 && sha256sum -c SHA256SUMS` | Tümü `OK` |
| P0b | MCP metin kapısı | `bash gates/s2_mcp_token_scan.sh` | `S2_MCP_TOKEN_SCAN_CLEAN` |
| P1 | PRE kayıt (salt-okunur) | `execute_sql(query = gates/s2_pre_assert.sql)` | `S2_PRE_ASSERT_PASS` (`0 FAIL / 16 counted`); satır 6 = `677c0f6b0f4fd37bb8b4fb7959a495fb`, satır 20 = `25:45f0c3ac7e466783e9e3fa3702183b28`, satır 21 = `3:e112c7b7523616c45bd38bf2c8c45064` (**PRE değerleri**) |
| P1b | (isteğe bağlı) red-before-green | `execute_sql(query = gates/s2_zero_footprint_test.sql)` | `REPORT:… FAIL anon.insert ALLOWED … S2_ZF_VERDICT=FAIL` (her şey geri alınır) |
| P2 | Migration | `apply_migration(name = 'sec_media_close_anon_write', query = <S2_up.sql içeriği, byte-exact>)` | Hata yok; NOTICE `S2_PRE_OK: state=baseline` + `S2_UP_OK`. `S2_PRE_DRIFT` / `S2_PRE_FAIL` / `S2_POST_FAIL` / `lock timeout` → hiçbir şey değişmemiştir → STOP (lock timeout ise trafik sakinken P2 yeniden denenir). |
| P3 | POST matris | `execute_sql(query = gates/s2_prod_assert.sql)` | `S2_PROD_ASSERT_PASS` (`0 FAIL / 19 counted`); satır 3–5 `{service_role}`, satır 6 = `0`, satır 7 = `74b56eca9c133d987aa2ac056b412473`, satır 15 = `1`, satır 18 = `3`, satır 20/21 == P1 |
| P4 | Davranış (zero footprint) | `execute_sql(query = gates/s2_zero_footprint_test.sql)` | Hata metni `REPORT:… INFO storage.objects policies=media anon delete:DELETE:{service_role},media anon insert:INSERT:{service_role},media anon read:SELECT:{public},media anon update:UPDATE:{service_role}; … S2_ZF_VERDICT=PASS fails=0` |
| P5 | Residue | `execute_sql(query = gates/s2_prod_assert.sql)` tekrar | Satır 13/14 = `0`, `S2_PROD_ASSERT_PASS` |
| P6 | Advisor | `get_advisors(type = 'security')` | S2'nin eklediği yeni bulgu yok (öncekiler not edilir) |
| P7 | Canlı HTTP kabul | §4 (GitHub Actions `qa-live` → `qa_runner.mjs s2-http`, Stage 1 harness'ları) | Tümü PASS |

**Mevcut production durumu ile v2 prod_assert (2026-10-07, read-only, P2'den önce):** `S2_PROD_ASSERT_FAIL` `7 FAIL / 19 counted` — FAIL satırları tam olarak 3, 4, 5 (roller `{public}`), 6 (`3`), 7 (`677c0f6b…`), 15 (ledger `0`), 18 (açıklama `0`); 1, 2, 8–14, 16, 20, 21 PASS. Bu "henüz uygulanmadı" imzasıdır ve satır 18 sorgusunun production yetkileriyle çalıştığını gösterir.

**Atomiklik:** gövdede dış BEGIN/COMMIT yok. `apply_migration` kendi transaction'ında çalıştırır; tek simple-query mesajı olarak gönderilse bile Postgres çok-ifadeli mesajı **örtük tek transaction** olarak yürütür — psql gate bunu `psql -1` olmadan da test eder (enjekte hata → tümü geri alınır; `SET LOCAL lock_timeout` uyarısız etkili). `ALTER POLICY` `storage.objects` üzerinde kısa bir `AccessExclusiveLock` alır; `lock_timeout=5s` beklemeyi sınırlar (psql gate: ikinci oturumun kilidi altında ~5 sn'de `lock timeout`, değişiklik yok). PostgREST DDL event trigger'ı şema-reload NOTIFY'ı tetikler (zararsız).
**İdempotency:** P2 yeniden çalışırsa PRE `state=already_applied_v2` der, aynı son durumu üretir ve aynı POST guard'dan geçer. Başarılı bir P2'den sonra tekrar `apply_migration` ledger'a ikinci satır ekler (P3 satır 15 = `2`, satır 15 FAIL olur; policy durumu etkilenmez) → başarılı P2 tekrarlanmaz. Başarısız P2 (guard / lock timeout) transaction'la birlikte geri alınır; ledger satırı oluşmaması beklenir (yeniden denemeden önce `execute_sql` ile satır 15 kontrol edilir).

## 4. Production kabul testleri (PRD İP2 → kanıt)

Canlı HTTP adımları `*.supabase.co` erişimi olan ortamdan (GitHub Actions `qa-live`, `LIVE_CHECKS/qa/qa_runner.mjs s2-http`) yapılır; bu hazırlık container'ı `www.asalocal.club` / `*.supabase.co`'ya erişemez (proxy 403). Anahtarlar ortamdan okunur, loglanmaz.

| PRD İP2 testi / kriteri | Kanıt | Beklenen |
|---|---|---|
| Anon doğrudan INSERT → reddedilir | P4 `PASS anon.insert denied 42501 RLS` (+ `authenticated`), `s2-http` "direct INSERT as anon/member denied" | 4xx; obje oluşmaz |
| Anon doğrudan UPDATE → reddedilir | P4 `anon.update rows=0`, `anon.upsert denied 42501 RLS`; `s2-http` PUT / `x-upsert` | 4xx; public bayt değişmez |
| Anon doğrudan DELETE → reddedilir | P4 `anon.delete rows=0`; `s2-http` "direct DELETE … removed nothing" | obje hâlâ 200; sayı değişmez |
| Public mevcut görsel SELECT/URL → çalışır | P4 `anon.select media visible`; P3 satır 2; `s2-http` "public read of admin upload 200 + bytes equal" | 200, `image/*` |
| Yetkili admin `media_upload` Edge yolu → çalışır | `s2-http` "admin Edge media_upload 200" (service_role BYPASSRLS; P4 `service_role.insert/update/delete`) | 200, HTTPS `public_url`, `venues/<uuid>.png` |
| Normal üye upload → 403 | `s2-http` member `media_upload` | 403, obje yok |
| Bucket public durumu değişmez | P3 satır 9–12, satır 21 | `media=true`, `email-assets-public=true`, `email-assets-draft=false` |
| Beklenmeyen obje yok; residue=0 | P5 satır 13/14; `s2-http` cleanup (`qa-media-cleanup`) | 0 |
| Anon yazma üçlüsü kapalı | P3 satır 3–7 (+ satır 18) | yazma policy'leri `{service_role}`, public/anon/authenticated yazma policy'si 0 |
| Diğer bucket/policy'lerde değişiklik yok | P1 satır 20/21 (PRE) ↔ P3/P5 satır 20/21 (POST) | PRE == POST (`25:45f0c3ac…`, `3:e112c7b7…`) |
| Migration source control + ledger'da | Bu paket (`S2_up.sql`, SHA256SUMS) + P3 satır 15 | `sec_media_close_anon_write` = 1 |

Tümü PASS → `SEC_MEDIA_STORAGE_CLOSED` raporu: P1 PRE çıktısı; P3/P5 POST matrisi (yeni canlı policy matrisi: 4 policy, md5 `74b56eca…`); P4 REPORT metni; HTTP kodları; maskeli obje path'i; residue; satır 20/21 PRE/POST yan yana; önkoşul 3 çıktıları; `storage-api` CI linki + üç pin satırı.

## 5. Geri alma

- **Güvenli (soft) rollback yoktur:** tek geri alma güvenliği gevşetir → yalnız `S2_down_INSECURE.sql`.
- **Önce fix-forward:** service_role BYPASSRLS olduğu için admin `media_upload` S2'den etkilenmez; admin yükleme bozulursa önce Edge/log.
- **Yalnız Mete'nin açık, yazılı onayıyla** ve kanıtlı neden varsa:
  1. `apply_migration(name = 'sec_media_s2_rollback_insecure', query = "set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE';\n" + S2_down_INSECURE.sql içeriği)` (yük `drop` içermez; P0b ayrıca tarar).
     psql: `psql -1 -v ON_ERROR_STOP=1 -c "set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE'" -f S2_down_INSECURE.sql`
  2. Beklenen: WARNING `S2_DOWN_INSECURE_APPLIED`. `s2_pre_assert.sql` → satır 1–11, 14, 20, 21 PASS, satır 6 = `677c0f6b0f4fd37bb8b4fb7959a495fb` (satır 13 ledger'da up kaydı olduğu için `1` — beklenen).
  3. Kök neden giderilince `S2_up.sql` yeniden uygulanır.
- Arming yoksa `S2_DOWN_INSECURE_NOT_ARMED`, hiçbir şey değişmez. Beklenmeyen/eksik policy veya tanım drift'i varsa `S2_DOWN_PRE_DRIFT`, hiçbir şey değişmez (v2 down yalnız rol çevirir; tanım düzeltmez).
- **Policy nesneleri yoksa** (ör. §7 kozmetik temizlik sonrası): `S2_down_INSECURE.sql` PRE'de durur. O durumda insecure rollback, aynı onay koşuluyla, baseline tanımlarının yeniden oluşturulmasıdır (tablo sahibi / Dashboard SQL editor):
  `create policy "media anon insert" on storage.objects as permissive for insert to public with check (bucket_id = 'media'::text);`
  `create policy "media anon update" on storage.objects as permissive for update to public using (bucket_id = 'media'::text) with check (bucket_id = 'media'::text);`
  `create policy "media anon delete" on storage.objects as permissive for delete to public using (bucket_id = 'media'::text);`
  ardından `s2_pre_assert.sql` satır 6 = `677c0f6b…`.

## 6. Değişmeyenler

`"media anon read"`; `storage.buckets` (tüm bayraklar; satır 21); storage.objects dışındaki tüm policy'ler (satır 20); `email-assets-*`; `storage.objects` grant'ları, RLS (enabled), trigger'ları (`protect_objects_delete`, `update_objects_updated_at`); roller ve BYPASSRLS bayrakları; Edge fonksiyonları ve `verify_jwt`; `admin_rate_check`; kill-switch; Auth/Resend/`email_provider_config`; HTML dosyaları. Üç yazma policy'sinin adı, `cmd`, `USING`, `WITH CHECK` ifadeleri de değişmez — yalnız `roles` ve açıklama.

## 7. Kapsam dışı (non-goal): kozmetik temizlik

Etkisiz üç policy'nin tamamen kaldırılması bu paketin hedefi **değildir** ve MCP ile yapılamaz (metin kapısı). İstenirse ileride, ayrı bir kararla, tablo sahibi yetkisiyle Supabase Dashboard SQL editor'da yapılabilir; öncesinde/sonrasında `s2_prod_assert.sql` yerine güncellenmiş bir POST assert gerekir (beklenen: yalnız `"media anon read"`), ve §5'teki "policy nesneleri yoksa" rollback yolu geçerli olur. Güvenlik açısından fark yoktur: v2 sonrası anon/authenticated için geçerli yazma policy'si zaten yoktur.

## 8. Notlar / riskler

- **Etkisizlik varsayımı:** `service_role` BYPASSRLS. Bayrak değişirse (Supabase platform değişikliği) policy'ler `service_role` için devreye girer — yine yalnız `media` bucket'ına yazma izni verirler; anon/authenticated etkilenmez. S2_up PRE/POST ve prod_assert satır 16 bayrağı doğrular.
- **Açıklamalar yeniden-grant'ı engellemez:** `ALTER POLICY … TO public` ile açık geri gelir; bu yüzden açıklama (EN/TR) "Do NOT re-grant" der ve prod_assert satır 3–7/18 bunu yakalar.
- **MCP metin kapısı yalnız `drop` için gözlendi.** `s2_zero_footprint_test.sql` `UPDATE`/`DELETE`/`INSERT` ifadeleri içerir (rollback'li); MCP bunlar için de onay isterse P4 bloklanır → davranış kanıtı `storage-api` CI + P7 HTTP kabulünden alınır ve raporda belirtilir.
- **protect_objects_delete trigger'ı:** `storage.allow_delete_query<>'true'` iken her rolün doğrudan SQL DELETE'ini **42501** ile reddeder (RLS değil); testler hata metnini doğrular ve RLS kanıtını GUC=`true` altında 0 satır olarak alır.
- **Yetki:** production'da `postgres` süper kullanıcı değil; `ALTER POLICY … TO …` ve `COMMENT ON POLICY` geri alınan DO bloğuyla doğrulandı; `RENAME` sahiplik ister. PGlite/PG16 yerelde süper kullanıcıyla koşar; non-superuser kanıtı CI `storage-api` (`runner role=postgres superuser=f`, v1 CI 37620936407'de doğrulandı) ve P2'dir.
- **CI pin (storage-api):** `supabase/setup-cli@v1` `version: 2.118.0` → `storage-api:v1.77.0` → `storage.migrations` `73:824c7cc22b2d773ff697a047f1ce5c70` = production. 'latest' yasak; 1.226.4 kullanılmaz. Job sürümü, imajı ve paritesi kendisi doğrular. `supabase start` çıktısında JWT/`sb_` anahtarları, DB parolası ve yerel S3 Access/Secret Key maskelenir.
- **Satır 20 formülü / yerel env satırı:** değişmedi (açık `order by schemaname, tablename, policyname`; yerelde PRE kaydedilir, her POST'ta PRE ile birebir karşılaştırılır).
- **Kapsam dışı gözlemler (S2 değiştirmez):** `"media anon read"` anon'un tüm media objelerini listelemesine izin verir; `anon`/`authenticated` `storage.objects` üzerinde Supabase varsayılan tablo grant'larına sahip; `cdp3c_edge_integration.sh:207` doğrudan `delete from storage.objects` kullanıyor.
- **Doğrulanmamış:** v2'nin `storage-api` CI koşusu (push sonrası) ve production P2–P7.

## 9. Yerel doğrulama (2026-10-07, v2)

```
bash gates/s2_mcp_token_scan.sh                                   -> S2_MCP_TOKEN_SCAN_CLEAN (5 dosya + armed rollback yükü)
PGLITE_DIR=<pglite 0.3.16> node gates/s2_pglite_gate.mjs          -> RESULT pass=257 fail=0 · S2_LOCAL_PGLITE_GATE_PASS (PostgreSQL 17.5)
PGLITE_DIR=<pglite 0.5.8>  node gates/s2_pglite_gate.mjs          -> RESULT pass=257 fail=0 · S2_LOCAL_PGLITE_GATE_PASS (PostgreSQL 18.3)
bash gates/s2_psql_gate.sh                                        -> RESULT pass=43 fail=0 · S2_PSQL_GATE_PASS (PostgreSQL 16.15)
bash gates/s2_client_write_scan.sh                                -> S2_CLIENT_WRITE_SCAN_CLEAN (11 client dosyası)
bash CDP3C_package/gates/secret_scan.sh SEC_MEDIA_package/stage2 .github/workflows/sec-media-stage2-gates.yml -> secret_scan_clean
shellcheck -S warning gates/*.sh ; actionlint sec-media-stage2-gates.yml -> temiz
```
- **storage-api gate SQL yolu simülasyonu (Docker yok):** yerel PG16 + model fixture + production ile birebir `storage.migrations` (73) + `supabase_migrations` yok + erişilemeyen API. Sonuç `pass=29 fail=14`; 14 FAIL'in **tamamı** HTTP kontrolleri (`000`); parite, baseline, açıklama yok, pre_assert, S2_up (`state=baseline` + `S2_UP_OK`), v2 roller, POST md5 `74b56eca…`, açıklama `3/3`, ZF PASS, prod_assert, idempotency (`state=already_applied_v2`), silahsız/armed down (md5 `677c0f6b…`, açıklama `0/0`), re-up ve final kontrolleri PASS. Simülasyon süper kullanıcıyla koştu (`superuser=t`).
- **Mutasyon kontrolü (gate duyarlılığı):** S2_up yorumuna `DrOp` → token scan + PGlite FAIL; ZF yorumuna `drop` → FAIL; bir ALTER'a `, anon` → 62 FAIL (POST guard dahil); bir COMMENT silinince → 63 FAIL (POST guard); DOWN'da `to anon` → 19 FAIL (DOWN POST guard); DOWN'da bir `is null` silinince → 18 FAIL; prod_assert satır 7 md5 bozulunca → 18 FAIL; S2_up karışık-rol reddi notice'a çevrilince → 1 FAIL.
- Client scan negatifleri: HTML'den `LIVE_CHECKS` yükleme → FAIL; `storage.from(...)` → FAIL; `LIVE_CHECKS/` altındaki doğrudan yazma → CLEAN (kapsam dışı harness).

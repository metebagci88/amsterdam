# CDP-3B (v8) · İki paketleme/gate kapanışı (ürün kodu DEĞİŞMEDİ)

CI koşusundan önce istenen iki düzeltme yapıldı; ürün kodunda yeni analiz/değişiklik YOK.

## 1) Workflow konumu — repo kökünde, GitHub tarafından keşfedilebilir
Canonical workflow artık **paket kökünde**: `.github/workflows/cdp3b-gates.yml`. `CDP3B/.github/...` kopyası kaldırıldı (canonical değil; SHA256SUMS'a da dahil değil). ZIP yerleşimi:
```
.github/workflows/cdp3b-gates.yml   ← GitHub workflow_dispatch bunu görür
CDP3B/...                            ← çalışma ağacı (SHA256SUMS burada)
```
Workflow içinde `defaults.run.working-directory: CDP3B` ve `pull_request.paths: ["CDP3B/**"]` **korundu** — tüm adımlar CDP3B altında çalışır.
Workflow SHA-256 (bağımsız): `4a8222b850ed2db432064e45ab3b38bf7d543e0f67598a21fc1a55f5d3070577`.

## 2) Teardown/residue — FAIL-CLOSED (job kırmızı olur)
`.github/workflows/cdp3b-gates.yml` teardown adımı yeniden yazıldı:
- **Sıra:** gate'ler → **Teardown (`if: always()`)** → **Artifact upload (`if: always()`)**. Artifact teardown'dan SONRA ve teardown'ın `/tmp/teardown.log`'unu da yükler; teardown başarısızlığını maskelemez (ayrı adımlar; teardown non-zero ise job kırmızı kalır).
- `supabase stop --no-backup` **`|| true` YOK** — hata olursa `GATE_FAILED:teardown_stop` + `exit 1`.
- Bu job'ın hedefleri açık: `docker ps -aq --filter name=supabase_` ve `docker volume ls -q --filter name=supabase_`.
- `container_count` ve `volume_count` hesaplanır ve **etiketli** `/tmp/teardown.log`'a yazılır (`container_count=0` / `volume_count=0`).
- İkisinden biri ≠ 0 → `GATE_FAILED:teardown_residue` + `exit 1` → **workflow kırmızı**.
- Artifact `path`'ine `/tmp/teardown.log` (+ `gates_out.txt`, `serve.log`, `ci_setup_psql.log`, `cdp3b_gate_step.log`) eklendi; gate'ler başarısız olsa bile `if: always()` ile yüklenir (secret içermez).

## Statik kanıtlar (bu turda üretilen)
- ZIP içindeki workflow yolu: **tam olarak** `.github/workflows/cdp3b-gates.yml` (kök); `CDP3B/.github` ZIP'te YOK.
- Teardown assertion'ları: `container_count == 0` **ve** `volume_count == 0` değilse `exit 1` (kod: workflow teardown adımı).
- Artifact adımı teardown'dan **sonra**, `if: always()`, `/tmp/teardown.log` dahil.
- **ZIP SHA-256:** teslim mesajında verilir (ZIP raporu içerdiği için öz-referans döngüsünü kırmak amacıyla; `sha256sum CDP3B_final.zip` ile doğrulanabilir).
- **SHA256SUMS:** paket kökündeki `CDP3B/SHA256SUMS` — 19 dosya, `sha256sum -c` = **VERIFY OK** (workflow kök'e taşındığı için listede değil; ayrı SHA yukarıda).

## Senin tarafında çalıştırma (kısa)
1. ZIP'i aç; `.github/` ve `CDP3B/` klasörlerini **repo köküne** koy (birleştir), commit + push.
2. GitHub → **Actions** → **CDP-3B Gates** → **Run workflow** (`workflow_dispatch`, herhangi bir branch).
3. **Yeşil = geçti** koşulu: iş `LOCAL_GATES_PASS_STAGING_PENDING` ile biter; `cdp3b-gate-logs` artifact'ında `gates_out.txt` son satırı `LOCAL_GATES_PASS_STAGING_PENDING` **ve** `teardown.log` içinde `container_count=0` + `volume_count=0`.
4. Bu gerçek run yeşil olana kadar production'a dokunulmaz; apply onayı istenmez.

---

# CDP-3B (v7) · Test altyapısı GERÇEKTEN koşulabilir — 10 düzeltme + AÇIK blocker

Bu tur yalnız **gate/CI altyapısı** (ürün mantığında yeni analiz yok; tek istisna: aşağıdaki prod-inert E2E test-seam). Talep edilen 10 maddenin dosya-seviyesi karşılığı:

1. **GITHUB_ENV export düzeltmesi.** `gates/ci_setup.sh` artık psql çıktısını **log dosyasına** yazar (`/tmp/ci_setup_psql.log`), stdout'a KARIŞMAZ; yalnız `$1` dosyasına **saf `KEY=value`** satırları (`SUPABASE_DB_URL/EMAIL_API_URL/SUPER_JWT/CRM_JWT/SERVICE_KEY`) üretir. Workflow bunu `cat >> $GITHUB_ENV` ile alır ve ayrı bir adımda 4 değişkenin gerçekten set olduğunu assert eder (`GATE_FAILED:env_<KEY>`).
2. **Supabase proje yapısı + fonksiyon yerleşimi.** Workflow `supabase init` ile `supabase/config.toml` üretir; Edge fonksiyonu `supabase/functions/email-api/{index.ts,email_sanitizer.js}` altına kopyalanır ve dosya varlığı `test -f` ile doğrulanır. Belirsiz `--no-verify-jwt` bayrağı KALDIRILDI (fonksiyon zaten `verify_jwt=true`). `sleep 8` yerine **readiness loop** (401/200/400 görene dek 60×1s); hata olursa `serve.log` basılır.
3. **Baseline fixture (`gates/baseline_fixture.sql`).** Admin altyapısı prod kontratıyla **birebir**: `admin_role` enum (8 değer), `admin_users/admin_roles/admin_settings/admin_write_ops/admin_write_log` tabloları (kolon/constraint/default), `_admin_active/_admin_has_role/_admin_writes_enabled` gövdeleri **prod'dan çekilen hâliyle**. `admin_writes_enabled=true` seed'lenir. `ci_setup.sh` + `run_gates.sh` **preflight** yapar; bağımlılık yoksa `GATE_FAILED:baseline_missing`.
4. **Gate4 gerçek audit-count.** `gates/e2e_gates.ts` DB'ye bağlanır (`deno-postgres`): ilk publish sonrası `admin_write_log where idempotency_key=<pidem>` = **1**; aynı-key retry sonrası **hâlâ 1** (ikinci audit YOK) + aynı `published_version_id`.
5. **Gate5 A+B.** A: aynı-idem paralel `new_version` → aynı `version_id`, tek draft, tek audit. B: **farklı-idem** paralel → tam biri 200, diğeri `draft_exists` (≥400); DB'de **tek current draft**.
6. **Gate6 gerçek fault injection.** Draft bucket'taki içerik-hash path'e (service_role storage REST) **yanlış bayt** yazılır → `asset_upload` → HTTP **409 `storage_hash_conflict`**; DB'de o idem için audit=0 ve register=0; ardından doğru içerik geri konur.
7. **Gate8 gerçek rehost + reject.** Reject (her ortamda): allowlist dışı host → `hosted=[]`, `needs_manual_upload` dolu, src rewrite yok. Accept (E2E_IMG_URL verildiğinde): allowlist'e alınmış test host → `hosted.length=1`, `rewritten_html` managed public path içerir, save→publish→get manifest korunur. **Prod-inert test-seam:** `index.ts`'e yalnız `EMAIL_API_E2E=1` iken aktif olan `E2E_IMAGE_HOSTS`/`E2E_ALLOW_HTTP` okuması eklendi; **production'da bu değişkenler ASLA set edilmez → SSRF allowlist/protokol davranışı DEĞİŞMEZ.** Bu nedenle `index.ts` SHA güncellendi (aşağıda).
8. **Admin reopen testi (`gates/admin_reopen_test.mjs`, jsdom).** admin.html'in **gerçek** e-posta script bloğu çıkarılıp jsdom penceresinde eval edilir (GrapesJS yüklenmez; `html_import` yolu). Doğrular: yayınlanmış+draft yok → "Yeni sürüm oluştur" + immutable rozeti; html_import draft reopen → alanlar dolar, `_emAssets` **manifest'ten yeniden kurulur** (emSave'in gönderdiği `asset_manifest` = draft manifest).
9. **Gate9 reconcile fault injection.** Shape + rol (crm forbidden) + `scanned.db_rows == gerçek email_assets sayısı` + `truncated=false`. DB error: `revoke select on email_assets from service_role` → 500 `reconcile_db_error` (asla ok:true). Storage error: `revoke select on storage.objects from service_role` → 500 `reconcile_storage_error`. Her ikisinde de grant geri verilir.
10. **`run_gates.sh` sertleştirme.** `set -euo pipefail` + `ERR` trap (beklenmedik hata → `GATE_FAILED:<son-gate>` + log kuyruğu stderr'e). Per-gate adları; adımlar: `sha256sums → sanitizer_sha → deno check/test/bundle → db_url → baseline → gate9(rollback dry-run) → e2e(4-9) → admin_reopen`. Çıktı YALNIZ `LOCAL_GATES_PASS_STAGING_PENDING` veya `GATE_FAILED:<gate>`.

## Güncellenen SHA-256
| Dosya | Yeni SHA-256 |
|---|---|
| `edge/email-api/index.ts` | `edf9273d397fc820f207161912c96b701d659b99a478186488755b65b14db663` (E2E test-seam eklendi; prod-inert) |
| `gates/baseline_fixture.sql` | `a6b5ff6d912cf79b520b6c2231a4b9ad615d3421dacd788fc2e5ac46a3ae98cc` (YENİ) |
| `gates/e2e_gates.ts` | `1cbd25e3f0488588cc4e484dd3c09e081bf722addb32feed5e4f806901d8e6ef` (madde 4-9) |
| `gates/admin_reopen_test.mjs` | `187eb44b177c310bed66e687ea1a826746aa8e06c4450b8b7f466dd4bf80d291` (YENİ, madde 8) |
| `gates/ci_setup.sh` | `7c996bf97ee52afdb0722ce2bfbbb8eef8c09c14d0d8296c9af50fe4202ca591` |
| `run_gates.sh` | `fc49eeea534d9f73775e9535742fea968fa42ada59bd831eee1f3f978211017b` |
| `.github/workflows/cdp3b-gates.yml` | `49915e9c48ea3cbdbd2d0ac2791ac199fe4ea7ca2f07d34559b0513250061a1c` |

Kesin/tam liste: paket kökündeki `SHA256SUMS` (run_gates ilk adımı `sha256sum -c SHA256SUMS`).

## AÇIK BLOCKER — dürüst beyan (uydurulmadı)
Talep edilen **"gerçek tamamlanmış GitHub Actions run linki/ID'si + gate log artifact'ı + teardown residue-0 kanıtı"** bu ortamda ÜRETİLEMEZ: bu sandbox'ta Deno yok (binary indirme engelli), Docker/Supabase CLI yok, ve GitHub'a push yetkim yok. Dolayısıyla CI koşusunu **ben başlatamam**. Bu sandbox'ta yapılan doğrulama: `bash -n` (run_gates.sh, ci_setup.sh) = OK, `node --check` (admin_reopen_test.mjs) = OK, workflow YAML parse = OK, `SHA256SUMS` self-check = VERIFY OK. Deno tipleri/e2e ve canlı Edge/Storage kapıları **yalnız CI'da** koşar.

**Çalıştırma (senin tarafında):** repo'ya `CDP3B/` ağacını koy → Actions'ta **CDP-3B Gates** workflow'unu `workflow_dispatch` ile çalıştır. PASS koşulu: iş `LOCAL_GATES_PASS_STAGING_PENDING` ile biter, `cdp3b-gate-logs` artifact'ı (secret'sız) yüklenir, teardown adımı kalan supabase container/volume = 0 gösterir. **O run yeşil olduktan sonra** kontrollü production apply onayına geçeriz; o zamana kadar production'a dokunulmaz (bucket/migration dahil).

---

# CDP-3B (v6) · Gate/paketleme kapanışı — TEK PAKET (`CDP3B_final.zip`) + SHA256SUMS

Bu tur yalnız gate/paketleme (ürün kodunda yeni analiz yok). Beş nokta:
1. **`run_gates.sh` fail-closed + gerçek Gate 9.** Artık `sha256sum -c SHA256SUMS` → canonical sanitizer SHA (`bc60ffed…`) → `deno check`/`deno test`/`deno bundle` → **gerçek `psql` rollback dry-run** (`\i CDP3B_up.sql` + `\i CDP3B_down.sql` → CDP-3B tablo+fonksiyon+trigger sayısı=0 assertion) → Gate 4-8 e2e. `SUPABASE_DB_URL` yoksa `GATE_FAILED:gate9_blocked_no_db_url` (non-zero). Herhangi bir adım başarısız → `GATE_FAILED:<gate>` (non-zero). Çıktı YALNIZ `LOCAL_GATES_PASS_STAGING_PENDING` ya da `GATE_FAILED:<gate>`; "ALL GATES PASS" yok.
2. **Tek canonical sanitizer.** Pakette yalnız `edge/email-api/email_sanitizer.js` = **`bc60ffed…`**; `c53e83…` kopya YOK (bu proje ağacında hiç yoktu — çoğaltma yalnız yükleme ortamındaki dosya-adı `(1)` etiketinden kaynaklanıyordu). `index.ts` + `test_sanitizer_deno.ts` bu tek dosyayı import eder; `run_gates.sh` testlerden ÖNCE SHA'sını doğrular.
3. **Tek bütün paket + SHA256SUMS.** `CDP3B_final.zip` korunmuş klasör ağacıyla teslim; kökte `SHA256SUMS` (kendisi hariç tüm dosyalar). `run_gates.sh` ilk adımı `sha256sum -c SHA256SUMS`.
4. **Production'a dokunmadan uygulanabilir CI.** `.github/workflows/cdp3b-gates.yml` + `gates/ci_setup.sh` + `gates/mint_jwt.ts`: **geçici/yerel Supabase** (`supabase start`), şema+2 bucket+test kullanıcıları seed, `supabase functions serve email-api`, sonra `run_gates.sh`. Hepsi geçici stack'te; **hiçbir production kaynağı, ücretli kaynak yok**. Local/CI mümkün değilse bu açık blocker'dır; production üzerinde test önerilmez.
5. **Gate 4-8 gerçek assertion testleri** (`gates/e2e_gates.ts`, Deno): HTTP aynı-key publish retry (aynı `published_version_id`) · iki paralel `new_version` (tek tutarlı draft) · asset_upload existing idempotent + `storage_hash_conflict` yolu (fault-injection notu) · promote+immutable publish (yayınlanmışta save reddi) · hosted→manifest→save→publish + get manifest korunur · reconcile super_admin fail-closed shape + crm forbidden. Her test assertion üretir; hata → non-zero.

**Paket SHA-256:** `CDP3B_final.zip` = `f7e761549f6c3b75b536157c60ff78055f22e3bb2507359096792fcc96ff3732` *(rapor güncellendiği için SHA256SUMS yeniden üretildi; kesin değer için zip içindeki `SHA256SUMS`'a bakın.)*

---

# CDP-3B (v5) · Son üç kapanış + kapı durumu — İNCELEME DURUMU (apply izni İSTENMİYOR)

Son üç nokta gerçek dosyalarda kapatıldı. Sandbox'ta koşulabilen kapılar koşuldu; Deno + canlı Edge/Storage gerektiren kapılar (bu sandbox'ta yok) CI/staging'e bırakıldı. **Apply istenmiyor.**

## Bu turdaki 3 düzeltme
1. **Edge publish retry artık SQL idempotency'sini bypass etmiyor.** ÖNCE: `if(!draft) throw no_draft_version` (SQL RPC'ye ulaşmadan). SONRA: draft yoksa **aynı idem/request_id ile `admin_w_email_publish` RPC çağrılır** → tamamlanmış aynı-key publish varsa önceki `published_version_id` döner; gerçekten draft yoksa RPC'nin `no_draft_version` hatası döner (Edge kısa-devre etmez). Draft varsa promote→verify→publish akışı sürer. rg: `edge/email-api/index.ts` publish `DRAFT YOK … RPC` bloğu mevcut.
   - HTTP retry testi (publish → yanıt kaybı → aynı payload+idem retry → 200 + aynı published_version_id + ikinci audit yok) **GATE 4** (canlı Edge; staging).
2. **`reconcile` fail-closed + tam listeleme + super_admin-only.** DB select error → `reconcile_db_error` (boş başarı DÖNMEZ). Storage list error → `reconcile_storage_error`. **Pagination** (offset döngüsü, `MAX=100000`, `truncated` bayrağı). Rol: **super_admin** (`admin_q_email_asset_gc_candidates` = `_email_can_publish` kapısı; analyst DEĞİL — önceki data_health-analyst kapısı kaldırıldı, açık karar: reconcile super_admin'e özel). Çıktı: `storage_only_orphan, db_only_missing, wrong_status_path, published_missing_public, scanned{db_rows,draft_objects,public_objects}, truncated`. rg: `reconcile_db_error`/`reconcile_storage_error`/`truncated` mevcut. (Storage-list-hatası→"0 sorun" DÖNMEZ, fail-closed.)
3. **Gerçek vendor dosyaları fiilen teslim + hash kanıtı.** `vendor/grapesjs/{grapes.min.js, grapes.min.css, grapesjs-preset-newsletter.index.js, LICENSE}` pakette. Her biri SHA-256 + SHA-384 hesaplandı; **3/3 SHA-384 admin.html `loadGrapes` değerleriyle BİREBİR MATCH** (aşağıda).

## Vendor kanıt tablosu
| Dosya | SHA-256 | SHA-384 (SRI) | admin.html eşleşme |
|---|---|---|---|
| `grapes.min.js` | `ef1148f91d22dee3a3f912e14582c1d8deaee076633a4a50c7479245c8541129` | `sha384-9WsveEkzJPxXhUVesgc+Yhf4S70h66eLgal2CckJku1ut13/IwUfb/MKTgti9Qf/` | **MATCH** |
| `grapes.min.css` | `92d7f8742ee053f525dcec4bea0f12386213fcc8c739ab3b57a040b77f253387` | `sha384-kcbRZleYUgRur4pld6Agh5vep/FKMvauFL9QYhviTKbxuJF1Iil2Y4q+DMXr6Pzl` | **MATCH** |
| `grapesjs-preset-newsletter.index.js` | `3d950fc726f3212434e33d89b3a4c3fbe5aa76a66aee5b9d87a20846a5b27f78` | `sha384-g6PRPz/Tx4TepexHMqRJ2fmXdDh3pdPgAjQOUwYZh7R1eAxdY2yG2XKwRykvQZB7` | **MATCH** |
| `LICENSE` (BSD-3, GrapesJS) | `1a7603ac82661e3ec4f0ad015e37f68ab62c85c725f07659b81760edb459ff8d` | — | — |

## Tam teslim manifesti + güncel SHA-256 (deploy/rollback için)
| Dosya | SHA-256 |
|---|---|
| `CDP3B_up.sql` | `ffc8f6aa4127b1f42efae495360156abb6a6b938278368737d040daf9fcc6d88` |
| `CDP3B_down.sql` | `5e255f6f11b60af77d0fa084ae32a0010e91d2c0abd648f6522afef208dcfc67` |
| `edge/email-api/index.ts` | `8ee3e5f0e9ef6386ab09549134fc6a14e63f73eca8650e1ea3559a4994cb1670` |
| `edge/email-api/email_sanitizer.js` (canonical) | `bc60ffede60a2e64f905146be0e32f3bf375bf5824eb96d3734225eaa71493d2` |
| `edge/email-api/test_sanitizer_deno.ts` | `8fe5a72a348873f29b4067235141c0051f1446cb10b8e8d1fe0ec0bc591284cc` |
| `admin.html` (canonical entegre) | `481e73cb536da1ab60bff82793d6eb4e414a84aa038ffac02a915feaf1fc1b44` |
| `vendor/grapesjs/grapes.min.js` | `ef1148f91d22dee3a3f912e14582c1d8deaee076633a4a50c7479245c8541129` |
| `vendor/grapesjs/grapes.min.css` | `92d7f8742ee053f525dcec4bea0f12386213fcc8c739ab3b57a040b77f253387` |
| `vendor/grapesjs/grapesjs-preset-newsletter.index.js` | `3d950fc726f3212434e33d89b3a4c3fbe5aa76a66aee5b9d87a20846a5b27f78` |
| `vendor/grapesjs/LICENSE` | `1a7603ac82661e3ec4f0ad015e37f68ab62c85c725f07659b81760edb459ff8d` |
| `run_gates.sh` (CI kapı runner) | teslimde |
| `CDP3A_proto/{package.json,package-lock.json,email_sanitizer.js,test_sanitizer.js,proof_grapesjs_pipeline.js}` | `32dbf921…`/`add0583b…`/`bc60ffed…`/`bc00f98b…`/`753ac1d1…` |

## Kapı durumu (apply-öncesi)
| # | Kapı | Durum |
|---|---|---|
| 9 | **Rollback dry-run** | **PASS** — statik: up.sql'in oluşturduğu 25 fonksiyon / 4 tablo / 4 trigger'ın TAMAMI down.sql'de düşürülüyor (eksik: NONE). Not: bu tur `_email_fp` eksikti; dry-run yakaladı, down.sql'e eklendi. |
| 1 | deno check | **KOŞULMADI** — sandbox'ta Deno yok (binary indirme engelli) → CI |
| 2 | deno test | **KOŞULMADI** → CI |
| 3 | Edge bundle/typecheck | **KOŞULMADI** → CI |
| 4 | Edge HTTP publish retry | **KOŞULMADI** — deploy edilmiş Edge gerektirir → staging |
| 5 | 2-paralel new_version/idempotency | **KOŞULMADI** — 2 gerçek bağlantı/canlı gerektirir → staging/CI |
| 6 | 2-bucket upload/exists/promote/GC/reconcile | **KOŞULMADI** — canlı Storage → staging |
| 7 | admin gerçek fonksiyon regresyonu | **KOŞULMADI** — canlı tarayıcı → staging |
| 8 | asset upload + HTML rehost uçtan uca | **KOŞULMADI** — canlı Edge+Storage → staging |

`run_gates.sh` 1/2/3/9'u otomatikleştirir; 4-8 deploy sonrası staging'de. SQL çekirdeği (fingerprint collision, publish/new_version retry idempotency, managed-URL↔manifest) ise bu sandbox'ta **hosted PASS** edildi.

## Sonuç
Kapı 1-8 (Deno + canlı Edge/Storage) bu sandbox'ta koşulamadı; bu yüzden **"tüm kapılar PASS" beyanı verilmiyor ve apply izni istenmiyor.** Paket yalnız inceleme. Kapılar bir Deno+staging ortamında PASS edilince, SHA'lı tam paket + kontrollü uygulama sırası ayrı onayla paylaşılır. Bu kapılar bitmeden bucket/migration uygulanmayacak.

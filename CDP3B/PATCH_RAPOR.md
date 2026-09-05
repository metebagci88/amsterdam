# CDP-3B Patch — Durum ve Teslim Raporu (düzeltilmiş)

**Tarih:** 2026-09-05
**Kapsam:** Taslak e-posta görselinin admin GrapesJS editöründe publish öncesi kırık görünmesi hatasının düzeltilmesi (asset_preview kısa-ömürlü signed URL + fail-closed içerik denetimi). Gerçek e-posta gönderimi / provider / consent / unsubscribe KAPSAM DIŞI.
**Branch:** `main` (repo: `metebagci88/amsterdam`)

> **EN GÜNCEL DURUM = BÖLÜM 8 (Run #10 düzeltmesi).** Bu teslimin geçerli dosya değerleri (index.ts, e2e_gates.ts, SHA256SUMS, workflow) Bölüm 8'dedir; Bölüm 2-3 önceki turların kaydıdır ve tarihsel bağlam içindir. Hedef branch: `cdp3b-asset-preview`. Bölüm 8'de index.ts artık DEĞİŞTİ (E2E public-origin alias) — Bölüm 2'deki "index.ts değişmedi" ifadesi yalnız önceki tur içindir.
>
> Bu sürüm iki kapanış düzeltmesini içerir: (1) SHA-1 ↔ SHA-256 etiket karışıklığı giderildi; (2) `admin_q_email_asset_preview` yetki sınırı, `created_by`-tek-başına sızıntısını kapatacak şekilde yeniden yazıldı. Bu iki dosya (up.sql + e2e_gates.ts) ve SHA256SUMS **yereldeki düzeltilmiş** sürümdür; repodaki commit'ler **düzeltme ÖNCESİ** sürümdür (bkz. Bölüm 6, repo/yerel sapması).

---

## 0. SHA terminolojisi (karışıklığı önlemek için)

Bu raporda iki AYRI hash türü geçer; asla birbirinin yerine kullanılmaz:

- **SHA-256** — 64 hex karakter. Dosya içeriğinin `sha256sum` değeri. SHA256SUMS manifestindeki tüm satırlar budur.
- **Git blob SHA-1** — 40 hex karakter. `git hash-object` / GitHub contents API `sha` alanı. Byte-exact commit doğrulaması bununla yapılır (GitHub SHA-256 vermez).

Önceki raporda SHA256SUMS satırındaki `1ecdf70f…` (40 hex) yanlışlıkla "Beklenen SHA-256" kolonunda gösterilmişti. O değer bir **Git blob SHA-1**'dir. Aşağıda hem doğru SHA-256 hem de güncel git-blob-sha1 ayrı ayrı, doğru etiketle verilmiştir.

---

## 1. admin.html — KISMİ/BOZUK COMMIT YOK (kritik)

- Repo'daki `CDP3B/admin.html` **git blob SHA-1** (40 hex): `ef818a001f69a18fc49f4c8846e6d173785b0312` (boyut **157167 bayt**) — **ESKİ (patch öncesi) sürüm.**
- Yani **admin.html'e ait hiçbir kısmi/bozuk commit oluşmadı.** Parçalı base64 çalışması yalnızca tarayıcı editör tamponundaydı, commit edilmedi; editör iptal edildi.
- Hazırlanan **doğru ve eksiksiz** yerel admin.html:
  - Boyut: **163337 bayt**
  - **SHA-256 (64 hex):** `6124b4b3731fc11c4b8fde701f24d588b3829976574d2828c33de0aac8556d8c` — bu değer bağımsız kontrolde doğrulandı.
  - (Git blob SHA-1 henüz hesaplanmadı çünkü admin.html repoya yazılmadı; upload sonrası GitHub contents API `sha` ile doğrulanacak.)

> admin.html byte-exact olarak repoya **yazılmadı**; onay ve yöntem sizde. Bölüm 6'ya bakın. Bu teslimde admin.html yeniden verilmiyor (SHA-256 `6124b4b3…` zaten doğrulandı).

---

## 2. GitHub'a byte-exact commit edilen 8 dosya

Her dosya, commit anında **GitHub contents API `sha` (git blob SHA-1, 40 hex) = yerel git-blob-sha1** eşitliğiyle byte-exact doğrulandı. Hepsi `main` branch'inde.

| Dosya | Commit SHA (commit objesi) | Dosyanın SHA-256 (64 hex) | Not |
|---|---|---|---|
| `CDP3B/CDP3B_patch_asset_preview_down.sql` | `4077439b739f91ec69c4d77d186f0c74fc9af57a` | `6b90031545e6df9ea403fcefd69c397b4d322469e97f6c7c86575f94ed5cb833` | değişmedi |
| `CDP3B/CDP3B_patch_asset_preview_up.sql` | `cd69fb9830064b215e3e362cd8052e3bb94ef059` | ~~`af946f7ce2600a11e40b844382d40283d8d41c022b1726284d13b6ae4b0c45ef`~~ | **repo PRE-FIX** — düzeltilmiş yerel SHA-256 aşağıda |
| `CDP3B/gates/gjs_serialize_test.mjs` | `108e413b0da49d35463e5c3d34e66f45fcd98a18` | `5dac035222fa13730c134481d390eac179712fa19667d02c82d19e9fe1748143` | değişmedi |
| `CDP3B/SHA256SUMS` | `4df4c74e96d5eb8f45244724fcae7f85585b343c` | (repo PRE-FIX manifest) | **repo PRE-FIX** — düzeltilmiş yerel değerler aşağıda |
| `CDP3B/run_gates.sh` | `cfd83cd6917a5f217e771d931aa13c135d12c9bf` | `91a7f633ccfe8d95cbabd6dee6a9bef387fc9fdb66805317acc4b1a79ee19ad1` | değişmedi |
| `CDP3B/gates/ci_setup.sh` | `a823a9f0b14502836b4c39610010043089495f77` | `2d070ac254c161d3336164d6dc4b478ebef134bfe2ebb37f5a01dce44d92bcb2` | değişmedi |
| `CDP3B/gates/e2e_gates.ts` | `cfcb6d6cf432ad7c60dc9159056ad65228769f99` | ~~`5769a564844450f5f9ceefacb99f331151160ad4030ce4761a5cec71ee82dbf8`~~ | **repo PRE-FIX** — düzeltilmiş yerel SHA-256 aşağıda |
| `CDP3B/edge/email-api/index.ts` | `7d1fe29aaa0a9141b73fbd363de8807846f5c281` | `92254e03d08f1423c563598191a36300ecd27783bf1e999de6173bd97ca14b85` | değişmedi (sınır RPC'de) |

**Düzeltilmiş yerel SHA-256 değerleri (bu teslimdeki dosyalar):**

| Dosya | Düzeltilmiş SHA-256 (64 hex) |
|---|---|
| `CDP3B_patch_asset_preview_up.sql` | `12f49c88a65f88860d1c28d3d6db387088c7eebcf25e5e5261c8626b12e2f12f` |
| `gates/e2e_gates.ts` | `1e4e59638113fe5b32700fc3b38cdec5746df814b7f2b53049f27b36e018ba55` |
| `SHA256SUMS` (dosyanın kendi SHA-256'sı) | `dad03efe2723d6c09486495fbec24e5c5d1b73121490488a5b274d0dd0f2f8f8` |
| `SHA256SUMS` (dosyanın git blob SHA-1'i, 40 hex) | `0c95f12851ddb5f7a62eb665889129b7b2606a2f` |

---

## 3. Güncel SHA256SUMS manifesti (düzeltilmiş; yerel `sha256sum -c` = tümü OK)

Tüm satırlar dosya **SHA-256** (64 hex) değerleridir:

```
bcfdcf7c80703aa5f1c5e055eb4175730ea1f5ae9a0a42bef546a65088c809e0  CDP3B_RAPOR.md
5e255f6f11b60af77d0fa084ae32a0010e91d2c0abd648f6522afef208dcfc67  CDP3B_down.sql
ffc8f6aa4127b1f42efae495360156abb6a6b938278368737d040daf9fcc6d88  CDP3B_up.sql
12f49c88a65f88860d1c28d3d6db387088c7eebcf25e5e5261c8626b12e2f12f  CDP3B_patch_asset_preview_up.sql
6b90031545e6df9ea403fcefd69c397b4d322469e97f6c7c86575f94ed5cb833  CDP3B_patch_asset_preview_down.sql
6124b4b3731fc11c4b8fde701f24d588b3829976574d2828c33de0aac8556d8c  admin.html
70a24c4d09328118f70d38e9152a450a28535c427ab87c6f0dd02ef4df43b040  admin_email_module.html
11490786a1d5de4f685c0db25f9555af56cc95611c5e2f6ea09fc8cf15592bf9  edge/email-api/email_sanitizer.js
b0c066dfcbdab7cdd975ce1d6d35b561ccff3aa1bba8d7cc7d18ce24bd732c4c  edge/email-api/index.ts
d944556cf9c696244f709869f4c08ea1b6adde54461f49f1706b17313873200d  edge/email-api/test_sanitizer_deno.ts
187eb44b177c310bed66e687ea1a826746aa8e06c4450b8b7f466dd4bf80d291  gates/admin_reopen_test.mjs
a6b5ff6d912cf79b520b6c2231a4b9ad615d3421dacd788fc2e5ac46a3ae98cc  gates/baseline_fixture.sql
2d070ac254c161d3336164d6dc4b478ebef134bfe2ebb37f5a01dce44d92bcb2  gates/ci_setup.sh
35945e0fcb4e7b44419f2f40e07182731dc581f7510a1a75d222f7e0ac7f56f7  gates/e2e_gates.ts
5dac035222fa13730c134481d390eac179712fa19667d02c82d19e9fe1748143  gates/gjs_serialize_test.mjs
91a7f633ccfe8d95cbabd6dee6a9bef387fc9fdb66805317acc4b1a79ee19ad1  run_gates.sh
e38ff34f7fb2bb01b2cd4cb616b244eb5ffa1d41196aaf9f8d77fa3a1a4a6e63  vendor/VENDOR.md
1a7603ac82661e3ec4f0ad015e37f68ab62c85c725f07659b81760edb459ff8d  vendor/grapesjs/LICENSE
92d7f8742ee053f525dcec4bea0f12386213fcc8c739ab3b57a040b77f253387  vendor/grapesjs/grapes.min.css
ef1148f91d22dee3a3f912e14582c1d8deaee076633a4a50c7479245c8541129  vendor/grapesjs/grapes.min.js
3d950fc726f3212434e33d89b3a4c3fbe5aa76a66aee5b9d87a20846a5b27f78  vendor/grapesjs/grapesjs-preset-newsletter.index.js
```

**SHA256SUMS dosyasının kendi doğrulama değerleri (Run #10 düzeltmesi sonrası — Bölüm 8 ile tutarlı):**
- SHA-256 (64 hex): `774d1d628227ccb4d2f70b803f9fba59f59af556a9ea8099a9117ce9a37fb850`
- Git blob SHA-1 (40 hex): `c763bc268de319dec013d03f54bb3ebdc5367bc3`

**Bu patch'te repoya göre DEĞİŞEN/EKLENEN dosyalar:**
1. `admin.html` — DEĞİŞTİ (component-level signed↔public swap). **Henüz commit EDİLMEDİ** (SHA-256 `6124b4b3…`).
2. `edge/email-api/index.ts` — DEĞİŞTİ (asset_preview case + assertCanonicalAssets). ✅ commit'lendi, **düzeltmeden etkilenmedi**.
3. `CDP3B_patch_asset_preview_up.sql` — YENİ + **bu turda DÜZELTİLDİ** (yetki sınırı). ⚠️ repo PRE-FIX.
4. `CDP3B_patch_asset_preview_down.sql` — YENİ (rollback). ✅ değişmedi.
5. `gates/e2e_gates.ts` — DEĞİŞTİ + **bu turda AP1–AP10 ile yeniden yazıldı**. ⚠️ repo PRE-FIX.
6. `gates/gjs_serialize_test.mjs` — YENİ. ✅ değişmedi.
7. `gates/ci_setup.sh` — DEĞİŞTİ. ✅ değişmedi.
8. `run_gates.sh` — DEĞİŞTİ. ✅ değişmedi.
9. `SHA256SUMS` — **bu turda güncellendi** (up.sql + e2e_gates.ts yeni hash'leri). ⚠️ repo PRE-FIX.

**Değişmeyen kritik dosya:** `edge/email-api/email_sanitizer.js` — SHA-256 `11490786…` korunuyor.

---

## 4. Güvenlik düzeltmesi — `admin_q_email_asset_preview` yetki sınırı

### 4.1 Reddedilen eski mantık ve neden sızıntı olduğu

Eski gövde: `a.created_by = p_actor OR (asset, p_template_id current draft manifestinde)`.
Sorun: `created_by = p_actor` dalı **tek başına** yetki veriyordu. Böylece bir admin, kendi oluşturduğu ama **başka bir şablona** bağlanmış eski bir asset'i, ilgisiz bir `template_id` ile (hatta template'siz) önizleyebiliyordu. `created_by` sahiplik kanıtıdır, ama bağ (binding) kanıtı değildir.

### 4.2 Uygulanan yeni sınır (fail-closed)

```
(A) Asset, verilen p_template_id'nin CURRENT DRAFT (is_published=false) sürümüne bağlı
    OR
(B) created_by = p_actor  AND  asset HİÇBİR sürüme bağlı DEĞİL (taze upload)
```
Ek olarak `status in ('draft','promoting')` → published asset asla signed preview üretmez.

### 4.3 Veri modeli gerçeği (authoritative kaynak seçimi — doğrulandı)

`CDP3B_up.sql` incelendi:
- `admin_w_email_version_save` (satır 291–330) yalnız `email_template_versions.asset_manifest`'i günceller; **`email_version_assets` junction'a YAZMAZ.**
- `email_version_assets` junction **yalnız publish anında** dolar (`admin_w_email_publish`, satır 410).

Sonuç: **taslak** bağı için authoritative kaynak `asset_manifest`'tir (junction taslakta boştur). Bu yüzden:
- Branch (A) — current draft bağı → **manifest** ile doğrulanır. Tutarlılık fail-closed: current draft için bir junction satırı varsa (anormal), manifest de içermeli; aksi hâlde erişim yok.
- Branch (B) — "hiçbir sürüme bağlı değil" → **junction (yayınlanmışlar) VE herhangi bir sürüm manifesti (taslaklar) BİRLİKTE** kontrol edilir (fail-closed union). İkisinden birinde bile varsa "bağlı" sayılır ve created_by dalı kapanır.

### 4.4 Zorunlu testler (AP1–AP10) — `gates/e2e_gates.ts`

| Test | Senaryo | Beklenen |
|---|---|---|
| **AP1** | Kendi taze (bağsız) upload'u | preview VAR + signed URL + token + `Cache-Control: no-store` + ttl=600 |
| **AP2** | Current draft'a bağlı kendi asset'i (doğru template_id) | preview VAR (branch A) |
| **AP3** | Aynı actor'ın BAŞKA template current draft'ına bağlı asset'i (farklı template_id ile ve template'siz) | preview YOK (created_by tek başına yetki vermez) + unavailable |
| **AP4** | Aynı template'in non-current (pointer'ı kaldırılmış) draft'ına bağlı asset | preview YOK (branch A yalnız current draft) + unavailable |
| **AP5** | Başka actor'ın (SUPER) bağsız asset'i, CRM sorgular | preview YOK + unavailable |
| **AP6** | Published asset | signed preview YOK (status filtresi) + unavailable; yanıtta hiç `sign/` yok |
| **AP7** | 2 asset'ten biri yetkisiz | previews yalnız yetkiliyi; unavailable_asset_ids yalnız yetkisizi |
| **AP8** | CRM+SUPER izinli; RPC EXECUTE yalnız `service_role` | 200 + `anon`/`authenticated` EXECUTE=false |
| **AP9** | Yanıt sızıntısı + gerçek sign-hatası fault | anahtarlar sabit `{ok,previews[{asset_id,url}],unavailable_asset_ids,ttl}`; `object_path`/ham storage hatası SIZMAZ |
| **AP10** | RLS deny-all + service-role-only RPC | 4 tablo RLS enabled + anon/authenticated grant=0; RPC EXECUTE yalnız service_role |
| AP-EDGE | Boş id listesi | 422 `no_ids` |

> AP4, pointer'ı `null`'a çekerek sürümü non-current yapar (deferred pointer-check yalnız not-null'da doğrular). AP9, bağsız kendi asset'inin `object_path`'ini biçim-geçerli ama storage'da olmayan bir path ile değiştirip `createSignedUrl` hata kolunu (index.ts satır 227) gerçekten tetikler; index.ts ham hatayı döndürmez, asset'i `unavailable`'a düşürür.

---

## 5. Yerel doğrulama sonuçları (Run #10 ÖNCESİ)

- `sha256sum -c SHA256SUMS` → **tümü OK** (güncel manifest).
- `gates/e2e_gates.ts` → **esbuild 0.28.2 ile parse/bundle başarılı** (TS sözdizimi geçerli). Tam e2e koşusu uzak `deno.land`/postgres importları yerelde kısıtlı olduğundan yalnız **Run #10 (ephemeral CI)** içinde koşar.
- `gates/gjs_serialize_test.mjs` (gerçek vendored GrapesJS, jsdom) → önceki turda **GJS_SERIALIZE_OK** (değişmedi).
- `gates/admin_reopen_test.mjs` → önceki turda **ADMIN_REOPEN_OK** (değişmedi).
- `CDP3B_up.sql` incelemesi ile authoritative kaynak (junction publish'te dolar, save doldurmaz) **kod düzeyinde doğrulandı**.

---

## 6. Production / deploy etkisi + repo-yerel sapması

**Production runtime DEĞİŞMEDİ:**
- **Supabase email-api YENİDEN DEPLOY EDİLMEDİ.** Canlı fonksiyon patch ÖNCESİ sürümdür; `asset_preview` + `assertCanonicalAssets` canlıda AKTİF DEĞİL.
- **Canlı `/admin` DEĞİŞMEDİ.** Repo'daki admin.html hâlâ ESKİ sürüm (commit edilmedi).
- **GitHub Pages:** Önceki 8 commit "pages build and deployment" (dynamic) tetikledi ve başarılı oldu; ancak bunlar kaynak/test/CI dosyaları — uygulama runtime davranışını değiştirmez. Cloudflare'e bu oturumda ayrı deploy tetiklenmedi.

**Repo ↔ yerel SAPMASI (önemli):**
Bu turdaki iki düzeltme repoya HENÜZ yansımadı. Repo şu an **PRE-FIX** tutar:
- `CDP3B_patch_asset_preview_up.sql` — repo: eski `created_by OR manifest` sınırı.
- `gates/e2e_gates.ts` — repo: eski GATE-AP1/AP2/AP3.
- `SHA256SUMS` — repo: eski hash'ler.

Yerelde düzeltilmiş sürümler bu teslimdeki kartlardır.

---

## 7. Kalan iş (bağımsız inceleme onayı bekliyor — hiçbir production adımı yapılmadı)

Bağımsız inceleme onayından SONRA, sırayla:
1. **admin.html** repoya byte-exact yazılır (GitHub "Add file → Upload files" ile tek dosya; yükleme sonrası raw SHA-256 = `6124b4b3…` doğrulanır). Tarayıcı aracı yerel dosya seçemediği için bu adım sizde en güvenlidir.
2. **Düzeltilmiş 3 dosya yeniden commit edilir:** `CDP3B_patch_asset_preview_up.sql` (`12f49c88…`), `gates/e2e_gates.ts` (`1e4e5963…`), `SHA256SUMS` (`dad03efe…`). Bunlar repodaki PRE-FIX sürümlerin ÜZERİNE yazılmalı; aksi hâlde Run #10 eski sınırı test eder.
3. Repo bütünlüğü doğrulandıktan sonra **Run #10** (CDP-3B Gates, workflow_dispatch) tetiklenir.
4. Run #10 tamamen yeşil (AP1–AP10 dâhil) + teardown residue=zero olmadan **hiçbir production adımı yapılmaz** (migration / edge deploy / admin publish).

> Bu teslimden sonra DURULDU: admin.html commit/upload, Run #10, migration, Edge deploy veya başka production işlemi YAPILMADI.

---

## 8. Run #10 sonrası düzeltme (test/CI katmanı — sevk edilen kod sınırı DEĞİŞMEDİ)

**Run #10 (branch `cdp3b-asset-preview`, commit `65f52d4`) sonucu:** `deno test gates/e2e_gates.ts` → **11 passed / 12 failed** (`GATE_FAILED:gate_e2e`). Diğer tüm gate'ler (paket bütünlüğü `sha256sum -c`, sanitizer, `deno check`, Gate9 rollback, edge_runtime) GEÇTİ. Güvenlik sınırını doğrulayan **AP5/AP8/AP10 dâhil 11 test geçti**. İki kök neden — ikisi de test/CI harness'ta, sevk edilen RPC/index.ts/admin.html mantığında değil:

**Kök neden A (9 test):** `save` → HTTP 409 `unmanaged_asset_url`. CI'da edge `supabase functions serve` ile sunulduğundan `SUPABASE_URL` = internal `http://kong:8000`; `assertCanonicalAssets` izinli public URL setini bununla kurar. Test ise görsel URL'sini `EMAIL_API_URL` = `http://127.0.0.1:54321`'den kurar → host uyuşmazlığı. (Prod'da admin `CFG.url` = edge `SUPABASE_URL` olduğundan bu durum OLUŞMAZ.)

**Kök neden B (3 test — AP1/AP7/AP9):** tüm testler paylaşılan `PNG_1x1`'i kullanıyordu; `asset_upload` içerik-hash'iyle dedupe yaptığından "taze" upload önceki testlerin yayınladığı/bağladığı ortak asset'e çözülüyordu (AP1/AP7 → 0 preview; AP9 → `published_asset_immutable`).

### Uygulanan düzeltmeler

**A — CI PUBLIC URL ALIAS (edge SUPABASE_URL'e DOKUNULMADAN):** `edge/email-api/index.ts`'e `E2E_PUBLIC_ORIGIN` eklendi. YALNIZ `EMAIL_API_E2E==="1"` iken `E2E_PUBLIC_SUPABASE_URL` env'i okunur; startup'ta **fail-closed** doğrulanır (yalnız tam origin: scheme+host[+port]; path/query/fragment/credentials → throw). `assertCanonicalAssets` bu origin'i, gerçek `SUPABASE_URL` origin'ine **EK** olarak yalnızca **kalıcı managed public URL** karşılaştırmasında kabul eder. `SUPABASE_URL` değiştirilmedi (Auth/DB/Storage/createSignedUrl internal URL'i kullanmaya devam eder). Host-duyarsız/path-bazlı karşılaştırma YOK; `FORBIDDEN` (signed/draft/token/data-asa-*) kontrolleri origin'den bağımsız aynen çalışır. CI env'i `.github/workflows/cdp3b-gates.yml` içinde `gates/e2e.env`'e `E2E_PUBLIC_SUPABASE_URL=$API_URL` olarak eklenir (dış API host'u). Prod'da bu env yok + E2E=false → tamamen inert.

**B — BENZERSİZ TEST GÖRSELİ:** `gates/e2e_gates.ts`'e `freshTestImage()` eklendi — her çağrıda geçerli PNG'nin IHDR'sinden sonra rasgele UUID'li **geçerli** bir tEXt chunk (CRC hesaplı) ekler; magic + 1×1 boyut korunur, ham baytlar (dolayısıyla sha256 içerik-hash'i) benzersiz olur. `mkPublishedTemplate`, `bindAssetToCurrentDraft`, AP1, AP5, AP7, AP9 dâhil taze-draft isteyen 11 upload `freshTestImage()` kullanır. Bilinçli dedupe testi (FIX-7) `PNG_1x1`'i iki kez kullanmaya devam eder.

### Zorunlu assertion'lar (gates/e2e_gates.ts)
- **FIX-6:** iki `freshTestImage()` → farklı asset_id + farklı content_hash (dedupe YOK) + magic/1×1 server'da geçti. *(runtime)*
- **FIX-7:** aynı içerik iki kez → dedupe korunur (aynı asset_id/path). *(runtime)*
- **FIX-1:** signed preview draft-bucket `sign` endpoint'i → internal storage istemcisi çalışıyor (SUPABASE_URL değişmedi). *(runtime)*
- **FIX-4:** alias host doğru + manifest DIŞI path → `unmanaged_asset_url`. *(runtime)*
- **FIX-5:** alias origin + token → `draft_asset_url_in_content` (FORBIDDEN). *(runtime)*
- **(2)** Alias yalnız `EMAIL_API_E2E=1` iken kabul: pozitif taraf artık geçen save testleriyle (mkPublishedTemplate/AP2/GATE-CF) kanıtlı. *(yapısal + runtime)*
- **(3)** E2E=false iken aynı alias URL → `unmanaged_asset_url`: index.ts'te `if(!E2E) return null` yapısal garanti; ampirik olarak Run #10 (alias env'siz) tam bu davranışı gösterdi. *(yapısal)*

### Operasyonel yorum düzeltmesi (bağımsız inceleme sonrası)
`index.ts` başındaki sanitizer yorumundaki eski `SHA bc60ffed…` değeri güncel kanonik `SHA-256 11490786a1d5de4f685c0db25f9555af56cc95611c5e2f6ea09fc8cf15592bf9` ile değiştirildi. **YALNIZ yorum; çalışma zamanı mantığı değişmedi.** index.ts SHA-256 bu nedenle nihai değere güncellendi (aşağıdaki tablo).

### Değişen dosyalar + yeni değerler (NİHAİ)
| Dosya | SHA-256 | git-blob-sha1 |
|---|---|---|
| `edge/email-api/index.ts` | `b0c066dfcbdab7cdd975ce1d6d35b561ccff3aa1bba8d7cc7d18ce24bd732c4c` | `db354752723fb8b122690b07b9db0e539e462799` |
| `gates/e2e_gates.ts` | `35945e0fcb4e7b44419f2f40e07182731dc581f7510a1a75d222f7e0ac7f56f7` | `cdd342c5a2af0cb5b2f983e4b45d6d5f7b94af05` |
| `SHA256SUMS` | `774d1d628227ccb4d2f70b803f9fba59f59af556a9ea8099a9117ce9a37fb850` | `c763bc268de319dec013d03f54bb3ebdc5367bc3` |
| `.github/workflows/cdp3b-gates.yml` (manifest DIŞI; repo `.github/workflows/`'a) | `5c81ba197f40c826135e9ae7576053d7ae96d81c13318d880b714a33e5d94e28` | `fcc896aa1ecd929a07798eee1f84413468617416` |

**DEĞİŞMEYEN (sevk sınırı korunur):** `CDP3B_patch_asset_preview_up.sql` (RPC), `CDP3B_patch_asset_preview_down.sql`, `admin.html`, `edge/email-api/email_sanitizer.js`. Yerel doğrulama: `sha256sum -c SHA256SUMS` = tümü OK; index.ts + e2e_gates.ts esbuild ile sözdizimsel geçerli; kaynaklarda NUL bayt yok.

> Bu bir güvenlik gevşetmesi DEĞİLDİR: E2E alias yalnız `EMAIL_API_E2E=1` altında çalışır, prod'da inert; FORBIDDEN (signed/draft/token) origin'den bağımsız korunur; host-duyarsız/path-bazlı karşılaştırma yapılmaz. **Henüz commit/push YOK, Run #11 YOK, production işlemi YOK — bağımsız inceleme bekleniyor.**

# CDP-3C · Kapanış Raporu (10 blocker · tek uygulama turu)

> **Kapsam:** Part A search_path hardening'ın repo paritesi + 10 kapanış blocker'ı, tek turda,
> yeni mimari genişletme AÇMADAN, **hiçbir production Edge/admin/statik deploy YAPMADAN** düzeltildi.
> DB katmanı (up + hardening) daha önce zaten uygulanmıştı ve **değiştirilmedi**.
> Yerel doğrulama: `node CDP3C_package/gates/cdp3c_edge_tests.mjs` → **PASS (54/54)**;
> Deno `deno check` (email-api, stub'lı) → **temiz**; esbuild transpile (email-api + admin-api) → **temiz**;
> tüm inline HTML script'leri → **0 sözdizim hatası**; `git diff` (admin.html + iki şehir SPA) → **yalnız ekleme**.

## Blocker → çözüm eşlemesi

**1) Kaynak-kontrol paritesi (hardening).** `CDP3C_package/CDP3C_up_search_path_hardening.sql`
(SHA `132718a268569a3a6247142cf343f27fcf58a4a6e2f342db4b8d9879fcbf0389`) repo'da; kök `SHA256SUMS`
36/36 `-c` OK. Production migration kaydı `20260909132039/cdp3c_consent_v9_search_path_hardening`
(kayıt adı = dosya adı; version↔SHA eşleşir). **Hardening yeniden uygulanmadı.** Manifest + paket raporu
(`CDP3C_DELIVERY_MANIFEST.md`, `CDP3C_PACKAGE_REPORT.md` §0.1) güncellendi.

**2/3/4) Gerçek Edge entegrasyonu + strict şema + CORS.** `CDP3B/edge/email-api/index.ts` (gerçek
authoritative email-api'ye ADDITIVE): `consent_get` / `consent_set` (yalnız pref_center) / `service_pref_set`
action'ları **kullanıcı JWT client'ı** ile eklendi (service_role değil). Strict şema: kapalı-alan,
gerçek boolean (`"false"/"0"` reddi), purpose/servis-key/locale sunucu allowlist'i, `request_id`+`idem`
zorunlu, text_version uuid|null, withdraw→null. Maskeli kodlar 401/403/409/422/400. CORS: yalnız apex+www;
bilinmeyen origin (OPTIONS dahil) → 403, ACAO yazılmaz, yan etki yok; `Allow-Credentials` kasıtlı yok
(JWT). `verify_jwt=true` + dependency pin'leri (std@0.224.0 / supabase-js@2.45.4 / deno_dom@v0.1.45) +
17 CDP-3B email-admin action'ı korunur. Tam birleşik dosya teslim (snippet değil).

**5) Admin backend + gerçek admin.html.** `CDP3B/edge/admin-api/index.ts` (gerçek v13'e ADDITIVE, tam
birleşik): `q_member_consent` + `marketing_readiness_check` action'ları eklendi, ROLE_SETS ile rol-kapılı
(super_admin/support/crm), **WRITE_ACTIONS'a EKLENMEDİ → admin opt-in VEREMEZ**. Yanıt RPC allowlist'iyle
sınırlı (ham HMAC/fingerprint/idempotency/request_id/evidence dönmez). `CDP3B/admin.html`'e **"İzin
Görünümü"** segmenti ADDITIVE eklendi (git diff = 62 ekleme / 0 silme); CDP-3B e-posta editörü (`renderEmail`)
byte-değişmedi (regresyon: 4 inline script 0 sözdizim hatası, tüm 17 action ve renderEmail mevcut).

**6) Üye Tercih Merkezi.** Gerçek üye rotası tespit edildi: şehir SPA'ları `amsterdam/index.html` +
`kopenhag/index.html` (aynı şablon). Her ikisine ADDITIVE **"E-posta Tercihleri"** segmenti: yalnız
**servis** e-posta tercihleri (`consent_get_my_state` + `service_pref_set` authenticated RPC), Türkçe
etiketler, `config_pending` dürüst gösterim. Pazarlama/SMS/push/reklam/profilleme **GİZLİ**; pazarlama
bölümü yalnız `state.marketing_available===true` sunucu yeteneğiyle açılır (kalıcı hard-code değil).
**"Tümünü reddet" yok.** İki mevcut kullanıcıya **popup/backfill/re-consent yok** (sekme yalnız açınca
yüklenir; save sonrası server'dan yeniden okunur, optimistic gösterim yok).

**7) Çerez modülü (WIRE EDİLMEDİ).** `CDP3C_package/edge_admin/web/cookie_consent.js` v2 fail-closed:
consent-mode default denied; **localStorage authoritative değil** (script yüklemeyi tetiklemez); gated
script yalnız sunucu consent yazımı 2xx başarısından sonra; sunucu reddi → denied kalır; `endpoint` veya
aktif `text_version` yoksa **tam pasif** (grant toplanmaz); Çerez Politikası linki yalnız geçerli `policyUrl`
varsa; anon subject/TTL/text_version yaşam döngüsü sunucuya bağlı. Hukuk metinleri sonra geleceği için
**production'a bağlanmadı**.

**8) Suppression / HMAC.** Çelişkili taslak (`consent-api.ts`) **kaldırıldı**; çelişki giderildi.
`CDP3C_SUPPRESSION_HMAC_NOTE.md`: gerçek gönderim olmadığından suppression çağrı yüzeyi public/client
route'a bağlanmadı; ham e-posta→HMAC dönüşümü ve pepper sınırı CDP-3D provider/webhook'a bırakıldı;
`admin_w_apply_suppression` yalnız 64-hex HMAC + service_role; `_contact_hmac` client rollerinden revoke;
ham e-posta audit/hata/idempotency/admin yanıtına girmez (tablolarda `~ '^[0-9a-f]{64}$'` CHECK).

**9) Testler.** `CDP3C_package/gates/cdp3c_edge_tests.mjs` (+ `_MAP.md`): 15 zorunlu testin tamamı
eşlendi, **PASS (54 assert)**. Ağ/deploy gerektirmeyen birim + statik-sözleşme katmanları.

**10) Teslim sınırı.** Bu turda: production Edge/admin/statik **deploy YOK**; marketing/legal-text/controller
**aktivasyonu YOK**; Resend/outbox/journey/send **YOK**; iki mevcut kullanıcıya **dokunulmadı**;
kill-switch v3 **değişmedi**. Kaldırılan taslaklar: `edge/consent-api.ts`, `admin/preference_center.html`,
`admin/admin_consent_view.js` (gerçek entegrasyonlarla superseded).

## Değişen / yeni dosyalar (bütünlük: `CDP3C_CLOSURE_SHA256SUMS.txt`)
- `CDP3B/edge/email-api/index.ts` (ADDITIVE — consent yüzeyi + CORS + strict şema)
- `CDP3B/edge/admin-api/index.ts` (YENİ repo dosyası — v13 + 2 salt-okunur action)
- `CDP3B/admin.html` (ADDITIVE — İzin Görünümü segmenti)
- `amsterdam/index.html`, `kopenhag/index.html` (ADDITIVE — E-posta Tercihleri segmenti)
- `CDP3C_package/edge_admin/web/cookie_consent.js` (v2 fail-closed; wire edilmedi)
- `CDP3C_package/edge_admin/CDP3C_EDGE_ADMIN_PACKAGE.md` (yeniden yazıldı; gerçek dosya konumları)
- `CDP3C_package/CDP3C_SUPPRESSION_HMAC_NOTE.md` (yeni)
- `CDP3C_package/gates/cdp3c_edge_tests.mjs` + `cdp3c_edge_tests_MAP.md` (yeni)
- `CDP3C_package/CDP3C_DELIVERY_MANIFEST.md`, `CDP3C_PACKAGE_REPORT.md` (hardening paritesi güncellendi)
- kök `SHA256SUMS` (hardening SQL + iki güncellenen doküman; 36/36 OK)

## İleride uygulanabilir deploy / rollback sırası (BU TURDA YAPILMADI — ayrı onayla)
DB zaten uygulı (up + hardening). Kalan adımlar, her biri ayrı onay + doğrulama ile:

1. **email-api deploy** (verify_jwt=true korunur). Doğrulama: `OPTIONS` bilinmeyen origin → 403 (ACAO yok);
   token yok → 401; normal üye `consent_get` 200 + admin action (`list`) 403; `"false"` grant → 422;
   marketing grant → 409 (aktif metin yok). Rollback: önceki email-api sürümüne geri al (consent action'ları
   ADDITIVE olduğundan CDP-3B davranışı değişmez).
2. **admin-api deploy** (v13→v13+consent). Doğrulama: `q_member_consent` super_admin 200 allowlist; non-admin
   403; readiness `{ready:false,missing:[...]}`; mevcut CDP-2B/2C action'ları regresyonsuz. Rollback: v13'e geri al.
3. **admin.html yayını** (Cloudflare Pages). Doğrulama: canlı SHA hedef dosyayla eşleşir; `/admin` yönlendirme
   döngüsü yok; İzin Görünümü sekmesi salt-okunur; e-posta editörü çalışır. Rollback: önceki admin.html.
4. **Şehir SPA yayını** (`amsterdam/`, `kopenhag/`). Doğrulama: E-posta Tercihleri sekmesi yalnız servis
   tercihleri; marketing gizli; save/reopen; iki kullanıcıya popup/backfill yok. Rollback: önceki index.html.
5. **Çerez modülü: WIRE ETME.** Yalnız hukuk metinleri + çalışan anon uç + policyUrl hazır olunca, ayrı
   fazda (CDP-3D/legal) aktive edilir. O ana kadar sayfaya bağlanmaz (dosya inert).

**Sıra ilkesi:** backend (email-api → admin-api) önce, statik (admin.html → şehir SPA) sonra; her adımda
401/403/409/422 red yolları doğrulanır; herhangi bir kritik testte güvenli tarafta DUR + yalnız o adımı
ilgili sürüme geri al. Marketing/legal/controller ve Resend/journey bu sırada **açılmaz**.

## EK: Entegrasyon kabul turu (5 blocker düzeltmesi)
Bağımsız incelemenin ardından, deploy öncesi sınırlı kabul turu:

1. **Test sınıflandırması.** `cdp3c_edge_tests.mjs` artık açıkça **DESTEKLEYİCİ** (birim + statik sözleşme)
   olarak etiketlendi; **deploy kanıtı değildir**. Deploy kanıtı yeni gerçek-HTTP gate'tir (aşağıda).
2. **Bütünlük.** Değişen TÜM tam dosyalar tek branch `cdp3c-edge-admin-closure` + tek ZIP'te; kök
   `SHA256SUMS` (53 giriş) + `CDP3C_CLOSURE_SHA256SUMS.txt` güncellendi; ZIP == commit ağacı (byte-exact).
3. **Çerez.** Önbellekteki `granted` kararında artık HER yüklemede yeni consent olayı ÜRETİLMEZ: salt-okunur
   `cookie_consent_status` ile teyit (yeni idem/yazma yok). Kalan yaşam döngüsü açıkça **AKTİVASYON
   BLOCKER'I** olarak işaretlendi; "hazır/canlıya alınabilir" DENMİYOR; hiçbir HTML'e wire edilmedi.
4. **marketing_available.** Üye UI'sinden marketing yüzeyi TAMAMEN kaldırıldı; RPC bu alanı döndürmediği
   için "geleceğe hazır otomatik açılır" iddiası KALDIRILDI. Bu turda marketing UI yok.
5. **Hardening parite.** `CDP3C_up_search_path_hardening.sql` source control'de; kök `SHA256SUMS`'ta;
   production'a YENİDEN uygulanmadı; commit ağacından SHA doğrulandı (aşağı).

### Gerçek-HTTP entegrasyon gate (deploy kanıtı)
- Workflow: `.github/workflows/cdp3c-edge-integration.yml` (CDP-3B gate'leri DEĞİŞMEDİ; ayrı workflow).
- Ephemeral Supabase (`supabase start`) → baseline doubles + entegrasyon doubles + `CDP3C_up.sql` + hardening
  uygulanır → gerçek birleşik `email-api` + `admin-api` `supabase functions serve` ile sunulur (byte-exact
  kopya doğrulanır) → `gates/cdp3c_edge_integration.sh` GERÇEK HTTP + GERÇEK DB RPC kabul testleri koşar:
  bilinmeyen origin OPTIONS+POST→403 (ACAO yok, DB yan etkisi yok), allowlist OPTIONS, token yok/geçersiz→401,
  üye consent_get→200+no-store, üye email-admin list→403, "false"/"0"/sayı→422, bilinmeyen alan→400,
  service_pref_set ilk→200 / aynı idem+payload→aynı / aynı idem+farklı→409, save→reopen gerçek durum,
  marketing grant→409 + consent satırı yok, otomatik backfill/yazım yok, admin q_member_consent super_admin→200
  allowlist (sızıntı yok) / normal üye→403, marketing_readiness_check→ready:false, admin opt-in yazma yok,
  secret scan temiz, teardown residue=0.
- **ÇALIŞTIRMA:** Bu gate GitHub Actions'ta koşar. Bu sandbox'ta **push kimlik bilgisi + Docker + Supabase CLI
  YOK**; bu yüzden gate BURADA çalıştırılamadı. Branch push + `workflow_dispatch` sonrası GitHub'da koşar.
  Yerel olarak yalnız statik doğrulamalar yapıldı: `bash -n` (script) OK, YAML parse OK, `deno check`
  (email-api stub'lı) temiz, esbuild transpile (email-api + admin-api + v13.base) temiz, destekleyici
  `cdp3c_edge_tests.mjs` **56/56 PASS**.

### Branch / base / rollback SHA'ları
- Branch: `cdp3c-edge-admin-closure` (base: `main` = `16ada030721e3da62c29b71dfb97c488caa1405a`).
- BASE (değişiklik öncesi, main'den) rollback SHA'ları:
  - `CDP3B/edge/email-api/index.ts` = `b0c066dfcbdab7cdd975ce1d6d35b561ccff3aa1bba8d7cc7d18ce24bd732c4c`
  - `CDP3B/admin.html` = `6124b4b3731fc11c4b8fde701f24d588b3829976574d2828c33de0aac8556d8c`
  - `amsterdam/index.html` = `509241f5d375b7532d6d0f5ec3efff964b75644dc7ec1abff10236d9b51f6df4`
  - `kopenhag/index.html` = `b7599962ef45eb0b3aa0343bfa04c1fd89a2f3b12a81f4c9a41f1ebc655570c4`
  - `admin-api`: main'de YOK → base = deployed v13 (id `75a6554b…`, version 13, ezbr_sha256 `d48a4a76…`).
- YENİ dosya SHA'ları: `CDP3C_CLOSURE_SHA256SUMS.txt` (byte-exact, commit ağacından doğrulandı).

## EK-2: Entegrasyon gate harness düzeltmeleri (yalnız workflow + script; ürün kodu DOKUNULMADI)
Bağımsız inceleme, gate'in yanlış-pozitif/negatif riskini işaret etti. YALNIZ
`cdp3c-edge-integration.yml` + `cdp3c_edge_integration.sh` (+ manifest/SHA) değişti:
1. **admin_qmc leak** kontrolü artık YALNIZ `.data` üzerinde ve tam allowlist ile: `.data` üst anahtarları
   {consent,consent_timeline,service_prefs}; `consent[]`={purpose,state,text_version_id,epoch,updated_at};
   `consent_timeline[]`={purpose,action,text_version_id,source,occurred_at}; `service_prefs[]`={key,enabled,updated_at}.
   Üst seviye meşru `request_id` yasak sayılmaz; `.data` içinde request_id/hmac/fingerprint/idempotency/evidence → fail.
2. **Functions readiness FAIL-CLOSED**: email-api'den gerçek **405** görülene kadar poll; süre sonunda 405 yoksa
   `GATE_FAILED:functions_readiness` + serve.log (redakte) + dur.
3. **Destekleyici test ayrı adım**: `node cdp3c_edge_tests.mjs`; `CDP3C_EDGE_TESTS_RESULT=PASS` yoksa
   `GATE_FAILED:supporting_tests`.
4. HTTP suite çıktısı `tee /tmp/integration.log`; `pipefail` ile gerçek exit code korunur.
5. Suite sentinel'i `CDP3C_EDGE_HTTP_SUITE_PASS` (yalnız HTTP sonucu). Nihai sentinel
   `LOCAL_CDP3C_EDGE_INTEGRATION_PASS` ayrı `if:success` adımında, secret-scan + teardown'dan SONRA.
   Teardown: `supabase stop` exit code YUTULMAZ; stop_exit=0 + container=0 + volume=0 üçü de doğrulanır.
6. Tek artifact `if:always`: supporting/serve/integration/teardown/secret_scan logları (JWT/anahtar REDAKTE).
   Secret scan redakte artifact'te sızıntı bulursa dosyayı çıkarır ve `GATE_FAILED:secret_scan`.
Yerel doğrulama: `bash -n` OK, 3 workflow YAML OK, destekleyici test 56/56 PASS. email-api/admin-api/admin.html/
şehir SPA'ları/cookie/SQL **byte-değişmedi** (git status ile doğrulandı).

## EK-3: CDP-3B gate re-pin + teardown sertleştirme (yalnız manifest/workflow; ürün kodu byte-exact)
PR #3'te CDP-3B Gates kırmızıydı; kök neden `GATE_FAILED:sha256sums_mismatch` — CDP-3B kendi iç manifesti
`CDP3B/SHA256SUMS` ile dosyaları byte-pinliyor; consent yüzeyini CDP-3B dosyalarına additive eklediğimiz için
`admin.html` + `edge/email-api/index.ts` hash'leri değişti ve yeni `edge/admin-api/index.ts` pinli değildi.
Onaylı düzeltme (yalnız manifest/workflow, ürün mantığına DOKUNULMADAN):
1. `CDP3B/SHA256SUMS` bilinçli re-pin: `admin.html`→`dc87f68d…`, `edge/email-api/index.ts`→`3464cddb…`,
   yeni `edge/admin-api/index.ts`→`880dd2c4…`. Diğer CDP-3B girdileri byte-değişmedi. (`sha256sum -c` = 22/22 OK.)
2. `cdp3b-gates.yml` teardown sertleştirme: `functions serve` PID'i `/tmp/cdp3b_serve.pid`'e yazılır; teardown
   başında TERM + sınırlı bekleme, gerekirse KILL + tekrar doğrulama; sonra `supabase stop --no-backup`.
   Artık TÜM koşullar istenir ve maskelenmez: `serve_process=stopped`, `supabase_stop=ok`, `container_count=0`,
   `volume_count=0`, `residue=zero`. (teardown residue artık "ikincil" sayılmıyor; ilk sınıf gate koşulu.)
Ürün dosyaları (admin.html, email-api, admin-api, şehir SPA'ları, CDP-3C SQL, cookie) `a6bc486` ile **byte-exact**
kalır (git diff ile kanıtlandı). CDP-3B eski suite'i (SHA, sanitizer, deno check/test, edge runtime, E2E, admin
reopen, GrapesJS serialize) re-pin sonrası eksiksiz koşar; assertion gevşetme/skip YOK.

## Durma
Tüm 10 kapanış + 5 kabul + 6 harness + CDP-3B re-pin/teardown düzeltmesi tamamlandı. Gerçek bir güvenlik
riski/çakışma bulunmadı. Push + PR #3'te üç gate yeşilse: merge YOK, tek kontrollü deploy + canlı kabul (sonraki adım).
